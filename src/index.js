const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

// Discord Bot require
require('./bot.js');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Database Initialization: Create table if not exists
async function initDB() {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS licenses (
            key TEXT PRIMARY KEY,
            user_id TEXT,
            is_used BOOLEAN DEFAULT false
        );
    `;
    try {
        await pool.query(createTableQuery);
        console.log('Database initialized: "licenses" table is ready.');
    } catch (err) {
        console.error('Error initializing database:', err.message);
    }
}

initDB();

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

// API Endpoint: /verify
app.post('/verify', async (req, res) => {
    const { key, user_id } = req.body;

    if (!key) {
        return res.status(400).json({ success: false, message: 'Key is required' });
    }

    try {
        // 1. Check if key exists and is not used
        const selectQuery = 'SELECT * FROM licenses WHERE key = $1';
        const result = await pool.query(selectQuery, [key]);

        if (result.rows.length === 0) {
            return res.json({ success: false, message: 'Invalid license key' });
        }

        const license = result.rows[0];

        if (license.is_used) {
            return res.json({ success: false, message: 'License key already used' });
        }

        // 2. Update license as used and assign user_id
        const updateQuery = 'UPDATE licenses SET is_used = true, user_id = $1 WHERE key = $2';
        await pool.query(updateQuery, [user_id || 'unknown', key]);

        return res.json({ success: true, message: 'License verified and activated' });

    } catch (err) {
        console.error('Database error during verification:', err.message);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Admin dashboard: http://localhost:${PORT}`);
});
