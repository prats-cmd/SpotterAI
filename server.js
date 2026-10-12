// Spotter proxy server — powered by NVIDIA Nemotron (fast, OpenAI-compatible)
// + Persistent anonymous memory system

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const memory = require('./services/memory');

const PORT = 3000;

// ── API key ──────────────────────────────────────────────────────────────────
let NEMOTRON_API_KEY = process.env.NEMOTRON_API_KEY || process.env.NVIDIA_API_KEY || process.env.GROQ_API_KEY || '';
try {
    const configPath = fs.existsSync(path.join(__dirname, 'config.json'))
        ? path.join(__dirname, 'config.json')
        : path.join(__dirname, '..', 'config.json');
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        NEMOTRON_API_KEY = config.NEMOTRON_API_KEY || config.NVIDIA_API_KEY || config.GROQ_API_KEY || NEMOTRON_API_KEY;
    } else {
        console.log('! No config.json — set NEMOTRON_API_KEY in environment or create config.json');
    }
} catch (e) {
    console.log('! Could not read config.json: ' + e.message);
}

// ── Model fallback chain for NVIDIA Nemotron ─────────────────────────────────
const MODELS = [
    'nvidia/nemotron-3-ultra-550b-a55b',
    'nvidia/nemotron-3-super-120b-a12b',
    'nvidia/nemotron-3.5-lightning-30b-a3b',
    'openai/gpt-oss-20b'
];

// ── Cookie helpers ───────────────────────────────────────────────────────────
function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    cookieHeader.split(';').forEach(pair => {
        const [name, ...rest] = pair.trim().split('=');
        if (name) cookies[name.trim()] = decodeURIComponent(rest.join('=').trim());
    });
    return cookies;
}

function getOrSetUserId(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    let userId = cookies['spotter_sid'];
    let isNew = false;

    if (!userId) {
        userId = memory.generateUserId();
        isNew = true;
        // Set cookie: 1 year expiry, HttpOnly, SameSite=Lax
        res.setHeader('Set-Cookie',
            `spotter_sid=${userId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
        );
    }

    // Ensure user record exists in storage
    memory.getOrCreateUser(userId);
    return { userId, isNew };
}

// ── JSON body parser helper ──────────────────────────────────────────────────
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

// ── Nemotron request helper ──────────────────────────────────────────────────
function nemotronRequest(payload) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(payload);
        const req = https.request({
            hostname: 'integrate.api.nvidia.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${NEMOTRON_API_KEY}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.setTimeout(30000, () => req.destroy(new Error('Nemotron request timed out')));
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    // CORS — allow credentials for cookie support
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url.split('?')[0];

    // ── Health check ─────────────────────────────────────────────────────────
    if (url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, hasKey: !!NEMOTRON_API_KEY, provider: 'Nemotron', memory: true }));
        return;
    }

    // ── Memory status endpoint ───────────────────────────────────────────────
    if (url === '/api/memory-status' && req.method === 'GET') {
        const { userId } = getOrSetUserId(req, res);
        const status = memory.getMemoryStatus(userId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
    }

    // ── Save workout endpoint ────────────────────────────────────────────────
    if (url === '/api/workout' && req.method === 'POST') {
        const { userId } = getOrSetUserId(req, res);
        try {
            const body = await parseBody(req);
            const record = await memory.saveWorkout(userId, body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, workout: record }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid workout data', details: e.message }));
        }
        return;
    }

    // ── Update profile endpoint ──────────────────────────────────────────────
    if (url === '/api/profile' && req.method === 'POST') {
        const { userId } = getOrSetUserId(req, res);
        try {
            const body = await parseBody(req);
            const updated = await memory.updateProfile(userId, body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, profile: updated?.profile }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid profile data', details: e.message }));
        }
        return;
    }

    // ── Clear user data endpoint ─────────────────────────────────────────────
    if (url === '/api/clear-data' && req.method === 'DELETE') {
        const { userId } = getOrSetUserId(req, res);
        await memory.clearUserData(userId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'All your data has been cleared.' }));
        return;
    }

    // ── Chat proxy (with memory context injection) ───────────────────────────
    if (url === '/api/chat' && req.method === 'POST') {
        const { userId } = getOrSetUserId(req, res);

        let payload;
        try { payload = await parseBody(req); }
        catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
        }

        if (!NEMOTRON_API_KEY) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'NEMOTRON_API_KEY not configured',
                hint: 'Add it to config.json (or NEMOTRON_API_KEY env) and restart.'
            }));
            return;
        }

        // ── Inject saved user context into the system prompt ─────────────
        const savedContext = memory.buildContextForAI(userId);
        if (savedContext && payload.messages && payload.messages.length > 0) {
            // Find the system message and append context
            const sysIdx = payload.messages.findIndex(m => m.role === 'system');
            if (sysIdx >= 0) {
                payload.messages[sysIdx].content += savedContext;
            } else {
                // Prepend a system message with context
                payload.messages.unshift({
                    role: 'system',
                    content: 'You are Spotter, an AI fitness coach.' + savedContext
                });
            }
        }

        // Try each model until one succeeds
        let lastResult = null, lastData = null;
        try {
            for (const model of MODELS) {
                payload.model = model;
                const result = await nemotronRequest(payload);
                let data;
                try { data = JSON.parse(result.body); } catch(e) { data = { raw: result.body }; }

                if (result.status >= 200 && result.status < 300) {
                    console.log(`✓ Model: ${model} | User: ${userId.slice(0, 16)}…`);

                    // ── Extract and save workout data from AI response ───
                    try {
                        const aiReply = data.choices?.[0]?.message?.content || '';
                        const userMsg = payload.messages?.[payload.messages.length - 1]?.content || '';
                        await extractAndSaveWorkoutData(userId, userMsg, aiReply);
                    } catch (extractErr) {
                        console.error('[memory] Extract error (non-fatal):', extractErr.message);
                    }

                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        'X-Model-Used': model,
                        'X-Spotter-User': userId.slice(0, 16)
                    });
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
            console.error('All Nemotron models failed. Last error:', errMsg);
            res.writeHead(lastResult?.status || 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: errMsg,
                hint: lastResult?.status === 401
                    ? 'Invalid API key — check build.nvidia.com'
                    : lastResult?.status === 429
                    ? 'Rate limited — wait a moment and try again.'
                    : 'Check the terminal for full error details.'
            }));

        } catch (err) {
            console.error('Network error:', err.message);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Could not reach Nemotron API', details: err.message }));
        }
        return;
    }

    // ── Static files ─────────────────────────────────────────────────────────
    let filePath;
    if (url === '/' || url === '/index.html' || url === '/index_spotter.html') {
        filePath = path.join(__dirname, 'public', 'index.html');
        if (!fs.existsSync(filePath)) {
            filePath = path.join(__dirname, 'index.html');
        }
    } else {
        // Serve from public/ directory or project root
        const safeName = path.basename(url);
        if (safeName === 'config.json') { res.writeHead(403); res.end('Forbidden'); return; }
        filePath = path.join(__dirname, 'public', safeName);
        if (!fs.existsSync(filePath)) {
            filePath = path.join(__dirname, safeName);
        }
    }

    const TYPES = {
        '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
        '.json': 'application/json'
    };
    const ext = path.extname(filePath).toLowerCase();
    if (TYPES[ext]) {
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end('Not Found'); }
            else { res.writeHead(200, { 'Content-Type': TYPES[ext] || 'text/plain' }); res.end(data); }
        });
        return;
    }

    res.writeHead(404); res.end('Not Found');
});

// ── Extract workout data from conversation ───────────────────────────────────
// Pattern-matches user messages for workout logging intent
async function extractAndSaveWorkoutData(userId, userMsg, aiReply) {
    const lower = userMsg.toLowerCase();

    // Detect workout logging patterns
    const workoutPatterns = [
        /(?:i\s+)?(?:just\s+)?did\s+(\d+)\s*(?:sets?\s+(?:of\s+)?)?(\d+)\s*reps?\s+(?:of\s+)?(.+?)(?:\s+(?:at|with|@)\s+(\d+(?:\.\d+)?)\s*(?:kg|lbs?|pounds?))?/i,
        /(?:logged?|completed?|finished)\s+(.+?)[\s:,]+(\d+)\s*(?:sets?)?\s*[x×]\s*(\d+)\s*(?:reps?)?\s*(?:(?:at|@|with)\s+(\d+(?:\.\d+)?)\s*(?:kg|lbs?)?)?/i,
        /(.+?)[\s:]+(\d+)\s*[x×]\s*(\d+)\s*(?:@|at)\s*(\d+(?:\.\d+)?)\s*(?:kg|lbs?)?/i
    ];

    for (const pattern of workoutPatterns) {
        const match = lower.match(pattern);
        if (match) {
            // Normalize — different patterns capture in different orders
            let exercise, sets, reps, weight;

            if (pattern === workoutPatterns[0]) {
                sets = parseInt(match[1]) || 1;
                reps = parseInt(match[2]) || 0;
                exercise = match[3]?.trim() || 'Unknown';
                weight = parseFloat(match[4]) || 0;
            } else {
                exercise = match[1]?.trim() || 'Unknown';
                sets = parseInt(match[2]) || 1;
                reps = parseInt(match[3]) || 0;
                weight = parseFloat(match[4]) || 0;
            }

            // Build sets array
            const setsArray = [];
            for (let i = 0; i < sets; i++) {
                setsArray.push({ reps, weightKg: weight });
            }

            await memory.saveWorkout(userId, {
                exercise: exercise.charAt(0).toUpperCase() + exercise.slice(1),
                sets: setsArray
            });

            console.log(`  💾 Saved workout: ${exercise} ${sets}x${reps} @ ${weight}kg for ${userId.slice(0, 16)}…`);
            return;
        }
    }

    // Also detect profile updates from conversation
    const goalPatterns = [
        /(?:my\s+)?goal\s+is\s+(?:to\s+)?(.+)/i,
        /(?:i\s+want\s+to|i'm\s+trying\s+to)\s+(.+)/i
    ];
    for (const pattern of goalPatterns) {
        const match = lower.match(pattern);
        if (match) {
            const goal = match[1].trim();
            if (goal.length > 3 && goal.length < 100) {
                await memory.updateProfile(userId, { goal: goal.charAt(0).toUpperCase() + goal.slice(1) });
                console.log(`  💾 Updated goal for ${userId.slice(0, 16)}…: ${goal}`);
            }
            return;
        }
    }
}

server.listen(PORT, () => {
    console.log('');
    console.log('  ✓ Spotter server → http://localhost:' + PORT);
    console.log('  ✓ Provider: Nemotron (NVIDIA NIM)  |  Models: ' + MODELS.join(', '));
    console.log('  ✓ API key: ' + (NEMOTRON_API_KEY ? 'loaded (' + NEMOTRON_API_KEY.slice(0, 8) + '…)' : 'MISSING'));
    console.log('  ✓ Memory: persistent (data/users.json)');
    console.log('');
});
