/** Regression tests for the counterexamples TLC found in tla/PluginLifecycle.tla. */
import { expect, it } from "vitest";
import type { Plugin } from "../src/types/plugin";
import type { IAgentRuntime } from "../src/types/runtime";
import { Service } from "../src/types/service";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
		await tick(5);
	}
}

async function newRuntime(name: string) {
	const { createInitializedRuntime } = await import("./initialized-runtime");
	return createInitializedRuntime({
		character: { name, bio: [] },
		logLevel: "fatal",
	});
}

// PluginLifecycle.tla NoOrphanInstance: a getServiceLoadPromise() during unload
// must not start a fresh instance of a class the unload is removing.
it("a service load during unload does not leave a live instance of the unloaded plugin", async () => {
	const runtime = await newRuntime("Unload resurrection");
	const secondStop = deferred();
	const started: Service[] = [];
	const stopped = new Set<Service>();
	class First extends Service {
		static serviceType = "unload_resurrection_fixture";
		static allowsMultiple = true;
		capabilityDescription = "First implementation";
		static async start(rt: IAgentRuntime): Promise<Service> {
			const service = new First(rt);
			started.push(service);
			return service;
		}
		async stop(): Promise<void> {
			stopped.add(this);
		}
	}
	class Second extends Service {
		static serviceType = "unload_resurrection_fixture";
		static allowsMultiple = true;
		capabilityDescription = "Second implementation";
		static async start(rt: IAgentRuntime): Promise<Service> {
			const service = new Second(rt);
			started.push(service);
			return service;
		}
		async stop(): Promise<void> {
			stopped.add(this);
			await secondStop.promise;
		}
	}
	await runtime.registerPlugin({
		name: "unload-resurrection-fixture",
		description: "Two implementations of one service type",
		services: [First, Second],
	});
	await runtime.getServiceLoadPromise("unload_resurrection_fixture");
	expect(started).toHaveLength(2);

	const unload = runtime.unloadPlugin("unload-resurrection-fixture");
	await waitFor(() => stopped.size === 2);
	// First is stopped and forgotten; Second is still stopping.
	const load = runtime
		.getServiceLoadPromise("unload_resurrection_fixture")
		.catch(() => null);
	await tick(10);
	secondStop.resolve();
	await unload;
	await load;

	const live = started.filter((service) => !stopped.has(service));
	expect(live).toEqual([]);
});

// PluginLifecycle.tla NoOrphanConnector: a service start that was in flight
// when unload began must not leave its connectors registered.
it("unload during a service start removes the connectors that start registers", async () => {
	const runtime = await newRuntime("Unload in-flight start");
	const startGate = deferred();
	let startCalled = false;
	class SlowConnectorService extends Service {
		static serviceType = "unload_inflight_connector_fixture";
		capabilityDescription = "Connector that takes a while to connect";
		static async start(rt: IAgentRuntime): Promise<Service> {
			startCalled = true;
			await startGate.promise;
			return new SlowConnectorService(rt);
		}
		async stop(): Promise<void> {}
		static registerSendHandlers(rt: IAgentRuntime): void {
			rt.registerMessageConnector({
				source: "inflight-chat",
				sendHandler: async () => undefined,
			});
		}
	}
	await runtime.registerPlugin({
		name: "unload-inflight-connector-fixture",
		description: "Its service is still starting when it is unloaded",
		services: [SlowConnectorService],
	});
	await waitFor(() => startCalled);

	const unload = runtime.unloadPlugin("unload-inflight-connector-fixture");
	await tick(10);
	startGate.resolve();
	await unload;

	expect(
		runtime.getMessageConnectors().map(({ source }) => source),
	).not.toContain("inflight-chat");
});

// PluginLifecycle.tla NoOrphanConnector: a service started lazily, after its
// plugin registered, runs start() in the plugin's context, so unload removes
// the connector that start() registers.
it("unload removes a connector registered by a lazily started service", async () => {
	const runtime = await newRuntime("Unload lazy start");
	let startCalls = 0;
	class LazyConnectorService extends Service {
		static serviceType = "unload_lazy_connector_fixture";
		capabilityDescription = "Connector whose first start fails";
		static async start(rt: IAgentRuntime): Promise<Service> {
			startCalls += 1;
			if (startCalls === 1) throw new Error("not ready yet");
			rt.registerMessageConnector({
				source: "lazy-chat",
				sendHandler: async () => undefined,
			});
			return new LazyConnectorService(rt);
		}
		async stop(): Promise<void> {}
	}
	await runtime.registerPlugin({
		name: "unload-lazy-connector-fixture",
		description: "Its service starts on the first load after registration",
		services: [LazyConnectorService],
	});
	await waitFor(() => startCalls === 1);
	await tick(10);
	await runtime.getServiceLoadPromise("unload_lazy_connector_fixture");
	expect(startCalls).toBe(2);
	expect(runtime.getMessageConnectors().map(({ source }) => source)).toContain(
		"lazy-chat",
	);

	await runtime.unloadPlugin("unload-lazy-connector-fixture");

	expect(
		runtime.getMessageConnectors().map(({ source }) => source),
	).not.toContain("lazy-chat");
	await runtime.stop();
});

// PluginLifecycle.tla NoOrphanInstance with StopMayFail: a rejected stop() must
// not leave the plugin's other instances running with no lookup to stop them.
it("unload stops every owned instance when one stop rejects", async () => {
	const runtime = await newRuntime("Unload failing stop");
	const stopped: string[] = [];
	class Failing extends Service {
		static serviceType = "unload_failing_stop_fixture";
		static allowsMultiple = true;
		capabilityDescription = "Its stop rejects";
		static async start(rt: IAgentRuntime): Promise<Service> {
			return new Failing(rt);
		}
		async stop(): Promise<void> {
			stopped.push("failing");
			throw new Error("stop failed");
		}
	}
	class Healthy extends Service {
		static serviceType = "unload_failing_stop_fixture";
		static allowsMultiple = true;
		capabilityDescription = "Stops cleanly";
		static async start(rt: IAgentRuntime): Promise<Service> {
			return new Healthy(rt);
		}
		async stop(): Promise<void> {
			stopped.push("healthy");
		}
	}
	await runtime.registerPlugin({
		name: "unload-failing-stop-fixture",
		description: "Two implementations; the first one's stop rejects",
		services: [Failing, Healthy],
	});
	await runtime.getServiceLoadPromise("unload_failing_stop_fixture");
	expect(runtime.getServicesByType("unload_failing_stop_fixture")).toHaveLength(
		2,
	);

	await expect(
		runtime.unloadPlugin("unload-failing-stop-fixture"),
	).rejects.toThrow();

	expect(stopped).toEqual(["failing", "healthy"]);
});

// PluginLifecycle.tla StopAtMostOnce: runtime.stop() during an unload must not
// stop the instance the unload is already stopping.
it("runtime stop during unload stops each service instance once", async () => {
	const runtime = await newRuntime("Unload and stop");
	const stopGate = deferred();
	let stopCalls = 0;
	class SlowStopService extends Service {
		static serviceType = "unload_stop_race_fixture";
		capabilityDescription = "Service that takes a while to stop";
		static async start(rt: IAgentRuntime): Promise<Service> {
			return new SlowStopService(rt);
		}
		async stop(): Promise<void> {
			stopCalls += 1;
			await stopGate.promise;
		}
	}
	await runtime.registerPlugin({
		name: "unload-stop-race-fixture",
		description: "Unloaded while the runtime stops",
		services: [SlowStopService],
	});
	await runtime.getServiceLoadPromise("unload_stop_race_fixture");

	const unload = runtime.unloadPlugin("unload-stop-race-fixture");
	const stop = runtime.stop();
	await waitFor(() => stopCalls >= 2);
	stopGate.resolve();
	await Promise.allSettled([unload, stop]);

	expect(stopCalls).toBe(1);
});

// PluginLifecycle.tla TeardownExclusive: two concurrent unloads of one plugin
// tear it down once.
it("concurrent unloads of one plugin run its teardown once", async () => {
	const runtime = await newRuntime("Concurrent unload");
	const disposeGate = deferred();
	let disposeCalls = 0;
	const plugin = {
		name: "concurrent-unload-fixture",
		description: "Counts teardown",
		actions: [
			{
				name: "CONCURRENT_UNLOAD_FIXTURE",
				description: "Owned component",
				validate: async () => true,
				handler: async () => ({ success: true }),
			},
		],
		dispose: async () => {
			disposeCalls += 1;
			await disposeGate.promise;
		},
	} as Plugin;
	await runtime.registerPlugin(plugin);

	const first = runtime.unloadPlugin(plugin.name);
	const second = runtime.unloadPlugin(plugin.name);
	await tick(10);
	disposeGate.resolve();
	await Promise.all([first, second]);

	expect(disposeCalls).toBe(1);
});

// PluginLifecycle.tla RegisterHonest: a register that joins an in-flight
// registration of the same plugin fails when that registration fails.
it("a duplicate register during a failing init does not report success", async () => {
	const runtime = await newRuntime("Duplicate register");
	const initGate = deferred();
	const plugin: Plugin = {
		name: "duplicate-register-fixture",
		description: "Its init fails after a while",
		init: async () => {
			await initGate.promise;
			throw new Error("init failed");
		},
	};

	const first = runtime.registerPlugin(plugin);
	const second = runtime.registerPlugin(plugin);
	await tick(10);
	initGate.resolve();
	const [firstResult, secondResult] = await Promise.allSettled([first, second]);

	expect(firstResult.status).toBe("rejected");
	expect(runtime.plugins.map((p) => p.name)).not.toContain(plugin.name);
	expect(secondResult.status).toBe("rejected");
});

// A failing registration rollback must not replace the registration error.
it("a register whose rollback also fails rejects with the init error", async () => {
	const runtime = await newRuntime("Rollback failure");
	const plugin = {
		name: "rollback-failure-fixture",
		description: "Its init and its dispose both fail",
		init: async () => {
			throw new Error("init failed");
		},
		dispose: async () => {
			throw new Error("dispose failed");
		},
	} as Plugin;

	await expect(runtime.registerPlugin(plugin)).rejects.toThrow("init failed");
});
