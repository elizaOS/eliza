/** Exercises strict retirement on real AgentRuntime instances with controlled lifecycle hooks. Deferred operations prove bounded shutdown cannot certify cleanup or replay teardown on a later wait. */
import { initializeTestRuntime } from "@elizaos/testing/in-memory-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import { trackPostDeliveryTask } from "../services/post-delivery-task-tracker";
import type { IAgentRuntime } from "../types/runtime";
import { Service } from "../types/service";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

async function initialized() {
	const runtime = new AgentRuntime({ logLevel: "fatal" });
	await initializeTestRuntime(runtime, { skipMigrations: true });
	return runtime;
}

async function stillPending(promise: Promise<void>) {
	const marker = Symbol("pending");
	expect(
		await Promise.race([
			promise,
			new Promise<symbol>((resolve) => setTimeout(() => resolve(marker), 20)),
		]),
	).toBe(marker);
}

describe("strict runtime retirement", () => {
	afterEach(() => vi.unstubAllEnvs());
	it.each([false, true])(
		"retains a late start after bounded stop (fast=%s)",
		async (fast) => {
			vi.stubEnv("ELIZA_SHUTDOWN_SERVICE_START_TIMEOUT_MS", "1");
			const runtime = await initialized();
			const entered = deferred();
			const start = deferred<LateService>();
			const stopping = deferred();
			const finish = deferred();
			let stops = 0;
			class LateService extends Service {
				static override serviceType = "quiescence-late";
				capabilityDescription = "Controlled late startup";
				static override async start(): Promise<LateService> {
					entered.resolve();
					return start.promise;
				}
				override async stop() {
					stops += 1;
					stopping.resolve();
					await finish.promise;
				}
			}
			await runtime.registerService(LateService);
			const loaded = runtime
				.getServiceLoadPromise(LateService.serviceType)
				.then(
					() => "loaded",
					() => "stopped",
				);
			await entered.promise;
			await runtime.stop({ fast });
			const strict = runtime.stop({ requireQuiescence: true });
			await stillPending(strict);
			start.resolve(new LateService(runtime));
			await stopping.promise;
			await stillPending(strict);
			const retry = runtime.stop({ requireQuiescence: true });
			expect(retry).toBe(strict);
			await stillPending(retry);
			expect(stops).toBe(1);
			finish.resolve();
			await Promise.all([strict, retry]);
			expect(await loaded).toBe("stopped");
			expect(stops).toBe(1);
		},
	);

	it.each(["stop", "prepareStop"] as const)(
		"retains %s failure after ordinary shutdown",
		async (failureHook) => {
			const runtime = await initialized();
			let stops = 0;
			class FailingService extends Service {
				static override serviceType = "quiescence-failure";
				capabilityDescription = "Controlled teardown failure";
				static override async start(runtime: IAgentRuntime) {
					return new FailingService(runtime);
				}
				override prepareStop() {
					if (failureHook === "prepareStop")
						throw new Error("admission failure");
				}
				override async stop() {
					stops += 1;
					if (failureHook === "stop") throw new Error("teardown failure");
				}
			}
			await runtime.registerService(FailingService);
			await runtime.getServiceLoadPromise(FailingService.serviceType);
			await runtime.stop();
			await expect(
				runtime.stop({ requireQuiescence: true }),
			).rejects.toMatchObject({ code: "RUNTIME_QUIESCENCE_FAILED" });
			await expect(
				runtime.stop({ requireQuiescence: true }),
			).rejects.toMatchObject({ code: "RUNTIME_QUIESCENCE_FAILED" });
			expect(stops).toBe(1);
		},
	);

	it("an outer wait deadline retains the original strict stop and teardown operation", async () => {
		const runtime = await initialized();
		const stopping = deferred();
		const finish = deferred();
		let stops = 0;
		class SlowStop extends Service {
			static override serviceType = "quiescence-outer-deadline";
			capabilityDescription = "Controlled teardown deadline";
			static override async start(runtime: IAgentRuntime) {
				return new SlowStop(runtime);
			}
			override async stop() {
				stops += 1;
				stopping.resolve();
				await finish.promise;
			}
		}
		await runtime.registerService(SlowStop);
		await runtime.getServiceLoadPromise(SlowStop.serviceType);
		const strict = runtime.stop({
			fast: true,
			serviceStopTimeoutMs: 1,
			requireQuiescence: true,
		});
		await stopping.promise;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expired = new Error("Host wait deadline expired");
		try {
			await expect(
				Promise.race([
					strict,
					new Promise<void>((_, reject) => {
						timer = setTimeout(() => reject(expired), 20);
					}),
				]),
			).rejects.toBe(expired);
			const retry = runtime.stop({ requireQuiescence: true });
			expect(retry).toBe(strict);
			await stillPending(retry);
			expect(stops).toBe(1);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			finish.resolve();
			await strict;
		}
		expect(stops).toBe(1);
	});

	it("publishes the strict stop before a preparation hook reenters it", async () => {
		const runtime = await initialized();
		let reentrant: Promise<void> | undefined;
		let preparations = 0;
		let stops = 0;
		class ReentrantStop extends Service {
			static override serviceType = "quiescence-reentrant";
			capabilityDescription = "Requests strict retirement during preparation";
			static override async start(runtime: IAgentRuntime) {
				return new ReentrantStop(runtime);
			}
			override prepareStop() {
				preparations += 1;
				reentrant = runtime.stop({ requireQuiescence: true });
			}
			override async stop() {
				stops += 1;
			}
		}
		await runtime.registerService(ReentrantStop);
		await runtime.getServiceLoadPromise(ReentrantStop.serviceType);
		const strict = runtime.stop({ requireQuiescence: true });
		expect(reentrant).toBe(strict);
		await strict;
		expect(preparations).toBe(1);
		expect(stops).toBe(1);
	});

	it("waits for pending plugin initialization and its existing registration rollback", async () => {
		const runtime = await initialized();
		const entered = deferred();
		const finish = deferred();
		const plugin = {
			name: "quiescence-plugin",
			description: "Controlled initialization",
			init: async () => {
				entered.resolve();
				await finish.promise;
			},
		};
		const registration = runtime.registerPlugin(plugin).then(
			() => "registered",
			() => "stopped",
		);
		await entered.promise;
		await runtime.stop({ fast: true });
		const strict = runtime.stop({ requireQuiescence: true });
		await stillPending(strict);
		finish.resolve();
		await strict;
		expect(await registration).toBe("stopped");
		expect(runtime.plugins).not.toContain(plugin);
	});

	it("joins an active fast stop until its room owner releases", async () => {
		const runtime = await initialized();
		const lease = await runtime.roomHandlerQueue.acquire(
			"00000000-0000-4000-8000-000000000098",
		);
		const fast = runtime.stop({ fast: true, serviceStopTimeoutMs: 5 });
		const strict = runtime.stop({ requireQuiescence: true });
		await stillPending(strict);
		await lease.release();
		await Promise.all([fast, strict]);
	});

	it("joins post-delivery work omitted by a prior fast stop", async () => {
		const runtime = await initialized();
		const finish = deferred();
		const task = trackPostDeliveryTask(
			runtime,
			"retirement-test",
			() => finish.promise,
			{ kind: "diagnostic" },
		);
		await runtime.stop({ fast: true });
		const strict = runtime.stop({ requireQuiescence: true });
		await stillPending(strict);
		finish.resolve();
		await Promise.all([task, strict]);
	});
});
