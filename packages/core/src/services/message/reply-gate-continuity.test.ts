/**
 * Deterministic tests for runtime-local on_mention continuity. The harness
 * treats returned Memory rows as connector receipts and never infers delivery
 * from callback resolution or response intent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	PersonalitySlot,
	ReplyGateMode,
} from "../../features/advanced-capabilities/personality/types";
import type { Memory } from "../../types/memory";
import type { Content, UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import { wrapSingleTurnVisibleCallback } from "../message";
import {
	CONTINUITY_WINDOW_MS,
	isTranscriptVisibleEngagement,
	MAX_CONTINUITY_ANCHORS_PER_RUNTIME,
	recordOnMentionContinuityDelivery,
	senderInActiveConversation,
} from "./reply-gate-continuity";

const AGENT_ID = "00000000-0000-0000-0000-00000000000a" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000000b" as UUID;
const OTHER_ROOM_ID = "00000000-0000-0000-0000-00000000000f" as UUID;
const SHAW_ID = "00000000-0000-0000-0000-00000000000c" as UUID;
const ALICE_ID = "00000000-0000-0000-0000-00000000000e" as UUID;
const NOW = 1_700_000_000_000;

type TestRuntime = IAgentRuntime & {
	getCache: ReturnType<typeof vi.fn>;
	setCache: ReturnType<typeof vi.fn>;
	reportError: ReturnType<typeof vi.fn>;
};

function makeRuntime(
	replyGate: ReplyGateMode | null = "on_mention",
): TestRuntime {
	const store = {
		getSlot: (entityId: UUID | "global") =>
			(entityId === "global" || replyGate === null
				? {}
				: { reply_gate: replyGate }) as PersonalitySlot,
	};
	return {
		agentId: AGENT_ID,
		getCache: vi.fn(),
		setCache: vi.fn(),
		reportError: vi.fn(),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		getService: vi.fn(() => store),
		getSetting: vi.fn((key: string) =>
			key === "ACTION_CALLBACK_VOICE_REWRITE" ? "false" : undefined,
		),
	} as unknown as TestRuntime;
}

function inbound(
	entityId: UUID,
	roomId: UUID = ROOM_ID,
): Pick<Memory, "entityId" | "roomId"> {
	return { entityId, roomId };
}

function receipt(args?: {
	agentId?: UUID;
	entityId?: UUID;
	roomId?: UUID;
	createdAt?: number;
	content?: Content;
}): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000099" as UUID,
		agentId: args?.agentId ?? AGENT_ID,
		entityId: args?.entityId ?? AGENT_ID,
		roomId: args?.roomId ?? ROOM_ID,
		createdAt: args?.createdAt ?? NOW,
		content: args?.content ?? { text: "delivered", actions: ["REPLY"] },
	};
}

function roomIdFor(index: number): UUID {
	return `00000000-0000-0000-0001-${String(index).padStart(12, "0")}` as UUID;
}

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isTranscriptVisibleEngagement", () => {
	it("accepts ordinary reply text", () => {
		expect(
			isTranscriptVisibleEngagement({
				text: "here is the answer",
				actions: ["REPLY"],
			}),
		).toBe(true);
	});

	it("rejects internal, action_result, blank, and pure IGNORE/STOP rows", () => {
		expect(
			isTranscriptVisibleEngagement({
				text: "secret",
				transcriptVisibility: "internal",
			}),
		).toBe(false);
		expect(
			isTranscriptVisibleEngagement({
				text: "done",
				type: "action_result",
			} as Content),
		).toBe(false);
		expect(isTranscriptVisibleEngagement({ text: "   " })).toBe(false);
		expect(
			isTranscriptVisibleEngagement({ text: "ignored", actions: ["IGNORE"] }),
		).toBe(false);
		expect(
			isTranscriptVisibleEngagement({ text: "stop", actions: ["STOP"] }),
		).toBe(false);
	});
});

describe("receipt ordering and bounded lifecycle", () => {
	it("opens only for a matching agent+room visible receipt", async () => {
		const runtime = makeRuntime();
		recordOnMentionContinuityDelivery(runtime, {
			roomId: ROOM_ID,
			senderId: SHAW_ID,
			delivered: [receipt()],
		});
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW + 1),
		).resolves.toBe(true);
	});

	it("uses the maximum finite provider createdAt", async () => {
		const runtime = makeRuntime();
		recordOnMentionContinuityDelivery(runtime, {
			roomId: ROOM_ID,
			senderId: SHAW_ID,
			delivered: [
				receipt({ createdAt: NOW - CONTINUITY_WINDOW_MS + 10 }),
				receipt({ createdAt: NOW }),
				receipt({ createdAt: Number.NaN }),
			],
		});
		await expect(
			senderInActiveConversation(
				runtime,
				inbound(SHAW_ID),
				NOW + CONTINUITY_WINDOW_MS,
			),
		).resolves.toBe(true);
	});

	it("keeps a newer receipt when an older callback finishes later", async () => {
		const runtime = makeRuntime();
		recordOnMentionContinuityDelivery(runtime, {
			roomId: ROOM_ID,
			senderId: ALICE_ID,
			delivered: [receipt({ createdAt: NOW })],
		});
		recordOnMentionContinuityDelivery(runtime, {
			roomId: ROOM_ID,
			senderId: SHAW_ID,
			delivered: [receipt({ createdAt: NOW - 1 })],
		});
		await expect(
			senderInActiveConversation(runtime, inbound(ALICE_ID), NOW + 1),
		).resolves.toBe(true);
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW + 1),
		).resolves.toBe(false);
	});

	it("invalidates equal-time receipts from different senders until a newer receipt", async () => {
		const runtime = makeRuntime();
		for (const senderId of [SHAW_ID, ALICE_ID]) {
			recordOnMentionContinuityDelivery(runtime, {
				roomId: ROOM_ID,
				senderId,
				delivered: [receipt()],
			});
		}
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW + 1),
		).resolves.toBe(false);
		await expect(
			senderInActiveConversation(runtime, inbound(ALICE_ID), NOW + 1),
		).resolves.toBe(false);

		recordOnMentionContinuityDelivery(runtime, {
			roomId: ROOM_ID,
			senderId: SHAW_ID,
			delivered: [receipt({ createdAt: NOW - 1 })],
		});
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW + 1),
		).resolves.toBe(false);

		recordOnMentionContinuityDelivery(runtime, {
			roomId: ROOM_ID,
			senderId: ALICE_ID,
			delivered: [receipt({ createdAt: NOW + 1 })],
		});
		await expect(
			senderInActiveConversation(runtime, inbound(ALICE_ID), NOW + 2),
		).resolves.toBe(true);
	});

	it("keeps equal-time receipts idempotent for the same sender", async () => {
		const runtime = makeRuntime();
		for (let index = 0; index < 2; index++) {
			recordOnMentionContinuityDelivery(runtime, {
				roomId: ROOM_ID,
				senderId: SHAW_ID,
				delivered: [receipt()],
			});
		}
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW + 1),
		).resolves.toBe(true);
	});

	it("expires old receipts and deletes future-clock receipts fail closed", async () => {
		const runtime = makeRuntime();
		recordOnMentionContinuityDelivery(runtime, {
			roomId: ROOM_ID,
			senderId: SHAW_ID,
			delivered: [receipt({ createdAt: NOW - CONTINUITY_WINDOW_MS - 1 })],
		});
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW),
		).resolves.toBe(false);

		recordOnMentionContinuityDelivery(runtime, {
			roomId: ROOM_ID,
			senderId: SHAW_ID,
			delivered: [receipt({ createdAt: NOW + 30_000 })],
		});
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW),
		).resolves.toBe(false);
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW + 30_001),
		).resolves.toBe(false);
	});

	it("is scoped by room and sender", async () => {
		const runtime = makeRuntime();
		recordOnMentionContinuityDelivery(runtime, {
			roomId: OTHER_ROOM_ID,
			senderId: ALICE_ID,
			delivered: [receipt({ roomId: OTHER_ROOM_ID })],
		});
		await expect(
			senderInActiveConversation(runtime, inbound(ALICE_ID), NOW + 1),
		).resolves.toBe(false);
		await expect(
			senderInActiveConversation(
				runtime,
				inbound(ALICE_ID, OTHER_ROOM_ID),
				NOW + 1,
			),
		).resolves.toBe(true);
	});

	it("bounds per-runtime room anchors and evicts the oldest", async () => {
		const runtime = makeRuntime();
		for (let index = 0; index <= MAX_CONTINUITY_ANCHORS_PER_RUNTIME; index++) {
			const roomId = roomIdFor(index);
			recordOnMentionContinuityDelivery(runtime, {
				roomId,
				senderId: SHAW_ID,
				delivered: [
					receipt({
						roomId,
						createdAt: NOW - MAX_CONTINUITY_ANCHORS_PER_RUNTIME + index,
					}),
				],
			});
		}
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID, roomIdFor(0)), NOW),
		).resolves.toBe(false);
		await expect(
			senderInActiveConversation(
				runtime,
				inbound(SHAW_ID, roomIdFor(MAX_CONTINUITY_ANCHORS_PER_RUNTIME)),
				NOW,
			),
		).resolves.toBe(true);
	});

	it("does not allocate an anchor for empty or mismatched receipt arrays", async () => {
		const runtime = makeRuntime();
		for (const delivered of [
			[],
			null,
			{},
			[null],
			[receipt({ roomId: OTHER_ROOM_ID })],
			[receipt({ agentId: ALICE_ID })],
			[receipt({ entityId: ALICE_ID })],
			[
				receipt({
					content: { text: "hidden", transcriptVisibility: "internal" },
				}),
			],
		]) {
			recordOnMentionContinuityDelivery(runtime, {
				roomId: ROOM_ID,
				senderId: SHAW_ID,
				delivered,
			});
		}
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW + 1),
		).resolves.toBe(false);
	});
});

describe("delivery-boundary contract", () => {
	it("records a matching returned Memory receipt without using persistent cache", async () => {
		const runtime = makeRuntime();
		const callback = vi.fn(async () => [receipt()]);
		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			{ roomId: ROOM_ID, entityId: SHAW_ID },
			callback,
		);
		await wrapped?.({ text: "response intent", actions: ["REPLY"] });
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW + 1),
		).resolves.toBe(true);
		expect(runtime.getCache).not.toHaveBeenCalled();
		expect(runtime.setCache).not.toHaveBeenCalled();
	});

	it("does not treat callback resolution with [] as delivery", async () => {
		const runtime = makeRuntime();
		const callback = vi.fn(async () => []);
		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			{ roomId: ROOM_ID, entityId: SHAW_ID },
			callback,
		);
		await wrapped?.({ text: "response intent", actions: ["REPLY"] });
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW + 1),
		).resolves.toBe(false);
	});

	it("does not record a wrong-room, wrong-agent, or internal returned receipt", async () => {
		const runtime = makeRuntime();
		const callback = vi.fn(async () => [
			receipt({ roomId: OTHER_ROOM_ID }),
			receipt({ agentId: ALICE_ID }),
			receipt({ entityId: ALICE_ID }),
			receipt({
				content: { text: "hidden", transcriptVisibility: "internal" },
			}),
		]);
		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			{ roomId: ROOM_ID, entityId: SHAW_ID },
			callback,
		);
		await wrapped?.({ text: "response intent", actions: ["REPLY"] });
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW + 1),
		).resolves.toBe(false);
	});

	it("releases the barrier without recording when the connector rejects", async () => {
		const runtime = makeRuntime();
		const callback = vi.fn(async (): Promise<Memory[]> => {
			throw new Error("connector down");
		});
		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			{ roomId: ROOM_ID, entityId: SHAW_ID },
			callback,
		);
		await expect(
			wrapped?.({ text: "answer", actions: ["REPLY"] }),
		).rejects.toThrow("connector down");
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW + 1),
		).resolves.toBe(false);
	});

	it("holds an immediate follow-up until the connector returns its receipt", async () => {
		const runtime = makeRuntime();
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let finishCallback: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			finishCallback = resolve;
		});
		const callback = vi.fn(async () => {
			markStarted?.();
			await blocked;
			return [receipt()];
		});
		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			{ roomId: ROOM_ID, entityId: SHAW_ID },
			callback,
		);
		const delivery = wrapped?.({ text: "answer", actions: ["REPLY"] });
		await started;
		let settled = false;
		const followUp = senderInActiveConversation(runtime, inbound(SHAW_ID)).then(
			(result) => {
				settled = true;
				return result;
			},
		);
		await Promise.resolve();
		expect(settled).toBe(false);
		finishCallback?.();
		await delivery;
		await expect(followUp).resolves.toBe(true);
	});

	it("orders overlapping callbacks by receipt timestamp, not completion", async () => {
		const runtime = makeRuntime();
		let startOlder: (() => void) | undefined;
		const olderStarted = new Promise<void>((resolve) => {
			startOlder = resolve;
		});
		let finishOlder: (() => void) | undefined;
		const olderBlocked = new Promise<void>((resolve) => {
			finishOlder = resolve;
		});
		const olderCallback = vi.fn(async () => {
			startOlder?.();
			await olderBlocked;
			return [receipt({ createdAt: NOW - 1 })];
		});
		const newerCallback = vi.fn(async () => [receipt({ createdAt: NOW })]);
		const olderWrapped = wrapSingleTurnVisibleCallback(
			runtime,
			{ roomId: ROOM_ID, entityId: SHAW_ID },
			olderCallback,
		);
		const newerWrapped = wrapSingleTurnVisibleCallback(
			runtime,
			{ roomId: ROOM_ID, entityId: ALICE_ID },
			newerCallback,
		);
		const olderDelivery = olderWrapped?.({ text: "older", actions: ["REPLY"] });
		await olderStarted;
		await newerWrapped?.({ text: "newer", actions: ["REPLY"] });
		finishOlder?.();
		await olderDelivery;
		await expect(
			senderInActiveConversation(runtime, inbound(ALICE_ID), NOW + 1),
		).resolves.toBe(true);
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW + 1),
		).resolves.toBe(false);
	});

	it.each<ReplyGateMode>([
		"always",
		"addressed_or_ambient",
		"never_until_lift",
	])("does not record while effective reply gate is %s", async (mode) => {
		const runtime = makeRuntime(mode);
		const callback = vi.fn(async () => [receipt()]);
		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			{ roomId: ROOM_ID, entityId: SHAW_ID },
			callback,
		);
		await wrapped?.({ text: "answer", actions: ["REPLY"] });
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW + 1),
		).resolves.toBe(false);
	});

	it("does not record without a personality store", async () => {
		const runtime = makeRuntime();
		runtime.getService = vi.fn(() => null);
		const callback = vi.fn(async () => [receipt()]);
		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			{ roomId: ROOM_ID, entityId: SHAW_ID },
			callback,
		);
		await wrapped?.({ text: "answer", actions: ["REPLY"] });
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW + 1),
		).resolves.toBe(false);
	});

	it("does not record receipts for the agent's own inbound turn", async () => {
		const runtime = makeRuntime();
		const callback = vi.fn(async () => [receipt()]);
		const wrapped = wrapSingleTurnVisibleCallback(
			runtime,
			{ roomId: ROOM_ID, entityId: AGENT_ID },
			callback,
		);
		await wrapped?.({ text: "answer", actions: ["REPLY"] });
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW + 1),
		).resolves.toBe(false);
	});
});
