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
	type ConversationsListReader,
	composeCharacterSnapshot,
	composeConversationsListSnapshot,
	readCharacterViaHttp,
	readConversationsListViaHttp,
} from "./conversations-and-character-rpc";
import type {
	CharacterSnapshot,
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
