/** Real Discord, Telegram, and SMTP helpers for integration tests. */

import path from "node:path";

// Load `.env` from the repo root when `dotenv` is available.
const REPO_ROOT = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
);
try {
  const { config } = await import("dotenv");
  config({ path: path.join(REPO_ROOT, ".env") });
} catch {
  // dotenv optional
}

export interface DiscordTestClient {
  client: unknown; // Discord.js Client - typed loosely to avoid hard dep
  userId: string;
  destroy: () => Promise<void>;
}

/**
 * Create a real Discord bot client for testing.
 * Requires DISCORD_BOT_TOKEN in env.
 * Returns null if token is not available.
 */
export async function createDiscordTestClient(): Promise<DiscordTestClient | null> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) return null;

  try {
    const { Client, GatewayIntentBits } = await import("discord.js");
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    await client.login(token);

    // Wait for the bot connection before returning the client.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Discord client ready timeout")),
        30_000,
      );
      client.once("ready", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    const userId = client.user?.id ?? "";

    return {
      client,
      userId,
      destroy: async () => {
        try {
          client.destroy();
        } catch {
          // ignore
        }
      },
    };
  } catch (err) {
    console.warn(`[real-connector] Discord client creation failed: ${err}`);
    return null;
  }
}

/**
 * Send a DM to a Discord user via the bot.
 */
export async function sendDiscordDM(
  client: unknown,
  userId: string,
  content: string,
): Promise<void> {
  const c = client as {
    users: {
      fetch: (
        id: string,
      ) => Promise<{ send: (content: string) => Promise<void> }>;
    };
  };
  const user = await c.users.fetch(userId);
  await user.send(content);
}

/**
 * Send a message to a Discord channel.
 */
export async function sendDiscordChannelMessage(
  client: unknown,
  channelId: string,
  content: string,
): Promise<void> {
  const c = client as {
    channels: {
      fetch: (
        id: string,
      ) => Promise<{ send: (content: string) => Promise<void> }>;
    };
  };
  const channel = await c.channels.fetch(channelId);
  await channel.send(content);
}

/**
 * Wait for a new message in a Discord channel within the given timeout.
 * Returns the message content or null if timeout.
 */
export async function waitForDiscordMessage(
  client: unknown,
  channelId: string,
  timeoutMs = 30_000,
  fromBotOnly = true,
): Promise<string | null> {
  const c = client as {
    on: (
      event: string,
      handler: (msg: {
        channelId: string;
        content: string;
        author: { bot: boolean };
      }) => void,
    ) => void;
    off: (event: string, handler: (...args: unknown[]) => void) => void;
  };

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      c.off("messageCreate", handler);
      resolve(null);
    }, timeoutMs);

    const handler = (msg: {
      channelId: string;
      content: string;
      author: { bot: boolean };
    }) => {
      if (msg.channelId !== channelId) return;
      if (fromBotOnly && !msg.author.bot) return;
      clearTimeout(timeout);
      c.off("messageCreate", handler);
      resolve(msg.content);
    };

    c.on("messageCreate", handler);
  });
}

export interface TelegramTestBot {
  token: string;
  botInfo: { id: number; username: string };
  sendMessage: (chatId: string | number, text: string) => Promise<void>;
  destroy: () => void;
}

/**
 * Create a real Telegram bot for testing.
 * Requires TELEGRAM_BOT_TOKEN in env.
 * Returns null if token is not available.
 */
export async function createTelegramTestBot(): Promise<TelegramTestBot | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;

  try {
    // Use the raw HTTP API to avoid adding a Telegram SDK dependency.
    const baseUrl = `https://api.telegram.org/bot${token}`;

    const meResponse = await fetch(`${baseUrl}/getMe`);
    const meData = (await meResponse.json()) as {
      ok: boolean;
      result: { id: number; username: string };
    };
    if (!meData.ok) return null;

    return {
      token,
      botInfo: meData.result,
      sendMessage: async (chatId: string | number, text: string) => {
        await fetch(`${baseUrl}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
      },
      destroy: () => {
        // Raw HTTP has no persistent connection to close.
      },
    };
  } catch (err) {
    console.warn(`[real-connector] Telegram bot creation failed: ${err}`);
    return null;
  }
}

/**
 * Send a test email using real SMTP credentials.
 * Requires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in env.
 * Falls back to sending via the agent's email action.
 */
export async function sendTestEmail(
  to: string,
  subject: string,
  body: string,
): Promise<boolean> {
  const host = process.env.SMTP_HOST?.trim();
  const port = process.env.SMTP_PORT?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();

  if (!host || !user || !pass) {
    console.warn("[real-connector] SMTP credentials not available");
    return false;
  }

  try {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host,
      port: port ? Number.parseInt(port, 10) : 587,
      secure: port === "465",
      auth: { user, pass },
    });

    await transport.sendMail({
      from: user,
      to,
      subject,
      text: body,
    });

    return true;
  } catch (err) {
    console.warn(`[real-connector] Email send failed: ${err}`);
    return false;
  }
}
