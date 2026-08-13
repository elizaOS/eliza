/**
 * Deterministic unit tests for on_mention continuity anchors: a typed
 * per-room/per-sender record written only after successful transcript-visible
 * delivery, then consulted (fail-closed) for unaddressed follow-ups.
 */
import { describe, expect, it, vi } from "vitest";
import type { Memory } from "../../types/memory";
import type { Content, UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import { wrapSingleTurnVisibleCallback } from "../message";
import {
	CONTINUITY_ANCHOR_VERSION,
	CONTINUITY_WINDOW_MS,
	continuityAnchorCacheKey,
	isTranscriptVisibleEngagement,
	type OnMentionContinuityAnchor,
	recordOnMentionContinuityAnchor,
	senderInActiveConversation,
} from "./reply-gate-continuity";

const AGENT_ID = "00000000-0000-0000-0000-00000000000a" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000000b" as UUID;
const SHAW_ID = "00000000-0000-0000-0000-00000000000c" as UUID;
const ALICE_ID = "00000000-0000-0000-0000-00000000000e" as UUID;

/** Fixed processing clock for TTL assertions. */
const NOW = 1_700_000_000_000;

function inbound(
	entityId: UUID,
	roomId: UUID = ROOM_ID,
): Pick<Memory, "entityId" | "roomId"> {
	return { entityId, roomId };
}

function makeRuntime(args?: {
	cache?: Map<string, unknown>;
	getError?: Error;
	setError?: Error;
	setResult?: boolean;
	setCache?: (key: string, value: unknown) => Promise<boolean>;
}): IAgentRuntime & {
	reportError: ReturnType<typeof vi.fn>;
	getCache: ReturnType<typeof vi.fn>;
	setCache: ReturnType<typeof vi.fn>;
	cache: Map<string, unknown>;
} {
	const cache = args?.cache ?? new Map<string, unknown>();
	const getCache = vi.fn(async (key: string) => {
		if (args?.getError) throw args.getError;
		return cache.get(key);
	});
	const setCache = vi.fn(
		args?.setCache ??
			(async (key: string, value: unknown) => {
				if (args?.setError) throw args.setError;
				cache.set(key, value);
				return args?.setResult ?? true;
			}),
	);
	return {
		agentId: AGENT_ID,
		cache,
		getCache,
		setCache,
		reportError: vi.fn(),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		getSetting: vi.fn((key: string) =>
			key === "ACTION_CALLBACK_VOICE_REWRITE" ? "false" : undefined,
		),
	} as unknown as IAgentRuntime & {
		reportError: ReturnType<typeof vi.fn>;
		getCache: ReturnType<typeof vi.fn>;
		setCache: ReturnType<typeof vi.fn>;
		cache: Map<string, unknown>;
	};
}

describe("isTranscriptVisibleEngagement", () => {
	it("accepts ordinary reply text", () => {
		expect(
			isTranscriptVisibleEngagement({
				text: "here is the answer",
				actions: ["REPLY"],
			} as Content),
		).toBe(true);
	});

	it("rejects internal, action_result, empty, and pure IGNORE/STOP rows", () => {
		expect(
			isTranscriptVisibleEngagement({
				text: "secret",
				transcriptVisibility: "internal",
			} as Content),
		).toBe(false);
		expect(
			isTranscriptVisibleEngagement({
				text: "done",
				type: "action_result",
			} as Content),
		).toBe(false);
		expect(isTranscriptVisibleEngagement({ text: "   " } as Content)).toBe(
			false,
		);
		expect(
			isTranscriptVisibleEngagement({
				text: "ignored",
				actions: ["IGNORE"],
			} as Content),
		).toBe(false);
		expect(
			isTranscriptVisibleEngagement({
				text: "stop",
				actions: ["STOP"],
			} as Content),
		).toBe(false);
	});
});

describe("recordOnMentionContinuityAnchor + senderInActiveConversation", () => {
	it("true for a fresh follow-up after a delivered engagement with this sender", async () => {
		const runtime = makeRuntime();
		await recordOnMentionContinuityAnchor(runtime, {
			roomId: ROOM_ID,
			senderId: SHAW_ID,
			deliveredAt: NOW - 50_000,
		});
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW),
		).resolves.toBe(true);
		expect(runtime.setCache).toHaveBeenCalledWith(
			continuityAnchorCacheKey(AGENT_ID, ROOM_ID),
			{
				v: CONTINUITY_ANCHOR_VERSION,
				senderId: SHAW_ID,
				deliveredAt: NOW - 50_000,
			} satisfies OnMentionContinuityAnchor,
		);
	});

	it("false when the anchor engaged a different sender (interleaving)", async () => {
		const runtime = makeRuntime();
		await recordOnMentionContinuityAnchor(runtime, {
			roomId: ROOM_ID,
			senderId: ALICE_ID,
			deliveredAt: NOW - 10_000,
		});
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW),
		).resolves.toBe(false);
	});

	it("false when the anchor is older than CONTINUITY_WINDOW_MS", async () => {
		const runtime = makeRuntime();
		await recordOnMentionContinuityAnchor(runtime, {
			roomId: ROOM_ID,
			senderId: SHAW_ID,
			deliveredAt: NOW - CONTINUITY_WINDOW_MS - 1,
		});
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW),
		).resolves.toBe(false);
	});

	it("false for negative ages (delayed / out-of-order event clocks)", async () => {
		const runtime = makeRuntime();
		await recordOnMentionContinuityAnchor(runtime, {
			roomId: ROOM_ID,
			senderId: SHAW_ID,
			deliveredAt: NOW + 30_000,
		});
		// Processing clock is BEFORE the recorded delivery — must not open the gate.
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW),
		).resolves.toBe(false);
	});

	it("false when no anchor has been recorded (no delivered engagement)", async () => {
		const runtime = makeRuntime();
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW),
		).resolves.toBe(false);
	});

	it("room-scoped: Alice's room anchor does not open Shaw's room", async () => {
		const otherRoom = "00000000-0000-0000-0000-0000000000ff" as UUID;
		const runtime = makeRuntime();
		await recordOnMentionContinuityAnchor(runtime, {
			roomId: otherRoom,
			senderId: SHAW_ID,
			deliveredAt: NOW - 5_000,
		});
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID, ROOM_ID), NOW),
		).resolves.toBe(false);
	});

	it("latest delivered sender wins — overwrites prior room anchor", async () => {
		const runtime = makeRuntime();
		await recordOnMentionContinuityAnchor(runtime, {
			roomId: ROOM_ID,
			senderId: SHAW_ID,
			deliveredAt: NOW - 40_000,
		});
		await recordOnMentionContinuityAnchor(runtime, {
			roomId: ROOM_ID,
			senderId: ALICE_ID,
			deliveredAt: NOW - 5_000,
		});
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW),
		).resolves.toBe(false);
		await expect(
			senderInActiveConversation(runtime, inbound(ALICE_ID), NOW),
		).resolves.toBe(true);
	});

	it("fails CLOSED on getCache error and reports it", async () => {
		const runtime = makeRuntime({ getError: new Error("db down") });
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW),
		).resolves.toBe(false);
		expect(runtime.reportError).toHaveBeenCalledWith(
			"ReplyGateContinuity.history",
			expect.any(Error),
			{ roomId: ROOM_ID },
		);
	});

	it("record is best-effort: setCache failure reports and does not throw", async () => {
		const runtime = makeRuntime({ setError: new Error("cache full") });
		await expect(
			recordOnMentionContinuityAnchor(runtime, {
				roomId: ROOM_ID,
				senderId: SHAW_ID,
				deliveredAt: NOW,
			}),
		).resolves.toBeUndefined();
		expect(runtime.reportError).toHaveBeenCalledWith(
			"ReplyGateContinuity.record",
			expect.any(Error),
			{ roomId: ROOM_ID, senderId: SHAW_ID },
		);
	});

	it("reports a false cache-write result as a rejected anchor", async () => {
		const runtime = makeRuntime({ setResult: false });
		await expect(
			recordOnMentionContinuityAnchor(runtime, {
				roomId: ROOM_ID,
				senderId: SHAW_ID,
				deliveredAt: NOW,
			}),
		).resolves.toBeUndefined();
		expect(runtime.reportError).toHaveBeenCalledWith(
			"ReplyGateContinuity.record",
			expect.objectContaining({
				code: "REPLY_GATE_CONTINUITY_WRITE_REJECTED",
			}),
			{ roomId: ROOM_ID, senderId: SHAW_ID },
		);
	});

	it("waits for a visible reply's pending anchor before checking a follow-up", async () => {
		let releaseWrite: (() => void) | undefined;
		const writeStarted = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		let unblockWrite: (() => void) | undefined;
		const blockedWrite = new Promise<void>((resolve) => {
			unblockWrite = resolve;
		});
		const cache = new Map<string, unknown>();
		const runtime = makeRuntime({
			cache,
			setCache: async (key, value) => {
				releaseWrite?.();
				await blockedWrite;
				cache.set(key, value);
				return true;
			},
		});
		const recording = recordOnMentionContinuityAnchor(runtime, {
			roomId: ROOM_ID,
			senderId: SHAW_ID,
			deliveredAt: NOW,
		});
		await writeStarted;
		const lookup = senderInActiveConversation(
			runtime,
			inbound(SHAW_ID),
			NOW + 1,
		);
		expect(runtime.getCache).not.toHaveBeenCalled();
		unblockWrite?.();
		await recording;
		await expect(lookup).resolves.toBe(true);
	});

	it("serializes same-room writes so an older slow delivery cannot overwrite a newer one", async () => {
		let markFirstStarted: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		let releaseFirst: (() => void) | undefined;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const cache = new Map<string, unknown>();
		let writes = 0;
		const runtime = makeRuntime({
			cache,
			setCache: async (key, value) => {
				writes += 1;
				if (writes === 1) {
					markFirstStarted?.();
					await firstBlocked;
				}
				cache.set(key, value);
				return true;
			},
		});
		const older = recordOnMentionContinuityAnchor(runtime, {
			roomId: ROOM_ID,
			senderId: SHAW_ID,
			deliveredAt: NOW,
		});
		await firstStarted;
		const newer = recordOnMentionContinuityAnchor(runtime, {
			roomId: ROOM_ID,
			senderId: ALICE_ID,
			deliveredAt: NOW + 1,
		});
		await Promise.resolve();
		expect(writes).toBe(1);
		releaseFirst?.();
		await Promise.all([older, newer]);
		expect(
			cache.get(continuityAnchorCacheKey(AGENT_ID, ROOM_ID)),
		).toMatchObject({ senderId: ALICE_ID, deliveredAt: NOW + 1 });
	});

	it("never records an anchor for the agent entity itself", async () => {
		const runtime = makeRuntime();
		await recordOnMentionContinuityAnchor(runtime, {
			roomId: ROOM_ID,
			senderId: AGENT_ID,
			deliveredAt: NOW,
		});
		expect(runtime.setCache).not.toHaveBeenCalled();
	});

	it("rejects malformed cache payloads", async () => {
		const runtime = makeRuntime({
			cache: new Map([
				[
					continuityAnchorCacheKey(AGENT_ID, ROOM_ID),
					{ v: 1, senderId: SHAW_ID } /* missing deliveredAt */,
				],
			]),
		});
		await expect(
			senderInActiveConversation(runtime, inbound(SHAW_ID), NOW),
		).resolves.toBe(false);
	});
});

describe("isTranscriptVisibleEngagement does not treat non-dialogue as engagement", () => {
	it("documents that IGNORE/action_result never open continuity (sticky-open / theft guard)", () => {
		// These shapes are what core persists under the agent entity; if they were
		// accepted as engagement anchors the five-minute window would stick open
		// or steal the room target from a genuine delivered reply.
		expect(
			isTranscriptVisibleEngagement({
				thought: "Agent decided not to respond",
				actions: ["IGNORE"],
			} as Content),
		).toBe(false);
		expect(
			isTranscriptVisibleEngagement({
				text: "tool finished",
				type: "action_result",
				actions: ["REPLY"],
			} as Content),
		).toBe(false);
	});
});

describe("delivery-boundary continuity contract (wrapSingleTurnVisibleCallback seam)", () => {
	it("records the room/sender anchor when a visible reply callback resolves", async () => {
		const runtime = makeRuntime();
		const message = { roomId: ROOM_ID, entityId: SHAW_ID };
		const callback = vi.fn(async () => []);
		const wrapped = wrapSingleTurnVisibleCallback(runtime, message, callback);
		await wrapped?.({ text: "answer", actions: ["REPLY"] } as Content);
		expect(callback).toHaveBeenCalled();
		const stored = runtime.cache.get(
			continuityAnchorCacheKey(AGENT_ID, ROOM_ID),
		) as OnMentionContinuityAnchor;
		expect(stored).toMatchObject({
			v: CONTINUITY_ANCHOR_VERSION,
			senderId: SHAW_ID,
		});
		expect(typeof stored.deliveredAt).toBe("number");
		await expect(
			senderInActiveConversation(
				runtime,
				inbound(SHAW_ID),
				stored.deliveredAt + 1_000,
			),
		).resolves.toBe(true);
	});

	it("does not record when the connector callback rejects (failed delivery)", async () => {
		const runtime = makeRuntime();
		const message = { roomId: ROOM_ID, entityId: SHAW_ID };
		const callback = vi.fn(async () => {
			throw new Error("connector down");
		});
		const wrapped = wrapSingleTurnVisibleCallback(runtime, message, callback);
		await expect(
			wrapped?.({ text: "answer", actions: ["REPLY"] } as Content),
		).rejects.toThrow("connector down");
		expect(runtime.cache.size).toBe(0);
	});

	it("holds an immediate follow-up until the delivered reply anchor is stored", async () => {
		const runtime = makeRuntime();
		const message = { roomId: ROOM_ID, entityId: SHAW_ID };
		let markVisible: (() => void) | undefined;
		const visible = new Promise<void>((resolve) => {
			markVisible = resolve;
		});
		let finishCallback: (() => void) | undefined;
		const callbackBlocked = new Promise<void>((resolve) => {
			finishCallback = resolve;
		});
		const callback = vi.fn(async () => {
			markVisible?.();
			await callbackBlocked;
			return [];
		});
		const wrapped = wrapSingleTurnVisibleCallback(runtime, message, callback);
		const delivery = wrapped?.({
			text: "answer",
			actions: ["REPLY"],
		} as Content);
		await visible;
		const followUp = senderInActiveConversation(runtime, inbound(SHAW_ID));
		expect(runtime.getCache).not.toHaveBeenCalled();
		finishCallback?.();
		await delivery;
		await expect(followUp).resolves.toBe(true);
	});

	it("does not record IGNORE terminal deliveries", async () => {
		const runtime = makeRuntime();
		const message = { roomId: ROOM_ID, entityId: SHAW_ID };
		const callback = vi.fn(async () => []);
		const wrapped = wrapSingleTurnVisibleCallback(runtime, message, callback);
		await wrapped?.({
			thought: "Agent decided not to respond",
			actions: ["IGNORE"],
		} as Content);
		expect(runtime.cache.size).toBe(0);
	});
});
