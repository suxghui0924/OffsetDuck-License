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
        console.log('Production Database Schema Ready.');
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
    return done(null, false);
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
        const rawCode = `print("[VISTA] Script Loaded Successfully!"); loadstring(game:HttpGet("${license.script_url}"))();`;
        const protectedCode = `-- Protected by Vista\nlocal d="${Buffer.from(rawCode).toString('base64')}";loadstring(game:GetService("HttpService"):Base64Decode(d))()`;

        res.send(protectedCode);

    } catch (err) {
        res.status(500).send('-- Server Error');
    }
});

// 3. Admin Panel Routes
app.get('/auth/discord', adminIpMiddleware, passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
    res.redirect('/admin');
});

app.get('/admin', adminIpMiddleware, (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/auth/discord');
    res.send(`<h1>VISTA Admin Dashboard</h1><p>Welcome, ${req.user.username}#${req.user.discriminator}</p><p>Authorized Access Only.</p>`);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
