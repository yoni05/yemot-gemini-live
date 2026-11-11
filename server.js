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
let globalLastAnswer = null;
const folderCounters = {};

async function fetchWithTimeout(url, options = {}, timeout = 20000) {
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

// 2. איתור מודלים זמינים ב-Gemini
async function getAvailableGeminiModels() {
    const defaultOrder = [
        'gemini-flash-latest',
        'gemini-3.5-flash',
        'gemini-2.5-flash',
        'gemini-flash-lite-latest',
        'gemini-3.5-flash-lite',
        'gemini-2.0-flash'
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

// 3. תמלול מהיר של ההקלטה לעברית
async function transcribeAudio(audioBase64) {
    const models = await getAvailableGeminiModels();
    const ordered = cachedTranscribeModel
        ? [cachedTranscribeModel, ...models.filter(m => m !== cachedTranscribeModel)]
        : models;

    const prompt = 'תמלל את ההקלטה לעברית. החזר אך ורק את המילים שנאמרו בהקלטה ללא שום תוספת, ללא סימני פיסוק וללא הסברים.';

    let lastErr = '';
    for (const model of ordered.slice(0, 4)) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
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
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 80
                    }
                })
            }, 10000);

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
    throw new Error('GEMINI_TRANSCRIBE_ERR: ' + lastErr);
}

// 4. מענה לשאלה עם חיפוש חי באינטרנט (Google Search Grounding)
async function answerQuestionWithLiveSearch(questionText) {
    const models = await getAvailableGeminiModels();
    const searchPreferred = models.filter(m => !m.includes('lite') && !m.includes('transcribe')).concat(models);
    const uniqueModels = [...new Set(cachedSearchModel ? [cachedSearchModel, ...searchPreferred] : searchPreferred)];

    const nowStr = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    const prompt = `הזמן הנוכחי בישראל: ${nowStr}.
שאלת המשתמש: "${questionText}"
ענה על השאלה בעברית ברורה, מדויקת ותמציתית המתאימה להקראה בטלפון (עד 4-5 משפטים).
השתמש בחיפוש גוגל כדי להביא מידע עדכני בזמן אמת במידת הצורך.
חשוב: כתוב טקסט רציף בלבד ללא כוכביות, ללא סולמיות, ללא קישורים וללא תווי עיצוב.`;

    let lastErr = '';

    for (const model of uniqueModels.slice(0, 4)) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;

        const attempts = [
            {
                contents: [{ parts: [{ text: prompt }] }],
                tools: [{ google_search: {} }],
                generationConfig: { temperature: 0.5, maxOutputTokens: 450 }
            },
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.5, maxOutputTokens: 450 }
            }
        ];

        for (const payload of attempts) {
            try {
                const res = await fetchWithTimeout(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }, 15000);

                if (res.ok) {
                    const data = await res.json();
                    const parts = (data?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought && p.text);
                    const answer = parts.map(p => p.text).join(' ').trim();
                    if (answer) {
                        cachedSearchModel = model;
                        console.log(`[Gemini Live Search] Model ${model} answer:`, answer.slice(0, 140));
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

// 5. ניקוי הטקסט והרכבת פקודת השמעה תקנית לימות המשיח (מחולקת למקטעי t- להקראה רציפה ללא חיתוך)
function cleanTextForYemot(rawText) {
    return String(rawText || '')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/[*#_~`>\[\]()"{}|\\^]/g, ' ')
        .replace(/[=&\r\n\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildYemotTtsPlayCommand(rawText) {
    const cleaned = cleanTextForYemot(rawText);
    if (!cleaned) return 't-לא התקבלה תשובה';

    const sentences = cleaned.split(/(?:[\.\!\?\:\;]+|\s+-\s+)/).map(s => s.trim()).filter(Boolean);
    const chunks = [];
    let current = '';

    for (const sentence of sentences) {
        const safeSentence = sentence.replace(/\./g, ' ').trim();
        if (!safeSentence) continue;

        if ((current + ' ' + safeSentence).trim().length <= 160) {
            current = (current ? current + ', ' : '') + safeSentence;
        } else {
            if (current) chunks.push(current);
            if (safeSentence.length <= 160) {
                current = safeSentence;
            } else {
                const words = safeSentence.split(' ');
                current = '';
                for (const w of words) {
                    if ((current + ' ' + w).trim().length <= 160) {
                        current = (current ? current + ' ' : '') + w;
                    } else {
                        if (current) chunks.push(current);
                        current = w;
                    }
                }
            }
        }
    }
    if (current) chunks.push(current);

    return chunks.slice(0, 12).map(c => `t-${c}`).join('.');
}

// 6. שמירת השאלה והתשובה בארכיון שלוחה 8 (ברקע)
async function saveArchiveToExt8(questionText, answerText, callerPhone, recFilePath) {
    try {
        const nextNum = await getNextFileNumberStr(TEXT_ARCHIVE_EXT);
        const nowStr = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
        const cleanAns = cleanTextForYemot(answerText).replace(/\./g, ', ');

        const ttsTargetPath = `ivr2:/${TEXT_ARCHIVE_EXT}/${nextNum}.tts`;
        const ttsForm = new FormData();
        ttsForm.append('token', TOKEN);
        ttsForm.append('path', ttsTargetPath);
        ttsForm.append('convertAudio', '0');
        ttsForm.append('file', new Blob([Buffer.from(`שאלה, ${questionText}. תשובה, ${cleanAns}`, 'utf8')], { type: 'text/plain; charset=utf-8' }), `${nextNum}.tts`);

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
    res.send('Gemini Live Search Line Server v2.0 OK');
});

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
    const q = { ...req.query, ...req.body };
    res.type('text/plain; charset=utf-8');

    console.log('[Yemot Request]', JSON.stringify(q));

    try {
        if (q.hangup === 'yes') return res.send('noop');

        const extFolder = String(q.ApiExtension || '9').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
        const callerPhone = String(q.ApiPhone || '').trim();

        // שלב 0: תפריט פתיחה
        if (!q.MenuChoice && !q.RecordPath) {
            return res.send('read=t-לשאלה חדשה הקישו 1 להאזנה לתשובה הקודמת הקישו 2=MenuChoice,no,1,1,7,Digits,no');
        }

        // הקשה על 2: השמעת התשובה האחרונה
        if (q.MenuChoice === '2' && !q.RecordPath) {
            const prev = (callerPhone && lastAnswerByPhone.get(callerPhone)) || globalLastAnswer;
            if (prev && prev.playCmd) {
                return res.send(`id_list_message=t-משמיע את התשובה הקודמת.${prev.playCmd}&go_to_folder=/`);
            } else {
                const recNum = await getNextFileNumberStr(extFolder);
                const recFolder = extFolder ? `/${extFolder}` : '';
                return res.send(`id_list_message=t-עדיין לא קיימת תשובה קודמת בקו&read=t-אנא אמרו את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${recNum},no,7,1`);
            }
        }

        // שלב 1: הקלטת השאלה
        if (!q.RecordPath) {
            const recNum = await getNextFileNumberStr(extFolder);
            const recFolder = extFolder ? `/${extFolder}` : '';
            return res.send(`read=t-אנא אמרו את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${recNum},no,7,1`);
        }

        // שלב 2: הורדת ההקלטה מימות המשיח
        let audioBuf;
        try {
            audioBuf = await downloadRecordingFromYemot(q.RecordPath, q.ApiExtension);
        } catch (dlErr) {
            console.error('[Step 2 Error]', dlErr.message);
            return res.send('id_list_message=t-שגיאה בהורדת ההקלטה מימות המשיח&go_to_folder=/');
        }

        // שלב 3: זיהוי דיבור ב-Gemini
        let rawQuestion = '';
        try {
            rawQuestion = await transcribeAudio(audioBuf.toString('base64'));
        } catch (gemErr) {
            console.error('[Step 3 Error]', gemErr.message);
            return res.send('id_list_message=t-שגיאה בתקשורת עם מנוע זיהוי הדיבור&go_to_folder=/');
        }

        const cleanQuestion = rawQuestion.replace(/[^א-תa-zA-Z0-9\s\?]/g, ' ').trim().replace(/\s+/g, ' ');
        console.log('[Step 3 Question]', cleanQuestion);

        if (!cleanQuestion) {
            return res.send('id_list_message=t-לא הצלחתי לשמוע את השאלה אנא נסו שנית&go_to_folder=/');
        }

        // שלב 4: שליחת השאלה ל-Gemini עם חיפוש חי באינטרנט
        let rawAnswer = '';
        try {
            rawAnswer = await answerQuestionWithLiveSearch(cleanQuestion);
        } catch (searchErr) {
            console.error('[Step 4 Error]', searchErr.message);
            return res.send('id_list_message=t-שגיאה בחיפוש התשובה אנא נסו שנית&go_to_folder=/');
        }

        const playCmd = buildYemotTtsPlayCommand(rawAnswer);
        const savedInfo = { playCmd, question: cleanQuestion, time: Date.now() };
        if (callerPhone) lastAnswerByPhone.set(callerPhone, savedInfo);
        globalLastAnswer = savedInfo;

        // שמירה לארכיון שלוחה 8 ברקע (ללא עיכוב המענה למתקשר)
        saveArchiveToExt8(cleanQuestion, rawAnswer, callerPhone, q.RecordPath);

        // שלב 5: הקראת התשובה למתקשר
        return res.send(`id_list_message=${playCmd}&go_to_folder=/`);

    } catch (e) {
        console.error('[General Error v2.0]', e.message);
        if (!res.headersSent) {
            return res.send('id_list_message=t-אירעה תקלה כללית בשרת&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Gemini Voice Assistant v2.0 Ready on port ${port} ===`));
