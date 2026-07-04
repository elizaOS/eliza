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

	it("keeps retrying past ATTACH_MAX_RETRIES and binds once when the coordinator appears late", async () => {
		const coordinator = makeCoordinator();
		const { runtime, setService } = makeRuntime({});

		const service = await VerificationRoomBridgeService.start(runtime);

		// Drain past the entire fast-retry budget (60 retries × 500ms = 30s). The
		// bridge does NOT give up here — a heavy boot can register the coordinator
		// well past that window, so it keeps retrying with a coarser backoff.
		vi.advanceTimersByTime(31_000);
		await Promise.resolve();
		expect(coordinator.__listenerCount()).toBe(0);

		// The coordinator finally shows up long after the fast window. The
		// still-running retry loop must bind it — exactly once.
		setService("SWARM_COORDINATOR", coordinator);
		vi.advanceTimersByTime(5_000);
		await Promise.resolve();
		expect(coordinator.__listenerCount()).toBe(1);

		await service.stop();
		expect(coordinator.__listenerCount()).toBe(0);
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

	// A scaffolded app lives at <repoRoot>/eliza/apps/app-<name>; the
	// load-from-directory route scans a PARENT for app subdirs, so the bridge
	// must register the workdir's parent, not the workdir itself.
	function appPassEvent() {
		return {
			type: "task_complete",
			sessionId: "app-pass",
			data: {
				originRoomId: "room-99",
				label: "create-app:notes",
				workdir: "/repo/eliza/apps/app-notes",
				verification: {
					source: "custom-validator",
					verdict: "pass",
					validator: { service: "app-verification", method: "verifyApp" },
					params: {
						appName: "notes",
						workdir: "/repo/eliza/apps/app-notes",
						profile: "full",
					},
				},
			},
		};
	}

	it("registers the built app on pass so 'launch <name>' resolves (#11954)", async () => {
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				ok: true,
				directory: "/repo/eliza/apps",
				registered: 1,
				items: [{ slug: "notes", canonicalName: "notes" }],
				rejectedManifests: [],
			}),
		} as Response);
		const coordinator = makeCoordinator();
		const { runtime } = makeRuntime({ SWARM_COORDINATOR: coordinator });
		const service = await VerificationRoomBridgeService.start(runtime);

		coordinator.__emit(appPassEvent());
		await flush();

		// It POSTed the app's PARENT dir to the app-register route so a subsequent
		// listInstalledApps() + launch resolves the freshly built app.
		expect(globalThis.fetch).toHaveBeenCalledWith(
			expect.stringContaining("/api/apps/load-from-directory"),
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ directory: "/repo/eliza/apps" }),
			}),
		);

		expect(runtime.createMemory).toHaveBeenCalledTimes(1);
		const [memory, table] = (runtime.createMemory as ReturnType<typeof vi.fn>)
			.mock.calls[0];
		expect(table).toBe("messages");
		expect(memory.roomId).toBe("room-99");
		const text = memory.content.text as string;
		expect(text).toContain("notes app built, verified, and installed");
		expect(text).toContain("launch notes");
		expect(memory.content.metadata).toMatchObject({ verdict: "pass" });

		await service.stop();
	});

	it("does not promise a launch when app registration fails", async () => {
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: false,
			status: 503,
			json: async () => ({
				ok: false,
				error: "AppRegistryService is not registered on the runtime",
			}),
		} as Response);
		const coordinator = makeCoordinator();
		const { runtime } = makeRuntime({ SWARM_COORDINATOR: coordinator });
		const service = await VerificationRoomBridgeService.start(runtime);

		coordinator.__emit(appPassEvent());
		await flush();

		const [memory] = (runtime.createMemory as ReturnType<typeof vi.fn>).mock
			.calls[0];
		const text = memory.content.text as string;
		expect(text).toContain("built and verified");
		expect(text).toContain("installing it failed");
		expect(text).toContain("AppRegistryService is not registered");
		// The false "reply 'launch notes' to open it" promise must be gone.
		expect(text).not.toContain("launch notes");

		await service.stop();
	});

	it("stays honest when the scan registers nothing matching the app name", async () => {
		// Registry scan succeeded but the built app's manifest was rejected or
		// registered under a different name — no launchable match for `notes`.
		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				ok: true,
				directory: "/repo/eliza/apps",
				registered: 1,
				items: [{ slug: "some-other-app", canonicalName: "some-other-app" }],
				rejectedManifests: [],
			}),
		} as Response);
		const coordinator = makeCoordinator();
		const { runtime } = makeRuntime({ SWARM_COORDINATOR: coordinator });
		const service = await VerificationRoomBridgeService.start(runtime);

		coordinator.__emit(appPassEvent());
		await flush();

		const [memory] = (runtime.createMemory as ReturnType<typeof vi.fn>).mock
			.calls[0];
		const text = memory.content.text as string;
		expect(text).toContain("did not register under a launchable name");
		expect(text).not.toContain("launch notes");

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

	it("offers a rollback in the verifyPlugin fail verdict (#8915)", async () => {
		const coordinator = makeCoordinator();
		const { runtime } = makeRuntime({ SWARM_COORDINATOR: coordinator });
		const service = await VerificationRoomBridgeService.start(runtime);

		coordinator.__emit(pluginEvent("fail"));
		await flush();

		const [memory] = (runtime.createMemory as ReturnType<typeof vi.fn>).mock
			.calls[0];
		const text = memory.content.text as string;
		// The user is offered a one-reply rollback that names the VIEWS rollback
		// action + the target, instead of being left with a broken plugin.
		expect(text).toMatch(/rollback/i);
		expect(text).toContain("action=rollback");
		expect(text).toContain("plugin-habit-tracker");
		// Retry/cancel remain available.
		expect(text).toMatch(/retry/i);
		expect(text).toMatch(/cancel/i);

		await service.stop();
	});

	it("does not offer a rollback for an app fail verdict (no app snapshot mode)", async () => {
		const coordinator = makeCoordinator();
		const { runtime } = makeRuntime({ SWARM_COORDINATOR: coordinator });
		const service = await VerificationRoomBridgeService.start(runtime);

		coordinator.__emit({
			type: "escalation",
			sessionId: "sess-app-fail",
			data: {
				originRoomId: "room-7",
				label: "create-app:notes",
				summary: "build error",
				verification: {
					source: "custom-validator",
					verdict: "fail",
					validator: { service: "app-verification", method: "verifyApp" },
					params: { appName: "notes", workdir: "/repo/apps/app-notes" },
				},
			},
		});
		await flush();

		const [memory] = (runtime.createMemory as ReturnType<typeof vi.fn>).mock
			.calls[0];
		const text = memory.content.text as string;
		expect(text).not.toContain("action=rollback");
		expect(text).toMatch(/retry/i);
		expect(text).toMatch(/cancel/i);

		await service.stop();
	});

	it("drops a verdict event missing the validator params (no targetName)", async () => {
		const coordinator = makeCoordinator();
		const { runtime } = makeRuntime({ SWARM_COORDINATOR: coordinator });
		const service = await VerificationRoomBridgeService.start(runtime);

		const event = pluginEvent("pass");
		delete (event.data.verification as { params?: unknown }).params;
		coordinator.__emit(event);
		await flush();

		expect(runtime.createMemory).not.toHaveBeenCalled();
		await service.stop();
	});
});
