import { afterEach, describe, expect, it } from "vitest";
import { AgentNotReadyError } from "./config-and-auth-rpc";
import {
	composeInboxChatsSnapshot,
	composeInboxMessagesSnapshot,
	composeInboxSourcesSnapshot,
	type InboxChatsReader,
	type InboxMessagesReader,
	type InboxSourcesReader,
	readInboxChatsViaHttp,
	readInboxMessagesViaHttp,
	readInboxSourcesViaHttp,
} from "./inbox-rpc";

const originalFetch = globalThis.fetch;
function installFetch(handler: (url: string) => Response): void {
	(globalThis as { fetch: typeof fetch }).fetch = (async (
		input: RequestInfo | URL,
	): Promise<Response> => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		return handler(url);
	}) as typeof fetch;
}

afterEach(() => {
	(globalThis as { fetch: typeof fetch }).fetch = originalFetch;
});

describe("inbox messages typed RPC", () => {
	const noReader: InboxMessagesReader = async () => null;

	it("throws AgentNotReadyError when port is null", async () => {
		await expect(
			composeInboxMessagesSnapshot(null, undefined, noReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("builds the HTTP query from optional filters", async () => {
		let requested = "";
		installFetch((url) => {
			requested = url;
			return Response.json({
				messages: [{ id: "m1" }, null, { id: "m2" }],
				count: 2,
			});
		});
		const result = await readInboxMessagesViaHttp(31337, {
			limit: 25,
			sources: ["imessage", "telegram"],
			roomId: "room-1",
			roomSource: "telegram",
		});
		expect(requested).toBe(
			"http://127.0.0.1:31337/api/inbox/messages?limit=25&sources=imessage%2Ctelegram&roomId=room-1&roomSource=telegram",
		);
		expect(result).toEqual({
			messages: [{ id: "m1" }, { id: "m2" }],
			count: 2,
		});
	});

	it("returns null on malformed messages payload", async () => {
		installFetch(() => Response.json({ messages: "bad", count: 0 }));
		expect(await readInboxMessagesViaHttp(31337)).toBeNull();
	});
});

describe("inbox chats typed RPC", () => {
	const noReader: InboxChatsReader = async () => null;

	it("throws AgentNotReadyError when port is null", async () => {
		await expect(
			composeInboxChatsSnapshot(null, undefined, noReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("builds the HTTP query from source filters", async () => {
		let requested = "";
		installFetch((url) => {
			requested = url;
			return Response.json({ chats: [{ id: "room-1" }, "bad"], count: 1 });
		});
		const result = await readInboxChatsViaHttp(31337, {
			sources: ["discord", "telegram"],
		});
		expect(requested).toBe(
			"http://127.0.0.1:31337/api/inbox/chats?sources=discord%2Ctelegram",
		);
		expect(result).toEqual({ chats: [{ id: "room-1" }], count: 1 });
	});

	it("returns null on malformed count", async () => {
		installFetch(() => Response.json({ chats: [], count: "1" }));
		expect(await readInboxChatsViaHttp(31337)).toBeNull();
	});
});

describe("inbox sources typed RPC", () => {
	const noReader: InboxSourcesReader = async () => null;

	it("throws AgentNotReadyError when port is null", async () => {
		await expect(
			composeInboxSourcesSnapshot(null, noReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("returns the sources list", async () => {
		installFetch(() => Response.json({ sources: ["imessage", "telegram"] }));
		expect(await readInboxSourcesViaHttp(31337)).toEqual({
			sources: ["imessage", "telegram"],
		});
	});

	it("returns null when sources include non-strings", async () => {
		installFetch(() => Response.json({ sources: ["imessage", 1] }));
		expect(await readInboxSourcesViaHttp(31337)).toBeNull();
	});
});
