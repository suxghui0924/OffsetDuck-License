const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    InteractionType
} = require('discord.js');
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

client.once('ready', () => {
    console.log(`Discord Bot ready as ${client.user.tag}`);
});

/**
 * Admin Commands: !gen [project_name] [days] [@user]
 */
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content.startsWith('!gen')) {
        const args = message.content.split(' ');
        if (args.length < 3) return message.reply('Usage: !gen [project_name] [days] [@user]');

        const projectName = args[1];
        const days = parseInt(args[2]);
        const targetUser = message.mentions.users.first();

        try {
            // Find project
            const projectRes = await pool.query('SELECT id FROM projects WHERE name = $1', [projectName]);
            if (projectRes.rows.length === 0) return message.reply('Project not found.');

            const projectId = projectRes.rows[0].id;
            const key = `VISTA-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

            await pool.query(
                'INSERT INTO licenses (key, project_id, duration_days, created_by, owner_discord_id) VALUES ($1, $2, $3, $4, $5)',
                [key, projectId, days, message.author.id, targetUser ? targetUser.id : null]
            );

            const embed = new EmbedBuilder()
                .setTitle('License Successfully Created')
                .setColor(0x2ecc71)
                .setDescription(targetUser ? `New license created for <@${targetUser.id}>.` : 'New license created.')
                .addFields(
                    { name: 'License Key', value: `\`\`\`${key}\`\`\`` },
                    { name: 'Duration', value: `${days} Days`, inline: true },
                    { name: 'Owner', value: targetUser ? targetUser.tag : 'Unassigned', inline: true },
                    { name: 'Type', value: projectName, inline: true }
                )
                .setFooter({ text: 'License System | Protect your privacy' })
                .setTimestamp();

            await message.channel.send({ content: targetUser ? `<@${targetUser.id}>` : null, embeds: [embed] });

            if (targetUser) {
                targetUser.send({ embeds: [embed] }).catch(() => { });
            }

        } catch (err) {
            console.error(err);
            message.reply('Error generating key.');
        }
    }
});

/**
 * Slash Commands & Interactions
 */
client.on('interactionCreate', async (interaction) => {
    // 1. /set_panel Command
    if (interaction.isChatInputCommand() && interaction.commandName === 'set_panel') {
        const embed = new EmbedBuilder()
            .setTitle('Dashboard')
            .setDescription('Manage your license here.')
            .setColor(0x3498db);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_register').setLabel('Register Key').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('btn_script').setLabel('Get Script').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('btn_reset').setLabel('Reset HWID').setStyle(ButtonStyle.Danger)
        );

        await interaction.reply({ embeds: [embed], components: [row] });
    }

    // 2. Button Interactions
    if (interaction.isButton()) {
        if (interaction.customId === 'btn_register') {
            const modal = new ModalBuilder()
                .setCustomId('modal_register')
                .setTitle('Register License');

            const keyInput = new TextInputBuilder()
                .setCustomId('input_key')
                .setLabel('Key to register')
                .setPlaceholder('VISTA-XXXX-XXXX-XXXX')
                .setStyle(TextInputStyle.Short);

            modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
            await interaction.showModal(modal);
        }

        if (interaction.customId === 'btn_script') {
            const res = await pool.query('SELECT key FROM licenses WHERE owner_discord_id = $1', [interaction.user.id]);
            if (res.rows.length === 0) return interaction.reply({ content: 'No license found.', ephemeral: true });

            await interaction.reply({ content: `Your Loader: \`loadstring(game:HttpGet('${process.env.RAILWAY_STATIC_URL || 'http://localhost:3000'}/api/verify'))()\``, ephemeral: true });
        }

        if (interaction.customId === 'btn_reset') {
            await pool.query('UPDATE licenses SET bound_roblox_id = NULL WHERE owner_discord_id = $1', [interaction.user.id]);
            await interaction.reply({ content: 'HWID Reset Successful.', ephemeral: true });
        }
    }

    // 3. Modal Submission
    if (interaction.type === InteractionType.ModalSubmit && interaction.customId === 'modal_register') {
        const key = interaction.fields.getTextInputValue('input_key');
        const res = await pool.query('SELECT * FROM licenses WHERE key = $1', [key]);

        if (res.rows.length === 0) return interaction.reply({ content: 'Invalid Key.', ephemeral: true });

        await pool.query('UPDATE licenses SET owner_discord_id = $1 WHERE key = $2', [interaction.user.id, key]);
        await interaction.reply({ content: 'Success! Your license is active and bound to your Discord.', ephemeral: true });
    }
});

if (process.env.DISCORD_TOKEN) {
    client.login(process.env.DISCORD_TOKEN);
}

module.exports = client;
