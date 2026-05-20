/**
 * Register Telegram Bot Webhook
 *
 * One-time setup script to register the bot's webhook URL with Telegram
 * and set the bot's command menu.
 *
 * Usage:
 *   bun scripts/register-telegram-webhook.ts
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN       — Bot token from @BotFather
 *   TELEGRAM_WEBHOOK_SECRET  — Random string for webhook signature verification
 *
 * Optional env vars:
 *   WEBHOOK_URL              — Override webhook URL (defaults to feed.market)
 */

import { Bot } from 'grammy';

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const webhookUrl =
  process.env.WEBHOOK_URL || 'https://feed.market/api/telegram/webhook';

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

if (!secret) {
  console.error('TELEGRAM_WEBHOOK_SECRET is required');
  process.exit(1);
}

const bot = new Bot(token);

async function register() {
  // Set the webhook URL with secret token verification
  await bot.api.setWebhook(webhookUrl, {
    secret_token: secret,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
  console.log(`Webhook registered: ${webhookUrl}`);

  // Set the bot's command menu (shown in Telegram's command picker)
  await bot.api.setMyCommands([
    { command: 'start', description: 'Open Feed' },
    { command: 'help', description: 'How to use this bot' },
  ]);
  console.log('Bot commands registered');

  // Verify the webhook info
  const info = await bot.api.getWebhookInfo();
  console.log('Webhook info:', {
    url: info.url,
    hasCustomCertificate: info.has_custom_certificate,
    pendingUpdateCount: info.pending_update_count,
    maxConnections: info.max_connections,
    allowedUpdates: info.allowed_updates,
  });
}

register().catch((err) => {
  console.error('Failed to register webhook:', err);
  process.exit(1);
});
