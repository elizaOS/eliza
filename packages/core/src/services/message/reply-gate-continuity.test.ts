/**
 * Deterministic unit tests for the reply-gate continuity helper
 * (senderInActiveConversation): the active-conversation signal that lets an
 * on_mention-gated agent answer an unaddressed follow-up from the user it just
 * replied to. Stub runtime (vi.fn getMemories/reportError), fixed epoch
 * timestamps — message.createdAt supplies "now", so no clocks are involved.
 */
import { describe, expect, it, vi } from "vitest";
import type { Memory } from "../../types/memory";
import type { UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import {
	CONTINUITY_WINDOW_MS,
	senderInActiveConversation,
} from "./reply-gate-continuity";

const AGENT_ID = "00000000-0000-0000-0000-00000000000a" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000000b" as UUID;
const SHAW_ID = "00000000-0000-0000-0000-00000000000c" as UUID;
const ALICE_ID = "00000000-0000-0000-0000-00000000000e" as UUID;

/** Epoch base for the fixture timeline. */
const T0 = 1_700_000_000_000;

function memory(args: {
	id: string;
	entityId: UUID;
	createdAt: number;
	text?: string;
	inReplyTo?: UUID;
}): Memory {
	return {
		id: args.id as UUID,
		entityId: args.entityId,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: {
			text: args.text ?? "x",
			...(args.inReplyTo ? { inReplyTo: args.inReplyTo } : {}),
		},
		createdAt: args.createdAt,
	};
}

function makeRuntime(args: {
	memories?: Memory[];
	memoriesError?: Error;
}): IAgentRuntime & { reportError: ReturnType<typeof vi.fn> } {
	const getMemories = vi.fn(async () => {
		if (args.memoriesError) throw args.memoriesError;
		return args.memories ?? [];
	});
	return {
		agentId: AGENT_ID,
		getMemories,
		reportError: vi.fn(),
	} as unknown as IAgentRuntime & { reportError: ReturnType<typeof vi.fn> };
}

describe("senderInActiveConversation", () => {
	it("true for a fresh follow-up right after the agent answered this sender (tj-80a71fc4 timeline)", async () => {
		// shaw asks Q1, agent answers A1 30s later, shaw follows up at +50s.
		const runtime = makeRuntime({
			memories: [
				memory({ id: "q1", entityId: SHAW_ID, createdAt: T0 }),
				memory({ id: "a1", entityId: AGENT_ID, createdAt: T0 + 30_000 }),
			],
		});
		const followUp = memory({
			id: "q2",
			entityId: SHAW_ID,
			createdAt: T0 + 50_000,
			text: "okay but how many dimensions?",
		});
		await expect(senderInActiveConversation(runtime, followUp)).resolves.toBe(
			true,
		);
	});

	it("false when the agent's last reply engaged a different user", async () => {
		const runtime = makeRuntime({
			memories: [
				memory({ id: "s1", entityId: SHAW_ID, createdAt: T0 }),
				memory({ id: "al1", entityId: ALICE_ID, createdAt: T0 + 10_000 }),
				memory({
					id: "a1",
					entityId: AGENT_ID,
					createdAt: T0 + 20_000,
					inReplyTo: "al1" as UUID,
				}),
			],
		});
		const followUp = memory({
			id: "s2",
			entityId: SHAW_ID,
			createdAt: T0 + 30_000,
		});
		await expect(senderInActiveConversation(runtime, followUp)).resolves.toBe(
			false,
		);
	});

	it("false when the agent's last reply is older than CONTINUITY_WINDOW_MS", async () => {
		const runtime = makeRuntime({
			memories: [
				memory({ id: "q1", entityId: SHAW_ID, createdAt: T0 }),
				memory({ id: "a1", entityId: AGENT_ID, createdAt: T0 + 10_000 }),
			],
		});
		const followUp = memory({
			id: "q2",
			entityId: SHAW_ID,
			createdAt: T0 + 10_000 + CONTINUITY_WINDOW_MS + 1,
		});
		await expect(senderInActiveConversation(runtime, followUp)).resolves.toBe(
			false,
		);
	});

	it("false when no agent message exists in the recent window", async () => {
		const runtime = makeRuntime({
			memories: [
				memory({ id: "s1", entityId: SHAW_ID, createdAt: T0 }),
				memory({ id: "al1", entityId: ALICE_ID, createdAt: T0 + 5_000 }),
			],
		});
		const followUp = memory({
			id: "s2",
			entityId: SHAW_ID,
			createdAt: T0 + 10_000,
		});
		await expect(senderInActiveConversation(runtime, followUp)).resolves.toBe(
			false,
		);
	});

	it("inReplyTo link to the sender wins even with an interleaved other-user message", async () => {
		// alice speaks between shaw's question and the agent's reply, but the
		// agent's reply explicitly reply-links shaw's message.
		const runtime = makeRuntime({
			memories: [
				memory({ id: "s1", entityId: SHAW_ID, createdAt: T0 }),
				memory({ id: "al1", entityId: ALICE_ID, createdAt: T0 + 5_000 }),
				memory({
					id: "a1",
					entityId: AGENT_ID,
					createdAt: T0 + 10_000,
					inReplyTo: "s1" as UUID,
				}),
			],
		});
		const followUp = memory({
			id: "s2",
			entityId: SHAW_ID,
			createdAt: T0 + 20_000,
		});
		await expect(senderInActiveConversation(runtime, followUp)).resolves.toBe(
			true,
		);
	});

	it("fails CLOSED on getMemories error and reports it", async () => {
		const runtime = makeRuntime({ memoriesError: new Error("db down") });
		const followUp = memory({
			id: "s2",
			entityId: SHAW_ID,
			createdAt: T0,
		});
		await expect(senderInActiveConversation(runtime, followUp)).resolves.toBe(
			false,
		);
		expect(runtime.reportError).toHaveBeenCalledWith(
			"ReplyGateContinuity.history",
			expect.any(Error),
			{ roomId: ROOM_ID },
		);
	});
});
