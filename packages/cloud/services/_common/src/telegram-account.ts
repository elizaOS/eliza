/** Derives a stable Telegram bot identity without retaining its credential. */

const TELEGRAM_BOT_TOKEN_RE = /^([1-9][0-9]{0,19}):([A-Za-z0-9_-]{20,128})$/;

/** Return the numeric bot id embedded in a structurally valid Bot API token. */
export function parseTelegramBotId(botToken: string): string {
  const match = TELEGRAM_BOT_TOKEN_RE.exec(botToken.trim());
  if (!match) {
    throw new Error("Telegram bot token is malformed");
  }
  return match[1];
}
