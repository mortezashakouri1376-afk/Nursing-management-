if (!checkSecret(req)) return res.status(401).json({ error: 'توکن دسترسی نامعتبر است.' });
    const { query = '', clientTavilyKey = '', clientExaKey = '', num = 5 } = req.body || {};
    const q = String(query || '').trim();
    if (!q) return res.status(400).json({ error: 'متن جستجو خالی است.' });

    const out = await fastLiveSearch(
      ${q} clinical guideline cardiology radiology,
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
      const seed = (text  context  modalityLabel || '').replace(/\s+/g, ' ').trim().slice(0, 150);
      if (seed) {
        searchOut = await fastLiveSearch(
          ${seed} clinical guideline interpretation,
          getTavilyKeys(clientTavilyKey),
          getExaKeys(clientExaKey),
          4
        );
      }
    }

    const searchBlock = searchOut.ok && searchOut.sources.length
      ? \n\nمنابع زنده پزشکی (${searchOut.provider}):\n
        + (searchOut.answer ? خلاصه: ${searchOut.answer}\n : '')
        + searchOut.sources.map((s, i) => ${i + 1}. ${s.title}: ${s.snippet}).join('\n')
      : '';

    const userText = [
      prompt,
      context ? زمینه بیمار: ${context} : '',
      text ? متن/ریپورت ارسالی:\n${text} : 'تصاویر پیوست را با دقت بررسی و تفسیر کن.',
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
      via: aiOut.provider + (searchOut.ok ?  + ${searchOut.provider} : ''),
      sources: searchOut.sources || []
    });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'خطا در ارتباط با سرور هوش مصنوعی' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Fast Cardiac AI Server v32 running on port ' + PORT));
