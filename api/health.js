module.exports = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
    res.status(200).json({ ok: true, hasKey: !!GROQ_API_KEY, provider: 'Groq' });
};
