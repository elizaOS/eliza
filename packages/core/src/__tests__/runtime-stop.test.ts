import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import { type Character, Service } from "../types";

class SlowStopService extends Service {
	static override serviceType = "slow-stop";
	override capabilityDescription = "test service";

	static override async start(): Promise<SlowStopService> {
		return new SlowStopService();
	}

	override async stop(): Promise<void> {
		await new Promise(() => {});
	}
}

class ThrowingStopService extends Service {
	static override serviceType = "throwing-stop";
	override capabilityDescription = "test service";

	static override async start(): Promise<ThrowingStopService> {
		return new ThrowingStopService();
	}

	override stop(): Promise<void> {
		throw new Error("sync stop failure");
	}
}

function makeRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "runtime-stop-test",
			bio: "test",
			settings: {},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

describe("AgentRuntime.stop", () => {
	const previousFastShutdown = process.env.ELIZA_FAST_SHUTDOWN;
	const previousStartTimeout =
		process.env.ELIZA_SHUTDOWN_SERVICE_START_TIMEOUT_MS;
	const previousStopTimeout =
		process.env.ELIZA_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS;

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousFastShutdown === undefined) {
			delete process.env.ELIZA_FAST_SHUTDOWN;
		} else {
			process.env.ELIZA_FAST_SHUTDOWN = previousFastShutdown;
		}
		if (previousStartTimeout === undefined) {
			delete process.env.ELIZA_SHUTDOWN_SERVICE_START_TIMEOUT_MS;
		} else {
			process.env.ELIZA_SHUTDOWN_SERVICE_START_TIMEOUT_MS =
				previousStartTimeout;
		}
		if (previousStopTimeout === undefined) {
			delete process.env.ELIZA_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS;
		} else {
			process.env.ELIZA_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS = previousStopTimeout;
		}
	});

	it("fast mode skips unresolved service starts and caps service stop waits", async () => {
		process.env.ELIZA_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS = "5";
		const runtime = makeRuntime();
		const stopSpy = vi.spyOn(SlowStopService.prototype, "stop");
		// biome-ignore lint/suspicious/noExplicitAny: inject internal service state to isolate stop behavior
		(runtime as any).startingServices.set(
			"never-starts",
			new Promise(() => {}),
		);
		// biome-ignore lint/suspicious/noExplicitAny: inject internal service state to isolate stop behavior
		(runtime as any).services.set("slow-stop", [new SlowStopService()]);

		const startedAt = Date.now();
		await runtime.stop({ fast: true });

		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(stopSpy).toHaveBeenCalledTimes(1);
		// biome-ignore lint/suspicious/noExplicitAny: verify in-flight starts were cleared
		expect((runtime as any).startingServices.size).toBe(0);
		expect(process.env.ELIZA_FAST_SHUTDOWN).toBe(previousFastShutdown);
	});

	it("continues when a service stop throws synchronously", async () => {
		const runtime = makeRuntime();
		// biome-ignore lint/suspicious/noExplicitAny: inject internal service state to isolate stop behavior
		(runtime as any).services.set("throwing-stop", [new ThrowingStopService()]);

		await expect(runtime.stop()).resolves.toBeUndefined();
	});

	it("stops and discards a service that finishes starting after shutdown begins", async () => {
		const runtime = makeRuntime();
		// biome-ignore lint/suspicious/noExplicitAny: resolve the private init gate without full runtime initialization
		(runtime as any).initResolver?.();
		// biome-ignore lint/suspicious/noExplicitAny: clear the resolver after manual init resolution
		(runtime as any).initResolver = undefined;

		let releaseStart!: () => void;
		const startCanFinish = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		let markStartEntered!: () => void;
		const startEntered = new Promise<void>((resolve) => {
			markStartEntered = resolve;
		});
		class LateStartService extends SlowStopService {
			static override serviceType = "late-start";
			static override async start(): Promise<SlowStopService> {
				markStartEntered();
				await startCanFinish;
				return new LateStartService();
			}

			override async stop(): Promise<void> {}
		}
		const stopSpy = vi.spyOn(LateStartService.prototype, "stop");

		// biome-ignore lint/suspicious/noExplicitAny: exercise private service-start path directly
		const startPromise = (runtime as any)._runServiceStart(
			"late-start",
			"late-start",
			LateStartService,
		);
		await startEntered;
		const stopPromise = runtime.stop({ fast: true });
		releaseStart();

		await expect(startPromise).resolves.toBeNull();
		await stopPromise;
		expect(stopSpy).toHaveBeenCalledTimes(1);
		// biome-ignore lint/suspicious/noExplicitAny: late service was not registered after shutdown
		expect((runtime as any).services.get("late-start")).toBeUndefined();
	});
});
