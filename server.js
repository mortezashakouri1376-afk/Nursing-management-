const express = require('express');
const app = express();

app.use(express.json({ limit: '20mb' }));

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

async function fetchWithTimeout(url, options = {}, timeoutMs = 18000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseLooseJSON(rawText) {
  const cleaned = String(rawText || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return JSON.parse(cleaned.slice(start, end + 1));
  }
  throw new Error('خروجی ساختاریافته JSON از هوش مصنوعی معتبر نبود.');
}

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
  try { return await Promise.any(tasks); } catch (e) { return { ok: false, sources: [], answer: '', provider: '' }; }
}

async function callGeminiFast({ keys, model, userText, images, jsonMode = false, maxOutputTokens = 1800 }) {
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

  function buildPayload(withJsonMime) {
    const cfg = { temperature: jsonMode ? 0.1 : 0.2, maxOutputTokens };
    if (withJsonMime) cfg.responseMimeType = 'application/json';
    return { contents: [{ role: 'user', parts }], generationConfig: cfg };
  }

  let lastErr = '';
  for (const apiKey of keys) {
    const hosts = [
      { label: 'AIStudio', makeUrl: (m) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}` },
      ...(apiKey.startsWith('AQ.') ? [{ label: 'Vertex', makeUrl: (m) => `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}` }] : [])
    ];

    for (const host of hosts) {
      let hostBlocked = false;
      for (const gemModel of modelsToTry) {
        const url = host.makeUrl(gemModel);
        try {
          let r = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify(buildPayload(jsonMode))
          }, 18000);

          if (!r.ok && r.status === 400 && jsonMode) {
            r = await fetchWithTimeout(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
              body: JSON.stringify(buildPayload(false))
            }, 18000);
          }

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
          if ([404, 429, 503].includes(r.status)) continue;
          hostBlocked = true;
          break;
        } catch (e) {
          lastErr = `${host.label}/${gemModel}: ${e.name === 'AbortError' ? 'Timeout' : e.message}`;
          continue;
        }
      }
      if (!hostBlocked) break;
    }
  }
  throw new Error(lastErr || 'اتصال به Gemini ناموفق بود.');
}

app.get(['/', '/health'], (req, res) => {
  res.json({
    ok: true,
    status: 'running',
    version: 'v37',
    geminiConfigured: getGeminiKeys().length > 0,
    tavilyConfigured: getTavilyKeys().length > 0,
    exaConfigured: getExaKeys().length > 0,
    model: (cachedRoute && cachedRoute.model) || process.env.GEMINI_MODEL || GEMINI_FREE_MODELS[0],
    features: ['extract-fields', 'followup-chat', 'voice-to-chart', 'clinical-generate', 'serial-ecg']
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
      modalityLabel = '', prompt = '', text = '', context = '',
      images = [], useLiveSearch = false, model: clientModel = '',
      clientGeminiKeys = [], clientTavilyKey = '', clientExaKey = ''
    } = req.body || {};

    const geminiKeys = getGeminiKeys(Array.isArray(clientGeminiKeys) ? clientGeminiKeys : []);
    if (!geminiKeys.length) return res.status(400).json({ error: 'کلید Gemini API تنظیم نشده است.' });

    const rawEnvSearch = String(process.env.LIVE_SEARCH ?? '').trim().toLowerCase();
    const doSearch = ['false', '0', 'no', 'off'].includes(rawEnvSearch)
      ? false
      : (Boolean(useLiveSearch) || ['true', '1', 'yes', 'on'].includes(rawEnvSearch));

    let searchOut = { ok: false, sources: [], answer: '', provider: '' };
    if (doSearch) {
      const seed = (text || context || modalityLabel || '').replace(/\s+/g, ' ').trim().slice(0, 150);
      if (seed) {
        searchOut = await fastLiveSearch(`${seed} clinical guideline interpretation`, getTavilyKeys(clientTavilyKey), getExaKeys(clientExaKey), 4);
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

    const aiOut = await callGeminiFast({ keys: geminiKeys, model: clientModel, userText, images });
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

// V37-1: استخراج ساختاریافته JSON از عکس (آزمایش/ABG، اکو/رادیولوژی، مانیتور، اردر پزشک، مقایسه ۲ نوار قلب)
app.post('/webhook/extract-fields', async (req, res) => {
  try {
    if (!checkSecret(req)) return res.status(401).json({ error: 'توکن دسترسی نامعتبر است.' });
    const { mode = 'lab_abg', images = [], text = '', context = '', model = '', clientGeminiKeys = [] } = req.body || {};
    const geminiKeys = getGeminiKeys(Array.isArray(clientGeminiKeys) ? clientGeminiKeys : []);
    if (!geminiKeys.length) return res.status(400).json({ error: 'کلید Gemini API تنظیم نشده است.' });

    const prompts = {
      lab_abg: `تو دستیار استخراج دقیق آزمایشگاه و ABG برای پرستار بخش قلب هستی. از روی تصویر یا متن، فقط مقادیر واقعی دیده‌شده را استخراج کن (هر فیلد ناموجود را null بگذار، حدس نزن!).
خروجی را دقیقاً به‌صورت JSON معتبر با ساختار زیر برگردان:
{
  "fields": {
    "ph": null, "pco2": null, "po2": null, "hco3": null, "be": null, "sao2": null,
    "na": null, "k": null, "ca": null, "mg": null, "alb": null, "bs": null,
    "bun": null, "cr": null, "hb": null, "hct": null, "wbc": null, "plt": null,
    "inr": null, "pt": null, "ptt": null, "trop": null, "ckmb": null, "bnp": null,
    "ddimer": null, "crp": null, "ast": null, "alt": null
  },
  "abgInterpretationFa": "تفسیر کوتاه ABG به فارسی در صورت وجود مقادیر گازی، وگرنه رشته خالی",
  "panicFlags": ["لیست مقادیر بحرانی به فارسی"],
  "summaryFa": "خلاصه بالینی کوتاه و پرستاری به فارسی"
}`,
      radiology_echo: `تو دستیار استخراج گزارش رادیولوژی، اکوکاردیوگرافی و آنژیوگرافی هستی. از تصویر یا متن ریپورت، اطلاعات را دقیقاً به‌صورت JSON زیر استخراج کن:
{
  "modality": "Echo / CXR / CT / MRI / Angio",
  "reportTextEn": "متن تمیز انگلیسی ریپورت",
  "lvef": null,
  "stenosisSummary": "خلاصه تنگی عروق در آنژیوگرافی یا null",
  "checklistTags": ["از بین: Cardiomegaly, Pleural Effusion, Pulmonary Edema, Consolidation, Pneumothorax, RWMA, LVH, MR, TR, AS, Pericardial Effusion, Reduced EF, Normal"],
  "criticalAlert": false,
  "keyFindingsFa": ["یافته ۱ به فارسی", "یافته ۲ به فارسی"],
  "nursingActionsFa": ["اقدام پرستاری ۱", "اقدام پرستاری ۲"],
  "summaryFa": "خلاصه فارسی آماده درج در برگ گزارش پرستاری"
}`,
      vitals_monitor: `از روی تصویر صفحه مانیتور علائم حیاتی بیمار، مقادیر عددی را بخوان و دقیقاً JSON زیر را برگردان (مقادیر نامشخص null):
{
  "bp_sys": null, "bp_dia": null, "hr": null, "rr": null, "spo2": null, "temp": null,
  "rhythm": "ریتم مشاهده‌شده مثلاً NSR یا AFib یا null",
  "notesFa": "نکته کوتاه هشدار یا وضعیت پایداری به فارسی"
}`,
      order_kardex: `تو رمزگشای اردر دست‌نویس پزشک و کاردکس بخش قلب هستی. داروها و دستورات را بخوان؛ هر موردی که دست‌خطش ناخوانا یا مشکوک به خطای دوز است حتماً needsDoubleCheck را true بگذار. خروجی فقط JSON:
{
  "orders": [
    { "drugLine": "Amp Pantozol 40mg IV BD", "time": "", "category": "drug|lab|imaging|diet|care", "needsDoubleCheck": false, "noteFa": "توضیح کوتاه یا علت دبل‌چک" }
  ],
  "summaryFa": "خلاصه کلی اردر به فارسی"
}`,
      serial_ecg: `دو نوار قلب (تصویر ۱: نوار قبلی/بدو ورود، تصویر ۲: نوار جدید/حین درد) را با هم مقایسه کن و تغییرات دینامیک را دقیقاً در قالب JSON زیر برگردان:
{
  "ecg1SummaryFa": "خلاصه ریتم، HR و ST-T نوار اول",
  "ecg2SummaryFa": "خلاصه ریتم، HR و ST-T نوار دوم",
  "dynamicChangesFa": ["تغییر دینامیک ۱", "تغییر دینامیک ۲"],
  "urgency": "normal|warn|critical",
  "recommendationFa": "اقدام پرستاری و فوریت اطلاع به پزشک به فارسی",
  "chartLineFa": "یک جمله رسمی پیوسته آماده درج در برگ گزارش پرستاری"
}`
    };

    const sys = prompts[mode] || prompts.lab_abg;
    const userText = [sys, context ? `زمینه بیمار: ${context}` : '', text ? `متن ورودی:\n${text}` : ''].filter(Boolean).join('\n\n');
    const aiOut = await callGeminiFast({ keys: geminiKeys, model, userText, images, jsonMode: true, maxOutputTokens: 2000 });
    const parsed = parseLooseJSON(aiOut.text);
    return res.json({ ok: true, mode, data: parsed, via: aiOut.provider });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'خطا در استخراج خودکار فیلدها' });
  }
});

// V37-2: چت پیگیری روی همان مدرک تفسیرشده
app.post('/webhook/followup-chat', async (req, res) => {
  try {
    if (!checkSecret(req)) return res.status(401).json({ error: 'توکن دسترسی نامعتبر است.' });
    const { originalResult = '', originalContext = '', history = [], question = '', images = [], model = '', clientGeminiKeys = [] } = req.body || {};
    const geminiKeys = getGeminiKeys(Array.isArray(clientGeminiKeys) ? clientGeminiKeys : []);
    if (!geminiKeys.length) return res.status(400).json({ error: 'کلید Gemini API تنظیم نشده است.' });
    if (!String(question || '').trim()) return res.status(400).json({ error: 'متن سؤال خالی است.' });

    const histText = (Array.isArray(history) ? history.slice(-6) : [])
      .map(m => `${m.role === 'user' ? 'پرستار' : 'دستیار'}: ${m.text}`).join('\n');

    const userText = [
      'تو دستیار بالینی تخصصی پرستاری قلب هستی. کوتاه، دقیق، عملی و به فارسی پاسخ بده.',
      originalContext ? `زمینه بیمار: ${originalContext}` : '',
      originalResult ? `تفسیر قبلی مدرک:\n${String(originalResult).slice(0, 2200)}` : '',
      histText ? `گفت‌وگوی قبلی:\n${histText}` : '',
      `سؤال جدید پرستار: ${question}`
    ].filter(Boolean).join('\n\n');

    const aiOut = await callGeminiFast({ keys: geminiKeys, model, userText, images, maxOutputTokens: 1200 });
    return res.json({ ok: true, answer: aiOut.text, via: aiOut.provider });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'خطا در چت پیگیری' });
  }
});

// V37-3: تبدیل ویس محاوره‌ای فارسی به گزارش رسمی پرونده + ستون دارو
app.post('/webhook/voice-to-chart', async (req, res) => {
  try {
    if (!checkSecret(req)) return res.status(401).json({ error: 'توکن دسترسی نامعتبر است.' });
    const { transcript = '', stage = 'dur', context = '', model = '', clientGeminiKeys = [] } = req.body || {};
    const geminiKeys = getGeminiKeys(Array.isArray(clientGeminiKeys) ? clientGeminiKeys : []);
    if (!geminiKeys.length) return res.status(400).json({ error: 'کلید Gemini API تنظیم نشده است.' });
    if (!String(transcript || '').trim()) return res.status(400).json({ error: 'متن گفتار خالی است.' });

    const userText = `تو پرستار ارشد بخش قلب در ایران هستی. گفتار محاوره‌ای زیر را به نثر رسمی، پیوسته، دقیق و استاندارد «برگ گزارش پرستار ایران» تبدیل کن و داروها/اقدامات ذکرشده را جداگانه استخراج کن. خروجی فقط JSON:
{
  "formalChartFa": "متن رسمی و پیوسته پرستاری آماده درج در پرونده",
  "procedures": [ { "time": "HH:MM یا خالی", "text": "نام دارو/اقدام استاندارد مثلاً Tab TNG 0.4mg SL" } ],
  "vitals": { "bp": null, "hr": null, "rr": null, "spo2": null, "temp": null },
  "painNrs": null
}

مرحله گزارش: ${stage}
زمینه پرونده: ${context || 'ندارد'}
متن گفتار پرستار:
${transcript}`;

    const aiOut = await callGeminiFast({ keys: geminiKeys, model, userText, images: [], jsonMode: true, maxOutputTokens: 1200 });
    const parsed = parseLooseJSON(aiOut.text);
    return res.json({ ok: true, data: parsed, via: aiOut.provider });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'خطا در تبدیل ویس به گزارش' });
  }
});

// V37-4: تولید کارت آموزش ترخیص، خلاصه مدیریتی شیفت، بررسی عمیق تداخل دارویی و SBAR
app.post('/webhook/clinical-generate', async (req, res) => {
  try {
    if (!checkSecret(req)) return res.status(401).json({ error: 'توکن دسترسی نامعتبر است.' });
    const { task = '', data = {}, model = '', clientGeminiKeys = [] } = req.body || {};
    const geminiKeys = getGeminiKeys(Array.isArray(clientGeminiKeys) ? clientGeminiKeys : []);
    if (!geminiKeys.length) return res.status(400).json({ error: 'کلید Gemini API تنظیم نشده است.' });

    const taskPrompts = {
      discharge_card: 'بر اساس اطلاعات زیر، یک «کارت آموزش ترخیص» فارسی، ساده، صمیمی، خوانا و ساختاریافته برای خود بیمار قلبی و همراهش بنویس شامل: ۱) نحوه مصرف و هشدارهای داروها ۲) رژیم غذایی و فعالیت مجاز ۳) علائم هشدار مراجعه فوری به اورژانس ۴) مراقبت زخم/آنژیو و پیگیری بعدی.',
      ward_briefing: 'بر اساس گزارش‌های شیفت زیر، یک «خلاصه مدیریتی ۳۰ ثانیه‌ای» برای تحویل کل بخش یا ارائه به سوپروایزر به فارسی بنویس: تعداد کل/ترخیص، بیماران پرخطر، NPOها، موارد نیازمند پیگیری فوری در شیفت بعد و چالش‌ها.',
      drug_interaction: 'لیست داروهای زیر مربوط به بیمار قلبی است. به فارسی، کوتاه و بالینی موارد زیر را چک کن: ۱) ناسازگاری تزریق هم‌زمان از یک لاین (Y-Site) ۲) تداخلات خطرناک (خونریزی، طولانی شدن QTc، هایپرکالمی، افت فشار) ۳) نکات پایش پرستاری.',
      sbar_polish: 'اطلاعات زیر را به یک پیام تماس تلفنی بسیار کوتاه، حرفه‌ای و استاندارد SBAR به فارسی برای پزشک کشیک بخش قلب تبدیل کن.'
    };

    const userText = `${taskPrompts[task] || taskPrompts.sbar_polish}\n\nاطلاعات ورودی:\n${JSON.stringify(data, null, 2)}`;
    const aiOut = await callGeminiFast({ keys: geminiKeys, model, userText, images: [], maxOutputTokens: 1600 });
    return res.json({ ok: true, result: aiOut.text, via: aiOut.provider });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'خطا در تولید محتوای بالینی' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Cardiac AI Pro Server v37 running on port ' + PORT));
