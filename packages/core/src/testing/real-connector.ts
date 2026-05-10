/**
 * Real connector helpers for integration tests.
 *
 * These helpers create real Discord/Telegram bot connections for testing
 * connector functionality against your own accounts.
 *
 * Usage:
 *   import { createDiscordTestClient, sendDiscordDM } from "../../test/helpers/real-connector";
 *
 *   const discord = await createDiscordTestClient();
 *   await sendDiscordDM(discord.client, discord.userId, "test message");
 *   const reply = await waitForDiscordMessage(discord.client, channelId, 30_000);
 */

import path from "node:path";

// Load .env on first connector call. The previous module-init top-level
// `await import("dotenv")` is incompatible with Bun.build's mobile bundle
// path: any runtime entry that transitively `require()`s a module with a
// TLA fails the build (see `packages/agent/scripts/build-mobile-bundle.mjs`
// for the rest of this story). Defer to a memoized loader so test helpers
// still pick up `.env` on first use without leaking a TLA into the import
// graph.
const REPO_ROOT =
	process.env.ELIZA_REPO_ROOT?.trim() ||
	(typeof import.meta.dirname === "string"
		? path.resolve(import.meta.dirname, "..", "..", "..", "..")
		: process.cwd());
let dotenvLoaded: Promise<void> | null = null;
async function ensureDotenvLoaded(): Promise<void> {
	if (dotenvLoaded) return dotenvLoaded;
	dotenvLoaded = (async () => {
		try {
			const { config } = await import("dotenv");
			config({ path: path.join(REPO_ROOT, ".env") });
		} catch {
			// dotenv optional
		}
	})();
	return dotenvLoaded;
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

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
	await ensureDotenvLoaded();
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

		// Wait for ready
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
		const handler = (msg: {
			channelId: string;
			content: string;
			author: { bot: boolean };
		}) => {
			if (msg.channelId !== channelId) return;
			if (fromBotOnly && !msg.author.bot) return;
			clearTimeout(timeout);
			c.off("messageCreate", handler as (...args: unknown[]) => void);
			resolve(msg.content);
		};

		const timeout = setTimeout(() => {
			c.off("messageCreate", handler as (...args: unknown[]) => void);
			resolve(null);
		}, timeoutMs);

		c.on("messageCreate", handler);
	});
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

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
	await ensureDotenvLoaded();
	const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
	if (!token) return null;

	try {
		// Use raw HTTP API to avoid telegraf/grammY dependency
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
				// No persistent connection to clean up with raw HTTP
			},
		};
	} catch (err) {
		console.warn(`[real-connector] Telegram bot creation failed: ${err}`);
		return null;
	}
}
