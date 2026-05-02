exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if(event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if(event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const ANT_KEY   = process.env.ANTHROPIC_API_KEY;
  const APIFY_KEY = process.env.APIFY_API_KEY;

  if(!ANT_KEY || !APIFY_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API keys not configured on server' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { action } = body;

  // ── Action: parse resume with Claude ──────────────────
  if(action === 'parse_resume') {
    const { fileData, fileMediaType, prompt, system } = body;

    let content;
    if(fileMediaType === 'application/pdf') {
      content = [
        { type:'document', source:{ type:'base64', media_type:'application/pdf', data:fileData }},
        { type:'text', text:prompt }
      ];
    } else {
      // DOCX or TXT: fileData is base64-encoded plain text
      let resumeText = '';
      try {
        resumeText = decodeURIComponent(escape(Buffer.from(fileData, 'base64').toString('binary')));
      } catch(e) {
        resumeText = Buffer.from(fileData, 'base64').toString('utf8');
      }
      content = `${prompt}\n\nResume text:\n${resumeText.slice(0, 8000)}`;
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANT_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:6000, system, messages:[{ role:'user', content }] })
    });
    const data = await res.json();
    if(!res.ok) return { statusCode: res.status, headers, body: JSON.stringify({ error: data.error?.message || 'Claude error' }) };
    return { statusCode: 200, headers, body: JSON.stringify({ result: data.content[0].text }) };
  }

  // ── Action: call Claude with plain text (ranking) ─────
  if(action === 'claude_text') {
    const { prompt, system } = body;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANT_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:6000, system, messages:[{ role:'user', content: prompt }] })
    });
    const data = await res.json();
    if(!res.ok) return { statusCode: res.status, headers, body: JSON.stringify({ error: data.error?.message || 'Claude error' }) };
    return { statusCode: 200, headers, body: JSON.stringify({ result: data.content[0].text }) };
  }

  // ── Action: start Apify run (returns run ID immediately) ──
  if(action === 'apify_start') {
    const { actorId, input } = body;
    const res = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${APIFY_KEY}` },
      body: JSON.stringify(input)
    });
    const data = await res.json();
    if(!res.ok) return { statusCode: res.status, headers, body: JSON.stringify({ error: `Apify start failed: ${res.status}` }) };
    return { statusCode: 200, headers, body: JSON.stringify({ runId: data.data?.id, datasetId: data.data?.defaultDatasetId }) };
  }

  // ── Action: check Apify run status ────────────────────
  if(action === 'apify_status') {
    const { runId } = body;
    const res = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
      headers:{ 'Authorization':`Bearer ${APIFY_KEY}` }
    });
    const data = await res.json();
    if(!res.ok) return { statusCode: res.status, headers, body: JSON.stringify({ error: 'Status check failed' }) };
    return { statusCode: 200, headers, body: JSON.stringify({ status: data.data?.status, datasetId: data.data?.defaultDatasetId }) };
  }

  // ── Action: fetch Apify dataset results ───────────────
  if(action === 'apify_results') {
    const { datasetId } = body;
    const res = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&limit=20`, {
      headers:{ 'Authorization':`Bearer ${APIFY_KEY}` }
    });
    const data = await res.json();
    if(!res.ok) return { statusCode: res.status, headers, body: JSON.stringify({ error: 'Results fetch failed' }) };
    return { statusCode: 200, headers, body: JSON.stringify({ items: data }) };
  }

  // ── Action: SerpAPI Google Jobs search ───────────────
  if(action === 'serpapi_jobs') {
    const SERP_KEY = process.env.SERPER_API_KEY || process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;
    if(!SERP_KEY) return { statusCode: 200, headers, body: JSON.stringify({ jobs: [], error: 'No SerpAPI key found in environment' }) };
    const { query, location } = body;
    const isUAE = (location||'').toLowerCase().includes('dubai') || (location||'').toLowerCase().includes('uae');
    const gl = isUAE ? 'ae' : 'in';
    const q = encodeURIComponent(`${query} jobs`);
    const loc = encodeURIComponent(location || 'India');
    const url = `https://serpapi.com/search?engine=google_jobs&q=${q}&location=${loc}&gl=${gl}&hl=en&api_key=${SERP_KEY}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if(data.error) {
        console.error('SerpAPI error:', data.error);
        return { statusCode: 200, headers, body: JSON.stringify({ jobs: [], serpError: data.error }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ jobs: data.jobs_results || [] }) };
    } catch(e) {
      console.error('SerpAPI fetch error:', e.message);
      return { statusCode: 200, headers, body: JSON.stringify({ jobs: [], fetchError: e.message }) };
    }
  }

  // ── Action: Adzuna jobs search ────────────────────────
  if(action === 'adzuna_search') {
    const ADZUNA_ID  = process.env.ADZUNA_APP_ID;
    const ADZUNA_KEY = process.env.ADZUNA_API_KEY;
    if(!ADZUNA_ID || !ADZUNA_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Adzuna keys not configured' }) };
    const { query, location } = body;
    const isUAE = (location||'').toLowerCase().includes('dubai') || (location||'').toLowerCase().includes('uae');
    const country = isUAE ? 'ae' : 'in';
    const loc = encodeURIComponent(location || '');
    const q   = encodeURIComponent(query);
    const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?app_id=${ADZUNA_ID}&app_key=${ADZUNA_KEY}&results_per_page=15&what=${q}&where=${loc}&max_days_old=15&sort_by=date&content-type=application/json`;
    const res = await fetch(url);
    const data = await res.json();
    if(!res.ok) return { statusCode: res.status, headers, body: JSON.stringify({ error: 'Adzuna error' }) };
    return { statusCode: 200, headers, body: JSON.stringify({ results: data.results || [] }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
};
