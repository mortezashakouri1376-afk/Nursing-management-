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
    String(raw || '').split(/[\n,]+/).map(k => k.trim()).filter(Boolean).forEach(k => {
      if (!out.includes(k)) out.push(k);
    });
  });
  return out;
}

function getServerGeminiKeys() { return splitKeys(process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY); }
function getServerGroqKeys() { return splitKeys(process.env.GROQ_API_KEYS, process.env.GROQ_API_KEY); }
function getServerOpenRouterKeys() { return splitKeys(process.env.OPENROUTER_API_KEYS, process.env.OPENROUTER_API_KEY); }
function getServerTavilyKeys() { return splitKeys(process.env.TAVILY_API_KEYS, process.env.TAVILY_API_KEY); }
function getServerExaKeys() { return splitKeys(process.env.EXA_API_KEYS, process.env.EXA_API_KEY); }
function getServerSerperKeys() { return splitKeys(process.env.SERPER_API_KEYS, process.env.SERPER_API_KEY); }

// 1) Tavily AI Medical Search (1000 free searches/month, built-in AI summary + sources)
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


// 1b) Exa AI Neural Medical Search (1000 free searches/month)
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

// 2) Serper Google Search
async function querySerper(query, serperKeys, num = 5) {
  const q = String(query || '').trim();
  if (!q || !serperKeys.length) return { ok: false, sources: [] };
  let lastErr = '';
  for (const apiKey of serperKeys) {
    try {
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, num, hl: 'en', gl: 'us' })
      });
      if (r.ok) {
        const data = await r.json();
        const organic = Array.isArray(data.organic) ? data.organic : [];
        const sources = organic.slice(0, num).map(it => ({
          title: it.title || '',
          link: it.link || '',
          snippet: it.snippet || ''
        }));
        return { ok: true, sources, provider: 'Serper' };
      }
      lastErr = `Serper HTTP ${r.status}`;
      if (![429, 403, 401].includes(r.status)) break;
    } catch (e) {
      lastErr = e.message || 'Serper error';
    }
  }
  return { ok: false, sources: [], error: lastErr };
}

// 3) Groq Ultra-Fast Vision + Text (Llama-4 Scout 17B Vision — Free Tier)
async function callGroqAPI({ keys, model, systemPrompt, userText, images }) {
  if (!keys.length) throw new Error('کلید Groq تعریف نشده است');
  const groqModel = model || process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
  const content = [{ type: 'text', text: userText }];
  if (Array.isArray(images)) {
    images.slice(0, 4).forEach(im => {
      if (im && im.base64) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${im.mimeType || 'image/jpeg'};base64,${im.base64}` }
        });
      }
    });
  }
  let lastErr = '';
  for (const apiKey of keys) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: groqModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content }
        ],
        temperature: 0.25,
        max_tokens: 2048
      })
    });
    if (r.ok) {
      const data = await r.json();
      const text = data?.choices?.[0]?.message?.content || '';
      if (text) return { text, provider: 'Groq (Llama-4 Vision)' };
    }
    lastErr = `Groq HTTP ${r.status}: ${(await r.text()).slice(0, 180)}`;
    if (![429, 503, 403, 401].includes(r.status)) break;
  }
  throw new Error(lastErr || 'Groq failed');
}

// 4) OpenRouter Free Models (Llama / Qwen / DeepSeek / Gemma Free)
async function callOpenRouterAPI({ keys, model, systemPrompt, userText, images }) {
  if (!keys.length) throw new Error('کلید OpenRouter تعریف نشده است');
  const orModel = model || process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
  const hasImgs = Array.isArray(images) && images.some(im => im && im.base64);
  const content = [{ type: 'text', text: userText }];
  if (hasImgs) {
    images.slice(0, 4).forEach(im => {
      if (im && im.base64) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${im.mimeType || 'image/jpeg'};base64,${im.base64}` }
        });
      }
    });
  }
  let lastErr = '';
  for (const apiKey of keys) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://mortezashakouri1376-afk.github.io',
        'X-Title': 'Cardiac Nursing Clinical Interpreter'
      },
      body: JSON.stringify({
        model: orModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: hasImgs ? content : userText }
        ],
        temperature: 0.25
      })
    });
    if (r.ok) {
      const data = await r.json();
      const text = data?.choices?.[0]?.message?.content || '';
      if (text) return { text, provider: 'OpenRouter (' + orModel.split('/')[0] + ')' };
    }
    lastErr = `OpenRouter HTTP ${r.status}: ${(await r.text()).slice(0, 180)}`;
    if (![429, 503, 403, 401].includes(r.status)) break;
  }
  throw new Error(lastErr || 'OpenRouter failed');
}

// 5) Gemini Vision + Built-in Google Search Grounding (Free Live Search without Serper!)
async function callGeminiAPI({ keys, model, userText, images, enableGoogleSearch }) {
  if (!keys.length) throw new Error('کلید Gemini تعریف نشده است');
  const gemModel = model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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
  const payload = { contents: [{ role: 'user', parts }] };
  if (enableGoogleSearch) {
    payload.tools = [{ google_search: {} }];
  }

  let lastErr = '';
  for (const apiKey of keys) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(gemModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      if (text) return { text, provider: 'Gemini (' + gemModel + ')', groundingSources: gSources };
    }
    lastErr = `Gemini HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
    if (![429, 503, 403, 401].includes(r.status)) break;
  }
  throw new Error(lastErr || 'Gemini failed');
}

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    status: 'running',
    geminiConfigured: getServerGeminiKeys().length > 0,
    groqConfigured: getServerGroqKeys().length > 0,
    openrouterConfigured: getServerOpenRouterKeys().length > 0,
    tavilyConfigured: getServerTavilyKeys().length > 0,
    exaConfigured: getServerExaKeys().length > 0,
    serperConfigured: getServerSerperKeys().length > 0,
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
  });
});

// Live Medical Search Endpoint (Tavily -> Serper -> Gemini Google Search Grounding)
app.post('/webhook/medical-search', async (req, res) => {
  try {
    if (!checkSecret(req)) {
      return res.status(401).json({ error: 'توکن دسترسی نامعتبر است.' });
    }
    const {
      query = '',
      clientTavilyKey = '',
      clientExaKey = '',
      clientSerperKey = '',
      clientGeminiKeys = [],
      num = 5
    } = req.body || {};
    const q = String(query || '').trim();
    if (!q) return res.status(400).json({ error: 'متن جستجو خالی است.' });

    const medicalQ = `${q} clinical guideline nursing cardiology radiology`;

    // 1. Try Tavily first
    const tKeys = splitKeys(process.env.TAVILY_API_KEYS, process.env.TAVILY_API_KEY, clientTavilyKey);
    if (tKeys.length) {
      const tOut = await queryTavily(medicalQ, tKeys, Math.min(Number(num) || 5, 7));
      if (tOut.ok && tOut.sources.length) {
        return res.json({ ok: true, provider: 'Tavily', answer: tOut.answer || '', sources: tOut.sources });
      }
    }

    // 1b. Try Exa AI second
    const eKeys = splitKeys(process.env.EXA_API_KEYS, process.env.EXA_API_KEY, clientExaKey);
    if (eKeys.length) {
      const eOut = await queryExa(medicalQ, eKeys, Math.min(Number(num) || 5, 7));
      if (eOut.ok && eOut.sources.length) {
        return res.json({ ok: true, provider: 'Exa AI', sources: eOut.sources });
      }
    }

    // 2. Try Serper third
    const sKeys = splitKeys(process.env.SERPER_API_KEYS, process.env.SERPER_API_KEY, clientSerperKey);
    if (sKeys.length) {
      const sOut = await querySerper(medicalQ, sKeys, Math.min(Number(num) || 5, 7));
      if (sOut.ok && sOut.sources.length) {
        return res.json({ ok: true, provider: 'Serper', sources: sOut.sources });
      }
    }

    // 3. Fallback to Gemini Built-in Google Search Grounding!
    const gKeys = splitKeys(process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY, ...(Array.isArray(clientGeminiKeys) ? clientGeminiKeys : []));
    if (gKeys.length) {
      const gOut = await callGeminiAPI({
        keys: gKeys,
        model: 'gemini-2.5-flash',
        userText: `جستجوی علمی و بالینی درباره موضوع زیر انجام بده و خلاصه معتبر به فارسی همراه با منابع بنویس:\n${medicalQ}`,
        images: [],
        enableGoogleSearch: true
      });
      return res.json({
        ok: true,
        provider: 'Google Search (Gemini Grounding)',
        answer: gOut.text,
        sources: gOut.groundingSources || []
      });
    }

    return res.status(400).json({ error: 'هیچ کلید جستجو (Tavily / Serper / Gemini) تنظیم نشده است.' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'خطا در جستجوی پزشکی' });
  }
});

// Multi-AI Clinical Interpretation Endpoint (Gemini + Groq + OpenRouter + Live Web Search)
app.post('/webhook/clinical-interpret', async (req, res) => {
  try {
    if (!checkSecret(req)) {
      return res.status(401).json({ error: 'توکن دسترسی نامعتبر است.' });
    }

    const {
      provider = 'auto', // 'auto' | 'gemini' | 'groq' | 'openrouter'
      modalityLabel = '',
      prompt = '',
      text = '',
      context = '',
      images = [],
      useLiveSearch = false,
      useSerper = false,
      model: clientModel = '',
      groqModel: clientGroqModel = '',
      openrouterModel: clientOrModel = '',
      clientGeminiKeys = [],
      clientGroqKey = '',
      clientOpenRouterKey = '',
      clientTavilyKey = '',
      clientExaKey = '',
      clientSerperKey = ''
    } = req.body || {};

    const wantSearch = Boolean(useLiveSearch || useSerper);
    const geminiKeys = splitKeys(process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY, ...(Array.isArray(clientGeminiKeys) ? clientGeminiKeys : []));
    const groqKeys = splitKeys(process.env.GROQ_API_KEYS, process.env.GROQ_API_KEY, clientGroqKey);
    const orKeys = splitKeys(process.env.OPENROUTER_API_KEYS, process.env.OPENROUTER_API_KEY, clientOpenRouterKey);
    const tavilyKeys = splitKeys(process.env.TAVILY_API_KEYS, process.env.TAVILY_API_KEY, clientTavilyKey);
    const exaKeys = splitKeys(process.env.EXA_API_KEYS, process.env.EXA_API_KEY, clientExaKey);
    const serperKeys = splitKeys(process.env.SERPER_API_KEYS, process.env.SERPER_API_KEY, clientSerperKey);

    let liveSources = [];
    let searchAnswer = '';
    if (wantSearch) {
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
        if (!liveSources.length && serperKeys.length) {
          const sOut = await querySerper(`${seed} clinical guideline interpretation`, serperKeys, 4);
          if (sOut.ok) { liveSources = sOut.sources; }
        }
      }
    }

    const searchBlock = liveSources.length
      ? '\n\nمنابع زنده پزشکی یافت‌شده (Tavily/Serper):\n'
        + (searchAnswer ? `خلاصه جستجو: ${searchAnswer}\n` : '')
        + liveSources.map((s, i) => `${i + 1}. ${s.title}: ${s.snippet}`).join('\n')
      : '';

    const userText = [
      prompt,
      context ? `زمینه بیمار: ${context}` : '',
      text ? `متن/ریپورت ارسالی:\n${text}` : 'تصاویر پیوست را با دقت بررسی و تفسیر کن.',
      searchBlock
    ].filter(Boolean).join('\n\n');

    const chain = provider === 'gemini' ? ['gemini']
      : provider === 'groq' ? ['groq']
      : provider === 'openrouter' ? ['openrouter']
      : ['gemini', 'groq', 'openrouter'];

    let finalOut = null;
    const errors = [];

    for (const p of chain) {
      try {
        if (p === 'gemini' && geminiKeys.length) {
          // If live search requested and neither Tavily nor Serper returned sources, activate Gemini built-in Google Search!
          const useBuiltInGoogle = wantSearch && liveSources.length === 0;
          const r = await callGeminiAPI({
            keys: geminiKeys,
            model: clientModel,
            userText,
            images,
            enableGoogleSearch: useBuiltInGoogle
          });
          if (r.groundingSources && r.groundingSources.length) {
            liveSources = liveSources.concat(r.groundingSources);
          }
          finalOut = r;
          break;
        }
        if (p === 'groq' && groqKeys.length) {
          finalOut = await callGroqAPI({
            keys: groqKeys,
            model: clientGroqModel,
            systemPrompt: prompt,
            userText,
            images
          });
          break;
        }
        if (p === 'openrouter' && orKeys.length) {
          finalOut = await callOpenRouterAPI({
            keys: orKeys,
            model: clientOrModel,
            systemPrompt: prompt,
            userText,
            images
          });
          break;
        }
      } catch (e) {
        errors.push(`${p}: ${e.message}`);
      }
    }

    if (!finalOut) {
      return res.status(502).json({
        error: errors.length ? errors.join(' | ') : 'هیچ کلید API فعالی (Gemini / Groq / OpenRouter) تنظیم نشده است.'
      });
    }

    return res.json({
      ok: true,
      result: finalOut.text,
      via: finalOut.provider,
      sources: liveSources
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'خطای داخلی سرور' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Multi-AI + Live Search Server running on port ' + PORT));
