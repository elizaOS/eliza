/**
 * Memory writes must pattern-scrub credential-shaped text even when the
 * character configures no secrets, matching `runtime.redactSecrets`. Drives a
 * real initialized runtime over the in-memory SQLite adapter.
 */

import { describe, expect, it } from "vitest";
import { createCharacter } from "../src/character";
import { persistMessageMemory } from "../src/runtime/message-content-storage.ts";
import type { Memory } from "../src/types/memory.js";
import { ChannelType } from "../src/types/primitives";
import { stringToUuid } from "../src/utils/string-to-uuid.js";
import { createInitializedRuntime } from "./initialized-runtime";

const GITHUB_TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyzAB";
const ANTHROPIC_KEY = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const TEXT = `here is my token ${GITHUB_TOKEN} and key ${ANTHROPIC_KEY}`;

describe.each([
	["no character secrets", undefined],
	["a configured credential secret", { OPENAI_API_KEY: "sk-configured-key" }],
])("memory secret redaction with %s", (_label, secrets) => {
	async function setup(name: string) {
		const runtime = await createInitializedRuntime({
			character: createCharacter({
				name,
				...(secrets ? { settings: { secrets } } : {}),
			}),
		});
		const roomId = stringToUuid(`${name}-room`);
		await runtime.ensureConnection({
			entityId: runtime.agentId,
			roomId,
			worldId: stringToUuid(`${name}-world`),
			channelId: roomId,
			source: "test",
			type: ChannelType.SELF,
		});
		const memory = (suffix: string): Memory => ({
			id: stringToUuid(`${name}-${suffix}`),
			entityId: runtime.agentId,
			roomId,
			content: { text: TEXT, attachments: [] },
		});
		const storedText = async (id: Memory["id"]) =>
			(id ? await runtime.getMemoryById(id) : null)?.content.text;
		return { runtime, memory, storedText };
	}

	function expectScrubbed(text: string | undefined) {
		expect(text).toContain("here is my token");
		expect(text).not.toContain(GITHUB_TOKEN);
		expect(text).not.toContain(ANTHROPIC_KEY);
	}

	it("scrubs createMemory text", async () => {
		const { runtime, memory, storedText } = await setup(
			`create-${secrets ? "s" : "n"}`,
		);
		const id = await runtime.createMemory(memory("create"), "messages");
		expectScrubbed(await storedText(id));
	});

	it("scrubs message publication text", async () => {
		const { runtime, memory, storedText } = await setup(
			`publish-${secrets ? "s" : "n"}`,
		);
		const id = await persistMessageMemory(runtime, memory("publish"));
		expectScrubbed(await storedText(id));
	});

	it("scrubs upsertMemory text", async () => {
		const { runtime, memory, storedText } = await setup(
			`upsert-${secrets ? "s" : "n"}`,
		);
		const row = memory("upsert");
		await runtime.upsertMemory(row, "messages");
		expectScrubbed(await storedText(row.id));
	});
});
