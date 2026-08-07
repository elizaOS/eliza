/**
 * Verifies production service startup ordering and ownership with real runtime
 * lifecycle calls. Implementations launch concurrently, readiness drains the
 * whole set, and plugin teardown targets instances by class rather than timing.
 */

import { describe, expect, it } from "vitest";
import { nativeRuntimeFeaturePluginNames } from "../plugins/native-features";
import { AgentRuntime } from "../runtime";
import type { Memory, Provider, ServiceTypeName, UUID } from "../types";
import { Service } from "../types/service";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

describe("AgentRuntime service startup", () => {
	it("starts cross-plugin siblings once in parallel and preserves registration order", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		const firstStartup = deferred<FirstService>();
		const secondStartup = deferred<SecondService>();
		const starts: string[] = [];
		const stops: string[] = [];

		class FirstService extends Service {
			static override serviceType = "parallel-start-test";
			static override allowsMultiple = true;
			capabilityDescription = "first registered implementation";

			static override async start(): Promise<FirstService> {
				starts.push("first");
				return firstStartup.promise;
			}

			override async stop(): Promise<void> {
				stops.push("first");
			}
		}

		class SecondService extends Service {
			static override serviceType = "parallel-start-test";
			static override allowsMultiple = true;
			capabilityDescription = "second registered implementation";

			static override async start(): Promise<SecondService> {
				starts.push("second");
				return secondStartup.promise;
			}

			override async stop(): Promise<void> {
				stops.push("second");
			}
		}

		try {
			await runtime.registerPlugin({
				name: "parallel-start-first",
				description: "Registers the first implementation",
				services: [FirstService],
			});
			await runtime.registerPlugin({
				name: "parallel-start-second",
				description: "Registers the second implementation",
				services: [SecondService],
			});

			const firstLoad = runtime.getServiceLoadPromise(FirstService.serviceType);
			const concurrentLoad = runtime.getServiceLoadPromise(
				FirstService.serviceType,
			);
			await Promise.resolve();
			expect(starts.sort()).toEqual(["first", "second"]);

			let ready = false;
			void firstLoad.then(() => {
				ready = true;
			});
			const second = new SecondService(runtime);
			secondStartup.resolve(second);
			await secondStartup.promise;
			await Promise.resolve();
			expect(ready).toBe(false);

			const first = new FirstService(runtime);
			firstStartup.resolve(first);
			await expect(Promise.all([firstLoad, concurrentLoad])).resolves.toEqual([
				first,
				first,
			]);
			expect(runtime.getServicesByType(FirstService.serviceType)).toEqual([
				first,
				second,
			]);
			expect(starts.sort()).toEqual(["first", "second"]);

			await runtime.unloadPlugin("parallel-start-first");
			expect(stops).toEqual(["first"]);
			expect(runtime.getServicesByType(FirstService.serviceType)).toEqual([
				second,
			]);
		} finally {
			await runtime.stop({ fast: true });
		}
	});

	it("starts a sibling registered after the first implementation is already running", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		let firstStarts = 0;
		let secondStarts = 0;

		class FirstService extends Service {
			static override serviceType = "late-sibling-start-test";
			static override allowsMultiple = true;
			capabilityDescription = "first registered implementation";

			static override async start(
				runtime: AgentRuntime,
			): Promise<FirstService> {
				firstStarts += 1;
				return new FirstService(runtime);
			}

			override async stop(): Promise<void> {}
		}

		class SecondService extends Service {
			static override serviceType = "late-sibling-start-test";
			static override allowsMultiple = true;
			capabilityDescription = "late registered implementation";

			static override async start(
				runtime: AgentRuntime,
			): Promise<SecondService> {
				secondStarts += 1;
				return new SecondService(runtime);
			}

			override async stop(): Promise<void> {}
		}

		try {
			await runtime.registerService(FirstService);
			const first = await runtime.getServiceLoadPromise(
				FirstService.serviceType,
			);
			expect(first).toBeInstanceOf(FirstService);
			expect(firstStarts).toBe(1);

			await runtime.registerService(SecondService);
			const resolved = await runtime.getServiceLoadPromise(
				FirstService.serviceType,
			);

			expect(resolved).toBe(first);
			expect(firstStarts).toBe(1);
			expect(secondStarts).toBe(1);
			expect(runtime.getServicesByType(FirstService.serviceType)).toEqual([
				first,
				expect.any(SecondService),
			]);
		} finally {
			await runtime.stop({ fast: true });
		}
	});

	it("fails closed when a configured tool-policy service fails to start", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

		class FailingPolicyService extends Service {
			static override serviceType = "tool_policy";
			capabilityDescription = "always fails to start";

			static override async start(): Promise<FailingPolicyService> {
				throw new Error("policy start boom");
			}

			override async stop(): Promise<void> {}
		}

		try {
			await runtime.registerPlugin({
				name: "failing-policy",
				description: "Registers a tool_policy service whose start throws",
				services: [FailingPolicyService],
			});

			const actions = await runtime.getFilteredActions({});
			expect(actions).toEqual([]);

			const verdict = await runtime.isActionAllowed("ANY_ACTION");
			expect(verdict).toEqual({
				allowed: false,
				reason: "Tool policy service failed to start",
			});

			const scopes = runtime
				.getRecentReportedErrors()
				.map((entry) => entry.scope);
			expect(scopes).toContain("AgentRuntime.getFilteredActions");
			expect(scopes).toContain("AgentRuntime.isActionAllowed");
		} finally {
			await runtime.stop({ fast: true });
		}
	});

	it("completes composeState when the trajectories service fails to start", async () => {
		const runtime = new AgentRuntime({
			logLevel: "fatal",
			enableTrajectories: false,
		});
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

		class FailingTrajectoriesService extends Service {
			static override serviceType = "trajectories";
			capabilityDescription = "always fails to start";

			static override async start(): Promise<FailingTrajectoriesService> {
				throw new Error("trajectory logger boom");
			}

			override async stop(): Promise<void> {}
		}

		try {
			// The plugin borrows the native trajectories plugin name so the
			// feature gate reads enabled while the only implementation fails.
			await runtime.registerPlugin({
				name: nativeRuntimeFeaturePluginNames.trajectories,
				description: "Registers a trajectories service whose start throws",
				services: [FailingTrajectoriesService],
			});

			const probe: Provider = {
				name: "PROBE",
				get: async () => ({ text: "probe-ran", values: {}, data: {} }),
			};
			runtime.registerProvider(probe);

			const message: Memory = {
				id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID,
				entityId: "22222222-2222-2222-2222-222222222222" as UUID,
				roomId: "11111111-1111-1111-1111-111111111111" as UUID,
				content: { text: "gm" },
			};
			const state = await runtime.composeState(message, ["PROBE"], true);
			expect(state.text).toContain("probe-ran");

			const scopes = runtime
				.getRecentReportedErrors()
				.map((entry) => entry.scope);
			expect(scopes).toContain("AgentRuntime.composeState.trajectories");
		} finally {
			await runtime.stop({ fast: true });
		}
	});

	it("serves an already-started instance during initialize without awaiting the init barrier", async () => {
		class StartedPolicyService extends Service {
			static override serviceType = "tool_policy";
			capabilityDescription = "already-running policy stand-in";

			override async stop(): Promise<void> {}

			isToolAllowed(): { allowed: boolean; reason: string } {
				return { allowed: true, reason: "stub policy" };
			}
		}

		const verdictDuringInit =
			deferred<Awaited<ReturnType<AgentRuntime["isActionAllowed"]>>>();
		const runtime = new AgentRuntime({
			logLevel: "fatal",
			plugins: [
				{
					name: "init-gate",
					description:
						"Exercises the tool-policy path while initialize() is still running",
					init: async () => {
						// The instance is already up before the init barrier resolves;
						// the lookup must take the fast path instead of deadlocking on
						// initPromise (which this very init call is blocking).
						runtime.services.set("tool_policy" as ServiceTypeName, [
							new StartedPolicyService(runtime),
						]);
						verdictDuringInit.resolve(
							await runtime.isActionAllowed("ANY_ACTION"),
						);
					},
				},
			],
		});

		try {
			const init = runtime.initialize({
				allowNoDatabase: true,
				skipMigrations: true,
			});
			const verdict = await verdictDuringInit.promise;
			expect(verdict).toEqual({ allowed: true, reason: "stub policy" });
			await init;
		} finally {
			await runtime.stop({ fast: true });
		}
	});
});
