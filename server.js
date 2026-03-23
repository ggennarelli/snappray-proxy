const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'SnapPray Proxy', version: '1.0.0' });
});

app.post('/prayer', async (req, res) => {
    try {
        const { systemPrompt, userPrompt } = req.body;
        if (!systemPrompt || !userPrompt) {
            return res.status(400).json({ error: 'systemPrompt and userPrompt required' });
        }
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 300,
                system: systemPrompt,
                messages: [{ role: 'user', content: userPrompt }]
            })
        });
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error('/prayer error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/daily-prayer', async (req, res) => {
    try {
        const { systemPrompt, userPrompt } = req.body;
        if (!systemPrompt || !userPrompt) {
            return res.status(400).json({ error: 'systemPrompt and userPrompt required' });
        }
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 300,
                system: systemPrompt,
                messages: [{ role: 'user', content: userPrompt }]
            })
        });
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error('/daily-prayer error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/voice', async (req, res) => {
    try {
        const { text, voiceId, voiceSettings } = req.body;
        if (!text || !voiceId) {
            return res.status(400).json({ error: 'text and voiceId required' });
        }
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'xi-api-key': ELEVENLABS_KEY
            },
            body: JSON.stringify({
                text,
                model_id: 'eleven_monolingual_v1',
                voice_settings: voiceSettings || {
                    stability: 0.75,
                    similarity_boost: 0.85,
                    style: 0.20,
                    use_speaker_boost: true
                }
            })
        });
        if (!response.ok) {
            const err = await response.text();
            return res.status(response.status).json({ error: err });
        }
        const audioBuffer = await response.arrayBuffer();
        res.set('Content-Type', 'audio/mpeg');
        res.send(Buffer.from(audioBuffer));
    } catch (err) {
        console.error('/voice error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`SnapPray proxy running on port ${PORT}`);
});
