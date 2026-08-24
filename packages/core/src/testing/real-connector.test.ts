/**
 * Unit tests for the real-connector integration helpers. Exercises the
 * deterministic surface only: env-gated client creation (null without a
 * token), Discord login/ready orchestration against a mocked discord.js
 * module, message-wait filtering by channel and author type with timeout
 * unsubscribe semantics, DM/channel send routing through a fake transport,
 * and Telegram bot creation plus sendMessage wire shape via a stubbed
 * global fetch. No live Discord or Telegram connection is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDiscordTestClient,
	createTelegramTestBot,
	sendDiscordChannelMessage,
	sendDiscordDM,
	waitForDiscordMessage,
} from "./real-connector.ts";

type DiscordMockState = {
	loginImpl: (token: string) => Promise<void>;
	destroyImpl: () => void;
	user: { id: string } | undefined;
	lastLoginToken: string | undefined;
	readyCallbacks: Array<() => void>;
	destroyCalls: number;
};

const discordState: DiscordMockState = {
	loginImpl: async () => {},
	destroyImpl: () => {},
	user: undefined,
	lastLoginToken: undefined,
	readyCallbacks: [],
	destroyCalls: 0,
};

vi.mock("discord.js", () => {
	class Client {
		async login(token: string) {
			discordState.lastLoginToken = token;
			await discordState.loginImpl(token);
		}
		once(_event: string, callback: () => void) {
			discordState.readyCallbacks.push(callback);
		}
		get user() {
			return discordState.user;
		}
		destroy() {
			discordState.destroyCalls += 1;
			discordState.destroyImpl();
		}
	}
	const GatewayIntentBits = {
		Guilds: 1,
		GuildMessages: 512,
		DirectMessages: 4096,
		MessageContent: 32768,
	};
	return { Client, GatewayIntentBits };
});

function makeDiscordEventClient() {
	const handlers = new Set<(msg: unknown) => void>();
	return {
		offCalls: [] as string[],
		on(_event: string, handler: (msg: unknown) => void) {
			handlers.add(handler);
		},
		off(event: string, handler: (...args: unknown[]) => void) {
			this.offCalls.push(event);
			handlers.delete(handler as (msg: unknown) => void);
		},
		emit(msg: unknown) {
			for (const handler of [...handlers]) handler(msg);
		},
		listenerCount: () => handlers.size,
	};
}

type FetchCall = {
	url: string;
	init?: RequestInit;
};

function makeFetchStub(
	routes: Record<string, { ok?: boolean; payload?: unknown; fail?: Error }>,
) {
	const calls: FetchCall[] = [];
	const impl = async (url: string | URL, init?: RequestInit) => {
		const call: FetchCall = { url: String(url), init };
		calls.push(call);
		const route = Object.keys(routes).find((key) => call.url.includes(key));
		if (!route) {
			throw new Error(`unexpected fetch url: ${call.url}`);
		}
		const configured = routes[route];
		if (configured.fail) {
			throw configured.fail;
		}
		return {
			json: async () => configured.payload ?? { ok: configured.ok ?? true },
		};
	};
	return { calls, impl };
}

async function waitFor(
	condition: () => boolean,
	label: string,
	budgetMs = 2_000,
): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > budgetMs) {
			throw new Error(`timed out waiting for ${label}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

beforeEach(() => {
	discordState.loginImpl = async () => {};
	discordState.destroyImpl = () => {};
	discordState.user = undefined;
	discordState.lastLoginToken = undefined;
	discordState.readyCallbacks = [];
	discordState.destroyCalls = 0;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("waitForDiscordMessage", () => {
	it("resolves with the content of the first matching bot message", async () => {
		const client = makeDiscordEventClient();
		const pending = waitForDiscordMessage(client, "channel-1", 5_000);
		expect(client.listenerCount()).toBe(1);
		client.emit({
			channelId: "channel-1",
			content: "hello from bot",
			author: { bot: true },
		});
		await expect(pending).resolves.toBe("hello from bot");
		expect(client.listenerCount()).toBe(0);
	});

	it("ignores messages from other channels and keeps waiting", async () => {
		const client = makeDiscordEventClient();
		const pending = waitForDiscordMessage(client, "channel-1", 5_000);
		client.emit({
			channelId: "channel-other",
			content: "wrong room",
			author: { bot: true },
		});
		expect(client.listenerCount()).toBe(1);
		client.emit({
			channelId: "channel-1",
			content: "right room",
			author: { bot: true },
		});
		await expect(pending).resolves.toBe("right room");
	});

	it("ignores human authors while fromBotOnly defaults to true", async () => {
		const client = makeDiscordEventClient();
		const pending = waitForDiscordMessage(client, "channel-1", 5_000);
		client.emit({
			channelId: "channel-1",
			content: "from a human",
			author: { bot: false },
		});
		expect(client.listenerCount()).toBe(1);
		client.emit({
			channelId: "channel-1",
			content: "from the bot",
			author: { bot: true },
		});
		await expect(pending).resolves.toBe("from the bot");
	});

	it("accepts human authors when fromBotOnly is false", async () => {
		const client = makeDiscordEventClient();
		const pending = waitForDiscordMessage(client, "channel-1", 5_000, false);
		client.emit({
			channelId: "channel-1",
			content: "human text",
			author: { bot: false },
		});
		await expect(pending).resolves.toBe("human text");
	});

	it("resolves null after the timeout elapses with no matching message", async () => {
		const client = makeDiscordEventClient();
		const pending = waitForDiscordMessage(client, "channel-1", 20);
		client.emit({
			channelId: "channel-other",
			content: "noise",
			author: { bot: true },
		});
		await expect(pending).resolves.toBeNull();
		expect(client.listenerCount()).toBe(0);
		expect(client.offCalls).toEqual(["messageCreate"]);
	});
});

describe("sendDiscordDM", () => {
	it("fetches the target user id and delivers the content", async () => {
		const sent: string[] = [];
		const fetchedIds: string[] = [];
		const client = {
			users: {
				fetch: async (id: string) => {
					fetchedIds.push(id);
					return {
						send: async (content: string) => {
							sent.push(content);
						},
					};
				},
			},
		};
		await sendDiscordDM(client, "user-7", "direct hello");
		expect(fetchedIds).toEqual(["user-7"]);
		expect(sent).toEqual(["direct hello"]);
	});

	it("propagates transport failures to the caller", async () => {
		const client = {
			users: {
				fetch: async () => {
					throw new Error("discord api down");
				},
			},
		};
		await expect(
			sendDiscordDM(client, "user-7", "will not arrive"),
		).rejects.toThrow("discord api down");
	});
});

describe("sendDiscordChannelMessage", () => {
	it("fetches the target channel id and delivers the content", async () => {
		const sent: string[] = [];
		const fetchedIds: string[] = [];
		const client = {
			channels: {
				fetch: async (id: string) => {
					fetchedIds.push(id);
					return {
						send: async (content: string) => {
							sent.push(content);
						},
					};
				},
			},
		};
		await sendDiscordChannelMessage(client, "channel-9", "room hello");
		expect(fetchedIds).toEqual(["channel-9"]);
		expect(sent).toEqual(["room hello"]);
	});
});

describe("createDiscordTestClient", () => {
	it("returns null when DISCORD_BOT_TOKEN is absent or blank", async () => {
		delete process.env.DISCORD_BOT_TOKEN;
		await expect(createDiscordTestClient()).resolves.toBeNull();
		process.env.DISCORD_BOT_TOKEN = "   ";
		await expect(createDiscordTestClient()).resolves.toBeNull();
	});

	it("trims the token before handing it to the Discord client", async () => {
		process.env.DISCORD_BOT_TOKEN = "  tok-123  ";
		discordState.loginImpl = async () => {};
		const pending = createDiscordTestClient();
		await waitFor(
			() => discordState.readyCallbacks.length > 0,
			"ready registration",
		);
		expect(discordState.lastLoginToken).toBe("tok-123");
		for (const callback of discordState.readyCallbacks) callback();
		const result = await pending;
		expect(result).not.toBeNull();
		expect(result?.userId).toBe("");
	});

	it("returns null when the Discord login fails", async () => {
		process.env.DISCORD_BOT_TOKEN = "tok-bad";
		discordState.loginImpl = async () => {
			throw new Error("invalid token");
		};
		await expect(createDiscordTestClient()).resolves.toBeNull();
	});

	it("waits for the ready event and exposes the authenticated user", async () => {
		process.env.DISCORD_BOT_TOKEN = "tok-ok";
		discordState.user = { id: "u-42" };
		const pending = createDiscordTestClient();
		await waitFor(
			() => discordState.readyCallbacks.length > 0,
			"ready registration",
		);
		for (const callback of discordState.readyCallbacks) callback();
		const result = await pending;
		expect(result).not.toBeNull();
		expect(result?.userId).toBe("u-42");
		result?.destroy();
		expect(discordState.destroyCalls).toBe(1);
	});

	it("survives a destroy that throws inside the underlying client", async () => {
		process.env.DISCORD_BOT_TOKEN = "tok-ok";
		discordState.user = { id: "u-42" };
		discordState.destroyImpl = () => {
			throw new Error("destroy blew up");
		};
		const pending = createDiscordTestClient();
		await waitFor(
			() => discordState.readyCallbacks.length > 0,
			"ready registration",
		);
		for (const callback of discordState.readyCallbacks) callback();
		const result = await pending;
		await expect(result?.destroy()).resolves.toBeUndefined();
		expect(discordState.destroyCalls).toBe(1);
	});

	it("returns null when the ready handshake exceeds 30 seconds", async () => {
		process.env.DISCORD_BOT_TOKEN = "tok-slow";
		discordState.loginImpl = async () => {};
		vi.useFakeTimers();
		const pending = createDiscordTestClient();
		const assertion = expect(pending).resolves.toBeNull();
		await vi.advanceTimersByTimeAsync(30_000);
		await assertion;
	});
});

describe("createTelegramTestBot", () => {
	it("returns null without calling the API when TELEGRAM_BOT_TOKEN is absent", async () => {
		delete process.env.TELEGRAM_BOT_TOKEN;
		const fetchStub = makeFetchStub({});
		vi.stubGlobal("fetch", fetchStub.impl);
		await expect(createTelegramTestBot()).resolves.toBeNull();
		expect(fetchStub.calls).toEqual([]);
	});

	it("returns null when getMe reports ok false", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "tg-tok";
		const fetchStub = makeFetchStub({
			"/getMe": { ok: false, payload: { ok: false, result: {} } },
		});
		vi.stubGlobal("fetch", fetchStub.impl);
		await expect(createTelegramTestBot()).resolves.toBeNull();
		expect(fetchStub.calls[0]?.url).toBe(
			"https://api.telegram.org/bottg-tok/getMe",
		);
	});

	it("returns null when the Telegram API is unreachable", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "tg-tok";
		const fetchStub = makeFetchStub({
			"/getMe": { fail: new Error("network unreachable") },
		});
		vi.stubGlobal("fetch", fetchStub.impl);
		await expect(createTelegramTestBot()).resolves.toBeNull();
	});

	it("maps getMe into botInfo and posts sendMessage as JSON chat payloads", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "tg-tok";
		const fetchStub = makeFetchStub({
			"/getMe": {
				payload: {
					ok: true,
					result: { id: 123, username: "eliza_bot" },
				},
			},
			"/sendMessage": { payload: { ok: true } },
		});
		vi.stubGlobal("fetch", fetchStub.impl);
		const bot = await createTelegramTestBot();
		expect(bot).not.toBeNull();
		expect(bot?.token).toBe("tg-tok");
		expect(bot?.botInfo).toEqual({ id: 123, username: "eliza_bot" });

		await bot?.sendMessage("chat-9", "hello there");
		await bot?.sendMessage(77, "numeric chat");

		const sends = fetchStub.calls.filter((call) =>
			call.url.includes("/sendMessage"),
		);
		expect(sends).toHaveLength(2);
		expect(sends[0]?.url).toBe(
			"https://api.telegram.org/bottg-tok/sendMessage",
		);
		expect(sends[0]?.init?.method).toBe("POST");
		expect(sends[0]?.init?.headers).toMatchObject({
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(sends[0]?.init?.body))).toEqual({
			chat_id: "chat-9",
			text: "hello there",
		});
		expect(JSON.parse(String(sends[1]?.init?.body))).toEqual({
			chat_id: 77,
			text: "numeric chat",
		});

		expect(() => bot?.destroy()).not.toThrow();
	});
});
