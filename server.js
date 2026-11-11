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

async function downloadRecordingFromYemot(recordPath, apiDir) {
    const cleanPath = String(recordPath).replace(/^ivr2:\/*/, '').replace(/^\/*/, '');
    const cleanDir = String(apiDir || '').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');

    const candidates = [`ivr2:/${cleanPath}`, `ivr2:${cleanPath}`];
    if (cleanDir && !cleanPath.startsWith(cleanDir + '/')) candidates.unshift(`ivr2:/${cleanDir}/${cleanPath}`);
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
                return buf;
            } else {
                lastYemotResponse = headStr;
            }
        } catch (e) { lastYemotResponse = e.message; }
    }
    throw new Error('YEMOT_DOWNLOAD_ERR: ' + lastYemotResponse);
}

async function getAvailableGeminiModels() {
    const defaultOrder = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];
    try {
        const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`, {}, 6000);
        if (res.ok) {
            const data = await res.json();
            const available = (data.models || [])
                .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                .map(m => m.name.replace('models/', ''))
                .filter(m => !m.includes('1.5') && !m.includes('tts') && !m.includes('image') && !m.includes('embedding'));
            const matched = [];
            for (const pref of defaultOrder) if (available.includes(pref)) matched.push(pref);
            for (const m of available) if (m.includes('flash') && !matched.includes(m)) matched.push(m);
            if (matched.length > 0) return matched;
        }
    } catch (e) {}
    return defaultOrder;
}

async function transcribeAudio(audioBase64) {
    const models = await getAvailableGeminiModels();
    const ordered = cachedTranscribeModel ? [cachedTranscribeModel, ...models.filter(m => m !== cachedTranscribeModel)] : models;
    const prompt = 'תמלל את ההקלטה לעברית בצורה מדויקת מילה במילה. החזר אך ורק את המשפט שנאמר ללא שום תוספת. אם שומעים רק רעש או שקט, החזר רווח ריק.';

    let lastErr = '';
    for (const model of ordered.slice(0, 4)) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
        try {
            const res = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'audio/wav', data: audioBase64 } }] }],
                    generationConfig: { temperature: 0.1, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } }
                })
            }, 12000);
            if (res.ok) {
                const data = await res.json();
                const parts = (data?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought && p.text);
                const text = parts.map(p => p.text).join(' ').trim();
                cachedTranscribeModel = model;
                return text;
            } else { lastErr = await res.text(); }
        } catch (err) {
            // fallback to config without thinkingBudget if model rejects it
            try {
                const res2 = await fetchWithTimeout(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'audio/wav', data: audioBase64 } }] }],
                        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
                    })
                }, 12000);
                if (res2.ok) {
                    const data = await res2.json();
                    const parts = (data?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought && p.text);
                    return parts.map(p => p.text).join(' ').trim();
                }
            } catch(e) { lastErr = e.message; }
        }
    }
    throw new Error('GEMINI_TRANSCRIBE_ERR: ' + lastErr);
}

async function answerQuestionWithLiveSearch(questionText, callHistory = []) {
    const models = await getAvailableGeminiModels();
    const uniqueModels = [...new Set(cachedSearchModel ? [cachedSearchModel, ...models] : models)];
    const nowStr = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    
    let historyContext = '';
    if (callHistory.length > 0) {
        const recent = callHistory.slice(-3).map(h => `משתמש: ${h.q}\nעוזר: ${h.a}`).join('\n');
        historyContext = `\nהיסטוריית השיחה:\n${recent}\n`;
    }

    const prompt = `אתה עוזר קולי חכם. הזמן: ${nowStr}.${historyContext}
שאלה נוכחית: "${questionText}"

הנחיות קריטיות:
1. בקרת איכות: אם השאלה מכילה רק אותיות בודדות, מילים קטועות, או שאינה ברורה כלל, ענה אך ורק: "לא הצלחתי להבין את השאלה במדויק, אנא נסו לחזור עליה שוב." אל תנחש ואל תמציא מידע!
2. דיוק: היצמד לעובדות. אם המידע דורש אימות, חפש באינטרנט. אל תמציא עובדות שאינך בטוח בהן.
3. מבנה: ענה ב-2 עד 5 משפטים ברורים להקראה קולית. ללא כוכביות, ללא קישורים.`;

    let lastErr = '';
    for (const model of uniqueModels.slice(0, 4)) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
        const attempts = [
            { contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.1, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } } },
            { contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.1, maxOutputTokens: 2048 } },
            { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 2048 } }
        ];

        for (const payload of attempts) {
            try {
                const res = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 15000);
                if (res.ok) {
                    const data = await res.json();
                    const parts = (data?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought && p.text);
                    const answer = parts.map(p => p.text).join(' ').trim();
                    if (answer && answer.length > 2) {
                        cachedSearchModel = model;
                        return answer;
                    }
                } else { lastErr = await res.text(); }
            } catch (err) { lastErr = err.message; }
        }
    }
    throw new Error('GEMINI_SEARCH_ERR: ' + lastErr);
}

function sanitizeForYemotTts(rawText) {
    return String(rawText || '').replace(/https?:\/\/\S+/gi, ' ').replace(/[*#_~`>\[\]()"{}|\\^]/g, ' ').replace(/[=&\r\n\t]/g, ' ').replace(/\./g, ', ').replace(/\s+/g, ' ').trim();
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
    } catch (err) { console.warn('[Archive Ext 8] Error:', err.message); }
}

app.get('/', (req, res) => res.send('Gemini Live Search Line Server v3.1 OK - High Accuracy'));

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
    const q = { ...req.query, ...req.body };
    res.type('text/plain; charset=utf-8');

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

        if (!q.MenuChoice && !latestRecordPath) {
            return res.send('read=t-לשיחה עם העוזר הקולי הקישו 1 לשמיעת התשובה האחרונה הקישו 2=MenuChoice,no,1,1,7,Digits,no');
        }

        if (q.MenuChoice === '2' && !latestRecordPath) {
            const prev = (callerPhone && lastAnswerByPhone.get(callerPhone)) || globalLastAnswer;
            const nextRecNum = await getNextFileNumberStr(extFolder);
            if (prev && prev.playCmd) {
                return res.send(`id_list_message=t-משמיע את התשובה הקודמת.${prev.playCmd}&read=t-לשאלה נוספת אמרו כעת את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${nextRecNum},no,7,1`);
            } else {
                return res.send(`id_list_message=t-עדיין לא קיימת תשובה קודמת בקו&read=t-אנא אמרו את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${nextRecNum},no,7,1`);
            }
        }

        if (!latestRecordPath) {
            const recNum = await getNextFileNumberStr(extFolder);
            return res.send(`read=t-אנא אמרו את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${recNum},no,7,1`);
        }

        let audioBuf;
        try { audioBuf = await downloadRecordingFromYemot(latestRecordPath, q.ApiExtension); } 
        catch (dlErr) {
            const retryNum = await getNextFileNumberStr(extFolder);
            return res.send(`id_list_message=t-שגיאה בקליטת ההקלטה&read=t-אנא אמרו שוב את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${retryNum},no,7,1`);
        }

        let rawQuestion = '';
        try { rawQuestion = await transcribeAudio(audioBuf.toString('base64')); } 
        catch (gemErr) {
            const retryNum = await getNextFileNumberStr(extFolder);
            return res.send(`id_list_message=t-שגיאה בתקשורת עם מנוע הזיהוי&read=t-אנא נסו שוב ואמרו את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${retryNum},no,7,1`);
        }

        const cleanQuestion = rawQuestion.replace(/[^א-תa-zA-Z0-9\s\?]/g, ' ').trim().replace(/\s+/g, ' ');
        if (!cleanQuestion || cleanQuestion.length < 2) {
            const retryNum = await getNextFileNumberStr(extFolder);
            return res.send(`id_list_message=t-לא הצלחתי להבין את השאלה במדויק&read=t-אנא אמרו שוב את שאלתכם באופן ברור ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${retryNum},no,7,1`);
        }

        const callHistory = conversationHistoryByCall.get(callId) || [];
        let rawAnswer = '';
        try { rawAnswer = await answerQuestionWithLiveSearch(cleanQuestion, callHistory); } 
        catch (searchErr) {
            const retryNum = await getNextFileNumberStr(extFolder);
            return res.send(`id_list_message=t-שגיאה בחיפוש התשובה&read=t-אנא אמרו שוב את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${retryNum},no,7,1`);
        }

        callHistory.push({ q: cleanQuestion, a: rawAnswer });
        conversationHistoryByCall.set(callId, callHistory);

        const playCmd = buildYemotTtsPlayCommand(rawAnswer);
        const savedInfo = { playCmd, question: cleanQuestion, time: Date.now() };
        if (callerPhone) lastAnswerByPhone.set(callerPhone, savedInfo);
        globalLastAnswer = savedInfo;
        saveArchiveToExt8(cleanQuestion, rawAnswer, callerPhone, latestRecordPath);

        const nextRecNum = await getNextFileNumberStr(extFolder);
        return res.send(`id_list_message=${playCmd}&read=t-לשאלה נוספת אמרו כעת את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${nextRecNum},no,7,1`);

    } catch (e) {
        if (!res.headersSent) return res.send('id_list_message=t-אירעה תקלה כללית בשרת&go_to_folder=/');
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Gemini Voice Assistant v3.1 Ready on port ${port} ===`));
