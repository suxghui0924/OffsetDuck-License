const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Initialize Discord Bot
require('./bot.js');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Database Initialization
async function initDB() {
    try {
        // Projects Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS projects (
                id SERIAL PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                script_url TEXT NOT NULL,
                maintainer_id TEXT NOT NULL
            );
        `);

        // Licenses Table
        await pool.query(`
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
        `);
        console.log('Database Schema Initialized.');
    } catch (err) {
        console.error('Database Init Error:', err.message);
    }
}
initDB();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

/** 
 * API Endpoints 
 */

// 1. Project Management (Example)
app.post('/api/projects', async (req, res) => {
    const { name, script_url, maintainer_id } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO projects (name, script_url, maintainer_id) VALUES ($1, $2, $3) RETURNING *',
            [name, script_url, maintainer_id]
        );
        res.json({ success: true, project: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. License Verification (Roblox Client)
app.post('/api/verify', async (req, res) => {
    const { key, roblox_id } = req.body;

    if (!key || !roblox_id) {
        return res.status(400).json({ success: false, message: "Key and Roblox ID required" });
    }

    try {
        const result = await pool.query(`
            SELECT l.*, p.script_url 
            FROM licenses l 
            JOIN projects p ON l.project_id = p.id 
            WHERE l.key = $1
        `, [key]);

        if (result.rows.length === 0) {
            return res.json({ success: false, message: "Invalid license key" });
        }

        const license = result.rows[0];

        // Activation Logic
        if (!license.is_activated) {
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + license.duration_days);

            await pool.query(`
                UPDATE licenses SET 
                    is_activated = true, 
                    activated_at = NOW(), 
                    expires_at = $1, 
                    bound_roblox_id = $2, 
                    status = 'active' 
                WHERE key = $3
            `, [expiresAt, roblox_id, key]);

            return res.json({
                success: true,
                message: "License activated!",
                script: license.script_url,
                expires_at: expiresAt
            });
        }

        // Validation Logic
        if (license.status === 'banned') return res.json({ success: false, message: "License Banned" });
        if (license.bound_roblox_id !== String(roblox_id)) return res.json({ success: false, message: "HWID Mismatch" });
        if (new Date() > new Date(license.expires_at)) {
            await pool.query("UPDATE licenses SET status = 'expired' WHERE key = $1", [key]);
            return res.json({ success: false, message: "License Expired" });
        }

        res.json({
            success: true,
            message: "Welcome back!",
            script: license.script_url,
            expires_at: license.expires_at
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
});

// 3. Web Dashboard List (Simplified)
app.get('/api/licenses', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT l.*, p.name as project_name 
            FROM licenses l 
            JOIN projects p ON l.project_id = p.id
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
