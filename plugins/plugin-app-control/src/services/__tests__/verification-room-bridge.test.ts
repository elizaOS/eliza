import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerificationRoomBridgeService } from "../verification-room-bridge.ts";

/**
 * Minimal SwarmCoordinator-shaped test double. Only `subscribe` is exercised
 * by the bridge.
 */
function makeCoordinator() {
	const listeners = new Set<(event: unknown) => void>();
	return {
		subscribe: (listener: (event: unknown) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		__emit: (event: unknown) => {
			for (const l of listeners) l(event);
		},
		__listenerCount: () => listeners.size,
	};
}

function makeRuntime(initialServices: Record<string, unknown>) {
	const services = { ...initialServices };
	return {
		runtime: {
			getService: vi.fn((name: string) => services[name] ?? null),
			createMemory: vi.fn(async () => ({ id: "mem-test" })),
			agentId: "agent-1",
			logger: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
		} as unknown as IAgentRuntime,
		setService: (name: string, instance: unknown) => {
			services[name] = instance;
		},
	};
}

describe("VerificationRoomBridgeService — boot-order retry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("attaches immediately when SwarmCoordinator is available at start()", async () => {
		const coordinator = makeCoordinator();
		const { runtime } = makeRuntime({ SWARM_COORDINATOR: coordinator });

		const service = await VerificationRoomBridgeService.start(runtime);

		expect(coordinator.__listenerCount()).toBe(1);
		await service.stop();
		expect(coordinator.__listenerCount()).toBe(0);
	});

	it("retries until SwarmCoordinator is registered, then subscribes once", async () => {
		const coordinator = makeCoordinator();
		const { runtime, setService } = makeRuntime({});

		const service = await VerificationRoomBridgeService.start(runtime);

		// First attach attempt failed — no service yet, no subscriber.
		expect(coordinator.__listenerCount()).toBe(0);

		// Service becomes available later; advance the retry timer.
		setService("SWARM_COORDINATOR", coordinator);
		vi.advanceTimersByTime(500);
		await Promise.resolve();

		expect(coordinator.__listenerCount()).toBe(1);
		await service.stop();
		expect(coordinator.__listenerCount()).toBe(0);
	});

	it("gives up quietly after ATTACH_MAX_RETRIES without binding twice", async () => {
		const coordinator = makeCoordinator();
		const { runtime, setService } = makeRuntime({});

		const service = await VerificationRoomBridgeService.start(runtime);

		// Drain the entire retry budget: 60 retries × 500ms = 30s.
		vi.advanceTimersByTime(31_000);
		await Promise.resolve();

		// Service eventually shows up AFTER giving up. Bridge must NOT
		// subscribe — the retry loop already terminated.
		setService("SWARM_COORDINATOR", coordinator);
		vi.advanceTimersByTime(5_000);
		await Promise.resolve();
		expect(coordinator.__listenerCount()).toBe(0);

		await service.stop();
	});

	it("stop() cancels a pending retry timer", async () => {
		const coordinator = makeCoordinator();
		const { runtime, setService } = makeRuntime({});

		const service = await VerificationRoomBridgeService.start(runtime);

		// Tear down BEFORE the service becomes available.
		await service.stop();

		// Now register the coordinator and advance time. A leaked timer
		// would re-attach and increment the listener count; a proper
		// cancel keeps it at zero.
		setService("SWARM_COORDINATOR", coordinator);
		vi.advanceTimersByTime(60_000);
		await Promise.resolve();
		expect(coordinator.__listenerCount()).toBe(0);
	});
});

describe("VerificationRoomBridgeService — verdict posting", () => {
	// A plugin pass triggers a loopback POST to /api/plugins/load-from-directory;
	// stub fetch so the load outcome is deterministic. `flush` lets the async
	// handleEvent chain (fetch → json → createMemory) settle.
	const flush = () => new Promise((r) => setTimeout(r, 0));
	beforeEach(() => {
		vi.useRealTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({ ok: true, pluginName: "plugin-habit-tracker" }),
			})),
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function pluginEvent(verdict: "pass" | "fail") {
		return {
			type: "task_complete",
			sessionId: `sess-${verdict}`,
			data: {
				originRoomId: "room-42",
				label: "create-view:habit-tracker",
				workdir: "/repo/plugins/plugin-habit-tracker",
				summary: verdict === "fail" ? "tsc error in src/index.ts" : undefined,
				verification: {
					source: "custom-validator",
					verdict,
					validator: { service: "app-verification", method: "verifyPlugin" },
					params: {
						pluginName: "plugin-habit-tracker",
						workdir: "/repo/plugins/plugin-habit-tracker",
						profile: "full",
					},
				},
			},
		};
	}

	it("live-loads the plugin and posts a 'loaded live' verdict (never reinject)", async () => {
		const coordinator = makeCoordinator();
		const { runtime } = makeRuntime({ SWARM_COORDINATOR: coordinator });
		const service = await VerificationRoomBridgeService.start(runtime);

		coordinator.__emit(pluginEvent("pass"));
		await flush();

		// It POSTed the workdir to the live-load route.
		expect(globalThis.fetch).toHaveBeenCalledWith(
			expect.stringContaining("/api/plugins/load-from-directory"),
			expect.objectContaining({ method: "POST" }),
		);

		expect(runtime.createMemory).toHaveBeenCalledTimes(1);
		const [memory, table] = (runtime.createMemory as ReturnType<typeof vi.fn>)
			.mock.calls[0];
		expect(table).toBe("messages");
		expect(memory.roomId).toBe("room-42");
		const text = memory.content.text as string;
		expect(text).toContain("plugin-habit-tracker plugin built, verified, and");
		expect(text).toContain("loaded live");
		expect(text).not.toContain("reinject");
		expect(memory.content.metadata).toMatchObject({ verdict: "pass" });

		await service.stop();
	});

	it("reports a build-passed-but-load-failed verdict honestly", async () => {
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: false,
			status: 422,
			json: async () => ({ ok: false, error: "import threw: bad export" }),
		} as Response);
		const coordinator = makeCoordinator();
		const { runtime } = makeRuntime({ SWARM_COORDINATOR: coordinator });
		const service = await VerificationRoomBridgeService.start(runtime);

		coordinator.__emit(pluginEvent("pass"));
		await flush();

		const [memory] = (runtime.createMemory as ReturnType<typeof vi.fn>).mock
			.calls[0];
		const text = memory.content.text as string;
		expect(text).toContain("built and verified");
		expect(text).toContain("live-load failed");
		expect(text).toContain("import threw: bad export");
		expect(text).toContain("Reload the agent");
		expect(text).not.toContain("reinject");

		await service.stop();
	});

	it("posts a verifyPlugin fail verdict with the failure summary", async () => {
		const coordinator = makeCoordinator();
		const { runtime } = makeRuntime({ SWARM_COORDINATOR: coordinator });
		const service = await VerificationRoomBridgeService.start(runtime);

		coordinator.__emit(pluginEvent("fail"));
		await flush();

		expect(runtime.createMemory).toHaveBeenCalledTimes(1);
		const [memory] = (runtime.createMemory as ReturnType<typeof vi.fn>).mock
			.calls[0];
		const text = memory.content.text as string;
		expect(text).toContain("tsc error in src/index.ts");
		expect(memory.content.metadata).toMatchObject({ verdict: "fail" });

		await service.stop();
	});

	it("drops a verdict event missing the validator params (no targetName)", async () => {
		const coordinator = makeCoordinator();
		const { runtime } = makeRuntime({ SWARM_COORDINATOR: coordinator });
		const service = await VerificationRoomBridgeService.start(runtime);

		const event = pluginEvent("pass");
		// biome-ignore lint/performance/noDelete: test mutation
		delete (event.data.verification as { params?: unknown }).params;
		coordinator.__emit(event);
		await flush();

		expect(runtime.createMemory).not.toHaveBeenCalled();
		await service.stop();
	});
});
