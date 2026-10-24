/**
 * Exercises storage content equality when routed content contains undefined
 * properties that are omitted after database JSON serialization.
 */
import { describe, expect, it, vi } from "vitest";
import { persistIncomingMessageMemory } from "../src/runtime/message-content-storage";
import type { Memory } from "../src/types/memory";
import type { UUID } from "../src/types/primitives";
import type { IAgentRuntime } from "../src/types/runtime";

describe("persistIncomingMessageMemory undefined properties tolerance", () => {
	it("reuses stored memory when routed content has undefined properties dropped by JSON serialization", async () => {
		const messageId = "11111111-1111-4111-8111-111111111111" as UUID;
		const agentId = "22222222-2222-4222-8222-222222222222" as UUID;
		const roomId = "33333333-3333-4333-8333-333333333333" as UUID;
		const entityId = "44444444-4444-4444-8444-444444444444" as UUID;

		// Stored row retrieved from JSON storage: inReplyTo was dropped upon database write
		const storedRow: Memory = {
			id: messageId,
			agentId,
			roomId,
			entityId,
			content: { text: "hi", source: "discord", channelType: 1 },
		};

		const runtime = {
			agentId,
			redactSecrets: (text: string) => text,
			getMemoriesByIds: vi.fn(async ([id]: UUID[]) =>
				id === messageId ? [storedRow] : [],
			),
		} as unknown as IAgentRuntime;

		// Routed content from connector (e.g. Discord edit turn) holding inReplyTo: undefined
		const routedMemory: Memory = {
			id: messageId,
			agentId,
			roomId,
			entityId,
			content: {
				text: "hi",
				source: "discord",
				channelType: 1,
				inReplyTo: undefined,
			},
		};

		await expect(
			persistIncomingMessageMemory(runtime, routedMemory),
		).resolves.toBe(messageId);
	});

	it("strictly rejects genuine content differences even if undefined keys are present", async () => {
		const messageId = "11111111-1111-4111-8111-111111111111" as UUID;
		const agentId = "22222222-2222-4222-8222-222222222222" as UUID;
		const roomId = "33333333-3333-4333-8333-333333333333" as UUID;
		const entityId = "44444444-4444-4444-8444-444444444444" as UUID;

		const storedRow: Memory = {
			id: messageId,
			agentId,
			roomId,
			entityId,
			content: { text: "hi", source: "discord" },
		};

		const runtime = {
			agentId,
			redactSecrets: (text: string) => text,
			getMemoriesByIds: vi.fn(async () => [storedRow]),
		} as unknown as IAgentRuntime;

		const conflictingMemory: Memory = {
			id: messageId,
			agentId,
			roomId,
			entityId,
			content: {
				text: "different text",
				source: "discord",
				inReplyTo: undefined,
			},
		};

		await expect(
			persistIncomingMessageMemory(runtime, conflictingMemory),
		).rejects.toMatchObject({
			code: "MESSAGE_CONTENT_PUBLICATION_CONFLICT",
		});
	});
});
