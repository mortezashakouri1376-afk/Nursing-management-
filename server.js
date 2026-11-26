const express = require('express');
const app = express();

app.use(express.json({ limit: '16mb' }));

// CORS کامل برای GitHub Pages، موبایل، PWA و حالت آفلاین
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const GEMINI_FREE_MODELS = [
  'gemini-4-hydrogen',
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview'
];

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

function getServerGeminiKeys() { return splitKeys(process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY); }
function getServerTavilyKeys() { return splitKeys(process.env.TAVILY_API_KEYS, process.env.TAVILY_API_KEY); }
function getServerExaKeys() { return splitKeys(process.env.EXA_API_KEYS, process.env.EXA_API_KEY); }

// 1) Tavily AI Medical Search (1000 free searches/month)
async function queryTavily(query, tavilyKeys, maxResults = 5) {
  const q = String(query || '').trim();
  if (!q || !tavilyKeys.length) return { ok: false, sources: [] };
  let lastErr = '';
  for (const apiKey of tavilyKeys) {
    try {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query: q,
          search_depth: 'basic',
          max_results: maxResults,
          include_answer: true
        })
      });
      if (r.ok) {
        const data = await r.json();
        const results = Array.isArray(data.results) ? data.results : [];
        const sources = results.map(it => ({
          title: it.title || '',
          link: it.url || '',
          snippet: it.content || ''
        }));
        return { ok: true, sources, answer: data.answer || '', provider: 'Tavily' };
      }
      lastErr = `Tavily HTTP ${r.status}`;
      if (![429, 403, 401].includes(r.status)) break;
    } catch (e) {
      lastErr = e.message || 'Tavily error';
    }
  }
  return { ok: false, sources: [], error: lastErr };
}

// 2) Exa AI Neural Medical Search (1000 free searches/month)
async function queryExa(query, exaKeys, numResults = 5) {
  const q = String(query || '').trim();
  if (!q || !exaKeys.length) return { ok: false, sources: [] };
  let lastErr = '';
  for (const apiKey of exaKeys) {
    try {
      const r = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: q,
          numResults,
          type: 'auto',
          contents: {
            highlights: { numSentences: 3, highlightsPerUrl: 1 }
          }
        })
      });
      if (r.ok) {
        const data = await r.json();
        const results = Array.isArray(data.results) ? data.results : [];
        const sources = results.map(it => ({
          title: it.title || it.url || '',
          link: it.url || '',
          snippet: (Array.isArray(it.highlights) && it.highlights[0]) ? it.highlights[0] : (it.text ? String(it.text).slice(0, 260) : '')
        }));
        return { ok: true, sources, provider: 'Exa AI' };
      }
      lastErr = `Exa HTTP ${r.status}`;
      if (![429, 403, 401].includes(r.status)) break;
    } catch (e) {
      lastErr = e.message || 'Exa error';
    }
  }
  return { ok: false, sources: [], error: lastErr };
}

// 3) Gemini Vision + Built-in Google Search Grounding
// Supports BOTH Google AI Studio keys (AIza...) AND Vertex AI Express keys (AQ....)
async function callGeminiAPI({ keys, model, userText, images, enableGoogleSearch }) {
  if (!keys.length) throw new Error('کلید Gemini تعریف نشده است');
  const primaryModel = (model || process.env.GEMINI_MODEL || GEMINI_FREE_MODELS[0]).trim();
  const candidateModels = [primaryModel, ...GEMINI_FREE_MODELS]
    .filter((v, i, a) => v && a.indexOf(v) === i);

  const parts = [{ text: userText }];
  if (Array.isArray(images)) {
    images.slice(0, 4).forEach(im => {
      if (im && im.base64) {
        parts.push({
          inline_data: { mime_type: im.mimeType || 'image/jpeg', data: im.base64 }
        });
      }
    });
  }

  async function sendGeminiRequest(endpointUrl, cleanKey, withSearch) {
    const payload = { contents: [{ role: 'user', parts }] };
    if (withSearch) {
      payload.tools = [{ google_search: {} }];
    }
    const r = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': cleanKey
      },
      body: JSON.stringify(payload)
    });
    if (r.ok) {
      const data = await r.json();
      const cand = data?.candidates?.[0] || {};
      const text = cand?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
      const chunks = cand?.groundingMetadata?.groundingChunks || [];
      const gSources = chunks
        .filter(c => c && c.web && c.web.uri)
        .slice(0, 5)
        .map(c => ({
          title: c.web.title || c.web.uri,
          link: c.web.uri,
          snippet: 'منبع تأییدشده از جستجوی زنده Google Search'
        }));
      if (text) return { ok: true, text, groundingSources: gSources };
      return { ok: false, status: 502, body: 'پاسخ متنی خالی از Gemini' };
    }
    const errBody = await r.text().catch(() => '');
    return { ok: false, status: r.status, body: errBody.slice(0, 220) };
  }

  let lastErr = '';
  for (const apiKey of keys) {
    const cleanKey = apiKey.replace(/^["']+|["']+$/g, '').trim();
    const isVertexExpress = cleanKey.startsWith('AQ.');

    for (const gemModel of candidateModels) {
      const endpoints = isVertexExpress
        ? [
            { label: 'Vertex', url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(gemModel)}:generateContent?key=${encodeURIComponent(cleanKey)}` },
            { label: 'AIStudio', url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(gemModel)}:generateContent?key=${encodeURIComponent(cleanKey)}` }
          ]
        : [
            { label: 'AIStudio', url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(gemModel)}:generateContent?key=${encodeURIComponent(cleanKey)}` }
          ];

      let stopModelsForThisKey = false;
      for (const ep of endpoints) {
        let resObj = await sendGeminiRequest(ep.url, cleanKey, Boolean(enableGoogleSearch));
        if (!resObj.ok && resObj.status === 400 && enableGoogleSearch) {
          resObj = await sendGeminiRequest(ep.url, cleanKey, false);
        }
        if (resObj.ok) {
          return {
            text: resObj.text,
            provider: `Gemini ${gemModel} (${ep.label})`,
            groundingSources: resObj.groundingSources
          };
        }
        lastErr = `Gemini/${ep.label} (${gemModel}) HTTP ${resObj.status}: ${resObj.body}`;
        if ([401, 403, 429].includes(resObj.status)) {
          if (isVertexExpress && ep.label === 'Vertex') continue;
          stopModelsForThisKey = true;
          break;
        }
        if (resObj.status === 404) break;
      }
      if (stopModelsForThisKey) break;
    }
  }
  throw new Error(lastErr || 'Gemini failed');
}

// صفحه وضعیت اصلی
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'Cardiac Clinical AI Server (v30 — Gemini + Tavily + Exa AI)',
    endpoints: ['/health', '/webhook/clinical-interpret', '/webhook/medical-search'],
    geminiConfigured: getServerGeminiKeys().length > 0,
    tavilyConfigured: getServerTavilyKeys().length > 0,
    exaConfigured: getServerExaKeys().length > 0,
    model: process.env.GEMINI_MODEL || GEMINI_FREE_MODELS[0],
    models: GEMINI_FREE_MODELS
  });
});

// مسیر سلامت
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    status: 'running',
    version: 'v30',
    geminiConfigured: getServerGeminiKeys().length > 0,
    tavilyConfigured: getServerTavilyKeys().length > 0,
    exaConfigured: getServerExaKeys().length > 0,
    model: process.env.GEMINI_MODEL || GEMINI_FREE_MODELS[0]
  });
});

// جستجوی زنده پزشکی (Tavily -> Exa AI -> Google Search Grounding)
app.post('/webhook/medical-search', async (req, res) => {
  try {
    if (!checkSecret(req)) {
      return res.status(401).json({ error: 'توکن دسترسی نامعتبر است.' });
    }
    const {
      query = '',
      clientTavilyKey = '',
      clientExaKey = '',
      clientGeminiKeys = [],
      num = 5
    } = req.body || {};
    const q = String(query || '').trim();
    if (!q) return res.status(400).json({ error: 'متن جستجو خالی است.' });

    const medicalQ = `${q} clinical guideline nursing cardiology radiology`;

    const tKeys = splitKeys(process.env.TAVILY_API_KEYS, process.env.TAVILY_API_KEY, clientTavilyKey);
    if (tKeys.length) {
      const tOut = await queryTavily(medicalQ, tKeys, Math.min(Number(num) || 5, 7));
      if (tOut.ok && tOut.sources.length) {
        return res.json({ ok: true, provider: 'Tavily', answer: tOut.answer || '', sources: tOut.sources });
      }
    }

    const eKeys = splitKeys(process.env.EXA_API_KEYS, process.env.EXA_API_KEY, clientExaKey);
    if (eKeys.length) {
      const eOut = await queryExa(medicalQ, eKeys, Math.min(Number(num) || 5, 7));
      if (eOut.ok && eOut.sources.length) {
        return res.json({ ok: true, provider: 'Exa AI', sources: eOut.sources });
      }
    }

    const gKeys = splitKeys(process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY, ...(Array.isArray(clientGeminiKeys) ? clientGeminiKeys : []));
    if (gKeys.length) {
      const gOut = await callGeminiAPI({
        keys: gKeys,
        model: process.env.GEMINI_MODEL || GEMINI_FREE_MODELS[0],
        userText: `جستجوی علمی و بالینی درباره موضوع زیر انجام بده و خلاصه معتبر به فارسی همراه با منابع بنویس:\n${medicalQ}`,
        images: [],
        enableGoogleSearch: true
      });
      return res.json({
        ok: true,
        provider: 'Google Search (Gemini)',
        answer: gOut.text,
        sources: gOut.groundingSources || []
      });
    }

    return res.status(400).json({ error: 'هیچ کلید جستجو (Tavily / Exa / Gemini) تنظیم نشده است.' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'خطا در جستجوی پزشکی' });
  }
});

// تحلیل بالینی Gemini Vision + جستجوی زنده Tavily / Exa / Google
app.post(['/webhook/clinical-interpret', '/'], async (req, res) => {
  try {
    if (!checkSecret(req)) {
      return res.status(401).json({ error: 'توکن دسترسی نامعتبر است.' });
    }

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

    const geminiKeys = splitKeys(process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY, ...(Array.isArray(clientGeminiKeys) ? clientGeminiKeys : []));
    const rawEnvSearch = String(process.env.LIVE_SEARCH ?? process.env.ENABLE_LIVE_SEARCH ?? process.env.USE_LIVE_SEARCH ?? '').trim().toLowerCase();
    const envSearchEnabled = ['true', '1', 'yes', 'on'].includes(rawEnvSearch);
    const envSearchDisabled = ['false', '0', 'no', 'off'].includes(rawEnvSearch);
    const effectiveLiveSearch = envSearchDisabled ? false : (Boolean(useLiveSearch) || envSearchEnabled);
    if (!geminiKeys.length) {
      return res.status(400).json({ error: 'هیچ کلید Gemini API در Render یا تنظیمات دستی تعریف نشده است.' });
    }

    const tavilyKeys = splitKeys(process.env.TAVILY_API_KEYS, process.env.TAVILY_API_KEY, clientTavilyKey);
    const exaKeys = splitKeys(process.env.EXA_API_KEYS, process.env.EXA_API_KEY, clientExaKey);

    let liveSources = [];
    let searchAnswer = '';
    if (effectiveLiveSearch) {
      const seed = (text || context || modalityLabel || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      if (seed) {
        if (tavilyKeys.length) {
          const tOut = await queryTavily(`${seed} clinical guideline interpretation`, tavilyKeys, 4);
          if (tOut.ok) { liveSources = tOut.sources; searchAnswer = tOut.answer || ''; }
        }
        if (!liveSources.length && exaKeys.length) {
          const eOut = await queryExa(`${seed} clinical guideline interpretation`, exaKeys, 4);
          if (eOut.ok) { liveSources = eOut.sources; }
        }
      }
    }

    const searchBlock = liveSources.length
      ? '\n\nمنابع زنده پزشکی یافت‌شده (Tavily/Exa):\n'
        + (searchAnswer ? `خلاصه جستجو: ${searchAnswer}\n` : '')
        + liveSources.map((s, i) => `${i + 1}. ${s.title}: ${s.snippet}`).join('\n')
      : '';

    const userText = [
      prompt,
      context ? `زمینه بیمار: ${context}` : '',
      text ? `متن/ریپورت ارسالی:\n${text}` : 'تصاویر پیوست را با دقت بررسی و تفسیر کن.',
      searchBlock
    ].filter(Boolean).join('\n\n');

    const useBuiltInGoogle = effectiveLiveSearch && liveSources.length === 0;
    const out = await callGeminiAPI({
      keys: geminiKeys,
      model: clientModel,
      userText,
      images,
      enableGoogleSearch: useBuiltInGoogle
    });

    if (out.groundingSources && out.groundingSources.length) {
      liveSources = liveSources.concat(out.groundingSources);
    }

    return res.json({
      ok: true,
      result: out.text,
      via: out.provider,
      sources: liveSources
    });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'خطا در ارتباط با Gemini' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Cardiac Gemini+Tavily+Exa Server v30 running on port ' + PORT));
