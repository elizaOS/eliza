/**
 * Clawd Code — Telegram relay
 * Long-polls the Telegram Bot API and routes text messages from an
 * allowlisted chat into the Z.AI GLM chat pipeline. No OS-level or
 * computer-use control is exposed — this is a chat/CLI relay only.
 */

import { loadClawdEnv } from './env.js';
import { createZaiClientFromEnv, ZAI_DEFAULT_MODEL, type ZaiMessage } from './zai.js';

const TELEGRAM_API = 'https://api.telegram.org';
const MAX_TELEGRAM_MESSAGE = 4000;
const MAX_HISTORY_TURNS = 20;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
  };
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

function chunkMessage(text: string, limit = MAX_TELEGRAM_MESSAGE): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks;
}

class TelegramBot {
  constructor(private readonly token: string) {}

  private url(method: string): string {
    return `${TELEGRAM_API}/bot${this.token}/${method}`;
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    const response = await fetch(this.url('getUpdates'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ['message'],
      }),
    });
    if (!response.ok) {
      throw new Error(`Telegram getUpdates ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as TelegramGetUpdatesResponse;
    return data.result ?? [];
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    for (const chunk of chunkMessage(text)) {
      const response = await fetch(this.url('sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      });
      if (!response.ok) {
        console.error(`[CLAWD CODE] Telegram sendMessage failed (${response.status}): ${await response.text()}`);
      }
    }
  }

  async getMe(): Promise<{ username?: string; id?: number }> {
    const response = await fetch(this.url('getMe'));
    if (!response.ok) throw new Error(`Telegram getMe ${response.status}: ${await response.text()}`);
    const data = (await response.json()) as { ok: boolean; result: { username?: string; id?: number } };
    return data.result;
  }
}

/**
 * Starts the Telegram relay. Blocks the process (long-poll loop) until
 * SIGINT/SIGTERM. Only chats in TELEGRAM_ALLOWED_CHAT_ID may issue commands.
 */
export async function runTelegramRelay(): Promise<void> {
  const env = loadClawdEnv();
  const token = env.TELEGRAM_BOT_TOKEN;
  const allowedChatId = env.TELEGRAM_ALLOWED_CHAT_ID;

  if (!token) {
    console.error('[CLAWD CODE] TELEGRAM_BOT_TOKEN is not set. Add it to ~/.clawd-code/.env.');
    process.exit(1);
  }
  if (!allowedChatId) {
    console.error('[CLAWD CODE] TELEGRAM_ALLOWED_CHAT_ID is not set. Refusing to start an open relay.');
    console.error('[CLAWD CODE] Message your bot once, then check https://api.telegram.org/bot<token>/getUpdates to find your chat id.');
    process.exit(1);
  }

  const zai = createZaiClientFromEnv(env);
  if (!zai) {
    console.error('[CLAWD CODE] ZAI_API_KEY is not set. The Telegram relay requires Z.AI for chat responses.');
    process.exit(1);
  }

  const model = env.CLAWD_MODEL || ZAI_DEFAULT_MODEL;
  const bot = new TelegramBot(token);
  const me = await bot.getMe();
  console.log(`[CLAWD CODE] Telegram relay online as @${me.username ?? 'unknown'}`);
  console.log(`[CLAWD CODE] Allowlisted chat: ${allowedChatId}`);
  console.log(`[CLAWD CODE] Model: ${model} (chat + CLI relay only — no computer-use control)`);

  const history = new Map<number, ZaiMessage[]>();
  let offset = 0;
  let running = true;
  const stop = () => {
    running = false;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (running) {
    let updates: TelegramUpdate[];
    try {
      updates = await bot.getUpdates(offset, 25);
    } catch (error) {
      console.error('[CLAWD CODE] Telegram poll error:', error instanceof Error ? error.message : error);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      const message = update.message;
      if (!message?.text) continue;

      const chatId = message.chat.id;
      if (String(chatId) !== String(allowedChatId)) {
        console.warn(`[CLAWD CODE] Rejected message from unauthorized chat ${chatId}`);
        continue;
      }

      const text = message.text.trim();
      if (!text) continue;

      if (text === '/reset' || text === '/clear') {
        history.delete(chatId);
        await bot.sendMessage(chatId, 'History cleared.');
        continue;
      }

      const turns = history.get(chatId) ?? [];
      turns.push({ role: 'user', content: text });

      try {
        const response = await zai.chat({
          model,
          messages: turns.slice(-MAX_HISTORY_TURNS),
          thinking: 'enabled',
        });
        const reply = response.content || '(no response)';
        turns.push({ role: 'assistant', content: reply });
        history.set(chatId, turns.slice(-MAX_HISTORY_TURNS));
        await bot.sendMessage(chatId, reply);
      } catch (error) {
        await bot.sendMessage(chatId, `Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  console.log('[CLAWD CODE] Telegram relay stopped.');
}
