const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { Pool } = require('pg');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Update the event to clientReady for v15 compatibility / warning avoidance
client.once('ready', () => {
    console.log(`Discord Bot Online: ${client.user.tag}`);
});

// Command: !gen [project] [days] [@user]
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith('!gen')) return;

    const adminIds = (process.env.ADMIN_DISCORD_IDS || '').split(',');
    if (!adminIds.includes(message.author.id)) return;

    const args = message.content.split(' ');
    if (args.length < 3) return message.reply('Usage: !gen [proj_name] [days] [@user]');

    const projName = args[1];
    const days = parseInt(args[2]);
    const target = message.mentions.users.first();

    try {
        const projRes = await pool.query('SELECT id FROM projects WHERE name = $1', [projName]);
        if (projRes.rows.length === 0) return message.reply('Project not found.');

        const key = `VISTA-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

        await pool.query(
            'INSERT INTO licenses (key, project_id, duration_days, created_by, owner_discord_id) VALUES ($1, $2, $3, $4, $5)',
            [key, projRes.rows[0].id, days, message.author.id, target ? target.id : null]
        );

        const embed = new EmbedBuilder()
            .setTitle('License Generated')
            .setColor(0x00ff00)
            .addFields(
                { name: 'Key', value: `\`${key}\`` },
                { name: 'Duration', value: `${days} Days` },
                { name: 'Project', value: projName }
            )
            .setTimestamp();

        message.channel.send({ embeds: [embed] });
        if (target) target.send({ embeds: [embed] }).catch(() => { });

    } catch (err) {
        console.error(err);
        message.reply('Error generating license.');
    }
});

if (process.env.DISCORD_TOKEN) client.login(process.env.DISCORD_TOKEN);

module.exports = client;
