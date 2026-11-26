const express = require('express');
const app = express();

app.use(express.json({ limit: '16mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const GEMINI_FREE_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3-flash-preview',
  'gemini-4-hydrogen',
  'gemini-2.5-flash'
];

// Cache working { host, model } in memory so follow-up calls are instantaneous
let cachedRoute = null;

function checkSecret(req) {
  const secret = (process.env.APP_SECRET || '').trim();
  if (!secret) return true;
  const token = (req.headers['x-api-key'] || '').trim()
    || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  return token === secret;
}

function splitKeys(...rawVals) {
  const out = [];
  rawVals.forEach(raw => {
    String(raw || '').split(/[\n,]+/).map(k => k.replace(/^["']+|["']+$/g, '').trim()).filter(Boolean).forEach(k => {
      if (!out.includes(k)) out.push(k);
    });
  });
  return out;
}

const getGeminiKeys = (extra = []) => splitKeys(process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY, ...extra);
const getTavilyKeys = (extra = '') => splitKeys(process.env.TAVILY_API_KEYS, process.env.TAVILY_API_KEY, extra);
const getExaKeys    = (extra = '') => splitKeys(process.env.EXA_API_KEYS, process.env.EXA_API_KEY, extra);

async function fetchWithTimeout(url, options = {}, timeoutMs = 14000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Parallel Fast Live Medical Search (Tavily + Exa race, 4.5s max)
async function fastLiveSearch(query, tavilyKeys, exaKeys, maxResults = 4) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, sources: [], answer: '', provider: '' };

  const tasks = [];

  if (tavilyKeys.length) {
    tasks.push((async () => {
      const r = await fetchWithTimeout('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKeys[0],
          query: q,
          search_depth: 'basic',
          max_results: maxResults,
          include_answer: true
        })
      }, 4500);
      if (!r.ok) throw new Error('Tavily ' + r.status);
      const data = await r.json();
      const sources = (Array.isArray(data.results) ? data.results : []).map(it => ({
        title: it.title || '',
        link: it.url || '',
        snippet: (it.content || '').slice(0, 260)
      }));
      if (!sources.length) throw new Error('Tavily empty');
      return { ok: true, sources, answer: data.answer || '', provider: 'Tavily' };
    })());
  }

  if (exaKeys.length) {
    tasks.push((async () => {
      const r = await fetchWithTimeout('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'x-api-key': exaKeys[0], 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q,
          numResults: maxResults,
          type: 'auto',
          contents: { highlights: { numSentences: 2, highlightsPerUrl: 1 } }
        })
      }, 4500);
      if (!r.ok) throw new Error('Exa ' + r.status);
      const data = await r.json();
      const sources = (Array.isArray(data.results) ? data.results : []).map(it => ({
        title: it.title || it.url || '',
        link: it.url || '',
        snippet: (Array.isArray(it.highlights) && it.highlights[0]) ? it.highlights[0] : ''
      }));
      if (!sources.length) throw new Error('Exa empty');
      return { ok: true, sources, answer: '', provider: 'Exa AI' };
    })());
  }

  if (!tasks.length) return { ok: false, sources: [], answer: '', provider: '' };

  try {
    return await Promise.any(tasks);
  } catch (e) {
    return { ok: false, sources: [], answer: '', provider: '' };
  }
}

// Native Google AI Studio Gemini API first (even for AQ.* keys!), with automatic model rotation on 404/429
async function callGeminiFast({ keys, model, userText, images }) {
  if (!keys.length) throw new Error('کلید Gemini API تنظیم نشده است.');

  const preferred = (model || (cachedRoute && cachedRoute.model) || process.env.GEMINI_MODEL || GEMINI_FREE_MODELS[0]).trim();
  const modelsToTry = [preferred, ...(cachedRoute ? [cachedRoute.model] : []), ...GEMINI_FREE_MODELS]
    .filter((v, i, a) => v && a.indexOf(v) === i);

  const parts = [{ text: userText }];
  if (Array.isArray(images)) {
    images.slice(0, 4).forEach(im => {
      if (im && im.base64) {
        parts.push({ inline_data: { mime_type: im.mimeType || 'image/jpeg', data: im.base64 } });
      }
    });
  }

  const payload = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1600 }
  };

  let lastErr = '';
  for (const apiKey of keys) {
    // Always try native Google AI Studio endpoint first (Google now issues AQ.* keys for AI Studio too)
    const hosts = [
      { label: 'AIStudio', makeUrl: (m) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}` },
      ...(apiKey.startsWith('AQ.') ? [{ label: 'Vertex', makeUrl: (m) => `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}` }] : [])
    ];

    for (const host of hosts) {
      let hostBlocked = false;
      for (const gemModel of modelsToTry) {
        const url = host.makeUrl(gemModel);
        try {
          const r = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify(payload)
          }, 16000);

          if (r.ok) {
            const data = await r.json();
            const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
            if (text) {
              cachedRoute = { host: host.label, model: gemModel };
              return { text: text.trim(), provider: `Gemini (${gemModel})` };
            }
            lastErr = 'پاسخ خالی از Gemini';
            continue;
          }

          const body = await r.text().catch(() => '');
          lastErr = `${host.label}/${gemModel} HTTP ${r.status}: ${body.slice(0, 140)}`;

          // 404 (not found) or 429 (free-tier quota 0/exhausted on this specific model) -> try next model!
          if (r.status === 404 || r.status === 429 || r.status === 503) {
            continue;
          }
          // 401/403 on this host -> stop trying models on this host, try next host/key
          hostBlocked = true;
          break;
        } catch (e) {
          lastErr = `${host.label}/${gemModel}: ${e.name === 'AbortError' ? 'Timeout' : e.message}`;
          continue;
        }
      }
      if (!hostBlocked) {
        // Tried all models on AIStudio and only got 404/429 (key IS valid on AIStudio, no need to hit disabled Vertex!)
        break;
      }
    }
  }
  throw new Error(lastErr || 'اتصال به Gemini ناموفق بود.');
}

app.get(['/', '/health'], (req, res) => {
  res.json({
    ok: true,
    status: 'running',
    version: 'v32',
    geminiConfigured: getGeminiKeys().length > 0,
    tavilyConfigured: getTavilyKeys().length > 0,
    exaConfigured: getExaKeys().length > 0,
    model: (cachedRoute && cachedRoute.model) || process.env.GEMINI_MODEL || GEMINI_FREE_MODELS[0]
  });
});

app.post('/webhook/medical-search', async (req, res) => {
  try {
    if (!checkSecret(req)) return res.status(401).json({ error: 'توکن دسترسی نامعتبر است.' });
    const { query = '', clientTavilyKey = '', clientExaKey = '', num = 5 } = req.body || {};
    const q = String(query || '').trim();
    if (!q) return res.status(400).json({ error: 'متن جستجو خالی است.' });

    const out = await fastLiveSearch(
      `${q} clinical guideline cardiology radiology`,
      getTavilyKeys(clientTavilyKey),
      getExaKeys(clientExaKey),
      Math.min(Number(num) || 5, 6)
    );
    if (out.ok) return res.json(out);
    return res.status(502).json({ error: 'پاسخی از Tavily یا Exa AI دریافت نشد.' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'خطا در جستجوی پزشکی' });
  }
});

app.post(['/webhook/clinical-interpret', '/'], async (req, res) => {
  try {
    if (!checkSecret(req)) return res.status(401).json({ error: 'توکن دسترسی نامعتبر است.' });

    const {
      modalityLabel = '',
      prompt = '',
      text = '',
      context = '',
      images = [],
      useLiveSearch = false,
      model: clientModel = '',
      clientGeminiKeys = [],
      clientTavilyKey = '',
      clientExaKey = ''
    } = req.body || {};

    const geminiKeys = getGeminiKeys(Array.isArray(clientGeminiKeys) ? clientGeminiKeys : []);
    if (!geminiKeys.length) {
      return res.status(400).json({ error: 'هیچ کلید Gemini API در Render یا تنظیمات دستی تعریف نشده است.' });
    }

    const rawEnvSearch = String(process.env.LIVE_SEARCH ?? '').trim().toLowerCase();
    const envDisabled = ['false', '0', 'no', 'off'].includes(rawEnvSearch);
    const envEnabled  = ['true', '1', 'yes', 'on'].includes(rawEnvSearch);
    const doSearch = envDisabled ? false : (Boolean(useLiveSearch) || envEnabled);

    let searchOut = { ok: false, sources: [], answer: '', provider: '' };
    if (doSearch) {
      const seed = (text || context || modalityLabel || '').replace(/\s+/g, ' ').trim().slice(0, 150);
      if (seed) {
        searchOut = await fastLiveSearch(
          `${seed} clinical guideline interpretation`,
          getTavilyKeys(clientTavilyKey),
          getExaKeys(clientExaKey),
          4
        );
      }
    }

    const searchBlock = searchOut.ok && searchOut.sources.length
      ? `\n\nمنابع زنده پزشکی (${searchOut.provider}):\n`
        + (searchOut.answer ? `خلاصه: ${searchOut.answer}\n` : '')
        + searchOut.sources.map((s, i) => `${i + 1}. ${s.title}: ${s.snippet}`).join('\n')
      : '';

    const userText = [
      prompt,
      context ? `زمینه بیمار: ${context}` : '',
      text ? `متن/ریپورت ارسالی:\n${text}` : 'تصاویر پیوست را با دقت بررسی و تفسیر کن.',
      searchBlock
    ].filter(Boolean).join('\n\n');

    const aiOut = await callGeminiFast({
      keys: geminiKeys,
      model: clientModel,
      userText,
      images
    });

    return res.json({
      ok: true,
      result: aiOut.text,
      via: aiOut.provider + (searchOut.ok ? ` + ${searchOut.provider}` : ''),
      sources: searchOut.sources || []
    });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'خطا در ارتباط با سرور هوش مصنوعی' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Fast Cardiac AI Server v32 running on port ' + PORT));
