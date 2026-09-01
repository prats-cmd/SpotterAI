// Spotter proxy server — powered by Groq (free, fast, OpenAI-compatible)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

// ── API key ──────────────────────────────────────────────────────────────────
let GROQ_API_KEY = process.env.GROQ_API_KEY || '';
try {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    GROQ_API_KEY = config.GROQ_API_KEY || GROQ_API_KEY;
} catch (e) {
    console.log('! No config.json — set GROQ_API_KEY in environment or create config.json');
}

// ── Model fallback chain (updated Sep 2026 per Groq deprecation notice) ──────
const MODELS = [
    'openai/gpt-oss-120b',   // replaces llama-3.3-70b-versatile
    'qwen/qwen3.6-27b',      // alternative flagship
    'openai/gpt-oss-20b',    // replaces llama-3.1-8b-instant
    'llama3-70b-8192',       // legacy fallback (still active for now)
    'gemma2-9b-it'           // last resort
];

// ── Groq request helper ──────────────────────────────────────────────────────
function groqRequest(payload) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(payload);
        const req = https.request({
            hostname: 'api.groq.com',
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
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

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url.split('?')[0];

    // Health check
    if (url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, hasKey: !!GROQ_API_KEY, provider: 'Groq' }));
        return;
    }

    // Chat proxy
    if (url === '/api/chat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            if (!GROQ_API_KEY) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'GROQ_API_KEY not configured', hint: 'Add it to config.json and restart.' }));
                return;
            }

            let payload;
            try { payload = JSON.parse(body); }
            catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

            // Try each model until one succeeds
            let lastResult = null, lastData = null;
            try {
                for (const model of MODELS) {
                    payload.model = model;
                    const result = await groqRequest(payload);
                    let data;
                    try { data = JSON.parse(result.body); } catch(e) { data = { raw: result.body }; }

                    if (result.status >= 200 && result.status < 300) {
                        console.log(`✓ Model: ${model}`);
                        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Model-Used': model });
                        res.end(JSON.stringify(data));
                        return;
                    }

                    console.log(`✗ ${model} → HTTP ${result.status}: ${result.body.slice(0, 120)}`);
                    lastResult = result;
                    lastData = data;
                    // Only keep probing on model-not-found errors; stop on auth/rate-limit
                    if (result.status === 401 || result.status === 429) break;
                }

                // All models failed
                const errMsg = lastData?.error?.message || lastResult?.body || 'All models failed';
                console.error('All Groq models failed. Last error:', errMsg);
                res.writeHead(lastResult?.status || 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: errMsg,
                    hint: lastResult?.status === 401
                        ? 'Invalid API key — check console.groq.com'
                        : lastResult?.status === 429
                        ? 'Rate limited — wait a moment and try again.'
                        : 'Check the terminal for full error details.'
                }));

            } catch (err) {
                console.error('Network error:', err.message);
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Could not reach Groq API', details: err.message }));
            }
        });
        return;
    }

    // Static files
    const fileName = (url === '/' || url === '/index.html') ? 'index_spotter.html' : path.basename(url);
    if (fileName === 'config.json') { res.writeHead(403); res.end('Forbidden'); return; }

    const TYPES = {
        '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
    };
    if (/\.(html|css|js|svg|png|ico)$/i.test(fileName)) {
        fs.readFile(path.join(__dirname, fileName), (err, data) => {
            if (err) { res.writeHead(404); res.end('Not Found'); }
            else { res.writeHead(200, { 'Content-Type': TYPES[path.extname(fileName).toLowerCase()] || 'text/plain' }); res.end(data); }
        });
        return;
    }

    res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, () => {
    console.log('');
    console.log('  ✓ Spotter server → http://localhost:' + PORT);
    console.log('  ✓ Provider: Groq  |  Models: ' + MODELS.join(', '));
    console.log('  ✓ API key: ' + (GROQ_API_KEY ? 'loaded (' + GROQ_API_KEY.slice(0, 8) + '…)' : 'MISSING'));
    console.log('');
});
