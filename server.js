const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const PORT = process.env.PORT || 3000;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS prayers (
            id SERIAL PRIMARY KEY,
            category VARCHAR(50),
            subcategory VARCHAR(50),
            style VARCHAR(20),
            country VARCHAR(50),
            created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS premium_joins (
            id SERIAL PRIMARY KEY,
            country VARCHAR(50),
            created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS daily_stats (
            date DATE PRIMARY KEY,
            total_prayers INTEGER DEFAULT 0,
            premium_joins INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS world_events (
            id SERIAL PRIMARY KEY,
            title VARCHAR(200) NOT NULL,
            description VARCHAR(500),
            category VARCHAR(50),
            prayer_count INTEGER DEFAULT 0,
            active BOOLEAN DEFAULT true,
            created_at TIMESTAMP DEFAULT NOW()
        );
        INSERT INTO world_events (title, description, category) VALUES
        ('Peace in the Middle East', 'Ongoing conflict affecting millions of lives', 'world'),
        ('Healing for Those Affected by Natural Disasters', 'Communities rebuilding after recent storms and earthquakes', 'world'),
        ('Wisdom for World Leaders', 'Nations facing critical decisions affecting peace and justice', 'country'),
        ('Protection for Persecuted Christians', 'Believers facing persecution in restricted nations', 'world'),
        ('Recovery from Economic Hardship', 'Families and communities struggling with poverty and uncertainty', 'community')
        ON CONFLICT DO NOTHING;
    `);
    console.log('DB tables ready');
}

async function callAnthropic(body) {
    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
    };
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });
    if (response.status === 529 || response.status === 503) {
        console.log('Anthropic overloaded, retrying in 10s...');
        await new Promise(r => setTimeout(r, 10000));
        const retry = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });
        return retry;
    }
    return response;
}

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'SnapPray Proxy', version: '2.0.0' });
});

app.post('/prayer', async (req, res) => {
    try {
        const { systemPrompt, userPrompt } = req.body;
        if (!systemPrompt || !userPrompt) {
            return res.status(400).json({ error: 'systemPrompt and userPrompt required' });
        }
        const response = await callAnthropic({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }]
        });
        if (response.status === 529 || response.status === 503) {
            return res.status(200).json({ fallback: true, reason: 'service_busy' });
        }
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error('/prayer error:', err);
        res.status(200).json({ fallback: true, reason: 'network_error' });
    }
});

app.post('/vision', async (req, res) => {
    try {
        const { systemPrompt, imageBase64, mediaType, userText } = req.body;
        if (!systemPrompt || !imageBase64) {
            return res.status(400).json({ error: 'systemPrompt and imageBase64 required' });
        }
        const response = await callAnthropic({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 400,
            system: systemPrompt,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: mediaType || 'image/jpeg',
                            data: imageBase64
                        }
                    },
                    {
                        type: 'text',
                        text: userText || 'Generate a prayer for this moment.'
                    }
                ]
            }]
        });
        if (response.status === 529 || response.status === 503) {
            return res.status(200).json({ fallback: true, reason: 'service_busy' });
        }
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error('/vision error:', err);
        res.status(200).json({ fallback: true, reason: 'network_error' });
    }
});

app.post('/daily-prayer', async (req, res) => {
    try {
        const { systemPrompt, userPrompt } = req.body;
        if (!systemPrompt || !userPrompt) {
            return res.status(400).json({ error: 'systemPrompt and userPrompt required' });
        }
        const response = await callAnthropic({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }]
        });
        if (response.status === 529 || response.status === 503) {
            return res.status(200).json({ fallback: true, reason: 'service_busy' });
        }
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error('/daily-prayer error:', err);
        res.status(200).json({ fallback: true, reason: 'network_error' });
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

app.post('/log-prayer', async (req, res) => {
    try {
        const { category, subcategory, style, country } = req.body;
        await pool.query(
            'INSERT INTO prayers (category, subcategory, style, country) VALUES ($1, $2, $3, $4)',
            [category || null, subcategory || null, style || null, country || null]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('/log-prayer error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/log-premium', async (req, res) => {
    try {
        const { country } = req.body;
        await pool.query(
            'INSERT INTO premium_joins (country) VALUES ($1)',
            [country || null]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('/log-premium error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/world-events', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, title, description, category, prayer_count
            FROM world_events
            WHERE active = true
            ORDER BY prayer_count DESC, created_at DESC
            LIMIT 5
        `);
        res.json({ events: result.rows });
    } catch (err) {
        console.error('/world-events error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/log-world-prayer', async (req, res) => {
    try {
        const { eventId } = req.body;
        await pool.query(
            'UPDATE world_events SET prayer_count = prayer_count + 1 WHERE id = $1',
            [eventId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('/log-world-prayer error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/world-events', async (req, res) => {
    try {
        const { title, description, category } = req.body;
        const result = await pool.query(
            'INSERT INTO world_events (title, description, category) VALUES ($1, $2, $3) RETURNING id',
            [title, description || null, category || null]
        );
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        console.error('/admin/world-events error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/stats', async (req, res) => {
    try {
        const today = new Date().toISOString().slice(0, 10);

        const [totalResult, todayResult, premiumTodayResult, moodResult, focusResult, othersResult] = await Promise.all([
            pool.query('SELECT COUNT(*) FROM prayers'),
            pool.query("SELECT COUNT(*) FROM prayers WHERE created_at::date = $1", [today]),
            pool.query("SELECT COUNT(*) FROM premium_joins WHERE created_at::date = $1", [today]),
            pool.query(`
                SELECT subcategory, COUNT(*) as count
                FROM prayers
                WHERE category = 'feeling' AND created_at::date = $1
                GROUP BY subcategory
                ORDER BY count DESC
                LIMIT 3
            `, [today]),
            pool.query(`
                SELECT subcategory, COUNT(*) as count
                FROM prayers
                WHERE category = 'focus' AND created_at::date = $1
                GROUP BY subcategory
                ORDER BY count DESC
                LIMIT 3
            `, [today]),
            pool.query(`
                SELECT COUNT(*) FROM prayers
                WHERE category = 'others' AND created_at::date = $1
            `, [today])
        ]);

        res.json({
            totalPrayers: parseInt(totalResult.rows[0].count),
            todayPrayers: parseInt(todayResult.rows[0].count),
            premiumToday: parseInt(premiumTodayResult.rows[0].count),
            trendingMoods: moodResult.rows.map(r => r.subcategory),
            trendingFocus: focusResult.rows.map(r => r.subcategory),
            trendingOthers: parseInt(othersResult.rows[0].count)
        });
    } catch (err) {
        console.error('/stats error:', err);
        res.status(500).json({ error: err.message });
    }
});

initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`SnapPray proxy running on port ${PORT}`);
    });
}).catch(err => {
    console.error('DB init failed:', err);
    process.exit(1);
});
