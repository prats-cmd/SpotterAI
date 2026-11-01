const chatProxy = require('./chat');
const { validatePlanInput, createPlanMessages } = require('../services/nutrition-plan');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        res.status(405).json({ error: 'Method Not Allowed' });
        return;
    }

    let input = req.body;
    if (typeof input === 'string') {
        try {
            input = JSON.parse(input);
        } catch (error) {
            res.status(400).json({ error: 'Invalid JSON' });
            return;
        }
    }

    try {
        const profile = validatePlanInput(input);
        req.body = {
            messages: createPlanMessages(profile),
            max_tokens: 1200,
            temperature: 0.35
        };
        return chatProxy(req, res);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};
