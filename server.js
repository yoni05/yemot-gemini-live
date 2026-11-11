const express = require('express');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const TOKEN = (process.env.YEMOT_TOKEN || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const DEFAULT_ARCHIVE_EXT = (process.env.ARCHIVE_EXT || '8').trim();
const YM = 'https://www.call2all.co.il/ym/api/';

let cachedModelList = null;
let lastModelFetchTime = 0;
const lastAnswerByPhone = new Map();
const conversationHistoryByCall = new Map();
let globalLastAnswer = null;

// מונה קבצים חכם בזיכרון (חוסך קריאת רשת לימות המשיח בכל שלב בשיחה ומאיץ מאוד את המענה)
const folderCounters = {};
const folderInitialized = {};

async function fetchWithTimeout(url, options = {}, timeout = 15000) {
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

function normalizeFolder(folder) {
    return String(folder || DEFAULT_ARCHIVE_EXT)
        .replace(/^ivr2:\/*/, '')
        .replace(/^\/*/, '')
        .replace(/\/*$/, '') || '8';
}

// שליפה מהירה במיוחד: בודקת את התיקייה בימות המשיח רק פעם אחת בהפעלה, ומאז מקדמת מונה בזיכרון באפס זמן
async function getNextFileNumberStr(folder) {
    const cleanFolder = normalizeFolder(folder);
    const folderPath = `ivr2:/${cleanFolder}`;

    if (!folderInitialized[cleanFolder]) {
        let maxExisting = -1;
        try {
            const url = `${YM}GetIVR2Dir?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(folderPath)}`;
            const res = await fetchWithTimeout(url, {}, 4000);
            if (res.ok) {
                const data = await res.json();
                const files = data.files || [];
                for (const f of files) {
                    const fname = (typeof f === 'string') ? f : (f && (f.name || f.fileName || ''));
                    const m = String(fname).match(/^(?:rec_)?(\d+)\.(wav|tts|txt|mp3)$/i);
                    if (m) {
                        const num = parseInt(m[1], 10);
                        if (!isNaN(num) && num < 99999 && num > maxExisting) {
                            maxExisting = num;
                        }
                    }
                }
            }
            folderInitialized[cleanFolder] = true;
            folderCounters[cleanFolder] = maxExisting;
        } catch (e) {
            console.warn(`[GetIVR2Dir] Fast fallback for ${folderPath}:`, e.message);
            if (folderCounters[cleanFolder] === undefined) folderCounters[cleanFolder] = 0;
        }
    }

    const nextNum = (folderCounters[cleanFolder] !== undefined ? folderCounters[cleanFolder] : -1) + 1;
    folderCounters[cleanFolder] = nextNum;
    return String(nextNum).padStart(3, '0');
}

// 1. הורדת ההקלטה מימות המשיח
async function downloadRecordingFromYemot(recordPath, fallbackDir) {
    const cleanPath = String(recordPath).replace(/^ivr2:\/*/, '').replace(/^\/*/, '');
    const cleanDir = normalizeFolder(fallbackDir);

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
            const res = await fetchWithTimeout(url, {}, 9000);
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

// 2. איתור מודלים מהירים וחכמים
async function getSmartGeminiModels() {
    const preferredSmartOrder = [
        'gemini-3.5-flash',
        'gemini-flash-latest',
        'gemini-3.8-flash',
        'gemini-3.5-flash-lite',
        'gemini-flash-lite-latest'
    ];

    if (cachedModelList && (Date.now() - lastModelFetchTime < 600000)) {
        return cachedModelList;
    }

    try {
        const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`, {}, 4500);
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
            for (const pref of preferredSmartOrder) {
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
                console.log('[Available Smart Models]:', JSON.stringify(matched));
                return matched;
            }
        }
    } catch (e) {}
    return preferredSmartOrder;
}

// 3. תמלול מהיר ומדויק של השאלה
async function transcribeAudio(audioBase64) {
    const modelsToTry = await getSmartGeminiModels();
    const prompt = 'תמלל את ההקלטה לעברית מילה במילה בצורה המדויקת ביותר. אם נאמרו מילים בשפה אחרת לצורך תרגום או חיפוש, כתוב אותן כפי שנאמרו. החזר אך ורק את המילים שנאמרו ללא שום תוספת.';

    let lastErr = '';
    for (const model of modelsToTry.slice(0, 4)) {
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
                        temperature: 0.05,
                        maxOutputTokens: 512
                    }
                })
            }, 9000);

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
            }
        } catch (err) {
            lastErr = err.message;
        }
    }
    throw new Error('GEMINI_TRANSCRIBE_ERR: ' + lastErr);
}

// 4. מנועי חיפוש מהירים במקביל (ויקיפדיה, תרגום גוגל, יוטיוב, אינטרנט, חדשות ומזג אוויר)
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

function cleanQueryForSearch(queryText) {
    return String(queryText || '')
        .replace(/תחפש לי|חפש לי|באינטרנט|בויקיפדיה|בוויקיפדיה|ביוטיוב|מה זה|מי זה|מי זאת|מהו|מהי|תגיד לי|תספר לי על|מידע על|ערך על/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || queryText;
}

async function searchWikipedia(queryText) {
    try {
        const cleanQ = cleanQueryForSearch(queryText);
        if (!cleanQ || cleanQ.length < 2) return '';

        const heUrl = `https://he.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanQ)}&utf8=&format=json&srlimit=2`;
        const res = await fetchWithTimeout(heUrl, {
            headers: { 'User-Agent': 'YemotVoiceAssistant/12.0' }
        }, 2800);

        const summaries = [];
        if (res.ok) {
            const data = await res.json();
            const searchResults = data?.query?.search || [];
            const summaryPromises = searchResults.slice(0, 2).map(async (item) => {
                const title = item.title;
                const sumUrl = `https://he.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
                try {
                    const sumRes = await fetchWithTimeout(sumUrl, {
                        headers: { 'User-Agent': 'YemotVoiceAssistant/12.0' }
                    }, 2200);
                    if (sumRes.ok) {
                        const sumData = await sumRes.json();
                        if (sumData.extract) {
                            return `- מתוך ויקיפדיה ("${title}"): ${sumData.extract}`;
                        }
                    }
                } catch (e) {}
                return `- מתוך ויקיפדיה ("${title}"): ${stripHtmlTags(item.snippet)}`;
            });
            const resolved = await Promise.all(summaryPromises);
            summaries.push(...resolved.filter(Boolean));
        }

        if (summaries.length > 0) {
            return `תוצאות מדויקות מוויקיפדיה עבור "${cleanQ}":\n${summaries.join('\n')}`;
        }
    } catch (e) {}
    return '';
}

async function translateTextLive(queryText) {
    try {
        const isTranslationQuery = /תרגם|לתרגם|איך אומרים|באנגלית|בעברית|ביידיש|בצרפתית|בספרדית|ברוסית|בערבית|פירוש המילה|מה הפירוש/i.test(queryText);
        if (!isTranslationQuery) return '';

        let targetLang = 'en';
        if (/לעברית|בעברית|מה הפירוש|פירוש המילה/i.test(queryText)) targetLang = 'iw';
        else if (/ליידיש|ביידיש/i.test(queryText)) targetLang = 'yi';
        else if (/לצרפתית|בצרפתית/i.test(queryText)) targetLang = 'fr';
        else if (/לספרדית|בספרדית/i.test(queryText)) targetLang = 'es';
        else if (/לרוסית|ברוסית/i.test(queryText)) targetLang = 'ru';
        else if (/לערבית|בערבית/i.test(queryText)) targetLang = 'ar';

        const phraseToTranslate = queryText
            .replace(/תרגם לי|תרגם|איך אומרים|באנגלית|בעברית|לאנגלית|לעברית|ביידיש|ליידיש|בצרפתית|לצרפתית|בספרדית|לספרדית|ברוסית|לרוסית|בערבית|לערבית|מה הפירוש של|מה הפירוש|את המשפט|את המילה/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim() || queryText;

        const gtUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(phraseToTranslate)}`;
        const res = await fetchWithTimeout(gtUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 2500);

        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && Array.isArray(data[0])) {
                const translated = data[0].map(item => item[0]).join('').trim();
                if (translated) {
                    return `תרגום מדויק מ-Google Translate עבור "${phraseToTranslate}" (שפת יעד: ${targetLang}): "${translated}"`;
                }
            }
        }
    } catch (e) {}
    return '';
}

async function searchYouTubeLatestVideos(queryText) {
    try {
        const cleanQ = cleanQueryForSearch(queryText);
        const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQ)}&sp=CAI%253D`;
        const ytRelevanceUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQ)}`;

        const [dateRes, relRes] = await Promise.allSettled([
            fetchWithTimeout(ytUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'he-IL,he;q=0.9' } }, 2800),
            fetchWithTimeout(ytRelevanceUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'he-IL,he;q=0.9' } }, 2800)
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

        const unique = [...new Set(combined)].slice(0, 5);
        if (unique.length > 0) {
            return `תוצאות חיות מיוטיוב עבור "${cleanQ}":\n${unique.join('\n')}`;
        }
    } catch (e) {}
    return '';
}

async function searchStableWeb(queryText) {
    try {
        const cleanQ = cleanQueryForSearch(queryText);
        const results = [];

        const ddgApiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(cleanQ)}&format=json&no_html=1&skip_disambig=1`;
        const googleRssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(cleanQ)}&hl=iw&gl=IL&ceid=IL:he`;

        const [ddgData, rssXml] = await Promise.all([
            fetchWithTimeout(ddgApiUrl, {}, 2500).then(r => r.ok ? r.json() : null).catch(() => null),
            fetchWithTimeout(googleRssUrl, {}, 2800).then(r => r.ok ? r.text() : '').catch(() => '')
        ]);

        if (ddgData) {
            if (ddgData.AbstractText) results.push(`- תקציר רשת: ${ddgData.AbstractText}`);
            if (Array.isArray(ddgData.RelatedTopics)) {
                for (const t of ddgData.RelatedTopics.slice(0, 3)) {
                    if (t && t.Text) results.push(`- מידע נוסף: ${t.Text}`);
                }
            }
        }

        if (rssXml) {
            const itemRegex = /<item>([\s\S]*?)<\/item>/g;
            let m;
            let count = 0;
            while ((m = itemRegex.exec(rssXml)) !== null && count < 5) {
                const block = m[1];
                const tMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
                const dMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
                if (tMatch && tMatch[1]) {
                    const cleanTitle = stripHtmlTags(tMatch[1]);
                    const pubDate = dMatch ? dMatch[1].trim() : '';
                    results.push(`- תוצאת רשת/חדשות: ${cleanTitle} (${pubDate})`);
                    count++;
                }
            }
        }

        if (results.length > 0) {
            return `תוצאות חיפוש רשת עבור "${cleanQ}":\n${results.join('\n')}`;
        }
    } catch (e) {}
    return '';
}

async function fetchAllLiveSources(questionText) {
    const snippets = [];
    try {
        const topNewsUrl = `https://news.google.com/rss?hl=iw&gl=IL&ceid=IL:he`;
        const weatherUrl = 'https://api.open-meteo.com/v1/forecast?latitude=31.7683,32.0853,29.5577,32.7940&longitude=35.2137,34.7818,34.9519,34.9896&current=temperature_2m&daily=temperature_2m_max,temperature_2m_min&timezone=Asia%2FJerusalem&forecast_days=2';

        const [wikiRes, transRes, webRes, ytRes, topNewsRes, weatherRes] = await Promise.allSettled([
            searchWikipedia(questionText),
            translateTextLive(questionText),
            searchStableWeb(questionText),
            searchYouTubeLatestVideos(questionText),
            fetchWithTimeout(topNewsUrl, {}, 2600),
            fetchWithTimeout(weatherUrl, {}, 2600)
        ]);

        if (transRes.status === 'fulfilled' && transRes.value) snippets.push(transRes.value);
        if (wikiRes.status === 'fulfilled' && wikiRes.value) snippets.push(wikiRes.value);
        if (webRes.status === 'fulfilled' && webRes.value) snippets.push(webRes.value);
        if (ytRes.status === 'fulfilled' && ytRes.value) snippets.push(ytRes.value);

        if (weatherRes.status === 'fulfilled' && weatherRes.value.ok) {
            const wData = await weatherRes.value.json();
            if (Array.isArray(wData) && wData.length >= 4) {
                const jlm = wData[0];
                const tlv = wData[1];
                const eil = wData[2];
                const hfa = wData[3];
                snippets.push(`נתוני מזג אוויר מדויקים בישראל כעת: ירושלים כעת ${jlm.current?.temperature_2m}°C (היום ${jlm.daily?.temperature_2m_min?.[0]}-${jlm.daily?.temperature_2m_max?.[0]}°C, מחר ${jlm.daily?.temperature_2m_min?.[1]}-${jlm.daily?.temperature_2m_max?.[1]}°C), תל אביב והמרכז כעת ${tlv.current?.temperature_2m}°C (היום עד ${tlv.daily?.temperature_2m_max?.[0]}°C), חיפה והצפון כעת ${hfa.current?.temperature_2m}°C (היום עד ${hfa.daily?.temperature_2m_max?.[0]}°C), אילת כעת ${eil.current?.temperature_2m}°C (היום עד ${eil.daily?.temperature_2m_max?.[0]}°C).`);
            }
        }

        if (topNewsRes.status === 'fulfilled' && topNewsRes.value.ok) {
            const xml = await topNewsRes.value.text();
            const items = [];
            const itemRegex = /<item>([\s\S]*?)<\/item>/g;
            let m;
            while ((m = itemRegex.exec(xml)) !== null && items.length < 5) {
                const block = m[1];
                const tMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
                if (tMatch && tMatch[1]) items.push(`- ${stripHtmlTags(tMatch[1])}`);
            }
            if (items.length > 0) snippets.push(`כותרות החדשות הראשיות בישראל כעת:\n${items.join('\n')}`);
        }
    } catch (e) {}
    return snippets.join('\n\n');
}

// 5. מענה חכם ומהיר ב-Gemini
async function answerQuestionWithLiveSearch(questionText, callHistory = []) {
    const [models, liveWebData] = await Promise.all([
        getSmartGeminiModels(),
        fetchAllLiveSources(questionText)
    ]);

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

    console.log(`[Live Search Context Gathered] (${liveWebData.length} chars)`);

    let historyContext = '';
    if (callHistory.length > 0) {
        const recent = callHistory.slice(-3).map(h => `שאלה קודמת: ${h.q}\nתשובה קודמת: ${h.a}`).join('\n');
        historyContext = `\nהיסטוריית השיחה הנוכחית (התייחס אליה אם המשתמש שואל שאלת המשך):\n${recent}\n`;
    }

    const prompt = `אתה עוזר קולי חכם, בקיא ומדויק במערכת טלפונית.
התאריך והשעה הנוכחיים בישראל: ${nowStr}.
${liveWebData ? `\nלהלן מידע חי ומדויק שנשלף כעת בזמן אמת מוויקיפדיה, Google Translate, אינטרנט, יוטיוב, חדשות ומזג אוויר:\n${liveWebData}\n` : ''}${historyContext}
שאלת המשתמש: "${questionText}"

הנחיות מחייבות:
1. ענה ישירות ובדיוק מרבי על שאלת המשתמש בהתבסס על הנתונים החיים שלמעלה ועל הידע שלך.
2. אם השאלה עוסקת בוויקיפדיה, תרגום, סרטונים ביוטיוב, חדשות או מזג אוויר - התבסס בראש ובראשונה על התוצאות החיות שמופיעות למעלה.
3. נסח תשובה ברורה, מלאה וטבעית להקראה בטלפון בעברית (בין 2 ל-5 משפטים שלמים). אל תקטע משפטים באמצע.
4. כתוב טקסט נקי בלבד ללא כוכביות, ללא סולמיות, ללא קישורים וללא תווי עיצוב.`;

    let lastErr = '';
    for (const model of models.slice(0, 4)) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
        try {
            const res = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.2,
                        maxOutputTokens: 1536
                    }
                })
            }, 13000);

            if (res.ok) {
                const data = await res.json();
                const parts = (data?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought && p.text);
                const answer = parts.map(p => p.text).join(' ').trim();

                if (answer && answer.length > 2) {
                    console.log(`[Gemini Answer Success] Model: ${model} | Answer:`, answer);
                    return answer;
                }
            } else {
                lastErr = await res.text();
            }
        } catch (err) {
            lastErr = err.message;
        }
    }
    throw new Error('GEMINI_ANSWER_ERR: ' + lastErr);
}

// 6. יצירת קובץ שמע אמיתי (WAV) דרך מודל ה-TTS של Gemini (פועל ברקע בלי לעכב את השיחה!)
function pcmToWavBuffer(pcmBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmBuffer.length;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
}

async function generateGeminiTtsWavBuffer(textToSpeak) {
    const ttsModels = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'];
    for (const model of ttsModels) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
            const res = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: `קרא בקול ברור וטבעי בעברית: ${textToSpeak}` }] }],
                    generationConfig: {
                        responseModalities: ['AUDIO'],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: { voiceName: 'Aoede' }
                            }
                        }
                    }
                })
            }, 14000);

            if (res.ok) {
                const data = await res.json();
                const inline = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
                if (inline && inline.data) {
                    const rawBuf = Buffer.from(inline.data, 'base64');
                    if (rawBuf.slice(0, 4).toString('ascii') === 'RIFF') {
                        return rawBuf;
                    }
                    return pcmToWavBuffer(rawBuf, 24000, 1, 16);
                }
            }
        } catch (e) {}
    }
    return null;
}

// 7. ניקוי הטקסט והרכבת פקודת השמעה תקנית לימות המשיח
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

    return chunks.slice(0, 20).map(c => `t-${c}`).join('.');
}

// 8. שמירת השאלה, התשובה וקובץ הקול של Gemini בשלוחת הארכיון שנבחרה (ברקע - אפס עיכוב בשיחה)
async function saveArchiveToSelectedExt(archiveExt, questionText, answerText, callerPhone, recFilePath) {
    try {
        const targetExt = normalizeFolder(archiveExt);
        const nextNum = await getNextFileNumberStr(targetExt);
        const nowStr = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
        const cleanAns = sanitizeForYemotTts(answerText);
        const cleanQ = sanitizeForYemotTts(questionText);
        const fullSpokenText = `שאלה: ${cleanQ}. תשובה: ${cleanAns}`;

        // א. שמירה מיידית של קובץ השמעה .tts וקובץ פירוט .txt בשלוחת הארכיון שנבחרה
        const ttsTargetPath = `ivr2:/${targetExt}/${nextNum}.tts`;
        const ttsForm = new FormData();
        ttsForm.append('token', TOKEN);
        ttsForm.append('path', ttsTargetPath);
        ttsForm.append('convertAudio', '0');
        ttsForm.append('file', new Blob([Buffer.from(fullSpokenText, 'utf8')], { type: 'text/plain; charset=utf-8' }), `${nextNum}.tts`);

        const txtDetails = `שאלה: ${questionText}\r\nתשובה: ${answerText}\r\nטלפון: ${callerPhone || 'לא ידוע'}\r\nזמן: ${nowStr}\r\nהקלטה מקורית: ${recFilePath || ''}\r\n`;
        const txtTargetPath = `ivr2:/${targetExt}/${nextNum}.txt`;
        const txtForm = new FormData();
        txtForm.append('token', TOKEN);
        txtForm.append('path', txtTargetPath);
        txtForm.append('convertAudio', '0');
        txtForm.append('file', new Blob([Buffer.from(txtDetails, 'utf8')], { type: 'text/plain; charset=utf-8' }), `${nextNum}.txt`);

        await Promise.allSettled([
            fetchWithTimeout(`${YM}UploadFile`, { method: 'POST', body: ttsForm }, 10000),
            fetchWithTimeout(`${YM}UploadFile`, { method: 'POST', body: txtForm }, 10000)
        ]);
        console.log(`[Archive Ext ${targetExt}] Saved instant TTS & TXT to ${ttsTargetPath}`);

        // ב. הפקת קובץ שמע איכותי (.wav) דרך מודל ה-TTS של Gemini והעלאתו לשלוחת הארכיון (ברקע)
        const geminiWavBuf = await generateGeminiTtsWavBuffer(fullSpokenText);
        if (geminiWavBuf && geminiWavBuf.length > 500) {
            const wavTargetPath = `ivr2:/${targetExt}/${nextNum}.wav`;
            const wavForm = new FormData();
            wavForm.append('token', TOKEN);
            wavForm.append('path', wavTargetPath);
            wavForm.append('convertAudio', '1');
            wavForm.append('file', new Blob([geminiWavBuf], { type: 'audio/wav' }), `${nextNum}.wav`);

            await fetchWithTimeout(`${YM}UploadFile`, { method: 'POST', body: wavForm }, 15000);
            console.log(`[Gemini TTS Audio] Uploaded natural Gemini voice WAV to ${wavTargetPath}`);
        }
    } catch (err) {
        console.warn(`[Archive Ext Error]:`, err.message);
    }
}

app.get('/', (req, res) => {
    res.send('Gemini Live Search Line Server v12.0 OK - Fast Memory Counter, Custom Archive Ext & Gemini TTS');
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

        // קליטת שלוחת ההשמעות והארכיון מהפרמטר בכתובת או ממשתנה הסביבה (ברירת מחדל: 8)
        const archiveExt = normalizeFolder(q.archive || DEFAULT_ARCHIVE_EXT);
        const recFolder = `/${archiveExt}`;
        const callerPhone = String(q.ApiPhone || '').trim();

        const rawRec = q.RecordPath;
        const latestRecordPath = Array.isArray(rawRec) ? rawRec[rawRec.length - 1] : rawRec;

        // שלב 0: תפריט פתיחה בכניסה ראשונה לשלוחה
        if (!q.MenuChoice && !latestRecordPath) {
            return res.send('read=t-לשיחה עם העוזר הקולי הקישו 1 לשמיעת התשובה האחרונה הקישו 2=MenuChoice,no,1,1,7,Digits,no');
        }

        // הקשה על 2: השמעת התשובה האחרונה ומיד לאחריה פתיחת הקלטה לשאלה חדשה
        if (q.MenuChoice === '2' && !latestRecordPath) {
            const prev = (callerPhone && lastAnswerByPhone.get(callerPhone)) || globalLastAnswer;
            const nextRecNum = await getNextFileNumberStr(archiveExt);
            if (prev && prev.playCmd) {
                return res.send(`id_list_message=t-משמיע את התשובה הקודמת.${prev.playCmd}&read=t-לשאלה נוספת אמרו כעת את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},rec_${nextRecNum},no,7,1`);
            } else {
                return res.send(`id_list_message=t-עדיין לא קיימת תשובה קודמת בקו&read=t-אנא אמרו את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},rec_${nextRecNum},no,7,1`);
            }
        }

        // שלב 1: הקלטת השאלה הראשונה
        if (!latestRecordPath) {
            const recNum = await getNextFileNumberStr(archiveExt);
            return res.send(`read=t-אנא אמרו את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},rec_${recNum},no,7,1`);
        }

        // שלב 2: הורדת ההקלטה מימות המשיח
        let audioBuf;
        try {
            audioBuf = await downloadRecordingFromYemot(latestRecordPath, archiveExt);
        } catch (dlErr) {
            console.error('[Step 2 Error]', dlErr.message);
            const retryNum = await getNextFileNumberStr(archiveExt);
            return res.send(`id_list_message=t-שגיאה בקליטת ההקלטה&read=t-אנא אמרו שוב את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},rec_${retryNum},no,7,1`);
        }

        // שלב 3: זיהוי דיבור מהיר ומדויק
        let rawQuestion = '';
        try {
            rawQuestion = await transcribeAudio(audioBuf.toString('base64'));
        } catch (gemErr) {
            console.error('[Step 3 Error]', gemErr.message);
            const retryNum = await getNextFileNumberStr(archiveExt);
            return res.send(`id_list_message=t-שגיאה בתקשורת עם מנוע זיהוי הדיבור&read=t-אנא נסו שוב ואמרו את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},rec_${retryNum},no,7,1`);
        }

        const cleanQuestion = rawQuestion.replace(/[^א-תa-zA-Z0-9\s\?]/g, ' ').trim().replace(/\s+/g, ' ');
        console.log('[Step 3 Question]', cleanQuestion);

        if (!cleanQuestion) {
            const retryNum = await getNextFileNumberStr(archiveExt);
            return res.send(`id_list_message=t-לא הצלחתי לשמוע את השאלה&read=t-אנא אמרו שוב את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},rec_${retryNum},no,7,1`);
        }

        // שלב 4: חיפוש חי מהיר ומענה ב-Gemini
        const callHistory = conversationHistoryByCall.get(callId) || [];
        let rawAnswer = '';
        try {
            rawAnswer = await answerQuestionWithLiveSearch(cleanQuestion, callHistory);
        } catch (searchErr) {
            console.error('[Step 4 Error]', searchErr.message);
            const retryNum = await getNextFileNumberStr(archiveExt);
            return res.send(`id_list_message=t-שגיאה בחיפוש התשובה&read=t-אנא אמרו שוב את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},rec_${retryNum},no,7,1`);
        }

        // שמירה בהיסטוריית השיחה הפעילה
        callHistory.push({ q: cleanQuestion, a: rawAnswer });
        conversationHistoryByCall.set(callId, callHistory);

        const playCmd = buildYemotTtsPlayCommand(rawAnswer);
        const savedInfo = { playCmd, question: cleanQuestion, time: Date.now() };
        if (callerPhone) lastAnswerByPhone.set(callerPhone, savedInfo);
        globalLastAnswer = savedInfo;

        // שמירה לארכיון בשלוחה שנבחרה + הפקת שמע במודל הקול של Gemini (רץ ברקע באפס השהיה למאזין!)
        saveArchiveToSelectedExt(archiveExt, cleanQuestion, rawAnswer, callerPhone, latestRecordPath);

        // שלב 5: השמעת התשובה המלאה ומיד לאחריה המשך שיחה
        const nextRecNum = await getNextFileNumberStr(archiveExt);
        return res.send(`id_list_message=${playCmd}&read=t-לשאלה נוספת אמרו כעת את שאלתכם ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},rec_${nextRecNum},no,7,1`);

    } catch (e) {
        console.error('[General Error v12.0]', e.message);
        if (!res.headersSent) {
            return res.send('id_list_message=t-אירעה תקלה כללית בשרת&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Gemini Voice Assistant v12.0 Ready on port ${port} ===`));
