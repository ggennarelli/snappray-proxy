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

async function refreshWorldEventsWithClaude() {
    console.log('🌍 Refreshing world events with Claude Sonnet + web search...');

    const today = new Date().toISOString().split('T')[0];
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const prompt = `You are curating a weekly "Pray for the World" feed for SnapPray, a Christian prayer app. Use the web_search tool to find 5 current ongoing situations in the world that Christians should be praying about. Today's date is ${today}.

SCOPE:
Focus on suffering, persecution, and crisis that Christians worldwide should bring before God:
- Christian persecution (imprisonment, church attacks, hostile regime actions against believers)
- Humanitarian crises (famine, displacement, refugee suffering)
- Natural disasters with significant human impact
- Ongoing armed conflicts affecting civilians and the church
- Disease outbreaks and health emergencies

POLITICAL NEUTRALITY — ABSOLUTE:
- Do NOT include elections, political campaigns, or partisan political news
- Do NOT include legislation, court rulings, or policy debates
- Do NOT include political commentary or analysis
- Frame events through a humanitarian and spiritual lens, never political
- When a situation has political dimensions, focus on the human suffering, NOT the politics

PREFERRED SOURCES (search these first):
- Open Doors USA (opendoorsusa.org) — persecution reporting
- Voice of the Martyrs (persecution.com) — persecuted church
- International Christian Concern (persecution.org) — country reports
- Samaritan's Purse (samaritanspurse.org) — disaster relief
- World Vision (worldvision.org) — humanitarian crises
- Mission Network News (mnnonline.org) — mission and persecution
Fallback: ReliefWeb (reliefweb.int), ICRC (icrc.org)
Avoid politically-charged outlets entirely.

FRESHNESS — STRICT RULE:
Today's date is ${today}. Only include events where the news, developments, or escalations you cite occurred within the past 90 days (since ${ninetyDaysAgo}).

For ongoing situations (long-running conflicts, persecution, displacement), it is acceptable IF AND ONLY IF there has been a meaningful development, news event, or update within the past 90 days that you can confirm via web search. Do NOT include long-running situations based solely on the situation being ongoing — there must be a recent news anchor.

REJECT IF:
- The event occurred more than 90 days ago and you have no recent news anchor
- You cannot confirm via web search that the situation has had developments in the past 90 days
- The description references casualties, displacement numbers, or specifics from events older than 90 days as if they were current

EXAMPLES OF WHAT TO REJECT:
- The September 2023 Morocco earthquake (older than 90 days, no recent recovery news)
- The 2022 Pakistan floods (too old)
- Generic "persecution in restricted nations" with no specific recent event

EXAMPLES OF WHAT TO INCLUDE:
- A persecution incident reported by Open Doors or VOM in the past 90 days
- A natural disaster that occurred or had major aftermath in the past 90 days
- An escalation in an ongoing conflict that occurred in the past 90 days
- A famine or hunger crisis declaration made in the past 90 days

FRAMING RULE:
Every title and description must be written from a compassionate Christian perspective focused on human need. Ask: "What would Christians pray about?" not "What is happening politically?"

OUTPUT FORMAT:
Return ONLY a raw JSON array. No markdown, no code fences, no backticks, no preamble. Just the raw JSON array starting with [ and ending with ].
- title: short compelling title (max 60 chars) — human need focused, never political
- description: 2-3 sentences of factual compassionate context (max 300 chars). No prayer language.
- category: one of "world", "country", or "community"

If you cannot find 5 events meeting the 90-day freshness criteria, return 3 or 4. Quality and freshness over quantity.

BEFORE RETURNING YOUR FINAL ANSWER:
For each event, ask yourself: "What specific news event from the past 90 days am I citing?" If you cannot name a specific recent news anchor for that event, REMOVE it from your response. Better to return 3 confirmed-current events than 5 with stale content.

Begin search now.`;

    const body = JSON.stringify({
        model: 'claude-sonnet-4-6-20250514',
        max_tokens: 4096,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
        },
        body
    });

    const data = await response.json();
    console.log('🔍 ANTHROPIC RESPONSE STATUS:', data.type, data.stop_reason || '');

    // Handle API errors gracefully
    if (data.type === 'error') {
        throw new Error(`Anthropic API error: ${data.error?.type} — ${data.error?.message}`);
    }
    if (!data.content) {
        throw new Error(`Unexpected response shape: ${JSON.stringify(data).substring(0, 500)}`);
    }

    // Sonnet with tools returns multiple content blocks — find the text block with JSON
    const textBlock = data.content.find(b => b.type === 'text');
    if (!textBlock) {
        throw new Error('No text block in Sonnet response. Content types: ' + data.content.map(b => b.type).join(', '));
    }
    const rawText = textBlock.text.trim();
    const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    console.log('🔍 Sonnet raw text (first 300 chars):', rawText.substring(0, 300));
    const events = JSON.parse(cleaned);

    if (!Array.isArray(events) || events.length < 3 || events.length > 5) {
        throw new Error(`Invalid events array from Claude: got ${events.length} items`);
    }

    await pool.query('UPDATE world_events SET active = false');
    for (const event of events) {
        await pool.query(
            'INSERT INTO world_events (title, description, category, active) VALUES ($1, $2, $3, true)',
            [event.title, event.description || '', event.category || 'world']
        );
    }

    await pool.query(`
        INSERT INTO app_config (key, value, updated_at)
        VALUES ('world_events_last_refresh', NOW()::text, NOW())
        ON CONFLICT (key) DO UPDATE SET value = NOW()::text, updated_at = NOW()
    `);

    console.log('✅ World events refreshed:', events.map(e => e.title));
    return events;
}

// DB-based world events refresh — survives container restarts
async function checkAndRefreshWorldEvents() {
    const result = await pool.query(
        "SELECT value FROM app_config WHERE key = 'world_events_last_refresh'"
    );
    const lastRefresh = result.rows[0] ? new Date(result.rows[0].value) : null;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    if (!lastRefresh || lastRefresh < sevenDaysAgo) {
        console.log('🌍 World events stale, refreshing...');
        await refreshWorldEventsWithClaude();
    } else {
        const daysLeft = Math.ceil((lastRefresh.getTime() + 7 * 24 * 60 * 60 * 1000 - Date.now()) / (24 * 60 * 60 * 1000));
        console.log(`🌍 World events fresh (last refresh: ${lastRefresh.toISOString()}), next in ~${daysLeft} days`);
    }
}

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
        CREATE TABLE IF NOT EXISTS installs (
            id SERIAL PRIMARY KEY,
            country VARCHAR(50),
            platform VARCHAR(20) DEFAULT 'ios',
            created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS app_config (
            key VARCHAR(100) PRIMARY KEY,
            value TEXT,
            updated_at TIMESTAMP DEFAULT NOW()
        );
        INSERT INTO app_config (key, value)
        VALUES ('world_events_last_refresh', NOW()::text)
        ON CONFLICT (key) DO NOTHING;
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

app.post('/log-iprayed', async (req, res) => {
  try {
    const { device_id, prayer_hash, timestamp } = req.body;
    await pool.query(
      'INSERT INTO iprayed_logs (device_id, prayer_hash, timestamp) VALUES ($1, $2, $3)',
      [device_id || 'anonymous', prayer_hash || '', timestamp || new Date().toISOString()]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('log-iprayed error:', err);
    res.json({ success: true });
  }
});

app.post('/log-install', async (req, res) => {
    try {
        const { country } = req.body;
        await pool.query(
            'INSERT INTO installs (country) VALUES ($1)',
            [country || null]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('/log-install error:', err);
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

app.post('/admin/seed', async (req, res) => {
    const { count = 1000 } = req.body;
    const categories = ['feeling', 'focus', 'snap', 'others'];
    const subcategories = ['grateful', 'anxious', 'healing', 'family', 'guidance', 'grief'];
    const styles = ['pastoral', 'modern'];
    for (let i = 0; i < count; i++) {
        const daysAgo = Math.floor(Math.random() * 90);
        const date = new Date();
        date.setDate(date.getDate() - daysAgo);
        await pool.query(
            'INSERT INTO prayers (category, subcategory, style, created_at) VALUES ($1, $2, $3, $4)',
            [
                categories[Math.floor(Math.random() * categories.length)],
                subcategories[Math.floor(Math.random() * subcategories.length)],
                styles[Math.floor(Math.random() * styles.length)],
                date.toISOString()
            ]
        );
    }
    res.json({ success: true, seeded: count });
});

app.get('/stats', async (req, res) => {
    try {
        const today = new Date().toISOString().slice(0, 10);

        const [totalResult, todayResult, premiumTodayResult, moodResult, focusResult, othersResult, milestoneResult, guidedResult, scriptureResult, totalInstallsResult, weeklyInstallsResult, todayInstallsResult, lastRefreshResult] = await Promise.all([
            pool.query('SELECT COUNT(*) FROM prayers'),
            pool.query("SELECT COUNT(*) FROM prayers WHERE created_at::date = $1", [today]),
            pool.query("SELECT COUNT(*) FROM premium_joins WHERE created_at::date = $1", [today]),
            pool.query(`
                SELECT subcategory, COUNT(*) as count
                FROM prayers
                WHERE category = 'feeling' AND created_at >= NOW() - INTERVAL '7 days'
                GROUP BY subcategory
                ORDER BY count DESC
                LIMIT 3
            `),
            pool.query(`
                SELECT subcategory, COUNT(*) as count
                FROM prayers
                WHERE category = 'focus' AND created_at >= NOW() - INTERVAL '7 days'
                GROUP BY subcategory
                ORDER BY count DESC
                LIMIT 3
            `),
            pool.query(`
                SELECT subcategory, COUNT(*) as count
                FROM prayers
                WHERE category = 'others' AND created_at >= NOW() - INTERVAL '7 days'
                GROUP BY subcategory
                ORDER BY count DESC
                LIMIT 3
            `),
            pool.query(`
                SELECT subcategory, COUNT(*) as count
                FROM prayers
                WHERE category = 'milestone' AND created_at >= NOW() - INTERVAL '7 days'
                GROUP BY subcategory
                ORDER BY count DESC
                LIMIT 3
            `),
            pool.query(`
                SELECT subcategory, COUNT(*) as count
                FROM prayers
                WHERE category = 'guided' AND created_at >= NOW() - INTERVAL '7 days'
                GROUP BY subcategory
                ORDER BY count DESC
                LIMIT 1
            `),
            pool.query(`
                SELECT subcategory, COUNT(*) as count
                FROM prayers
                WHERE category = 'scripture' AND created_at >= NOW() - INTERVAL '7 days'
                GROUP BY subcategory
                ORDER BY count DESC
                LIMIT 3
            `),
            pool.query('SELECT COUNT(*) FROM installs'),
            pool.query("SELECT COUNT(*) FROM installs WHERE created_at > NOW() - INTERVAL '7 days'"),
            pool.query('SELECT COUNT(*) FROM installs WHERE DATE(created_at) = CURRENT_DATE'),
            pool.query("SELECT value FROM app_config WHERE key = 'world_events_last_refresh'")
        ]);

        res.json({
            totalPrayers:       parseInt(totalResult.rows[0].count),
            todayPrayers:       parseInt(todayResult.rows[0].count),
            premiumToday:       parseInt(premiumTodayResult.rows[0].count),
            trendingMoods:      moodResult.rows.map(r => r.subcategory),
            trendingFocus:      focusResult.rows.map(r => r.subcategory),
            trendingOthers:     othersResult.rows.map(r => r.subcategory),
            trendingMilestones: milestoneResult.rows.map(r => r.subcategory),
            trendingGuided:     guidedResult.rows.map(r => r.subcategory),
            trendingScripture:  scriptureResult.rows.map(r => r.subcategory),
            totalInstalls:      parseInt(totalInstallsResult.rows[0].count),
            weeklyInstalls:     parseInt(weeklyInstallsResult.rows[0].count),
            todayInstalls:      parseInt(todayInstallsResult.rows[0].count),
            worldEventsLastRefresh: lastRefreshResult.rows[0]?.value || null
        });
    } catch (err) {
        console.error('/stats error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/refresh-world-events', async (req, res) => {
    const expectedKey = process.env.ADMIN_KEY;
    if (!expectedKey) {
        console.error('ADMIN_KEY env var not set');
        return res.status(500).json({ error: 'Server misconfigured' });
    }
    if (req.headers['x-admin-key'] !== expectedKey) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const events = await refreshWorldEventsWithClaude();
        res.json({ success: true, events });
    } catch(err) {
        console.error('Refresh error:', err);
        res.status(500).json({ error: err.message });
    }
});

initDB().then(async () => {
    await checkAndRefreshWorldEvents().catch(console.error);
    // Check daily in case container stays up longer than a week
    setInterval(() => {
        checkAndRefreshWorldEvents().catch(console.error);
    }, 24 * 60 * 60 * 1000);
    app.listen(PORT, () => {
        console.log(`SnapPray proxy running on port ${PORT}`);
    });
}).catch(err => {
    console.error('DB init failed:', err);
    process.exit(1);
});
