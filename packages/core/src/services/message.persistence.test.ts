/**
 * Service-level persistence coverage for inbound message transforms that must
 * affect stored memories without changing the in-flight turn payload.
 */
import { describe, expect, it, vi } from "vitest";
import { TurnControllerRegistry } from "../runtime/turn-controller";
import type { IAgentRuntime, Memory, UUID } from "../types";
import { DefaultMessageService } from "./message";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const RUN_ID = "00000000-0000-0000-0000-0000000000d1" as UUID;
const CREATED_MESSAGE_ID = "00000000-0000-0000-0000-0000000000e1" as UUID;

function augmentedText(userText: string): string {
	return [
		"Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
		"If the answer appears verbatim in the contextual documents, repeat it exactly.",
		"Do not ask follow-up questions or invoke tools/actions when the contextual documents already answer the request.",
		"",
		"<contextual_documents>",
		'<source title="notes.md" similarity="0.412">',
		"some retrieved snippet",
		"</source>",
		"</contextual_documents>",
		"",
		"<user_request>",
		userText,
		"</user_request>",
	].join("\n");
}

function makeRuntime() {
	const createMemory = vi.fn(async () => CREATED_MESSAGE_ID);
	const queueEmbeddingGeneration = vi.fn(async () => undefined);
	const runActionsByMode = vi.fn(async () => undefined);
	const emitEvent = vi.fn(async () => undefined);
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		stateCache: new Map(),
		turnControllers: new TurnControllerRegistry(),
		startRun: vi.fn(() => RUN_ID),
		getCurrentRunId: vi.fn(() => RUN_ID),
		emitEvent,
		runActionsByMode,
		reportError: vi.fn(),
		getSetting: vi.fn((key: string) =>
			key === "BASIC_CAPABILITIES_DEFLLMOFF" ? "true" : undefined,
		),
		getRoom: vi.fn(async () => null),
		getWorld: vi.fn(async () => null),
		getService: vi.fn(() => null),
		getMemoryById: vi.fn(async () => null),
		createMemory,
		queueEmbeddingGeneration,
		getParticipantUserState: vi.fn(async () => null),
	} as unknown as IAgentRuntime;
	return { runtime, createMemory, queueEmbeddingGeneration };
}

describe("DefaultMessageService message persistence", () => {
	it("strips document augmentation from stored memories and embeddings only", async () => {
		const service = new DefaultMessageService();
		const { runtime, createMemory, queueEmbeddingGeneration } = makeRuntime();
		const userText = "just fixing eliza app for demo";
		const wrapped = augmentedText(userText);
		const message = {
			entityId: USER_ID,
			agentId: AGENT_ID,
			roomId: ROOM_ID,
			content: {
				text: wrapped,
				source: "client_chat",
			},
		} as Memory;

		const result = await service.handleMessage(runtime, message);

		expect(result.mode).toBe("none");
		expect(message.id).toBe(CREATED_MESSAGE_ID);
		expect(message.content.text).toBe(wrapped);

		expect(createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({
					text: userText,
					source: "client_chat",
				}),
			}),
			"messages",
		);
		expect(queueEmbeddingGeneration).toHaveBeenCalledWith(
			expect.objectContaining({
				id: CREATED_MESSAGE_ID,
				content: expect.objectContaining({ text: userText }),
			}),
			"normal",
		);
	});
});
