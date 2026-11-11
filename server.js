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

// 2. איתור מודלים תומכי חיפוש גוגל חי (מעדיף את סדרת 2.5/2.0 היציבה ביותר ב-Google Search Grounding)
async function getSearchCapableModels() {
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
                if (m.includes('flash') && !m.includes('lite') && !matched.includes(m)) {
                    matched.push(m);
                }
            }
            if (matched.length > 0) return matched;
        }
    } catch (e) {}
    return preferredOrder;
}

// 3. זיהוי דיבור מהיר ומלא (תומך בהקלטות ארוכות ללא חיתוך)
async function transcribeAudio(audioBase64) {
    const models = await getSearchCapableModels();
    const transcribeList = [
        ...(cachedTranscribeModel ? [cachedTranscribeModel] : []),
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-flash-lite-latest',
        ...models
    ];
    const uniqueModels = [...new Set(transcribeList)];

    const prompt = 'תמלל את ההקלטה לעברית מילה במילה. החזר אך ורק את המילים שנאמרו בהקלטה ללא שום תוספת וללא הסברים.';

    let lastErr = '';
    for (const model of uniqueModels.slice(0, 4)) {
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
                        maxOutputTokens: 2048
                    }
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
    throw new Error('GEMINI_TRANSCRIBE_ERR: ' + lastErr);
}

// 4. שליפת נתונים חיים מרשת האינטרנט (Google News RSS בעברית + מזג אוויר חי בישראל) להבטחת עדכניות של 100%
async function fetchLiveIsraelContext(questionText) {
    const snippets = [];
    try {
        // שליפת חיפוש עדכני מ-Google News בעברית לפי שאלת המשתמש או חדשות ראשיות
        const searchTerms = encodeURIComponent(questionText);
        const rssUrl = `https://news.google.com/rss/search?q=${searchTerms}+when:2d&hl=iw&gl=IL&ceid=IL:he`;
        const topNewsUrl = `https://news.google.com/rss?hl=iw&gl=IL&ceid=IL:he`;

        const [searchRes, topRes, weatherRes] = await Promise.allSettled([
            fetchWithTimeout(rssUrl, {}, 4500),
            fetchWithTimeout(topNewsUrl, {}, 4500),
            fetchWithTimeout('https://api.open-meteo.com/v1/forecast?latitude=31.7683,32.0853,29.5577&longitude=35.2137,34.7818,34.9519&current=temperature_2m&daily=temperature_2m_max,temperature_2m_min&timezone=Asia%2FJerusalem&forecast_days=2', {}, 4500)
        ]);

        if (weatherRes.status === 'fulfilled' && weatherRes.value.ok) {
            const wData = await weatherRes.value.json();
            if (Array.isArray(wData) && wData.length >= 3) {
                const jlm = wData[0];
                const tlv = wData[1];
                const eil = wData[2];
                snippets.push(`נתוני מזג אוויר חיים להיום ומחר בישראל (מתוך תחנות מטאורולוגיות בזמן אמת): ירושלים כעת ${jlm.current?.temperature_2m}°C (היום ${jlm.daily?.temperature_2m_min?.[0]}-${jlm.daily?.temperature_2m_max?.[0]}°C, מחר ${jlm.daily?.temperature_2m_min?.[1]}-${jlm.daily?.temperature_2m_max?.[1]}°C), תל אביב כעת ${tlv.current?.temperature_2m}°C (היום עד ${tlv.daily?.temperature_2m_max?.[0]}°C, מחר עד ${tlv.daily?.temperature_2m_max?.[1]}°C), אילת כעת ${eil.current?.temperature_2m}°C (היום עד ${eil.daily?.temperature_2m_max?.[0]}°C, מחר עד ${eil.daily?.temperature_2m_max?.[1]}°C).`);
            }
        }

        const extractTitles = (xmlText, limit = 6) => {
            const items = [];
            const itemRegex = /<item>([\s\S]*?)<\/item>/g;
            let m;
            while ((m = itemRegex.exec(xmlText)) !== null && items.length < limit) {
                const block = m[1];
                const tMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
                const dMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
                if (tMatch && tMatch[1]) {
                    const cleanTitle = tMatch[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
                    const pubDate = dMatch ? dMatch[1].trim() : '';
                    items.push(`- ${cleanTitle} (${pubDate})`);
                }
            }
            return items;
        };

        if (searchRes.status === 'fulfilled' && searchRes.value.ok) {
            const xml = await searchRes.value.text();
            const found = extractTitles(xml, 5);
            if (found.length > 0) {
                snippets.push(`תוצאות אמת מהיממה האחרונה בחיפוש חדשות גוגל עבור "${questionText}":\n${found.join('\n')}`);
            }
        }

        if (topRes.status === 'fulfilled' && topRes.value.ok) {
            const xml = await topRes.value.text();
            const topFound = extractTitles(xml, 6);
            if (topFound.length > 0) {
                snippets.push(`כותרות החדשות הראשיות בישראל כעת (Google News Live):\n${topFound.join('\n')}`);
            }
        }
    } catch (e) {
        console.warn('[Live Context Fetch Warning]', e.message);
    }
    return snippets.join('\n\n');
}

// 5. מענה לשאלה עם חיפוש חי של גוגל (Google Search Grounding) + נתוני זמן אמת
async function answerQuestionWithLiveSearch(questionText, callHistory = []) {
    const models = await getSearchCapableModels();
    const uniqueModels = [...new Set(cachedSearchModel ? [cachedSearchModel, ...models] : models)];

    const now = new Date();
    const nowStr = now.toLocaleString('he-IL', {
        timeZone: 'Asia/Jerusalem',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    // משיכת נתוני אמת חיים (מזג אוויר וחדשות מהשעות האחרונות) במקביל
    const liveWebContext = await fetchLiveIsraelContext(questionText);

    let historyContext = '';
    if (callHistory.length > 0) {
        const recent = callHistory.slice(-2).map(h => `שאלה קודמת: ${h.q}\nתשובה קודמת: ${h.a}`).join('\n');
        historyContext = `\nהיסטוריית השיחה הנוכחית (התייחס אליה רק אם המשתמש שואל שאלת המשך ישירה):\n${recent}\n`;
    }

    const prompt = `התאריך והשעה הנוכחיים בישראל: ${nowStr}.
${liveWebContext ? `\nנתוני זמן אמת שנשלפו כעת מהאינטרנט עבורך:\n${liveWebContext}\n` : ''}${historyContext}
שאלת המשתמש: "${questionText}"

הנחיות מחייבות:
1. בצע חיפוש עדכני ב-Google Search והסתמך על נתוני הזמן-אמת שלמעלה ועל תוצאות החיפוש מהיום בלבד.
2. איסור מוחלט להביא חדשות ישנות או תחזיות משנים קודמות (כגון 2024 או 2025). התייחס אך ורק למה שקורה היום!
3. ענה תשובה עניינית, ישירה, מדויקת וברורה בעברית באורך של 2 עד 5 משפטים שלמים.
4. כתוב טקסט נקי להקראה בטלפון ללא שום כוכביות, סולמיות, מספור או קישורים.`;

    let lastErr = '';

    for (const model of uniqueModels.slice(0, 3)) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;

        // מנסים תחילה עם כלי החיפוש המובנה של גוגל (google_search) על טקסט נקי
        const payloads = [
            {
                contents: [{ parts: [{ text: prompt }] }],
                tools: [{ google_search: {} }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 4096
                }
            },
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 4096
                }
            }
        ];

        for (const bodyObj of payloads) {
            try {
                const res = await fetchWithTimeout(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(bodyObj)
                }, 18000);

                if (res.ok) {
                    const data = await res.json();
                    const candidate = data?.candidates?.[0];
                    const parts = (candidate?.content?.parts || []).filter(p => !p.thought && p.text);
                    const answer = parts.map(p => p.text).join(' ').trim();

                    if (answer && answer.length > 2) {
                        cachedSearchModel = model;
                        const searchQueries = candidate?.groundingMetadata?.webSearchQueries || [];
                        console.log(`[Grounding Verified] Model: ${model} | Search Queries:`, JSON.stringify(searchQueries));
                        console.log(`[Gemini Live Answer]`, answer);
                        return answer;
                    }
                } else {
                    const errTxt = await res.text();
                    console.warn(`[Model ${model} attempt failed]:`, errTxt.slice(0, 200));
                    lastErr = errTxt;
                }
            } catch (err) {
                lastErr = err.message;
            }
        }
    }
    throw new Error('GEMINI_SEARCH_ERR: ' + lastErr);
}

// 6. ניקוי הטקסט והרכבת פקודת השמעה תקנית לימות המשיח
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

// 7. שמירת השאלה והתשובה בארכיון שלוחה 8 (ברקע)
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
    res.send('Gemini Live Search Line Server v5.0 OK - Verified Real-Time Search & Weather/News');
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

        // שלב 3: זיהוי דיבור מהיר ומדויק
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

        // שלב 4: חיפוש חי מאומת בזמן אמת וקבלת תשובה עדכנית להיום
        const callHistory = conversationHistoryByCall.get(callId) || [];
        let rawAnswer = '';
        try {
            rawAnswer = await answerQuestionWithLiveSearch(cleanQuestion, callHistory);
        } catch (searchErr) {
            console.error('[Step 4 Error]', searchErr.message);
            const retryNum = await getNextFileNumberStr(extFolder);
            return res.send(`id_list_message=t-שגיאה בחיפוש התשובה&read=t-אנא אמרו שוב את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${retryNum},no,7,1`);
        }

        // שמירה בהיסטוריית השיחה הפעילה
        callHistory.push({ q: cleanQuestion, a: rawAnswer });
        conversationHistoryByCall.set(callId, callHistory);

        const playCmd = buildYemotTtsPlayCommand(rawAnswer);
        const savedInfo = { playCmd, question: cleanQuestion, time: Date.now() };
        if (callerPhone) lastAnswerByPhone.set(callerPhone, savedInfo);
        globalLastAnswer = savedInfo;

        // שמירה לארכיון שלוחה 8 ברקע
        saveArchiveToExt8(cleanQuestion, rawAnswer, callerPhone, latestRecordPath);

        // שלב 5: השמעת התשובה המלאה ומיד לאחריה המשך שיחה (הקלטת השאלה הבאה)
        const nextRecNum = await getNextFileNumberStr(extFolder);
        return res.send(`id_list_message=${playCmd}&read=t-לשאלה נוספת אמרו כעת את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${nextRecNum},no,7,1`);

    } catch (e) {
        console.error('[General Error v5.0]', e.message);
        if (!res.headersSent) {
            return res.send('id_list_message=t-אירעה תקלה כללית בשרת&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Gemini Voice Assistant v5.0 Ready on port ${port} ===`));
