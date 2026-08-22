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

	it("rejects a service whose start settles after the shutdown cordon", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		const start = createDeferred<LateService>();
		let stopCalls = 0;

		class LateService extends Service {
			static override serviceType = "shutdown-late-service";
			capabilityDescription = "service that settles during shutdown";

			static override async start(): Promise<LateService> {
				return start.promise;
			}

			override async stop(): Promise<void> {
				stopCalls += 1;
			}
		}

		await runtime.registerService(LateService);
		const load = runtime
			.getServiceLoadPromise(LateService.serviceType)
			.catch((error: unknown) => error);
		await Promise.resolve();
		const stop = runtime.stop();
		start.resolve(new LateService());

		await stop;
		expect(await load).toMatchObject({ code: "SERVICE_START_FAILED" });
		expect(stopCalls).toBe(1);
		expect(runtime.getService(LateService.serviceType)).toBeNull();
	});

	it("fast shutdown caps already-started service stop waits", async () => {
		process.env.ELIZA_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS = "500";
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
			runtime
				.stop({ fast: true, serviceStopTimeoutMs: 5 })
				.then(() => "stopped"),
			delay(500),
		]);

		expect(stopResult).toBe("stopped");
		expect(stopCalls).toBe(1);
		expect(process.env.ELIZA_FAST_SHUTDOWN).toBe(previousFastShutdown);
	});

	it("cordons service admissions before waiting for the room drain", async () => {
		process.env.ELIZA_FAST_ROOM_DRAIN_TIMEOUT_MS = "50";
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		const events: string[] = [];

		class AdmissionAwareService extends Service {
			static override serviceType = "shutdown-admission-aware-service";
			capabilityDescription = "observes the pre-drain shutdown cordon";

			static override async start(): Promise<AdmissionAwareService> {
				return new AdmissionAwareService();
			}

			override prepareStop(reason: string): void {
				events.push(`prepare:${reason}`);
			}

			override async stop(): Promise<void> {
				events.push("stop");
			}
		}

		await runtime.registerService(AdmissionAwareService);
		await runtime.getServiceLoadPromise(AdmissionAwareService.serviceType);
		const lease = await runtime.roomHandlerQueue.acquire(
			"00000000-0000-4000-8000-000000000098",
		);

		const stop = runtime.stop();
		await Promise.resolve();
		expect(events).toEqual(["prepare:runtime-stop"]);
		await lease.release();
		await stop;
		expect(events).toEqual(["prepare:runtime-stop", "stop"]);
	});

	it("makes reentrant and concurrent stop callers await one teardown", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		expect(runtime.getLifecycleState()).toBe("initializing");
		expect(runtime.getStopSignal().aborted).toBe(false);
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		expect(runtime.getLifecycleState()).toBe("running");
		const stopStarted = createDeferred<void>();
		const finishStop = createDeferred<void>();
		let stopCalls = 0;
		let reentrantStop: Promise<void> | null = null;

		class DeferredStopService extends Service {
			static override serviceType = "shutdown-concurrent-stop-service";
			capabilityDescription = "service that exposes concurrent stop ordering";

			static override async start(): Promise<DeferredStopService> {
				return new DeferredStopService();
			}

			override prepareStop(): void {
				reentrantStop = runtime.stop();
			}

			override async stop(): Promise<void> {
				stopCalls += 1;
				stopStarted.resolve();
				await finishStop.promise;
			}
		}

		await runtime.registerService(DeferredStopService);
		await runtime.getServiceLoadPromise(DeferredStopService.serviceType);
		const first = runtime.stop();
		expect(runtime.getLifecycleState()).toBe("stopping");
		expect(runtime.getStopSignal().aborted).toBe(true);
		await stopStarted.promise;
		expect(reentrantStop).not.toBeNull();
		let secondSettled = false;
		const second = runtime.stop().then(() => {
			secondSettled = true;
		});
		await Promise.resolve();
		expect(secondSettled).toBe(false);

		finishStop.resolve();
		await Promise.all([first, second, reentrantStop]);
		expect(stopCalls).toBe(1);
		expect(secondSettled).toBe(true);
		expect(runtime.getLifecycleState()).toBe("stopped");
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
