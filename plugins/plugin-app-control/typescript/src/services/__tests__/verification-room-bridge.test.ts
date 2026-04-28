/**
 * @module plugin-app-control/services/__tests__/verification-room-bridge
 *
 * Unit tests for VerificationRoomBridgeService.
 *
 * Covers:
 *  - subscribes to SwarmCoordinator.subscribe on start
 *  - filters out events with the wrong validator service or method
 *  - filters out events without a verification.source === "custom-validator"
 *  - filters out events without an originRoomId on the data payload
 *  - posts a memory back into originRoomId for app pass / fail
 *  - posts a memory back into originRoomId for plugin pass / fail
 *  - logs and does not throw when the orchestrator service is missing
 *  - unsubscribes on stop()
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VerificationRoomBridgeService } from "../verification-room-bridge.js";

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
	unsubscribed: number;
}

/** Drain pending microtasks so async listener handlers run before assertions. */
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
				coord.unsubscribed += 1;
			};
		}),
		emit: (event: SwarmEventLike) => {
			for (const l of listeners) l(event);
		},
		listeners,
		unsubscribed: 0,
	};
	return coord;
}

function createRuntime(coordinator: FakeCoordinator | null): {
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

function passEvent(
	originRoomId: string | undefined,
	overrides?: Partial<{ method: string; appName: string; pluginName: string }>,
): SwarmEventLike {
	const method = overrides?.method ?? "verifyApp";
	const params: Record<string, string> = {
		workdir: "/tmp/wd",
		profile: "full",
	};
	if (method === "verifyApp")
		params.appName = overrides?.appName ?? "notes-app";
	else params.pluginName = overrides?.pluginName ?? "plugin-notes";
	return {
		type: "task_complete",
		sessionId: "s1",
		timestamp: Date.now(),
		data: {
			reasoning: "validator pass",
			verification: {
				source: "custom-validator",
				verdict: "pass",
				validator: { service: "app-verification", method },
				params,
			},
			originRoomId,
			label: "create-app:notes-app",
			workdir: "/tmp/wd",
		},
	};
}

function failEvent(originRoomId: string): SwarmEventLike {
	return {
		type: "escalation",
		sessionId: "s1",
		timestamp: Date.now(),
		data: {
			reason: "verification_failed",
			summary: "Verification failed: tests=2 failed",
			verifier: { service: "app-verification", method: "verifyApp" },
			verification: {
				source: "custom-validator",
				verdict: "fail",
				validator: { service: "app-verification", method: "verifyApp" },
				params: { workdir: "/tmp/wd", appName: "notes-app", profile: "full" },
			},
			details: null,
			retryCount: 3,
			maxRetries: 3,
			originRoomId,
			label: "create-app:notes-app",
			workdir: "/tmp/wd",
		},
	};
}

describe("VerificationRoomBridgeService", () => {
	let coord: FakeCoordinator;

	beforeEach(() => {
		coord = createFakeCoordinator();
	});

	it("subscribes on start", async () => {
		const { runtime } = createRuntime(coord);
		await VerificationRoomBridgeService.start(runtime);
		expect(coord.subscribe).toHaveBeenCalledTimes(1);
	});

	it("posts a memory into originRoomId on app pass", async () => {
		const { runtime, createMemory } = createRuntime(coord);
		await VerificationRoomBridgeService.start(runtime);
		coord.emit(passEvent("room-42"));
		await flushMicrotasks();
		expect(createMemory).toHaveBeenCalledTimes(1);
		const [memory, table] = createMemory.mock.calls[0] as [
			{ roomId: string; content: { text: string; source: string } },
			string,
		];
		expect(table).toBe("messages");
		expect(memory.roomId).toBe("room-42");
		expect(memory.content.source).toBe("verification-room-bridge");
		expect(memory.content.text).toContain("notes-app");
		expect(memory.content.text).toContain("built and verified");
	});

	it("posts a memory into originRoomId on plugin pass with reinject hint", async () => {
		const { runtime, createMemory } = createRuntime(coord);
		await VerificationRoomBridgeService.start(runtime);
		coord.emit(
			passEvent("room-42", {
				method: "verifyPlugin",
				pluginName: "plugin-notes",
			}),
		);
		await flushMicrotasks();
		expect(createMemory).toHaveBeenCalledTimes(1);
		const [memory] = createMemory.mock.calls[0] as [
			{ roomId: string; content: { text: string } },
			string,
		];
		expect(memory.roomId).toBe("room-42");
		expect(memory.content.text).toContain("plugin-notes");
		expect(memory.content.text).toContain("reinject");
	});

	it("posts a fail message into originRoomId on escalation", async () => {
		const { runtime, createMemory } = createRuntime(coord);
		await VerificationRoomBridgeService.start(runtime);
		coord.emit(failEvent("room-42"));
		await flushMicrotasks();
		expect(createMemory).toHaveBeenCalledTimes(1);
		const [memory] = createMemory.mock.calls[0] as [
			{ roomId: string; content: { text: string } },
			string,
		];
		expect(memory.roomId).toBe("room-42");
		expect(memory.content.text).toContain("verification failure");
		expect(memory.content.text).toContain("3");
	});

	it("ignores events with no originRoomId", async () => {
		const { runtime, createMemory } = createRuntime(coord);
		await VerificationRoomBridgeService.start(runtime);
		coord.emit(passEvent(undefined));
		await flushMicrotasks();
		expect(createMemory).not.toHaveBeenCalled();
	});

	it("ignores events from a different validator service", async () => {
		const { runtime, createMemory } = createRuntime(coord);
		await VerificationRoomBridgeService.start(runtime);
		const evt: SwarmEventLike = {
			type: "task_complete",
			sessionId: "s1",
			timestamp: Date.now(),
			data: {
				verification: {
					source: "custom-validator",
					verdict: "pass",
					validator: { service: "some-other-service", method: "verifyApp" },
					params: { workdir: "/tmp/wd", appName: "notes-app" },
				},
				originRoomId: "room-42",
			},
		};
		coord.emit(evt);
		await flushMicrotasks();
		expect(createMemory).not.toHaveBeenCalled();
	});

	it("ignores task_complete events without verification metadata", async () => {
		const { runtime, createMemory } = createRuntime(coord);
		await VerificationRoomBridgeService.start(runtime);
		const evt: SwarmEventLike = {
			type: "task_complete",
			sessionId: "s1",
			timestamp: Date.now(),
			data: { reasoning: "ok", originRoomId: "room-42" },
		};
		coord.emit(evt);
		await flushMicrotasks();
		expect(createMemory).not.toHaveBeenCalled();
	});

	it("ignores unrelated event types", async () => {
		const { runtime, createMemory } = createRuntime(coord);
		await VerificationRoomBridgeService.start(runtime);
		const evt: SwarmEventLike = {
			type: "task_status_changed",
			sessionId: "s1",
			timestamp: Date.now(),
			data: { originRoomId: "room-42" },
		};
		coord.emit(evt);
		await flushMicrotasks();
		expect(createMemory).not.toHaveBeenCalled();
	});

	it("stays inert when SWARM_COORDINATOR is missing", async () => {
		const { runtime, createMemory } = createRuntime(null);
		const service = await VerificationRoomBridgeService.start(runtime);
		expect(service).toBeInstanceOf(VerificationRoomBridgeService);
		expect(createMemory).not.toHaveBeenCalled();
	});

	it("unsubscribes on stop()", async () => {
		const { runtime } = createRuntime(coord);
		const service = await VerificationRoomBridgeService.start(runtime);
		expect(coord.listeners.length).toBe(1);
		await service.stop();
		expect(coord.listeners.length).toBe(0);
		expect(coord.unsubscribed).toBe(1);
	});

	it("stop() handles a non-function unsubscribe gracefully", async () => {
		const { runtime } = createRuntime(coord);
		const service = await VerificationRoomBridgeService.start(runtime);
		// Force the stored unsubscribe into an invalid runtime shape — what
		// would happen if a future coordinator surface returned an object
		// instead of the documented `() => void`.
		(service as unknown as { unsubscribe: unknown }).unsubscribe = {
			not: "callable",
		};
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		await expect(service.stop()).resolves.toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				"[VerificationRoomBridge] stored unsubscribe was not a function",
			),
		);
		// Field cleared so a second stop() is a no-op.
		expect(
			(service as unknown as { unsubscribe: unknown }).unsubscribe,
		).toBeNull();
		warnSpy.mockRestore();
	});

	it("stop() handles an unsubscribe that throws", async () => {
		const { runtime } = createRuntime(coord);
		const service = await VerificationRoomBridgeService.start(runtime);
		const boom = new Error("coordinator exploded");
		(service as unknown as { unsubscribe: () => void }).unsubscribe = () => {
			throw boom;
		};
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		await expect(service.stop()).resolves.toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				"[VerificationRoomBridge] unsubscribe threw during stop()",
			),
		);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("coordinator exploded"),
		);
		expect(
			(service as unknown as { unsubscribe: unknown }).unsubscribe,
		).toBeNull();
		warnSpy.mockRestore();
	});
});
