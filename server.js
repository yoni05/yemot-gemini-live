const express = require('express');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const TOKEN = (process.env.YEMOT_TOKEN || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const YM = 'https://www.call2all.co.il/ym/api/';
const TEXT_ARCHIVE_EXT = '8';

let cachedTranscribeModel = null;
let cachedSearchModel = null;
const lastAnswerByPhone = new Map();
const conversationHistoryByCall = new Map();
let globalLastAnswer = null;
const folderCounters = {};

async function fetchWithTimeout(url, options = {}, timeout = 22000) {
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

// 2. איתור מודלים יציבים ומהירים ב-Gemini (מעדיף מודלים שאינם קוטעים טקסט בגלל חשיבה פנימית)
async function getAvailableGeminiModels() {
    const defaultOrder = [
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-flash-latest',
        'gemini-2.5-flash-lite',
        'gemini-flash-lite-latest'
    ];
    try {
        const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`, {}, 6000);
        if (res.ok) {
            const data = await res.json();
            const available = (data.models || [])
                .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                .map(m => m.name.replace('models/', ''))
                .filter(m => !m.includes('1.5') && !m.includes('tts') && !m.includes('image') && !m.includes('robotics') && !m.includes('research') && !m.includes('computer-use') && !m.includes('embedding'));

            const matched = [];
            for (const pref of defaultOrder) {
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
    return defaultOrder;
}

// 3. תמלול מלא ומדויק של ההקלטה לעברית (ללא חיתוך טוקנים!)
async function transcribeAudio(audioBase64) {
    const models = await getAvailableGeminiModels();
    const ordered = cachedTranscribeModel
        ? [cachedTranscribeModel, ...models.filter(m => m !== cachedTranscribeModel)]
        : models;

    const prompt = 'תמלל את ההקלטה לעברית בצורה מלאה ומדויקת מילה במילה. החזר אך ורק את המשפט שנאמר בהקלטה ללא שום תוספת וללא הסברים.';

    let lastErr = '';
    for (const model of ordered.slice(0, 4)) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;

        const configsToTry = [
            {
                temperature: 0.1,
                maxOutputTokens: 1024,
                thinkingConfig: { thinkingBudget: 0 }
            },
            {
                temperature: 0.1,
                maxOutputTokens: 1024
            }
        ];

        for (const genCfg of configsToTry) {
            try {
                const res = await fetchWithTimeout(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { text: prompt },
                                { inlineData: { mimeType: 'audio/wav', data: audioBase64 } }
                            ]
                        }],
                        generationConfig: genCfg
                    })
                }, 12000);

                if (res.ok) {
                    const data = await res.json();
                    const parts = (data?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought && p.text);
                    const text = parts.map(p => p.text).join(' ').trim();
                    if (text) {
                        cachedTranscribeModel = model;
                        console.log(`[Gemini Transcribe] Model ${model} success:`, JSON.stringify(text));
                        return text;
                    }
                } else {
                    lastErr = await res.text();
                }
            } catch (err) {
                lastErr = err.message;
            }
        }
    }
    throw new Error('GEMINI_TRANSCRIBE_ERR: ' + lastErr);
}

// 4. מענה מלא לשאלה עם חיפוש חי באינטרנט וזיכרון של השיחה הנוכחית
async function answerQuestionWithLiveSearch(questionText, callHistory = []) {
    const models = await getAvailableGeminiModels();
    const searchPreferred = models.filter(m => !m.includes('lite') && !m.includes('transcribe')).concat(models);
    const uniqueModels = [...new Set(cachedSearchModel ? [cachedSearchModel, ...searchPreferred] : searchPreferred)];

    const nowStr = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    let historyContext = '';
    if (callHistory.length > 0) {
        const recent = callHistory.slice(-4).map(h => `משתמש: ${h.q}\nעוזר: ${h.a}`).join('\n');
        historyContext = `\nהיסטוריית השיחה הקודמת עם המשתמש (לצורך הקשר אם זו שאלת המשך):\n${recent}\n`;
    }

    const prompt = `אתה עוזר קולי חכם במערכת טלפונית. הזמן הנוכחי בישראל: ${nowStr}.${historyContext}
שאלת המשתמש הנוכחית: "${questionText}"

הנחיות חשובות:
1. אם השאלה דורשת מידע עדכני מהאינטרנט (חדשות, מזג אוויר, זמנים, עובדות וכו'), השתמש בחיפוש גוגל והבא תשובה מלאה ומדויקת.
2. ענה בעברית ברורה, שלמה וטבעית להקראה בטלפון (בין 2 ל-6 משפטים שלמים). אל תקטע משפטים באמצע.
3. אל תשתמש כלל בכוכביות, סולמיות, מספור, קישורים או תווי עיצוב, אלא אך ורק בטקסט רגיל ונקי.`;

    let lastErr = '';

    for (const model of uniqueModels.slice(0, 4)) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;

        const attempts = [
            // ניסיון 1: עם חיפוש גוגל + כיבוי חשיבה פנימית כדי שכל הטוקנים ילכו לתשובה מלאה ומהירה
            {
                contents: [{ parts: [{ text: prompt }] }],
                tools: [{ google_search: {} }],
                generationConfig: {
                    temperature: 0.5,
                    maxOutputTokens: 4096,
                    thinkingConfig: { thinkingBudget: 0 }
                }
            },
            // ניסיון 2: עם חיפוש גוגל ו-4096 טוקנים (עבור מודלים שאינם מקבלים thinkingBudget: 0)
            {
                contents: [{ parts: [{ text: prompt }] }],
                tools: [{ google_search: {} }],
                generationConfig: {
                    temperature: 0.5,
                    maxOutputTokens: 4096
                }
            },
            // ניסיון 3: גיבוי ללא כלי חיפוש אם המודל הספציפי אינו תומך ב-google_search
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.5,
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
                }, 18000);

                if (res.ok) {
                    const data = await res.json();
                    const parts = (data?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought && p.text);
                    const answer = parts.map(p => p.text).join(' ').trim();
                    if (answer && answer.length > 2) {
                        cachedSearchModel = model;
                        console.log(`[Gemini Live Search] Model ${model} full answer (${answer.length} chars):`, answer);
                        return answer;
                    }
                } else {
                    lastErr = await res.text();
                }
            } catch (err) {
                lastErr = err.message;
            }
        }
    }
    throw new Error('GEMINI_SEARCH_ERR: ' + lastErr);
}

// 5. ניקוי הטקסט כדי שלא יקטע את פקודת ההקראה של ימות המשיח
function sanitizeForYemotTts(rawText) {
    return String(rawText || '')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/[*#_~`>\[\]()"{}|\\^]/g, ' ')
        .replace(/[=&\r\n\t]/g, ' ')
        .replace(/\./g, ', ') // נקודה בימות המשיח מחלקת להודעות נפרדות, לכן נחליף בפסיק להקראה רציפה
        .replace(/\s+/g, ' ')
        .trim();
}

function buildYemotTtsPlayCommand(rawText) {
    const clean = sanitizeForYemotTts(rawText);
    if (!clean) return 't-לא התקבלה תשובה';

    // פיצול למקטעים של עד 220 תווים כדי להבטיח שימות המשיח יקריאו תשובות ארוכות במלואן
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

// 6. שמירת השאלה והתשובה בארכיון שלוחה 8 (ברקע)
async function saveArchiveToExt8(questionText, answerText, callerPhone, recFilePath) {
    try {
        const nextNum = await getNextFileNumberStr(TEXT_ARCHIVE_EXT);
        const nowStr = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
        const cleanAns = sanitizeForYemotTts(answerText);

        const ttsTargetPath = `ivr2:/${TEXT_ARCHIVE_EXT}/${nextNum}.tts`;
        const ttsForm = new FormData();
        ttsForm.append('token', TOKEN);
        ttsForm.append('path', ttsTargetPath);
        ttsForm.append('convertAudio', '0');
        ttsForm.append('file', new Blob([Buffer.from(`שאלה, ${questionText}, תשובה, ${cleanAns}`, 'utf8')], { type: 'text/plain; charset=utf-8' }), `${nextNum}.tts`);

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
    res.send('Gemini Live Search Line Server v3.0 OK - Full Answers & Continuous Conversation');
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

        // קבלת קובץ ההקלטה העדכני ביותר (בימות המשיח כשמקליטים ברצף באותה שיחה מתקבל לעיתים מערך של הקלטות)
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
            return res.send(`read=t-אנא אמרו את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${recNum},no,7,1`);
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

        // שלב 3: זיהוי דיבור מלא ב-Gemini
        let rawQuestion = '';
        try {
            rawQuestion = await transcribeAudio(audioBuf.toString('base64'));
        } catch (gemErr) {
            console.error('[Step 3 Error]', gemErr.message);
            const retryNum = await getNextFileNumberStr(extFolder);
            return res.send(`id_list_message=t-שגיאה בתקשורת עם מנוע זיהוי הדיבור&read=t-אנא נסו שוב ואמרו את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${retryNum},no,7,1`);
        }

        const cleanQuestion = rawQuestion.replace(/[^א-תa-zA-Z0-9\s\?]/g, ' ').trim().replace(/\s+/g, ' ');
        console.log('[Step 3 Question]', cleanQuestion);

        if (!cleanQuestion) {
            const retryNum = await getNextFileNumberStr(extFolder);
            return res.send(`id_list_message=t-לא הצלחתי לשמוע את השאלה&read=t-אנא אמרו שוב את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${retryNum},no,7,1`);
        }

        // שלב 4: מענה מלא מ-Gemini עם חיפוש חי באינטרנט + שמירת הקשר השיחה
        const callHistory = conversationHistoryByCall.get(callId) || [];
        let rawAnswer = '';
        try {
            rawAnswer = await answerQuestionWithLiveSearch(cleanQuestion, callHistory);
        } catch (searchErr) {
            console.error('[Step 4 Error]', searchErr.message);
            const retryNum = await getNextFileNumberStr(extFolder);
            return res.send(`id_list_message=t-שגיאה בחיפוש התשובה&read=t-אנא אמרו שוב את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${retryNum},no,7,1`);
        }

        // עדכון היסטוריית השיחה הפעילה
        callHistory.push({ q: cleanQuestion, a: rawAnswer });
        conversationHistoryByCall.set(callId, callHistory);

        const playCmd = buildYemotTtsPlayCommand(rawAnswer);
        const savedInfo = { playCmd, question: cleanQuestion, time: Date.now() };
        if (callerPhone) lastAnswerByPhone.set(callerPhone, savedInfo);
        globalLastAnswer = savedInfo;

        // שמירה לארכיון שלוחה 8 ברקע
        saveArchiveToExt8(cleanQuestion, rawAnswer, callerPhone, latestRecordPath);

        // שלב 5: השמעת התשובה המלאה ומיד לאחריה פתיחת הקלטה לשאלה הבאה באותה שיחה (ללא חזרה לתפריט הראשי!)
        const nextRecNum = await getNextFileNumberStr(extFolder);
        return res.send(`id_list_message=${playCmd}&read=t-לשאלה נוספת אמרו כעת את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${nextRecNum},no,7,1`);

    } catch (e) {
        console.error('[General Error v3.0]', e.message);
        if (!res.headersSent) {
            return res.send('id_list_message=t-אירעה תקלה כללית בשרת&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Gemini Voice Assistant v3.0 Ready on port ${port} ===`));
