/**
 * Exercises bounded and strict `AgentRuntime.stop` paths with real services:
 * fast teardown stays bounded, while snapshot teardown stops every sibling and
 * surfaces any failure. Deterministic: real runtime, no database.
 */
import { afterEach, describe, expect, it } from "vitest";
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

	it("strict shutdown stops every sibling before surfacing failures", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		const stopped: string[] = [];

		class FailingService extends Service {
			static override serviceType = "shutdown-strict-failing-service";
			capabilityDescription = "strict shutdown failure fixture";

			static override async start(): Promise<FailingService> {
				return new FailingService();
			}

			override async stop(): Promise<void> {
				stopped.push("failing");
				throw new Error("strict stop failed");
			}
		}

		class HealthyService extends Service {
			static override serviceType = "shutdown-strict-healthy-service";
			capabilityDescription = "strict shutdown sibling fixture";

			static override async start(): Promise<HealthyService> {
				return new HealthyService();
			}

			override async stop(): Promise<void> {
				stopped.push("healthy");
			}
		}

		await runtime.registerService(FailingService);
		await runtime.registerService(HealthyService);
		await runtime.getServiceLoadPromise(FailingService.serviceType);
		await runtime.getServiceLoadPromise(HealthyService.serviceType);

		await expect(runtime.stop({ strict: true })).rejects.toThrow(
			/Strict runtime shutdown/,
		);
		expect(stopped).toEqual(["failing", "healthy"]);
	});

	it("strict shutdown waits for and surfaces a failing late service stop", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		const start = createDeferred<LateFailingService>();
		let stopCalls = 0;

		class LateFailingService extends Service {
			static override serviceType = "shutdown-strict-late-failing-service";
			capabilityDescription = "strict late-start shutdown fixture";

			static override async start(): Promise<LateFailingService> {
				return start.promise;
			}

			override async stop(): Promise<void> {
				stopCalls += 1;
				throw new Error("late strict stop failed");
			}
		}

		await runtime.registerService(LateFailingService);
		const load = runtime
			.getServiceLoadPromise(LateFailingService.serviceType)
			.catch(() => null);
		await Promise.resolve();
		const stop = runtime.stop({ strict: true });
		let settled = false;
		void stop.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await Promise.resolve();
		expect(settled).toBe(false);

		start.resolve(new LateFailingService(runtime));
		await expect(stop).rejects.toThrow(/Strict runtime shutdown/);
		await load;
		expect(stopCalls).toBe(1);
	});

	it("fails closed when strict shutdown races an earlier non-strict teardown", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		const enteredStop = createDeferred<void>();
		const releaseStop = createDeferred<void>();

		class DeferredStopService extends Service {
			static override serviceType = "shutdown-deferred-stop-service";
			capabilityDescription = "concurrent shutdown ordering fixture";

			static override async start(): Promise<DeferredStopService> {
				return new DeferredStopService();
			}

			override async stop(): Promise<void> {
				enteredStop.resolve();
				await releaseStop.promise;
			}
		}

		await runtime.registerService(DeferredStopService);
		await runtime.getServiceLoadPromise(DeferredStopService.serviceType);

		const ordinaryStop = runtime.stop();
		await enteredStop.promise;
		await expect(runtime.stop({ strict: true })).rejects.toMatchObject({
			code: "RUNTIME_STRICT_STOP_AFTER_NON_STRICT",
		});

		let ordinarySettled = false;
		void ordinaryStop.then(() => {
			ordinarySettled = true;
		});
		await Promise.resolve();
		expect(ordinarySettled).toBe(false);

		releaseStop.resolve();
		await ordinaryStop;
	});

	it("rejects mutually exclusive fast and strict shutdown", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

		await expect(
			runtime.stop({ fast: true, strict: true }),
		).rejects.toMatchObject({ code: "RUNTIME_STOP_OPTIONS_INVALID" });
		await runtime.stop({ fast: true });
	});
});
