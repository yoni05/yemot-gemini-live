const express = require('express');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const TOKEN = (process.env.YEMOT_TOKEN || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const YM = 'https://www.call2all.co.il/ym/api/';
const TEXT_ARCHIVE_EXT = '8';

let cachedBestModel = null;
const lastAnswerByPhone = new Map();
const conversationHistoryByCall = new Map();
let globalLastAnswer = null;
const folderCounters = {};

async function fetchWithTimeout(url, options = {}, timeout = 24000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (err) {
        clearTimeout(id);
        throw err;
    }
}

async function getNextFileNumberStr(folder) {
    const cleanFolder = String(folder || '').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    const folderPath = cleanFolder ? `ivr2:/${cleanFolder}` : `ivr2:/`;
    let maxExisting = -1;

    try {
        const url = `${YM}GetIVR2Dir?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(folderPath)}`;
        const res = await fetchWithTimeout(url, {}, 7000);
        if (res.ok) {
            const data = await res.json();
            const files = data.files || [];
            for (const f of files) {
                const fname = (typeof f === 'string') ? f : (f && (f.name || f.fileName || ''));
                const m = String(fname).match(/^(\d+)\.(wav|tts|txt|mp3)$/i);
                if (m) {
                    const num = parseInt(m[1], 10);
                    if (!isNaN(num) && num < 900 && num > maxExisting) {
                        maxExisting = num;
                    }
                }
            }
        }
    } catch (e) {
        console.warn(`[GetIVR2Dir] Warning checking ${folderPath}:`, e.message);
    }

    const currentMem = (folderCounters[cleanFolder] !== undefined) ? folderCounters[cleanFolder] : -1;
    const nextNum = Math.max(maxExisting, currentMem) + 1;
    folderCounters[cleanFolder] = nextNum;
    return String(nextNum).padStart(3, '0');
}

// 1. הורדת ההקלטה משלוחת העוזר הקולי
async function downloadRecordingFromYemot(recordPath, apiDir) {
    const cleanPath = String(recordPath).replace(/^ivr2:\/*/, '').replace(/^\/*/, '');
    const cleanDir = String(apiDir || '').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');

    const candidates = [
        `ivr2:/${cleanPath}`,
        `ivr2:${cleanPath}`
    ];
    if (cleanDir && !cleanPath.startsWith(cleanDir + '/')) {
        candidates.unshift(`ivr2:/${cleanDir}/${cleanPath}`);
    }
    if (!cleanPath.toLowerCase().endsWith('.wav')) {
        candidates.unshift(`ivr2:/${cleanPath}.wav`);
        if (cleanDir) candidates.unshift(`ivr2:/${cleanDir}/${cleanPath}.wav`);
    }

    const uniquePaths = [...new Set(candidates)];
    let lastYemotResponse = '';
    for (const p of uniquePaths) {
        const url = `${YM}DownloadFile?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(p)}`;
        try {
            const res = await fetchWithTimeout(url, {}, 10000);
            if (!res.ok) {
                lastYemotResponse = `HTTP_${res.status}`;
                continue;
            }
            const buf = Buffer.from(await res.arrayBuffer());
            const headStr = buf.toString('utf8', 0, Math.min(buf.length, 150));

            if (buf.length > 200 && !headStr.includes('responseStatus') && !headStr.includes('EXCEPTION')) {
                console.log(`[Yemot Download] Success from ${p} (${buf.length} bytes)`);
                return buf;
            } else {
                lastYemotResponse = headStr;
            }
        } catch (e) {
            lastYemotResponse = e.message;
        }
    }
    throw new Error('YEMOT_DOWNLOAD_ERR: ' + lastYemotResponse);
}

// 2. בחירת מודלים חכמים בלבד (מסנן מודלי lite שטועים בהבנת שמע טלפוני)
async function getSmartGeminiModels() {
    const preferredOrder = [
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-flash-latest'
    ];
    try {
        const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`, {}, 6000);
        if (res.ok) {
            const data = await res.json();
            const available = (data.models || [])
                .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                .map(m => m.name.replace('models/', ''))
                .filter(m =>
                    !m.includes('lite') &&
                    !m.includes('1.5') &&
                    !m.includes('tts') &&
                    !m.includes('image') &&
                    !m.includes('robotics') &&
                    !m.includes('research') &&
                    !m.includes('computer-use') &&
                    !m.includes('embedding')
                );

            const matched = [];
            for (const pref of preferredOrder) {
                if (available.includes(pref)) matched.push(pref);
            }
            for (const m of available) {
                if (m.includes('flash') && !matched.includes(m)) {
                    matched.push(m);
                }
            }
            if (matched.length > 0) return matched;
        }
    } catch (e) {}
    return preferredOrder;
}

// 3. פענוח קולי ישיר + חיפוש חי בגוגל בצעד אחד חכם ומדויק!
async function processAudioQuestionWithLiveSearch(audioBase64, callHistory = []) {
    const models = await getSmartGeminiModels();
    const uniqueModels = [...new Set(cachedBestModel ? [cachedBestModel, ...models] : models)];

    const nowStr = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    let historyContext = '';
    if (callHistory.length > 0) {
        const recent = callHistory.slice(-2).map(h => `שאלה קודמת: ${h.q} | תשובה קודמת: ${h.a}`).join('\n');
        historyContext = `\nהקשר משאלות קודמות בשיחה זו (השתמש בו רק אם המשתמש מתייחס אליו ישירות, אחרת התעלם ממנו לחלוטין):\n${recent}\n`;
    }

    const systemInstructionText = `אתה עוזר קולי חכם, אמין ומדויק במערכת טלפונית בעברית.
הזמן והתאריך הנוכחיים בישראל: ${nowStr}.${historyContext}

בצע את הפעולות הבאות בדיוק:
1. הקשב היטב לקובץ השמע המצורף (הקלטת טלפון בעברית) והבן בדיוק מה המשתמש שואל או מבקש.
2. חפש מידע מאומת, אמיתי ועדכני באמצעות חיפוש גוגל (Google Search) כדי לענות תשובה עובדתית מדויקת. לעולם אל תמציא עובדות או מספרים.
3. אם ההקלטה היא רק רעש או שקט מוחלט ולא נאמרה שום מילה ברורה, החזר אך ורק את המילה: UNCLEAR
4. החזר את הפלט בשתי שורות בדיוק בפורמט הבא (ללא כוכביות, ללא סולמיות וללא עיצוב):
שאלה: [כתוב כאן משפט קצר של מה שהמשתמש שאל]
תשובה: [כתוב כאן תשובה מלאה, לעניין, ברורה וטבעית להקראה בטלפון באורך 2 עד 5 משפטים שלמים]`;

    let lastErr = '';

    for (const model of uniqueModels.slice(0, 3)) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;

        const contentsPayload = [{
            parts: [
                { text: systemInstructionText },
                { inlineData: { mimeType: 'audio/wav', data: audioBase64 } }
            ]
        }];

        const attempts = [
            // ניסיון 1: חיפוש גוגל חי + תקציב חשיבה מבוקר (512) למניעת חיתוך ולמניעת שטויות
            {
                contents: contentsPayload,
                tools: [{ google_search: {} }],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 4096,
                    thinkingConfig: { thinkingBudget: 512 }
                }
            },
            // ניסיון 2: חיפוש גוגל חי (למודלים שאינם מקבלים thinkingConfig)
            {
                contents: contentsPayload,
                tools: [{ google_search: {} }],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 4096
                }
            },
            // ניסיון 3: גיבוי ללא כלי חיפוש אם המודל הספציפי חוסם שילוב אודיו וחיפוש
            {
                contents: contentsPayload,
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 4096
                }
            }
        ];

        for (const payload of attempts) {
            try {
                const res = await fetchWithTimeout(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }, 20000);

                if (res.ok) {
                    const data = await res.json();
                    const parts = (data?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought && p.text);
                    const fullText = parts.map(p => p.text).join('\n').trim();

                    if (fullText) {
                        cachedBestModel = model;
                        console.log(`[Gemini Direct Audio+Search] Model ${model} raw output:\n${fullText}`);

                        if (fullText.includes('UNCLEAR') && fullText.length < 25) {
                            return { question: '', answer: '' };
                        }

                        let parsedQuestion = 'שאלה קולית';
                        let parsedAnswer = fullText;

                        const qMatch = fullText.match(/שאלה\s*:\s*([^\n\r]+)/);
                        const aMatch = fullText.match(/תשובה\s*:\s*([\s\S]+)/);

                        if (qMatch && qMatch[1]) {
                            parsedQuestion = qMatch[1].trim();
                        }
                        if (aMatch && aMatch[1]) {
                            parsedAnswer = aMatch[1].trim();
                        } else {
                            parsedAnswer = fullText.replace(/^שאלה\s*:[^\n\r]+[\n\r]*/i, '').trim();
                        }

                        return { question: parsedQuestion, answer: parsedAnswer };
                    }
                } else {
                    lastErr = await res.text();
                }
            } catch (err) {
                lastErr = err.message;
            }
        }
    }
    throw new Error('GEMINI_AUDIO_SEARCH_ERR: ' + lastErr);
}

// 4. ניקוי הטקסט והכנתו להקראה רציפה וברורה בימות המשיח
function sanitizeForYemotTts(rawText) {
    return String(rawText || '')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/[*#_~`>\[\]()"{}|\\^]/g, ' ')
        .replace(/[=&\r\n\t]/g, ' ')
        .replace(/\./g, ', ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildYemotTtsPlayCommand(rawText) {
    const clean = sanitizeForYemotTts(rawText);
    if (!clean) return 't-לא התקבלה תשובה';

    const words = clean.split(' ');
    const chunks = [];
    let current = '';

    for (const w of words) {
        if ((current + ' ' + w).trim().length <= 220) {
            current = (current ? current + ' ' : '') + w;
        } else {
            if (current) chunks.push(current);
            current = w;
        }
    }
    if (current) chunks.push(current);

    return chunks.slice(0, 15).map(c => `t-${c}`).join('.');
}

// 5. שמירת השאלה והתשובה בארכיון שלוחה 8 (ברקע)
async function saveArchiveToExt8(questionText, answerText, callerPhone, recFilePath) {
    try {
        const nextNum = await getNextFileNumberStr(TEXT_ARCHIVE_EXT);
        const nowStr = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
        const cleanAns = sanitizeForYemotTts(answerText);
        const cleanQ = sanitizeForYemotTts(questionText);

        const ttsTargetPath = `ivr2:/${TEXT_ARCHIVE_EXT}/${nextNum}.tts`;
        const ttsForm = new FormData();
        ttsForm.append('token', TOKEN);
        ttsForm.append('path', ttsTargetPath);
        ttsForm.append('convertAudio', '0');
        ttsForm.append('file', new Blob([Buffer.from(`שאלה, ${cleanQ}, תשובה, ${cleanAns}`, 'utf8')], { type: 'text/plain; charset=utf-8' }), `${nextNum}.tts`);

        await fetchWithTimeout(`${YM}UploadFile`, { method: 'POST', body: ttsForm }, 12000);

        const txtDetails = `שאלה: ${questionText}\r\nתשובה: ${answerText}\r\nטלפון: ${callerPhone || 'לא ידוע'}\r\nזמן: ${nowStr}\r\nהקלטה: ${recFilePath || ''}\r\n`;
        const txtTargetPath = `ivr2:/${TEXT_ARCHIVE_EXT}/${nextNum}.txt`;
        const txtForm = new FormData();
        txtForm.append('token', TOKEN);
        txtForm.append('path', txtTargetPath);
        txtForm.append('convertAudio', '0');
        txtForm.append('file', new Blob([Buffer.from(txtDetails, 'utf8')], { type: 'text/plain; charset=utf-8' }), `${nextNum}.txt`);

        await fetchWithTimeout(`${YM}UploadFile`, { method: 'POST', body: txtForm }, 12000);
        console.log(`[Archive Ext 8] Saved Q&A to ${ttsTargetPath}`);
    } catch (err) {
        console.warn('[Archive Ext 8] Error:', err.message);
    }
}

app.get('/', (req, res) => {
    res.send('Gemini Live Search Line Server v4.0 OK - Direct Audio Understanding & Live Search');
});

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
    const q = { ...req.query, ...req.body };
    res.type('text/plain; charset=utf-8');

    console.log('[Yemot Request]', JSON.stringify(q));

    try {
        const callId = String(q.ApiCallId || q.ApiPhone || 'default');
        if (q.hangup === 'yes') {
            conversationHistoryByCall.delete(callId);
            return res.send('noop');
        }

        const extFolder = String(q.ApiExtension || '2').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
        const callerPhone = String(q.ApiPhone || '').trim();
        const recFolder = extFolder ? `/${extFolder}` : '';

        const rawRec = q.RecordPath;
        const latestRecordPath = Array.isArray(rawRec) ? rawRec[rawRec.length - 1] : rawRec;

        // שלב 0: תפריט פתיחה בכניסה ראשונה לשלוחה
        if (!q.MenuChoice && !latestRecordPath) {
            return res.send('read=t-לשיחה עם העוזר הקולי הקישו 1 לשמיעת התשובה האחרונה הקישו 2=MenuChoice,no,1,1,7,Digits,no');
        }

        // הקשה על 2: השמעת התשובה האחרונה ומיד לאחריה פתיחת הקלטה לשאלה חדשה
        if (q.MenuChoice === '2' && !latestRecordPath) {
            const prev = (callerPhone && lastAnswerByPhone.get(callerPhone)) || globalLastAnswer;
            const nextRecNum = await getNextFileNumberStr(extFolder);
            if (prev && prev.playCmd) {
                return res.send(`id_list_message=t-משמיע את התשובה הקודמת.${prev.playCmd}&read=t-לשאלה נוספת אמרו כעת את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${nextRecNum},no,7,1`);
            } else {
                return res.send(`id_list_message=t-עדיין לא קיימת תשובה קודמת בקו&read=t-אנא אמרו את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${nextRecNum},no,7,1`);
            }
        }

        // שלב 1: הקלטת השאלה הראשונה
        if (!latestRecordPath) {
            const recNum = await getNextFileNumberStr(extFolder);
            return res.send(`read=t-אנא אמרו את שאלתכם בבירור ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${recNum},no,7,1`);
        }

        // שלב 2: הורדת ההקלטה מימות המשיח
        let audioBuf;
        try {
            audioBuf = await downloadRecordingFromYemot(latestRecordPath, q.ApiExtension);
        } catch (dlErr) {
            console.error('[Step 2 Error]', dlErr.message);
            const retryNum = await getNextFileNumberStr(extFolder);
            return res.send(`id_list_message=t-שגיאה בקליטת ההקלטה&read=t-אנא אמרו שוב את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${retryNum},no,7,1`);
        }

        // שלב 3: פענוח השמע + חיפוש חי בגוגל וקבלת תשובה מדויקת בצעד אחד
        const callHistory = conversationHistoryByCall.get(callId) || [];
        let result;
        try {
            result = await processAudioQuestionWithLiveSearch(audioBuf.toString('base64'), callHistory);
        } catch (gemErr) {
            console.error('[Step 3 Error]', gemErr.message);
            const retryNum = await getNextFileNumberStr(extFolder);
            return res.send(`id_list_message=t-שגיאה בקבלת תשובה מהשרת&read=t-אנא נסו שוב ואמרו את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${retryNum},no,7,1`);
        }

        if (!result || !result.answer) {
            const retryNum = await getNextFileNumberStr(extFolder);
            return res.send(`id_list_message=t-לא הצלחתי לשמוע את השאלה בבירור&read=t-אנא אמרו שוב את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${retryNum},no,7,1`);
        }

        console.log(`[Parsed Question] ${result.question}`);
        console.log(`[Parsed Answer] ${result.answer}`);

        // שמירה בהיסטוריית השיחה הפעילה
        callHistory.push({ q: result.question, a: result.answer });
        conversationHistoryByCall.set(callId, callHistory);

        const playCmd = buildYemotTtsPlayCommand(result.answer);
        const savedInfo = { playCmd, question: result.question, time: Date.now() };
        if (callerPhone) lastAnswerByPhone.set(callerPhone, savedInfo);
        globalLastAnswer = savedInfo;

        // שמירה לארכיון שלוחה 8 ברקע
        saveArchiveToExt8(result.question, result.answer, callerPhone, latestRecordPath);

        // שלב 4: השמעת התשובה המלאה ומיד לאחריה המשך שיחה (הקלטת השאלה הבאה)
        const nextRecNum = await getNextFileNumberStr(extFolder);
        return res.send(`id_list_message=${playCmd}&read=t-לשאלה נוספת אמרו כעת את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${nextRecNum},no,7,1`);

    } catch (e) {
        console.error('[General Error v4.0]', e.message);
        if (!res.headersSent) {
            return res.send('id_list_message=t-אירעה תקלה כללית בשרת&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Gemini Voice Assistant v4.0 Ready on port ${port} ===`));
