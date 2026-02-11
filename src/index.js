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

// Discord Bot require
require('./bot.js');

const app = express();
const PORT = process.env.PORT || 5432;
const SECRET_KEY = process.env.SECRET_KEY || 'very_secret_default_key';

// Database Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
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
        console.log('Advanced Database Schema Initialized.');
    } catch (err) {
        console.error('Database Init Error:', err.message);
    }
}
initDB();

// Passport Discord Config
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL,
    scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
    const adminIds = (process.env.ADMIN_DISCORD_IDS || '').split(',');
    if (adminIds.includes(profile.id)) {
        return done(null, profile);
    }
    return done(null, false, { message: 'Unauthorized' });
}));

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(session({
    secret: SECRET_KEY,
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// Rate Limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { success: false, message: "Too many requests, please try again later." }
});

// 1. Root Redirection
app.get('/', (req, res) => {
    res.redirect(process.env.PURCHASE_URL || 'https://discord.gg/default');
});

/**
 * API Endpoints
 */

// 2. Secure Script Loader
app.get('/api/load', apiLimiter, async (req, res) => {
    const { key, uid, sig, ts } = req.query;

    if (!key || !uid || !sig || !ts) {
        return res.status(401).send('-- Unauthorized Request');
    }

    // Verify HMAC Signature (Security)
    const expectedSig = crypto.createHmac('sha256', SECRET_KEY)
        .update(`${key}:${uid}:${ts}`)
        .digest('hex');

    if (sig !== expectedSig) {
        return res.status(401).send('-- Signature Mismatch');
    }

    // Check Timestamp (Anti-Replay)
    const now = Math.floor(Date.now() / 1000);
    if (now - parseInt(ts) > 60) {
        return res.status(401).send('-- Request Expired');
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

        // Verification Logic
        if (license.status === 'banned') return res.status(403).send('-- Banned');
        if (license.is_activated && license.bound_roblox_id !== String(uid)) return res.status(403).send('-- HWID Locked');
        if (license.is_activated && new Date() > new Date(license.expires_at)) return res.status(403).send('-- Expired');

        // Log Access
        await pool.query('INSERT INTO access_logs (license_key, roblox_id, ip) VALUES ($1, $2, $3)', [key, uid, req.ip]);

        // "Obfuscated" Lua Code
        const rawCode = `print("Welcome to VISTA!"); loadstring(game:HttpGet("${license.script_url}"))();`;
        const obfuscated = `-- Encrypted Payload\nlocal data = "${Buffer.from(rawCode).toString('base64')}"\nloadstring(game:GetService("HttpService"):Base64Decode(data))()`;

        res.send(obfuscated);

    } catch (err) {
        console.error(err);
        res.status(500).send('-- Server Error');
    }
});

// 3. Simple Verification API (for UI check)
app.post('/api/verify', async (req, res) => {
    const { key, roblox_id } = req.body;
    try {
        const result = await pool.query("SELECT * FROM licenses WHERE key = $1", [key]);
        if (result.rows.length === 0) return res.json({ success: false, message: "No key found" });

        const license = result.rows[0];
        if (!license.is_activated) {
            const exp = new Date();
            exp.setDate(exp.getDate() + license.duration_days);
            await pool.query("UPDATE licenses SET is_activated = true, activated_at = NOW(), expires_at = $1, bound_roblox_id = $2, status = 'active' WHERE key = $3", [exp, roblox_id, key]);
            return res.json({ success: true, message: "Activated" });
        }

        res.json({ success: true, message: "Valid" });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

/**
 * Admin Panel (OAuth + IP Restriction)
 */
const adminIpMiddleware = (req, res, next) => {
    const allowedIps = (process.env.ADMIN_IPS || '').split(',');
    // In production (Railway), you might need to check 'x-forwarded-for'
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (allowedIps.length > 0 && allowedIps[0] !== '' && !allowedIps.includes(clientIp)) {
        console.warn(`Blocked unauthorized admin access attempt from IP: ${clientIp}`);
        return res.status(403).send('Forbidden: IP Not Whitelisted');
    }
    next();
};

app.get('/auth/discord', adminIpMiddleware, passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
    res.redirect('/admin');
});

app.get('/admin', adminIpMiddleware, (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    res.send(`<h1>Welcome Admin ${req.user.username}</h1><p>Admin panel restricted to authorized Discord IDs and IPs.</p>`);
});

app.listen(PORT, () => {
    console.log(`Ultra-Secure Server running on port ${PORT}`);
});
