/**
 * Exercises `AgentRuntime.stop` ownership and fast-shutdown paths: lazy service
 * cleanup, unresolved starts, bounded stop waits, and throwing teardown.
 * Deterministic: real runtime, no database.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import { type Action, ModelType, type Plugin } from "../types";
import type { IAgentRuntime } from "../types/runtime";
import { Service } from "../types/service";

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function delay(ms: number): Promise<"timeout"> {
	return new Promise((resolve) => {
		setTimeout(() => resolve("timeout"), ms);
	});
}

describe("AgentRuntime.stop", () => {
	const previousFastShutdown = process.env.ELIZA_FAST_SHUTDOWN;
	const previousStopTimeout =
		process.env.ELIZA_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS;
	const previousRoomDrainTimeout = process.env.ELIZA_FAST_ROOM_DRAIN_TIMEOUT_MS;

	afterEach(() => {
		if (previousFastShutdown === undefined) {
			delete process.env.ELIZA_FAST_SHUTDOWN;
		} else {
			process.env.ELIZA_FAST_SHUTDOWN = previousFastShutdown;
		}
		if (previousStopTimeout === undefined) {
			delete process.env.ELIZA_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS;
		} else {
			process.env.ELIZA_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS = previousStopTimeout;
		}
		if (previousRoomDrainTimeout === undefined) {
			delete process.env.ELIZA_FAST_ROOM_DRAIN_TIMEOUT_MS;
		} else {
			process.env.ELIZA_FAST_ROOM_DRAIN_TIMEOUT_MS = previousRoomDrainTimeout;
		}
	});

	it("stops runtime-owned resources for a lazy service that never started", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		let starts = 0;
		let runtimeStops = 0;
		const releaseStop = createDeferred<void>();

		class LazyOwnedService extends Service {
			static override serviceType = "shutdown-lazy-owned-service";
			capabilityDescription = "lazy service with pre-start runtime ownership";

			static override async start(
				runtime: IAgentRuntime,
			): Promise<LazyOwnedService> {
				starts += 1;
				return new LazyOwnedService(runtime);
			}

			static override async stopRuntime(): Promise<void> {
				runtimeStops += 1;
				await releaseStop.promise;
			}

			override async stop(): Promise<void> {}
		}

		await runtime.registerService(LazyOwnedService);
		expect(runtime.getService(LazyOwnedService.serviceType)).toBeNull();

		const firstStop = runtime.stop({ fast: true });
		await vi.waitFor(() => expect(runtimeStops).toBe(1));
		const concurrentStop = runtime.stop({ fast: true });
		expect(concurrentStop).toBe(firstStop);

		releaseStop.resolve();
		await Promise.all([firstStop, concurrentStop]);
		expect(runtime.stop({ fast: true })).toBe(firstStop);

		expect(starts).toBe(0);
		expect(runtimeStops).toBe(1);
	});

	it("publishes one stop task before abort listeners can reenter shutdown", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const turnStarted = createDeferred<void>();
		const releaseTurn = createDeferred<void>();
		let reentrantStop: Promise<void> | null = null;
		let runtimeStops = 0;

		class ReentrantOwnedService extends Service {
			static override serviceType = "shutdown-reentrant-owned-service";
			capabilityDescription = "service observing reentrant runtime shutdown";

			static override async start(
				runtime: IAgentRuntime,
			): Promise<ReentrantOwnedService> {
				return new ReentrantOwnedService(runtime);
			}

			static override async stopRuntime(): Promise<void> {
				runtimeStops += 1;
			}

			override async stop(): Promise<void> {}
		}

		await runtime.registerService(ReentrantOwnedService);
		const turn = runtime.turnControllers.runWith(
			"00000000-0000-4000-8000-000000000101",
			async (signal) => {
				signal.addEventListener(
					"abort",
					() => {
						reentrantStop = runtime.stop({ fast: true });
					},
					{ once: true },
				);
				turnStarted.resolve();
				await releaseTurn.promise;
			},
		);
		await turnStarted.promise;

		const firstStop = runtime.stop({ fast: true });
		expect(reentrantStop).toBe(firstStop);
		releaseTurn.resolve();
		await Promise.all([turn, firstStop]);

		expect(runtimeStops).toBe(1);
	});

	it("rejects registry mutations reentered from an abort listener", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const turnStarted = createDeferred<void>();
		const releaseTurn = createDeferred<void>();
		let serviceRegistrationResult: Promise<unknown> | null = null;
		let pluginRegistrationResult: Promise<unknown> | null = null;

		class ReentrantLateService extends Service {
			static override serviceType = "shutdown-reentrant-late-service";
			capabilityDescription = "service rejected during runtime shutdown";

			static override async start(
				runtime: IAgentRuntime,
			): Promise<ReentrantLateService> {
				return new ReentrantLateService(runtime);
			}

			override async stop(): Promise<void> {}
		}
		const lateAction: Action = {
			name: "SHUTDOWN_REENTRANT_ACTION",
			description: "Action rejected during runtime shutdown",
			similes: [],
			examples: [],
			validate: async () => true,
			handler: async () => ({ success: true }),
		};
		const latePlugin: Plugin = {
			name: "shutdown-reentrant-plugin",
			description: "Plugin rejected during runtime shutdown",
			actions: [lateAction],
			models: {
				[ModelType.TEXT_SMALL]: async () => "must not register",
			},
			routes: [{ type: "GET", path: "/shutdown-reentrant" }],
		};

		const turn = runtime.turnControllers.runWith(
			"00000000-0000-4000-8000-000000000102",
			async (signal) => {
				signal.addEventListener(
					"abort",
					() => {
						serviceRegistrationResult = runtime
							.registerService(ReentrantLateService)
							.then(
								() => "registered",
								(error) => error,
							);
						pluginRegistrationResult = runtime.registerPlugin(latePlugin).then(
							() => "registered",
							(error) => error,
						);
					},
					{ once: true },
				);
				turnStarted.resolve();
				await releaseTurn.promise;
			},
		);
		await turnStarted.promise;

		const stop = runtime.stop({ fast: true });
		releaseTurn.resolve();
		await Promise.all([turn, stop]);
		if (!serviceRegistrationResult || !pluginRegistrationResult) {
			throw new Error("Abort listener did not attempt registry mutations");
		}
		await expect(serviceRegistrationResult).resolves.toMatchObject({
			code: "RUNTIME_STOPPED_DURING_SERVICE_REGISTRATION",
		});
		await expect(pluginRegistrationResult).resolves.toMatchObject({
			code: "RUNTIME_STOPPED_DURING_PLUGIN_REGISTRATION",
		});

		expect(runtime.getRegisteredServiceTypes()).not.toContain(
			ReentrantLateService.serviceType,
		);
		expect(
			runtime.getServiceRegistrationStatus(ReentrantLateService.serviceType),
		).toBe("unknown");
		expect(runtime.plugins).not.toContain(latePlugin);
		expect(runtime.actions).not.toContain(lateAction);
		expect(runtime.getPluginOwnership(latePlugin.name)).toBeNull();
		expect(
			runtime
				.getModelRegistrations()
				.some((entry) => entry.provider === latePlugin.name),
		).toBe(false);
		expect(
			runtime.routes.some((route) => route.path.includes("shutdown-reentrant")),
		).toBe(false);
	});

	it("shares cleanup ownership when a service start resolves after fast shutdown", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

		let startRuntime: IAgentRuntime | null = null;
		let runtimeStops = 0;
		let instanceStops = 0;
		let cleanupCalls = 0;
		let cleaned = false;
		const start = createDeferred<SlowService>();
		const releaseOwnedResource = async (): Promise<void> => {
			if (cleaned) return;
			cleaned = true;
			cleanupCalls += 1;
		};

		class SlowService extends Service {
			static override serviceType = "shutdown-slow-service";
			capabilityDescription = "slow service used by shutdown tests";

			static override async start(
				runtime: IAgentRuntime,
			): Promise<SlowService> {
				startRuntime = runtime;
				return start.promise;
			}

			static override async stopRuntime(): Promise<void> {
				runtimeStops += 1;
				await releaseOwnedResource();
			}

			override async stop(): Promise<void> {
				instanceStops += 1;
				await releaseOwnedResource();
			}
		}

		await runtime.registerService(SlowService);
		const load = runtime.getServiceLoadPromise(SlowService.serviceType).then(
			() => "loaded",
			(error) => (error instanceof Error ? error.message : String(error)),
		);

		await Promise.resolve();
		const stopResult = await Promise.race([
			runtime.stop({ fast: true }).then(() => "stopped"),
			delay(100),
		]);

		expect(stopResult).toBe("stopped");
		expect(runtimeStops).toBe(1);
		expect(instanceStops).toBe(0);
		expect(cleanupCalls).toBe(1);
		expect(startRuntime).toBe(runtime);

		start.resolve(new SlowService(runtime));

		await expect(load).resolves.toContain("not found or failed to start");
		expect(runtimeStops).toBe(1);
		expect(instanceStops).toBe(1);
		expect(cleanupCalls).toBe(1);
		expect(runtime.getServiceRegistrationStatus(SlowService.serviceType)).toBe(
			"failed",
		);
	});

	it("rejects service registration after shutdown without mutating the registry", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });

		class LateService extends Service {
			static override serviceType = "shutdown-late-registration-service";
			capabilityDescription = "service registered after shutdown for testing";

			static override async start(): Promise<LateService> {
				return new LateService();
			}

			override async stop(): Promise<void> {}
		}

		await runtime.stop({ fast: true });
		await expect(runtime.registerService(LateService)).rejects.toMatchObject({
			code: "RUNTIME_STOPPED_DURING_SERVICE_REGISTRATION",
		});
		expect(runtime.getRegisteredServiceTypes()).not.toContain(
			LateService.serviceType,
		);
		expect(runtime.getServiceRegistrationStatus(LateService.serviceType)).toBe(
			"unknown",
		);
	});

	it("fast shutdown caps already-started service stop waits", async () => {
		process.env.ELIZA_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS = "5";
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		let stopCalls = 0;

		class HangingStopService extends Service {
			static override serviceType = "shutdown-hanging-stop-service";
			capabilityDescription = "hanging stop service used by shutdown tests";

			static override async start(): Promise<HangingStopService> {
				return new HangingStopService();
			}

			override async stop(): Promise<void> {
				stopCalls += 1;
				await new Promise(() => {});
			}
		}

		await runtime.registerService(HangingStopService);
		await runtime.getServiceLoadPromise(HangingStopService.serviceType);

		const stopResult = await Promise.race([
			runtime.stop({ fast: true }).then(() => "stopped"),
			delay(500),
		]);

		expect(stopResult).toBe("stopped");
		expect(stopCalls).toBe(1);
		expect(process.env.ELIZA_FAST_SHUTDOWN).toBe(previousFastShutdown);
	});

	it("fails fast without stopping resources beneath a noncooperative room owner", async () => {
		process.env.ELIZA_FAST_ROOM_DRAIN_TIMEOUT_MS = "5";
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		let stopCalls = 0;

		class ObservedService extends Service {
			static override serviceType = "shutdown-room-owner-service";
			capabilityDescription = "observes whether room drain precedes teardown";

			static override async start(): Promise<ObservedService> {
				return new ObservedService();
			}

			override async stop(): Promise<void> {
				stopCalls += 1;
			}
		}

		await runtime.registerService(ObservedService);
		await runtime.getServiceLoadPromise(ObservedService.serviceType);
		const reportError = vi.spyOn(runtime, "reportError");
		const lease = await runtime.roomHandlerQueue.acquire(
			"00000000-0000-4000-8000-000000000099",
		);

		const failedStop = runtime.stop({ fast: true });
		await expect(failedStop).rejects.toMatchObject({
			code: "RUNTIME_FAST_STOP_ROOM_DRAIN_TIMEOUT",
		});
		expect(stopCalls).toBe(0);
		expect(reportError).toHaveBeenCalledWith(
			"AgentRuntime.stop.roomDrain",
			expect.objectContaining({
				code: "RUNTIME_FAST_STOP_ROOM_DRAIN_TIMEOUT",
			}),
			expect.objectContaining({ pendingRooms: 1 }),
		);
		class RetryRegistrationService extends Service {
			static override serviceType = "shutdown-retry-registration-service";
			capabilityDescription =
				"service registered after a retryable stop failure";

			static override async start(
				runtime: IAgentRuntime,
			): Promise<RetryRegistrationService> {
				return new RetryRegistrationService(runtime);
			}

			override async stop(): Promise<void> {}
		}
		const retryPlugin: Plugin = {
			name: "shutdown-retry-registration-plugin",
			description: "Plugin registered after a retryable stop failure",
		};
		await expect(
			runtime.registerService(RetryRegistrationService),
		).resolves.toBeUndefined();
		await expect(runtime.registerPlugin(retryPlugin)).resolves.toBeUndefined();
		expect(runtime.getRegisteredServiceTypes()).toContain(
			RetryRegistrationService.serviceType,
		);
		expect(runtime.plugins).toContain(retryPlugin);

		await lease.release();
		const retryStop = runtime.stop({ fast: true });
		expect(retryStop).not.toBe(failedStop);
		await retryStop;
		expect(stopCalls).toBe(1);
	});

	it("preserves service startup failures instead of resolving them as absence", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

		class FailingStartService extends Service {
			static override serviceType = "shutdown-failing-start-service";
			capabilityDescription = "service whose startup fails for testing";

			static override async start(): Promise<FailingStartService> {
				throw new Error("startup dependency unavailable");
			}
		}

		await runtime.registerService(FailingStartService);
		let startupError: unknown;
		try {
			await runtime.getServiceLoadPromise(FailingStartService.serviceType);
		} catch (error) {
			startupError = error;
		}
		expect(startupError).toMatchObject({
			code: "SERVICE_START_FAILED",
		});
		const aggregate = (startupError as { cause?: unknown }).cause;
		expect(aggregate).toBeInstanceOf(AggregateError);
		expect((aggregate as AggregateError).errors).toEqual([
			expect.objectContaining({
				code: "SERVICE_START_FAILED",
				cause: expect.objectContaining({
					message: "startup dependency unavailable",
				}),
			}),
		]);
		await runtime.stop();
	});

	it("continues when a service stop throws synchronously", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

		class ThrowingStopService extends Service {
			static override serviceType = "shutdown-throwing-stop-service";
			capabilityDescription = "throwing stop service used by shutdown tests";

			static override async start(): Promise<ThrowingStopService> {
				return new ThrowingStopService();
			}

			override stop(): Promise<void> {
				throw new Error("sync stop failure");
			}
		}

		await runtime.registerService(ThrowingStopService);
		await runtime.getServiceLoadPromise(ThrowingStopService.serviceType);

		await expect(runtime.stop()).resolves.toBeUndefined();
	});
});
