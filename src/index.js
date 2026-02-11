const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Discord Bot
require('./bot.js');

const app = express();
const PORT = process.env.PORT || 5432;
const SECRET_KEY = process.env.SECRET_KEY || 'very_secret_default_key';

// Database Pool
const dbUrl = process.env.DATABASE_URL;
if (dbUrl) {
    const maskedUrl = dbUrl.replace(/:([^@]+)@/, ':****@');
    console.log(`[DB] Using Connection: ${maskedUrl}`);
}

const pool = new Pool({
    connectionString: dbUrl,
    ssl: dbUrl && dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Database Initialization
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS projects (
                id SERIAL PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                script_url TEXT NOT NULL,
                maintainer_id TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS licenses (
                key TEXT PRIMARY KEY,
                project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
                duration_days INTEGER NOT NULL,
                created_by TEXT NOT NULL,
                owner_discord_id TEXT,
                bound_roblox_id TEXT,
                is_activated BOOLEAN DEFAULT false,
                activated_at TIMESTAMP,
                expires_at TIMESTAMP,
                status TEXT DEFAULT 'waiting'
            );
            CREATE TABLE IF NOT EXISTS access_logs (
                id SERIAL PRIMARY KEY,
                license_key TEXT,
                roblox_id TEXT,
                ip TEXT,
                timestamp TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('[OffsetDuck] Database Schema Ready.');
    } catch (err) {
        console.error('[DB ERROR]:', err.message);
    }
}
initDB();

// Passport Session Serialization
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Passport Discord Strategy Setup
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_CALLBACK_URL = process.env.DISCORD_CALLBACK_URL;

if (DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && DISCORD_CALLBACK_URL) {
    passport.use(new DiscordStrategy({
        clientID: DISCORD_CLIENT_ID,
        clientSecret: DISCORD_CLIENT_SECRET,
        callbackURL: DISCORD_CALLBACK_URL,
        scope: ['identify']
    }, (accessToken, refreshToken, profile, done) => {
        const adminIds = (process.env.ADMIN_DISCORD_IDS || '').split(',').map(id => id.trim());
        if (adminIds.includes(profile.id)) {
            return done(null, profile);
        }
        return done(null, false);
    }));
} else {
    console.error('[AUTH] Missing Discord OAuth credentials in environment variables.');
    console.warn('[AUTH] Admin login features will be disabled.');
}

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(session({
    secret: SECRET_KEY,
    resave: true,
    saveUninitialized: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000
    }
}));
app.set('trust proxy', 1); // Required for secure cookies on Railway
app.use(passport.initialize());
app.use(passport.session());

// IP Restriction Middleware
const adminIpMiddleware = (req, res, next) => {
    const allowedIps = (process.env.ADMIN_IPS || '').split(',').map(ip => ip.trim());
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Bypass IP check if ADMIN_IPS is empty
    if (allowedIps.length === 0 || allowedIps[0] === '') return next();

    // Handle both raw IP and IPv6 mapped IPv4
    const normalizedIp = clientIp.replace('::ffff:', '');
    if (allowedIps.includes(normalizedIp) || allowedIps.includes(clientIp)) {
        return next();
    }

    console.warn(`Blocked admin access from IP: ${clientIp}`);
    return res.status(403).send('Forbidden: IP Not Whitelisted');
};

// 1. Root Redirection
app.get('/', (req, res) => {
    res.redirect(process.env.PURCHASE_URL || 'https://discord.gg/yourlink');
});

/**
 * API Endpoints
 */

// 2. Secure Script Loader
app.get('/api/load', async (req, res) => {
    const { key, uid, sig, ts } = req.query;

    if (!key || !uid) return res.status(400).send('-- Missing Parameters');

    // Security Check: Signature (Optional bypass for initial Lua testing)
    if (sig !== 'bypass_for_test') {
        const expectedSig = crypto.createHmac('sha256', SECRET_KEY)
            .update(`${key}:${uid}:${ts}`)
            .digest('hex');

        if (sig !== expectedSig) return res.status(401).send('-- Signature Error');

        const now = Math.floor(Date.now() / 1000);
        if (now - parseInt(ts) > 300) return res.status(401).send('-- Request Expired');
    }

    try {
        const result = await pool.query(`
            SELECT l.*, p.script_url 
            FROM licenses l 
            JOIN projects p ON l.project_id = p.id 
            WHERE l.key = $1
        `, [key]);

        if (result.rows.length === 0) return res.status(403).send('-- Invalid Key');

        const license = result.rows[0];

        // Status Checks
        if (license.status === 'banned') return res.status(403).send('-- Banned');
        if (license.is_activated && license.bound_roblox_id !== String(uid)) return res.status(403).send('-- HWID Locked');
        if (license.is_activated && new Date() > new Date(license.expires_at)) return res.status(403).send('-- Expired');

        // Log Access
        await pool.query('INSERT INTO access_logs (license_key, roblox_id, ip) VALUES ($1, $2, $3)', [key, uid, req.ip]);

        // Code Protection (Base64 + dynamic loading)
        const rawCode = `print("[OffsetDuck] Script Loaded Successfully!"); loadstring(game:HttpGet("${license.script_url}"))();`;
        const protectedCode = `-- Protected by OffsetDuck\nlocal d="${Buffer.from(rawCode).toString('base64')}";loadstring(game:GetService("HttpService"):Base64Decode(d))()`;

        res.send(protectedCode);

    } catch (err) {
        res.status(500).send('-- Server Error');
    }
});

// 3. Admin Panel Routes
app.get('/auth/discord', adminIpMiddleware, passport.authenticate('discord'));
app.get('/auth/discord/callback', (req, res, next) => {
    passport.authenticate('discord', (err, user, info) => {
        if (err) {
            console.error('[AUTH] Callback Error:', err);
            return res.status(500).send('<h1>Auth Error</h1><pre>' + err.message + '</pre>');
        }
        if (!user) {
            console.warn('[AUTH] Authentication Failed:', info);
            return res.redirect('/?error=auth_failed');
        }
        req.logIn(user, (err) => {
            if (err) return next(err);
            return res.redirect('/admin');
        });
    })(req, res, next);
});

/** 
 * Admin API Endpoints (Protected)
 */

const isAdmin = (req, res, next) => {
    if (req.isAuthenticated()) return next();
    res.status(401).json({ success: false, message: "Unauthorized" });
};

app.get('/api/admin/stats', isAdmin, adminIpMiddleware, async (req, res) => {
    try {
        const stats = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM licenses) as total_keys,
                (SELECT COUNT(*) FROM licenses WHERE is_activated = true) as active_keys,
                (SELECT COUNT(*) FROM licenses WHERE status = 'banned') as banned_keys,
                (SELECT COUNT(*) FROM projects) as total_projects,
                (SELECT COUNT(*) FROM access_logs WHERE timestamp > NOW() - INTERVAL '24 hours') as loads_24h
        `);
        res.json(stats.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/projects', isAdmin, adminIpMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM projects ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/projects', isAdmin, adminIpMiddleware, async (req, res) => {
    const { name, script_url } = req.body;
    try {
        await pool.query('INSERT INTO projects (name, script_url, maintainer_id) VALUES ($1, $2, $3)', [name, script_url, req.user.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/projects/:id', isAdmin, adminIpMiddleware, async (req, res) => {
    try {
        await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/licenses', isAdmin, adminIpMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT l.*, p.name as project_name 
            FROM licenses l 
            JOIN projects p ON l.project_id = p.id 
            ORDER BY l.activated_at DESC NULLS LAST, l.key ASC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/licenses/generate', isAdmin, adminIpMiddleware, async (req, res) => {
    const { project_id, duration, amount } = req.body;
    try {
        const keys = [];
        for (let i = 0; i < amount; i++) {
            const key = `OD-${Math.random().toString(36).substring(2, 7).toUpperCase()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
            await pool.query(
                'INSERT INTO licenses (key, project_id, duration_days, created_by) VALUES ($1, $2, $3, $4)',
                [key, project_id, duration, req.user.id]
            );
            keys.push(key);
        }
        res.text(`Generated ${amount} keys successfully.`);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/admin/licenses/:key', isAdmin, adminIpMiddleware, async (req, res) => {
    const { action } = req.body;
    const { key } = req.params;
    try {
        if (action === 'ban') {
            await pool.query("UPDATE licenses SET status = 'banned' WHERE key = $1", [key]);
        } else if (action === 'unban') {
            await pool.query("UPDATE licenses SET status = 'active' WHERE key = $1", [key]);
        } else if (action === 'reset_hwid') {
            await pool.query("UPDATE licenses SET bound_roblox_id = NULL WHERE key = $1", [key]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/licenses/:key', isAdmin, adminIpMiddleware, async (req, res) => {
    try {
        await pool.query("DELETE FROM licenses WHERE key = $1", [req.params.key]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/admin', adminIpMiddleware, (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    res.sendFile(path.join(__dirname, '../public/admin/index.html'));
});

app.get('/admin/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
