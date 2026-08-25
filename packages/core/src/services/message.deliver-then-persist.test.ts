/**
 * Reply delivery and durable storage on the simple fast path run concurrently,
 * so connector latency and the response-memory write do not add serially. Both
 * still settle before handleMessage resolves: a callback failure never loses
 * the memory, a persist failure reaches the boundary, and a same-room follow-up
 * fired off delivery is barred from composing until the reply row is stored
 * while other rooms stay unblocked.
 * Real AgentRuntime + InMemoryDatabaseAdapter end to end; only the Stage-1
 * model surface is a deterministic registered handler (no live model, no
 * network). The adapter wrapper below observes/faults/holds the storage
 * boundary but always delegates real writes to the real adapter.
 */

import { v4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { createCharacter } from "../character";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { inferenceTimingRegistry } from "../inference-timing";
import { AgentRuntime } from "../runtime";
import {
	attestDeliveryAudienceFromCanonicalRoom,
	authorizeOwnerExclusiveDisclosure,
	PRIVACY_DENIED_TEXT,
} from "../security";
import type { Content, Memory } from "../types";
import { EventType } from "../types";
import { ModelType } from "../types/model";
import { asUUID, ChannelType, type UUID } from "../types/primitives";
import {
	DefaultMessageService,
	enforceTrustedDeliveryAudienceOnResult,
} from "./message";

/** The Stage-1 HANDLE_RESPONSE tool-call envelope a live model emits. */
function stage1DirectReply(replyText: string) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: "Direct answer.",
					contexts: ["simple"],
					intents: [],
					candidateActionNames: [],
					replyText,
					facts: [],
					relationships: [],
					addressedTo: [],
				},
			},
		],
		finishReason: "tool_calls",
	};
}

const activeRuntimes: AgentRuntime[] = [];

afterEach(async () => {
	await Promise.all(
		activeRuntimes.splice(0).map(async (runtime) => {
			await runtime.stop();
			await runtime.close();
		}),
	);
});

interface HarnessOptions {
	/** Artificial latency injected on the agent-reply row write only. */
	persistDelayMs?: number;
	/** Fail the agent-reply row write only (incoming-message write succeeds). */
	failReplyPersist?: boolean;
	/**
	 * Hold the FIRST agent-reply row write open until `releaseReplyPersist()`
	 * is called — a deterministic, sleep-free window for the compose-vs-persist
	 * race tests. Later reply writes (follow-up turns) are never held.
	 */
	holdReplyPersist?: boolean;
	/** Deterministic interleaving point after Stage-1 reads state, before egress. */
	beforeStage1Return?: (runtime: AgentRuntime) => Promise<void>;
}

async function createHarness(opts: HarnessOptions = {}) {
	const replyText = `the build finished clean, all green. probe-${v4()}`;
	const followUpReplyText = `and the tests passed too. probe-${v4()}`;
	const adapter = new InMemoryDatabaseAdapter();
	const runtime = new AgentRuntime({
		character: createCharacter({
			name: `DeliverThenPersist${v4().slice(0, 8)}`,
		}),
		adapter,
		logLevel: "fatal",
		enableAutonomy: false,
	});
	activeRuntimes.push(runtime);
	await runtime.initialize();
	// Interleaving trace shared by the model handler and the storage seam.
	const order: string[] = [];
	// Serialized `messages` model input per Stage-1 invocation — lets tests
	// assert what a turn's composed prompt actually contained.
	const stage1Invocations: string[] = [];
	runtime.registerModel(
		ModelType.RESPONSE_HANDLER,
		async (_rt, params) => {
			const invocation = stage1Invocations.length + 1;
			stage1Invocations.push(
				JSON.stringify((params as { messages?: unknown }).messages ?? null),
			);
			order.push(`stage1:${invocation}`);
			await opts.beforeStage1Return?.(runtime);
			return stage1DirectReply(
				invocation === 1 ? replyText : followUpReplyText,
			);
		},
		"deterministic-test",
	);

	const roomId = asUUID(v4());
	const entityId = asUUID(v4());
	await runtime.ensureConnection({
		entityId,
		roomId,
		worldId: asUUID(v4()),
		userName: "tester",
		name: "tester",
		source: "test",
		type: ChannelType.DM,
	});

	// Observation-only storage seam: records when the agent-reply row write
	// COMPLETES relative to the delivery callback, and optionally injects
	// latency, a hold-open gate, or a fault for the failure/race tests. Real
	// writes always reach the real in-memory adapter.
	let releaseReplyPersist: () => void = () => {};
	const replyPersistGate = new Promise<void>((resolve) => {
		releaseReplyPersist = resolve;
	});
	const realCreateMemories = adapter.createMemories.bind(adapter);
	adapter.createMemories = (async (
		memories: Array<{ memory: Memory; tableName: string; unique?: boolean }>,
	): Promise<UUID[]> => {
		const isReplyWrite = memories.some(
			({ memory, tableName }) =>
				tableName === "messages" &&
				memory.entityId === runtime.agentId &&
				memory.content?.text === replyText,
		);
		if (isReplyWrite && opts.persistDelayMs) {
			await new Promise((resolve) => setTimeout(resolve, opts.persistDelayMs));
		}
		if (isReplyWrite && opts.holdReplyPersist) {
			await replyPersistGate;
		}
		if (isReplyWrite && opts.failReplyPersist) {
			throw new Error("injected reply-persist failure");
		}
		const ids = await realCreateMemories(memories);
		if (isReplyWrite) {
			order.push("persist:reply");
		}
		return ids;
	}) as InMemoryDatabaseAdapter["createMemories"];

	const makeMessage = (): Memory => ({
		id: asUUID(v4()),
		entityId,
		agentId: runtime.agentId,
		roomId,
		content: {
			text: "how did the build go?",
			source: "test",
			channelType: ChannelType.DM,
		},
		createdAt: Date.now(),
	});

	const makeFollowUp = (): Memory => ({
		id: asUUID(v4()),
		entityId,
		agentId: runtime.agentId,
		roomId,
		content: {
			text: "nice — and did the tests pass?",
			source: "test",
			channelType: ChannelType.DM,
		},
		createdAt: Date.now(),
	});

	/** A second, unrelated room on the same runtime (cross-room isolation). */
	const createSecondRoom = async () => {
		const otherRoomId = asUUID(v4());
		const otherEntityId = asUUID(v4());
		await runtime.ensureConnection({
			entityId: otherEntityId,
			roomId: otherRoomId,
			worldId: asUUID(v4()),
			userName: "tester-b",
			name: "tester-b",
			source: "test",
			type: ChannelType.DM,
		});
		const makeRoomBMessage = (): Memory => ({
			id: asUUID(v4()),
			entityId: otherEntityId,
			agentId: runtime.agentId,
			roomId: otherRoomId,
			content: {
				text: "unrelated question from another room",
				source: "test",
				channelType: ChannelType.DM,
			},
			createdAt: Date.now(),
		});
		return { roomId: otherRoomId, makeRoomBMessage };
	};

	const storedReplies = async (): Promise<Memory[]> => {
		const memories = await runtime.getMemories({
			roomId,
			tableName: "messages",
			count: 100,
		});
		return memories.filter(
			(m) => m.entityId === runtime.agentId && m.content.text === replyText,
		);
	};

	const service = new DefaultMessageService();
	return {
		runtime,
		service,
		roomId,
		replyText,
		followUpReplyText,
		order,
		stage1Invocations,
		makeMessage,
		makeFollowUp,
		createSecondRoom,
		releaseReplyPersist,
		storedReplies,
	};
}

describe("simple-path deliver-then-persist ordering", () => {
	it("fires the delivery callback before the reply persist completes, then still persists it", async () => {
		const h = await createHarness();
		let orderAtDelivery: string[] | undefined;
		let deliveryActionName: string | undefined;

		const result = await h.service.handleMessage(
			h.runtime,
			h.makeMessage(),
			async (_content, actionName) => {
				h.order.push("callback");
				deliveryActionName = actionName;
				// Direct proof delivery precedes persistence: the reply-row write
				// is started only after the delivery callback has been entered, so
				// no persist marker exists yet at this synchronous point. Read it
				// synchronously — the two tasks then run CONCURRENTLY (see the
				// Promise.allSettled in the simple-path branch), so awaiting an
				// adapter read here would hand the in-memory persist a scheduling
				// window and prove nothing about the ordering contract.
				orderAtDelivery = [...h.order];
				return [];
			},
		);

		expect(result.didRespond).toBe(true);
		expect(result.mode).toBe("simple");
		expect(result.responseContent?.text).toBe(h.replyText);
		expect(deliveryActionName).toBeUndefined();
		expect(orderAtDelivery).toEqual(["stage1:1", "callback"]);
		expect(h.order).toEqual(["stage1:1", "callback", "persist:reply"]);
		expect(result.persistedResponseMessageIds).toHaveLength(1);

		// The persist completed before handleMessage resolved: an immediate
		// next-turn-style read sees exactly one stored reply — no drop, no
		// double-persist.
		const replies = await h.storedReplies();
		expect(replies).toHaveLength(1);
		expect(replies[0].content.text).toBe(h.replyText);
	});

	it("replaces private callback, persistence, event, and returned content when membership changes", async () => {
		const guest = asUUID(v4());
		let privateRoomId: UUID | undefined;
		const h = await createHarness({
			beforeStage1Return: async (runtime) => {
				if (!privateRoomId) throw new Error("private room not initialized");
				await runtime.addParticipant(guest, privateRoomId);
			},
		});
		privateRoomId = h.roomId;
		const turn = h.makeMessage();
		h.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", turn.entityId);
		h.runtime.registerProvider({
			name: "OWNER_PRIVATE_TEST_CONTEXT",
			disclosureGate: { require: "owner_exclusive" },
			alwaysInResponseState: true,
			get: async () => ({ text: "OWNER_PRIVATE_PROVIDER_CANARY" }),
		});
		await attestDeliveryAudienceFromCanonicalRoom(h.runtime, turn);

		const delivered: Content[] = [];
		const messageSentContents: Content[] = [];
		const emitEvent = h.runtime.emitEvent.bind(h.runtime);
		h.runtime.emitEvent = (async (event, payload) => {
			if (event === EventType.MESSAGE_SENT) {
				const sentMessage = (payload as { message?: Memory }).message;
				if (sentMessage) messageSentContents.push(sentMessage.content);
			}
			return emitEvent(event, payload);
		}) as AgentRuntime["emitEvent"];

		const result = await h.service.handleMessage(
			h.runtime,
			turn,
			async (content) => {
				delivered.push(content);
				return [];
			},
		);
		const stored = await h.runtime.getMemories({
			roomId: h.roomId,
			tableName: "messages",
			count: 100,
		});
		const observable = JSON.stringify({
			delivered,
			messageSentContents,
			responseContent: result.responseContent,
			responseMessages: result.responseMessages.map((memory) => memory.content),
			stored: stored.filter((memory) => memory.entityId === h.runtime.agentId),
		});

		expect(observable).not.toContain(h.replyText);
		expect(observable).not.toContain("OWNER_PRIVATE_PROVIDER_CANARY");
		expect(delivered).toEqual([
			expect.objectContaining({ text: PRIVACY_DENIED_TEXT }),
		]);
		expect(result.responseContent?.text).toBe(PRIVACY_DENIED_TEXT);
		expect(
			stored.some(
				(memory) =>
					memory.entityId === h.runtime.agentId &&
					memory.content.text === PRIVACY_DENIED_TEXT,
			),
		).toBe(true);
	});

	it("rewrites every actions-mode response memory after the audience changes", async () => {
		const h = await createHarness();
		const turn = h.makeMessage();
		h.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", turn.entityId);
		await attestDeliveryAudienceFromCanonicalRoom(h.runtime, turn);
		expect(
			await authorizeOwnerExclusiveDisclosure(h.runtime, turn),
		).toMatchObject({ allowed: true });
		await h.runtime.addParticipant(asUUID(v4()), h.roomId);

		const actionCanary = "OWNER_PRIVATE_ACTION_RESULT_CANARY";
		const responseMessages: Memory[] = ["first", "second"].map(
			(label, index) => ({
				id: asUUID(v4()),
				entityId: h.runtime.agentId,
				agentId: h.runtime.agentId,
				roomId: h.roomId,
				createdAt: Date.now() + index,
				content: {
					text: `${label}: ${actionCanary}`,
					data: { actionCanary },
				},
			}),
		);

		const result = await enforceTrustedDeliveryAudienceOnResult(
			h.runtime,
			turn,
			{
				text: `top-level: ${actionCanary}`,
				data: { actionCanary },
			},
			responseMessages,
		);

		expect(JSON.stringify(result)).not.toContain(actionCanary);
		expect(result.responseContent?.text).toBe(PRIVACY_DENIED_TEXT);
		expect(result.responseMessages).toHaveLength(2);
		expect(
			result.responseMessages.every(
				(memory) => memory.content.text === PRIVACY_DENIED_TEXT,
			),
		).toBe(true);
	});

	it("still persists the reply when the delivery callback throws, then rethrows that exact error", async () => {
		const h = await createHarness();
		const boom = new Error("connector send failed");

		await expect(
			h.service.handleMessage(h.runtime, h.makeMessage(), async () => {
				h.order.push("callback-throw");
				throw boom;
			}),
		).rejects.toBe(boom);

		// The memory was persisted despite the delivery failure, and the error
		// surfaced identity-preserved at the handleMessage boundary.
		expect(h.order).toEqual(["stage1:1", "callback-throw", "persist:reply"]);
		expect(await h.storedReplies()).toHaveLength(1);
	});

	it("propagates a reply-persist failure to the handleMessage boundary after the user got the reply", async () => {
		const h = await createHarness({ failReplyPersist: true });
		const delivered: Content[] = [];

		await expect(
			h.service.handleMessage(h.runtime, h.makeMessage(), async (content) => {
				delivered.push(content);
				return [];
			}),
		).rejects.toThrow("injected reply-persist failure");

		// Delivery happened first; the persist failure was NOT swallowed.
		expect(delivered).toHaveLength(1);
		expect(delivered[0].text).toBe(h.replyText);
	});

	it("keeps both failures observable when the callback AND the persist fail", async () => {
		const h = await createHarness({ failReplyPersist: true });
		const reported: unknown[] = [];
		const realReportError = h.runtime.reportError.bind(h.runtime);
		h.runtime.reportError = ((scope, error, context) => {
			if (scope === "MessageService.simpleDeliveryCallback") {
				reported.push(error);
			}
			return realReportError(scope, error, context);
		}) as AgentRuntime["reportError"];
		const boom = new Error("connector send failed");

		// The persist failure propagates (data loss outranks delivery failure);
		// the held delivery failure is reported, never silently superseded.
		await expect(
			h.service.handleMessage(h.runtime, h.makeMessage(), async () => {
				throw boom;
			}),
		).rejects.toThrow("injected reply-persist failure");
		expect(reported).toEqual([boom]);
	});

	it("overlaps reply delivery with persistence and records reply time independently", async () => {
		const h = await createHarness({ persistDelayMs: 150 });
		let observedTurnId: string | undefined;

		await h.service.handleMessage(
			h.runtime,
			h.makeMessage(),
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return [];
			},
			{
				onInferenceTimingSummary: (summary) => {
					observedTurnId = summary.turnId;
				},
			},
		);

		const turn = inferenceTimingRegistry.recentTurns(1)[0];
		expect(turn).toBeDefined();
		expect(observedTurnId).toBe(turn.turnId);
		const callbackSpan = turn.spans.find(
			(s) => s.name === "message:delivery:callback",
		);
		const persistSpan = turn.spans.find(
			(s) => s.name === "message:delivery:persistence",
		);
		expect(callbackSpan).toBeDefined();
		expect(persistSpan).toBeDefined();
		if (!callbackSpan || !persistSpan) return;

		// Both operations are in flight together, while the reply mark follows
		// the callback rather than waiting for the slower durable write.
		expect(persistSpan.startMs).toBeLessThanOrEqual(callbackSpan.endMs);
		expect(persistSpan.durationMs).toBeGreaterThanOrEqual(140);
		expect(turn.timeToReplyMs).not.toBeNull();
		expect(turn.timeToReplyMs as number).toBeLessThanOrEqual(persistSpan.endMs);
	});

	it("bars a same-room follow-up fired from the delivery callback from composing until the reply persist completes", async () => {
		// THE race deliver-then-persist opens up: the client reacts to the
		// delivered reply while the reply row is still being written. The
		// follow-up's compose must wait for the persist barrier, or its
		// RECENT_MESSAGES omits the very reply it is answering. The persist is
		// held open by a gate (no timing games): if the barrier did not work,
		// the follow-up's Stage-1 would run while the gate is still closed.
		const h = await createHarness({ holdReplyPersist: true });
		let followUpTurn: Promise<unknown> | null = null;

		const firstTurn = h.service.handleMessage(
			h.runtime,
			h.makeMessage(),
			async () => {
				h.order.push("callback");
				// Fire-and-forget, exactly like a real client reacting to the
				// delivered reply. A callback must never AWAIT a same-room turn
				// to completion (documented on registerPendingReplyPersist).
				followUpTurn = h.service.handleMessage(
					h.runtime,
					h.makeFollowUp(),
					async () => [],
				);
				return [];
			},
		);

		// Give the follow-up every opportunity to (incorrectly) reach Stage-1
		// while the first reply's persist is still held open.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(h.order).toContain("callback");
		expect(h.order).not.toContain("stage1:2");

		h.releaseReplyPersist();
		await firstTurn;
		expect(followUpTurn).not.toBeNull();
		await followUpTurn;

		// Stage-1 for the follow-up ran only after the reply row was stored…
		expect(h.order.indexOf("persist:reply")).toBeGreaterThan(-1);
		expect(h.order.indexOf("stage1:2")).toBeGreaterThan(
			h.order.indexOf("persist:reply"),
		);
		// …and its composed model input actually contains the delivered reply.
		expect(h.stage1Invocations).toHaveLength(2);
		expect(h.stage1Invocations[1]).toContain(h.replyText);
	});

	it("lets a different room proceed while another room's reply persist is still pending", async () => {
		// The barrier is per-room: holding room A's reply persist open must not
		// serialize room B behind it.
		const h = await createHarness({ holdReplyPersist: true });
		const roomB = await h.createSecondRoom();

		let roomADelivered: () => void = () => {};
		const delivered = new Promise<void>((resolve) => {
			roomADelivered = resolve;
		});
		const turnA = h.service.handleMessage(
			h.runtime,
			h.makeMessage(),
			async () => {
				roomADelivered();
				return [];
			},
		);

		// Room A's reply is delivered and its persist is now held open.
		await delivered;
		const resultB = await h.service.handleMessage(
			h.runtime,
			roomB.makeRoomBMessage(),
			async () => [],
		);

		// Room B ran to completion while room A's persist never finished.
		expect(resultB.didRespond).toBe(true);
		expect(h.order).not.toContain("persist:reply");

		h.releaseReplyPersist();
		await turnA;
		expect(h.order).toContain("persist:reply");
	});
});
