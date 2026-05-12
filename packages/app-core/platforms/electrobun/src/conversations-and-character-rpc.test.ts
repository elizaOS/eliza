/**
 * Typed-RPC contract tests for listConversations + getCharacter.
 *
 * Composers throw `AgentNotReadyError` on port=null / reader=null —
 * never fabricate an empty list. The renderer-side wrappers catch and
 * fall through to HTTP so the existing transport-error semantics drive
 * the polling loop. See conversations-and-character-rpc.ts for the
 * rationale.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { AgentNotReadyError } from "./config-and-auth-rpc";
import {
	type CharacterReader,
	type ConversationMessagesReader,
	type ConversationsListReader,
	composeCharacterSnapshot,
	composeConversationMessagesSnapshot,
	composeConversationsListSnapshot,
	readCharacterViaHttp,
	readConversationMessagesViaHttp,
	readConversationsListViaHttp,
} from "./conversations-and-character-rpc";
import type {
	CharacterSnapshot,
	ConversationMessagesSnapshot,
	ConversationsListSnapshot,
} from "./rpc-schema";

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

describe("listConversations typed RPC", () => {
	const noReader: ConversationsListReader = async () => null;

	it("throws AgentNotReadyError when port is null", async () => {
		await expect(
			composeConversationsListSnapshot(null, noReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("throws when reader returns null", async () => {
		await expect(
			composeConversationsListSnapshot(31337, noReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("forwards a list of conversation records", async () => {
		const reader: ConversationsListReader = async () => ({
			conversations: [
				{ id: "c1", title: "First chat" },
				{ id: "c2", title: "Second chat" },
			],
		});
		const snap = await composeConversationsListSnapshot(31337, reader);
		const _typed: ConversationsListSnapshot = snap;
		void _typed;
		expect(snap.conversations).toHaveLength(2);
		expect(snap.conversations[0]).toEqual({ id: "c1", title: "First chat" });
	});

	it("readConversationsListViaHttp filters non-object entries", async () => {
		installFetch(() =>
			Response.json({
				conversations: [{ id: "c1" }, "junk", null, 42, { id: "c2" }],
			}),
		);
		const result = await readConversationsListViaHttp(31337);
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.conversations).toEqual([{ id: "c1" }, { id: "c2" }]);
	});

	it("readConversationsListViaHttp returns null when payload isn't an array", async () => {
		installFetch(() => Response.json({ conversations: "not an array" }));
		expect(await readConversationsListViaHttp(31337)).toBeNull();
	});

	it("readConversationsListViaHttp returns null on 5xx", async () => {
		installFetch(() => new Response("server error", { status: 500 }));
		expect(await readConversationsListViaHttp(31337)).toBeNull();
	});
});

describe("getCharacter typed RPC", () => {
	const noReader: CharacterReader = async () => null;

	it("throws AgentNotReadyError when port is null", async () => {
		await expect(
			composeCharacterSnapshot(null, noReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("forwards the character record verbatim", async () => {
		const reader: CharacterReader = async () => ({
			name: "Atlas",
			style: "concise",
		});
		const snap = await composeCharacterSnapshot(31337, reader);
		const _typed: CharacterSnapshot = snap;
		void _typed;
		expect(snap).toEqual({ name: "Atlas", style: "concise" });
	});

	it("readCharacterViaHttp returns null on 5xx", async () => {
		installFetch(() => new Response("server error", { status: 500 }));
		expect(await readCharacterViaHttp(31337)).toBeNull();
	});

	it("readCharacterViaHttp returns the JSON body on 200", async () => {
		installFetch(() => Response.json({ name: "Atlas" }));
		expect(await readCharacterViaHttp(31337)).toEqual({ name: "Atlas" });
	});
});

describe("getConversationMessages typed RPC", () => {
	const noReader: ConversationMessagesReader = async () => null;

	it("throws AgentNotReadyError when port is null", async () => {
		await expect(
			composeConversationMessagesSnapshot(null, "c1", noReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("throws when id is empty", async () => {
		await expect(
			composeConversationMessagesSnapshot(31337, " ", noReader),
		).rejects.toThrow("Conversation id is required.");
	});

	it("forwards message records", async () => {
		const reader: ConversationMessagesReader = async () => ({
			messages: [
				{ id: "m1", role: "user", text: "hello" },
				{ id: "m2", role: "assistant", text: "hi" },
			],
		});
		const snap = await composeConversationMessagesSnapshot(31337, "c1", reader);
		const _typed: ConversationMessagesSnapshot = snap;
		void _typed;
		expect(snap.messages).toHaveLength(2);
		expect(snap.messages[1]).toEqual({
			id: "m2",
			role: "assistant",
			text: "hi",
		});
	});

	it("readConversationMessagesViaHttp filters non-object entries", async () => {
		installFetch(() =>
			Response.json({
				messages: [{ id: "m1" }, null, "junk", { id: "m2" }],
			}),
		);
		const result = await readConversationMessagesViaHttp(31337, "c1");
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.messages).toEqual([{ id: "m1" }, { id: "m2" }]);
	});

	it("readConversationMessagesViaHttp returns null when payload is invalid", async () => {
		installFetch(() => Response.json({ messages: "not an array" }));
		expect(await readConversationMessagesViaHttp(31337, "c1")).toBeNull();
	});

	it("readConversationMessagesViaHttp returns null on 404", async () => {
		installFetch(() => new Response("missing", { status: 404 }));
		expect(await readConversationMessagesViaHttp(31337, "c1")).toBeNull();
	});
});
