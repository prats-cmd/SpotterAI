const https = require('https');

// Model fallback chain (identical to server.js)
const MODELS = [
    'openai/gpt-oss-120b',   // replaces llama-3.3-70b-versatile
    'qwen/qwen3.6-27b',      // alternative flagship
    'openai/gpt-oss-20b',    // replaces llama-3.1-8b-instant
    'llama3-70b-8192',       // legacy fallback
    'gemma2-9b-it'           // last resort
];

function groqRequest(payload, apiKey) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(payload);
        const req = https.request({
            hostname: 'api.groq.com',
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.setTimeout(30000, () => req.destroy(new Error('Groq request timed out')));
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method Not Allowed' });
        return;
    }

    const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
    if (!GROQ_API_KEY) {
        res.status(500).json({
            error: 'GROQ_API_KEY not configured',
            hint: 'Add GROQ_API_KEY to your Vercel Project Settings > Environment Variables.'
        });
        return;
    }

    let payload = req.body;
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch (e) {
            res.status(400).json({ error: 'Invalid JSON' });
            return;
        }
    } else if (!payload) {
        let rawBody = '';
        await new Promise((resolve) => {
            req.on('data', chunk => rawBody += chunk.toString());
            req.on('end', resolve);
        });
        try {
            payload = JSON.parse(rawBody);
        } catch (e) {
            res.status(400).json({ error: 'Invalid JSON' });
            return;
        }
    }

    let lastResult = null;
    let lastData = null;

    try {
        for (const model of MODELS) {
            payload.model = model;
            const result = await groqRequest(payload, GROQ_API_KEY);
            let data;
            try { data = JSON.parse(result.body); } catch(e) { data = { raw: result.body }; }

            if (result.status >= 200 && result.status < 300) {
                res.setHeader('X-Model-Used', model);
                res.status(200).json(data);
                return;
            }

            console.log(`✗ ${model} → HTTP ${result.status}: ${result.body.slice(0, 120)}`);
            lastResult = result;
            lastData = data;
            if (result.status === 401 || result.status === 429) break;
        }

        const errMsg = lastData?.error?.message || lastResult?.body || 'All models failed';
        res.status(lastResult?.status || 500).json({
            error: errMsg,
            hint: lastResult?.status === 401
                ? 'Invalid API key — check console.groq.com'
                : lastResult?.status === 429
                ? 'Rate limited — wait a moment and try again.'
                : 'Check logs for full error details.'
        });
    } catch (err) {
        console.error('Network error:', err.message);
        res.status(502).json({ error: 'Could not reach Groq API', details: err.message });
    }
};
