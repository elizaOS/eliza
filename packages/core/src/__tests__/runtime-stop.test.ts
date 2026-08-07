/**
 * Exercises `AgentRuntime.stop` fast-shutdown paths: not hanging on an
 * unresolved service start, capping already-started stop waits, and surviving a
 * synchronously-throwing stop. Deterministic: real runtime, no database.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
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

	it("fast shutdown does not hang on an unresolved service start and cleans up late starts", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

		let startRuntime: IAgentRuntime | null = null;
		let stopCalls = 0;
		const start = createDeferred<SlowService>();

		class SlowService extends Service {
			static override serviceType = "shutdown-slow-service";
			capabilityDescription = "slow service used by shutdown tests";

			static override async start(
				runtime: IAgentRuntime,
			): Promise<SlowService> {
				startRuntime = runtime;
				return start.promise;
			}

			override async stop(): Promise<void> {
				stopCalls += 1;
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
		expect(stopCalls).toBe(0);
		expect(startRuntime).toBe(runtime);

		start.resolve(new SlowService(runtime));

		await expect(load).resolves.toContain("not found or failed to start");
		expect(stopCalls).toBe(1);
		expect(runtime.getServiceRegistrationStatus(SlowService.serviceType)).toBe(
			"failed",
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

		await expect(runtime.stop({ fast: true })).rejects.toMatchObject({
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

		await lease.release();
		await runtime.stop({ fast: true });
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
		// Since #17427 sibling implementations start in parallel and the load
		// promise rejects with the aggregate: an AggregateError of per-class
		// SERVICE_START_FAILED errors, each preserving the original cause.
		await expect(
			runtime.getServiceLoadPromise(FailingStartService.serviceType),
		).rejects.toMatchObject({
			code: "SERVICE_START_FAILED",
			cause: expect.objectContaining({
				errors: [
					expect.objectContaining({
						code: "SERVICE_START_FAILED",
						cause: expect.objectContaining({
							message: "startup dependency unavailable",
						}),
					}),
				],
			}),
		});
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
