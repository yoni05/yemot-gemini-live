const express = require('express');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const TOKEN = (process.env.YEMOT_TOKEN || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const YM = 'https://www.call2all.co.il/ym/api/';
const TEXT_ARCHIVE_EXT = '8';

let cachedModelList = null;
let lastModelFetchTime = 0;
const lastAnswerByPhone = new Map();
const conversationHistoryByCall = new Map();
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

// 2. איתור מודלים זמינים בעלי מכסה גבוהה (מסנן אוטומטית את 2.5 ו-1.5 שנסגרו למשתמשים חדשים ומחזירים 404)
async function getHighQuotaGeminiModels() {
    const defaultFastOrder = [
        'gemini-flash-lite-latest',
        'gemini-3.5-flash-lite',
        'gemini-3.5-flash',
        'gemini-3.8-flash',
        'gemini-flash-latest'
    ];

    if (cachedModelList && (Date.now() - lastModelFetchTime < 300000)) {
        return cachedModelList;
    }

    try {
        const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`, {}, 6000);
        if (res.ok) {
            const data = await res.json();
            const available = (data.models || [])
                .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                .map(m => m.name.replace('models/', ''))
                .filter(m =>
                    !m.includes('2.5') &&
                    !m.includes('2.0') &&
                    !m.includes('1.5') &&
                    !m.includes('tts') &&
                    !m.includes('image') &&
                    !m.includes('robotics') &&
                    !m.includes('research') &&
                    !m.includes('computer-use') &&
                    !m.includes('embedding') &&
                    !m.includes('pro')
                );

            const matched = [];
            for (const pref of defaultFastOrder) {
                if (available.includes(pref)) matched.push(pref);
            }
            for (const m of available) {
                if ((m.includes('flash') || m.includes('lite')) && !matched.includes(m)) {
                    matched.push(m);
                }
            }
            if (matched.length > 0) {
                cachedModelList = matched;
                lastModelFetchTime = Date.now();
                console.log('[Available High-Quota Models]:', JSON.stringify(matched));
                return matched;
            }
        }
    } catch (e) {}
    return defaultFastOrder;
}

// 3. תמלול מהיר ומדויק של השאלה (ללא חיתוך)
async function transcribeAudio(audioBase64) {
    const modelsToTry = await getHighQuotaGeminiModels();
    const prompt = 'תמלל את ההקלטה לעברית מילה במילה. החזר אך ורק את המילים שנאמרו בהקלטה ללא שום תוספת, ללא סימני פיסוק וללא הסברים.';

    let lastErr = '';
    for (const model of modelsToTry.slice(0, 5)) {
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
                        maxOutputTokens: 1024
                    }
                })
            }, 12000);

            if (res.ok) {
                const data = await res.json();
                const parts = (data?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought && p.text);
                const text = parts.map(p => p.text).join(' ').trim();
                if (text) {
                    console.log(`[Gemini Transcribe] Model ${model} success:`, JSON.stringify(text));
                    return text;
                }
            } else {
                lastErr = await res.text();
                console.warn(`[Transcribe ${model} failed ${res.status}]:`, lastErr.slice(0, 140));
            }
        } catch (err) {
            lastErr = err.message;
        }
    }
    throw new Error('GEMINI_TRANSCRIBE_ERR: ' + lastErr);
}

// 4. חיפוש חי בזמן אמת ישירות מהשרת (חיפוש אינטרנט, יוטיוב, חדשות ומזג אוויר - ללא צורך במכסת Google Search Grounding!)
function stripHtmlTags(str) {
    return String(str || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

async function searchYouTubeLatestVideos(queryText) {
    try {
        const cleanQ = queryText
            .replace(/תחפש לי|חפש לי|באינטרנט|ביוטיוב|מה השם של|מהו|תגיד לי/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || queryText;

        // שליפת דף תוצאות ממוין לפי תאריך העלאה או רלוונטיות מיוטיוב
        const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQ)}&sp=CAI%253D`;
        const ytRelevanceUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQ)}`;

        const [dateRes, relRes] = await Promise.allSettled([
            fetchWithTimeout(ytUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'he-IL,he;q=0.9' } }, 5000),
            fetchWithTimeout(ytRelevanceUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'he-IL,he;q=0.9' } }, 5000)
        ]);

        const extractYtVideos = (html) => {
            const list = [];
            const regex = /"videoRenderer":\{"videoId":"[^"]+","thumbnail":\{.*?\},"title":\{"runs":\[\{"text":"([^"]+)"\}\].*?"publishedTimeText":\{"simpleText":"([^"]+)"\}/g;
            let m;
            while ((m = regex.exec(html)) !== null && list.length < 5) {
                list.push(`- "${m[1]}" (זמן העלאה: ${m[2]})`);
            }
            return list;
        };

        const combined = [];
        if (dateRes.status === 'fulfilled' && dateRes.value.ok) {
            const html = await dateRes.value.text();
            combined.push(...extractYtVideos(html));
        }
        if (relRes.status === 'fulfilled' && relRes.value.ok) {
            const html = await relRes.value.text();
            combined.push(...extractYtVideos(html));
        }

        const unique = [...new Set(combined)].slice(0, 6);
        if (unique.length > 0) {
            return `תוצאות חיות מיוטיוב עבור "${cleanQ}":\n${unique.join('\n')}`;
        }
    } catch (e) {
        console.warn('[YouTube Live Search Warning]:', e.message);
    }
    return '';
}

async function searchDuckDuckGoWeb(queryText) {
    try {
        const cleanQ = queryText
            .replace(/תחפש לי|חפש לי|באינטרנט|תגיד לי|מהו|מהי/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || queryText;

        const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQ)}&kl=il-he`;
        const res = await fetchWithTimeout(ddgUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'he-IL,he;q=0.9'
            }
        }, 5000);

        if (res.ok) {
            const html = await res.text();
            const results = [];
            const snippetRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
            const titleRegex = /<a rel="nofollow" class="result__a"[^>]*>([\s\S]*?)<\/a>/g;

            const titles = [];
            let tm;
            while ((tm = titleRegex.exec(html)) !== null && titles.length < 6) {
                titles.push(stripHtmlTags(tm[1]));
            }

            let sm;
            let idx = 0;
            while ((sm = snippetRegex.exec(html)) !== null && results.length < 5) {
                const snippet = stripHtmlTags(sm[1]);
                const title = titles[idx] || '';
                if (snippet) {
                    results.push(`- ${title}: ${snippet}`);
                }
                idx++;
            }

            if (results.length > 0) {
                return `תוצאות חיפוש אינטרנט חי עבור "${cleanQ}":\n${results.join('\n')}`;
            }
        }
    } catch (e) {
        console.warn('[Web Search Warning]:', e.message);
    }
    return '';
}

async function fetchLiveWebAndNewsContext(questionText) {
    const snippets = [];
    try {
        const cleanSearchQ = questionText
            .replace(/תחפש לי|חפש לי|באינטרנט|תגיד לי/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || questionText;

        const rssSearchUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(cleanSearchQ)}&hl=iw&gl=IL&ceid=IL:he`;
        const topNewsUrl = `https://news.google.com/rss?hl=iw&gl=IL&ceid=IL:he`;
        const weatherUrl = 'https://api.open-meteo.com/v1/forecast?latitude=31.7683,32.0853,29.5577&longitude=35.2137,34.7818,34.9519&current=temperature_2m&daily=temperature_2m_max,temperature_2m_min&timezone=Asia%2FJerusalem&forecast_days=2';

        const [webRes, ytRes, newsSearchRes, topNewsRes, weatherRes] = await Promise.allSettled([
            searchDuckDuckGoWeb(questionText),
            searchYouTubeLatestVideos(questionText),
            fetchWithTimeout(rssSearchUrl, {}, 4500),
            fetchWithTimeout(topNewsUrl, {}, 4500),
            fetchWithTimeout(weatherUrl, {}, 4500)
        ]);

        if (webRes.status === 'fulfilled' && webRes.value) {
            snippets.push(webRes.value);
        }

        if (ytRes.status === 'fulfilled' && ytRes.value) {
            snippets.push(ytRes.value);
        }

        if (weatherRes.status === 'fulfilled' && weatherRes.value.ok) {
            const wData = await weatherRes.value.json();
            if (Array.isArray(wData) && wData.length >= 3) {
                const jlm = wData[0];
                const tlv = wData[1];
                const eil = wData[2];
                snippets.push(`נתוני מזג אוויר חיים בישראל כעת: ירושלים כעת ${jlm.current?.temperature_2m}°C (היום ${jlm.daily?.temperature_2m_min?.[0]}-${jlm.daily?.temperature_2m_max?.[0]}°C, מחר ${jlm.daily?.temperature_2m_min?.[1]}-${jlm.daily?.temperature_2m_max?.[1]}°C), תל אביב כעת ${tlv.current?.temperature_2m}°C (היום עד ${tlv.daily?.temperature_2m_max?.[0]}°C, מחר עד ${tlv.daily?.temperature_2m_max?.[1]}°C), אילת כעת ${eil.current?.temperature_2m}°C (היום עד ${eil.daily?.temperature_2m_max?.[0]}°C, מחר עד ${eil.daily?.temperature_2m_max?.[1]}°C).`);
            }
        }

        const extractRssItems = (xmlText, limit = 5) => {
            const items = [];
            const itemRegex = /<item>([\s\S]*?)<\/item>/g;
            let m;
            while ((m = itemRegex.exec(xmlText)) !== null && items.length < limit) {
                const block = m[1];
                const tMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
                const dMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
                if (tMatch && tMatch[1]) {
                    const cleanTitle = stripHtmlTags(tMatch[1]);
                    const pubDate = dMatch ? dMatch[1].trim() : '';
                    items.push(`- ${cleanTitle} (${pubDate})`);
                }
            }
            return items;
        };

        if (newsSearchRes.status === 'fulfilled' && newsSearchRes.value.ok) {
            const xml = await newsSearchRes.value.text();
            const found = extractRssItems(xml, 5);
            if (found.length > 0) {
                snippets.push(`תוצאות מחדשות גוגל עבור "${cleanSearchQ}":\n${found.join('\n')}`);
            }
        }

        if (topNewsRes.status === 'fulfilled' && topNewsRes.value.ok) {
            const xml = await topNewsRes.value.text();
            const topFound = extractRssItems(xml, 5);
            if (topFound.length > 0) {
                snippets.push(`כותרות החדשות הראשיות בישראל כעת:\n${topFound.join('\n')}`);
            }
        }
    } catch (e) {
        console.warn('[Live Context Error]:', e.message);
    }
    return snippets.join('\n\n');
}

// 5. מענה חכם ומדויק ללא חריגת מכסה (משתמש בנתוני החיפוש החיים שנשלפו על ידי השרת)
async function answerQuestionWithLiveSearch(questionText, callHistory = []) {
    const models = await getHighQuotaGeminiModels();

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

    const liveWebData = await fetchLiveWebAndNewsContext(questionText);
    console.log(`[Live Search Context Gathered] (${liveWebData.length} chars)`);

    let historyContext = '';
    if (callHistory.length > 0) {
        const recent = callHistory.slice(-2).map(h => `שאלה קודמת: ${h.q}\nתשובה קודמת: ${h.a}`).join('\n');
        historyContext = `\nהיסטוריית השיחה הנוכחית (התייחס אליה רק אם זו שאלת המשך ישירה):\n${recent}\n`;
    }

    const prompt = `אתה עוזר קולי חכם ומדויק במערכת טלפונית.
התאריך והשעה הנוכחיים בישראל: ${nowStr}.
${liveWebData ? `\nלהלן תוצאות חיפוש חיות שנשלפו כעת בזמן אמת מהאינטרנט, מיוטיוב וממבזקי החדשות:\n${liveWebData}\n` : ''}${historyContext}
שאלת המשתמש: "${questionText}"

הנחיות מחייבות:
1. ענה ישירות ובמדויק על שאלת המשתמש בהתבסס על תוצאות החיפוש החיות שלמעלה ועל הידע שלך.
2. אם המשתמש שאל על סרטון, שיעור אחרון ביוטיוב, חדשות או מזג אוויר - השתמש אך ורק בנתונים החיים שלמעלה.
3. נסח תשובה ברורה, מלאה וטבעית להקראה בטלפון בעברית (בין 2 ל-5 משפטים שלמים). אל תקטע משפטים באמצע.
4. כתוב טקסט נקי בלבד ללא כוכביות, ללא סולמיות, ללא קישורים וללא תווי עיצוב.`;

    let lastErr = '';

    for (const model of models.slice(0, 5)) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
        try {
            const res = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.2,
                        maxOutputTokens: 2048
                    }
                })
            }, 16000);

            if (res.ok) {
                const data = await res.json();
                const parts = (data?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought && p.text);
                const answer = parts.map(p => p.text).join(' ').trim();

                if (answer && answer.length > 2) {
                    console.log(`[Gemini Answer Success] Model: ${model} | Answer:`, answer);
                    return answer;
                }
            } else {
                const errTxt = await res.text();
                console.warn(`[Model ${model} failed ${res.status}]:`, errTxt.slice(0, 160));
                lastErr = errTxt;
            }
        } catch (err) {
            lastErr = err.message;
        }
    }
    throw new Error('GEMINI_ANSWER_ERR: ' + lastErr);
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
    res.send('Gemini Live Search Line Server v6.0 OK - Quota-Free Live Web & YouTube Search');
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

        // שלב 3: זיהוי דיבור מהיר במודל עתיר מכסה
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

        // שלב 4: חיפוש חי מהשרת (אינטרנט, יוטיוב, חדשות ומזג אוויר) ומענה ב-Gemini ללא חריגת מכסה
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
        console.error('[General Error v6.0]', e.message);
        if (!res.headersSent) {
            return res.send('id_list_message=t-אירעה תקלה כללית בשרת&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Gemini Voice Assistant v6.0 Ready on port ${port} ===`));
