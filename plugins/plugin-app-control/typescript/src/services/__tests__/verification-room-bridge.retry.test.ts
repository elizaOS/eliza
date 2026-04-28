/**
 * @module plugin-app-control/services/__tests__/verification-room-bridge.retry
 *
 * Integration test for VerificationRoomBridgeService that drives a full
 * `APP create → fail → retry → … → escalation` retry sequence through the
 * SwarmCoordinator broadcast surface.
 *
 * The existing unit test (`verification-room-bridge.test.ts`) covers the
 * single-event paths: subscribe-on-start, pass posts a memory, escalation
 * posts a memory, off-target validators are filtered, missing originRoomId
 * is filtered, and stop() unsubscribes. This file fills the gap that the
 * unit suite does not exercise: the orchestrator's retry budget.
 *
 * Contract under test (verified by reading
 * `plugins/plugin-agent-orchestrator/src/services/swarm-decision-loop.ts`
 * around the custom-validator branch ~line 935-1060):
 *
 *  1. On a `fail` verdict where `nextCount <= cap` and
 *     `onVerificationFail === "retry"`, the decision loop appends a
 *     `validation_failed` event to the task registry and replays the
 *     retry prompt to the PTY. It does NOT call `broadcast()` for that
 *     event — `validation_failed` is registry-only.
 *  2. Only when the retry budget is exhausted does it call `broadcast()`
 *     with an `escalation` event carrying the final `retryCount` /
 *     `maxRetries` and the `originRoomId` stamped onto the
 *     CREATE_TASK metadata.
 *
 * Therefore the bridge — which only sees the broadcast stream — must:
 *  - emit zero chat memories during the retry rounds,
 *  - emit exactly one chat memory on the final escalation, and
 *  - that memory must reference the final retry count.
 *
 * Even if a buggy upstream were to broadcast `validation_failed`
 * directly, the bridge's `decodeEvent()` rejects any event whose `type`
 * isn't `task_complete` or `escalation`. We assert that defensively too:
 * if a `validation_failed` event slips onto the broadcast bus, the bridge
 * still must not post into the room.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VerificationRoomBridgeService } from "../verification-room-bridge.js";

/**
 * Structurally compatible with the real `SwarmEvent` exported from
 * plugin-agent-orchestrator. Declared locally because plugin-app-control
 * intentionally does NOT depend on plugin-agent-orchestrator at the
 * package level — the bridge already mirrors this minimal shape.
 */
interface SwarmEventLike {
	type: string;
	sessionId: string;
	timestamp: number;
	data: unknown;
}

type Listener = (event: SwarmEventLike) => void;

interface FakeCoordinator {
	subscribe: ReturnType<typeof vi.fn>;
	emit: (event: SwarmEventLike) => void;
	listeners: Listener[];
}

/** Drain pending microtasks so the bridge's async handler runs before assertions. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 8; i += 1) {
		await Promise.resolve();
	}
}

function createFakeCoordinator(): FakeCoordinator {
	const listeners: Listener[] = [];
	const coord: FakeCoordinator = {
		subscribe: vi.fn((listener: Listener) => {
			listeners.push(listener);
			return () => {
				const idx = listeners.indexOf(listener);
				if (idx !== -1) listeners.splice(idx, 1);
			};
		}),
		emit: (event: SwarmEventLike) => {
			for (const l of listeners) l(event);
		},
		listeners,
	};
	return coord;
}

function createRuntime(coordinator: FakeCoordinator): {
	runtime: IAgentRuntime;
	createMemory: ReturnType<typeof vi.fn>;
} {
	const createMemory = vi.fn(
		async () => "00000000-0000-0000-0000-000000000000",
	);
	const runtime = {
		agentId: "agent-1",
		getService: vi.fn((name: string) =>
			name === "SWARM_COORDINATOR" ? coordinator : null,
		),
		createMemory,
	} as unknown as IAgentRuntime;
	return { runtime, createMemory };
}

/**
 * Shape of `validation_failed` as emitted by `swarm-decision-loop.ts`
 * (~line 968). Note: in production this is *not* broadcast — it's only
 * appended to the task registry. We construct it here as a defensive
 * negative-case probe: even if it leaked onto the broadcast bus, the
 * bridge must reject it.
 */
function validationFailedEvent(args: {
	sessionId: string;
	attempt: number;
	maxRetries: number;
	originRoomId: string;
}): SwarmEventLike {
	return {
		type: "validation_failed",
		sessionId: args.sessionId,
		timestamp: Date.now(),
		data: {
			verdict: "fail",
			summary: `attempt ${args.attempt} failed`,
			retryCount: args.attempt - 1,
			attempt: args.attempt,
			maxRetries: args.maxRetries,
			details: null,
			originRoomId: args.originRoomId,
		},
	};
}

/**
 * Shape of the broadcast `escalation` event from `swarm-decision-loop.ts`
 * (~line 1029). This is the only failure event the bridge actually sees.
 */
function escalationEvent(args: {
	sessionId: string;
	retryCount: number;
	maxRetries: number;
	originRoomId: string;
	appName: string;
}): SwarmEventLike {
	return {
		type: "escalation",
		sessionId: args.sessionId,
		timestamp: Date.now(),
		data: {
			reason: "verification_failed",
			summary: `Verification failed after ${args.retryCount} retries: tests=2 failed`,
			verifier: { service: "app-verification", method: "verifyApp" },
			verification: {
				source: "custom-validator",
				verdict: "fail",
				validator: { service: "app-verification", method: "verifyApp" },
				params: {
					workdir: "/tmp/wd",
					appName: args.appName,
					profile: "full",
				},
			},
			details: null,
			retryCount: args.retryCount,
			maxRetries: args.maxRetries,
			originRoomId: args.originRoomId,
			label: `create-app:${args.appName}`,
			workdir: "/tmp/wd",
		},
	};
}

describe("VerificationRoomBridgeService — retry-loop integration", () => {
	let coord: FakeCoordinator;

	beforeEach(() => {
		coord = createFakeCoordinator();
	});

	it("posts exactly one memory after a 3-retry sequence ending in escalation", async () => {
		const { runtime, createMemory } = createRuntime(coord);
		await VerificationRoomBridgeService.start(runtime);
		expect(coord.subscribe).toHaveBeenCalledTimes(1);

		const sessionId = "sess-retry-1";
		const room = "room-99";
		const appName = "notes-app";
		const cap = 3;

		// Simulate the orchestrator's retry rounds. In production these are
		// registry-only and never reach the broadcast bus, but emitting them
		// here is the cleanest way to verify both invariants:
		//   (a) the bridge does not act on `validation_failed`,
		//   (b) the bridge handles only the final `escalation`.
		for (let attempt = 1; attempt <= cap; attempt += 1) {
			coord.emit(
				validationFailedEvent({
					sessionId,
					attempt,
					maxRetries: cap,
					originRoomId: room,
				}),
			);
			await flushMicrotasks();
			expect(createMemory).not.toHaveBeenCalled();
		}

		// Budget exhausted → orchestrator broadcasts `escalation`.
		coord.emit(
			escalationEvent({
				sessionId,
				retryCount: cap,
				maxRetries: cap,
				originRoomId: room,
				appName,
			}),
		);
		await flushMicrotasks();

		expect(createMemory).toHaveBeenCalledTimes(1);
		const [memory, table] = createMemory.mock.calls[0] as [
			{ roomId: string; content: { text: string; source: string } },
			string,
		];
		expect(table).toBe("messages");
		expect(memory.roomId).toBe(room);
		expect(memory.content.source).toBe("verification-room-bridge");
		// Must reference the final retry count so the user knows how many
		// rounds we burned before giving up.
		expect(memory.content.text).toContain(appName);
		expect(memory.content.text).toContain(String(cap));
		expect(memory.content.text).toContain("verification failure");
	});

	it("ignores `validation_failed` events even if a future change broadcasts them directly", async () => {
		// Defensive: today the orchestrator never broadcasts `validation_failed`,
		// it only appends to the task registry. If someone changes that, the
		// bridge's type-gate in `decodeEvent()` is the only thing standing
		// between the user and a flood of intermediate retry-noise messages.
		const { runtime, createMemory } = createRuntime(coord);
		await VerificationRoomBridgeService.start(runtime);

		for (let attempt = 1; attempt <= 5; attempt += 1) {
			coord.emit(
				validationFailedEvent({
					sessionId: "sess-defensive",
					attempt,
					maxRetries: 5,
					originRoomId: "room-defensive",
				}),
			);
		}
		await flushMicrotasks();
		expect(createMemory).not.toHaveBeenCalled();
	});

	it("surfaces a single retry escalation in isolation when no preceding failures arrive on the bus", async () => {
		// In production the bridge is restart-tolerant: if it starts mid-flight
		// (after some `validation_failed` events have already been appended to
		// the registry but before the final escalation), it should still post
		// the escalation message correctly. Verify by emitting only the
		// terminal escalation event — the bridge has zero history to rely on.
		const { runtime, createMemory } = createRuntime(coord);
		await VerificationRoomBridgeService.start(runtime);

		coord.emit(
			escalationEvent({
				sessionId: "sess-mid-flight",
				retryCount: 2,
				maxRetries: 3,
				originRoomId: "room-mid",
				appName: "todo-app",
			}),
		);
		await flushMicrotasks();

		expect(createMemory).toHaveBeenCalledTimes(1);
		const [memory] = createMemory.mock.calls[0] as [
			{ roomId: string; content: { text: string } },
			string,
		];
		expect(memory.roomId).toBe("room-mid");
		expect(memory.content.text).toContain("todo-app");
		// Includes both the count and the cap so the user knows the budget
		// was exhausted, not just the absolute number of retries.
		expect(memory.content.text).toContain("2/3");
	});
});
