/** Regression tests for counterexamples found by tla/ServiceLifecycle.tla. */
import { expect, it } from "vitest";
import { EventType } from "../src/types/events";
import type { Plugin } from "../src/types/plugin";
import type { IAgentRuntime } from "../src/types/runtime";
import { Service } from "../src/types/service";
import { createInitializedRuntime } from "./initialized-runtime";

function gate(): { open: () => void; wait: Promise<void> } {
	let open!: () => void;
	const wait = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { open, wait };
}

function runtimeFixture(name: string) {
	return createInitializedRuntime({
		character: { name, bio: [] },
		logLevel: "fatal",
	});
}

// TLA+ StatusConsistent: one sibling's failure never marks a running type failed.
it("reports a running sibling as registered when another sibling failed", async () => {
	const runtime = await runtimeFixture("SiblingStatus");
	const type = "sibling-status-model";
	class FailingSibling extends Service {
		static override serviceType = type;
		capabilityDescription = "fails to start";
		static override async start(): Promise<Service> {
			throw new Error("sibling start failed");
		}
	}
	class SlowSibling extends Service {
		static override serviceType = type;
		capabilityDescription = "starts after its sibling failed";
		static override async start(owner: IAgentRuntime) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			return new SlowSibling(owner);
		}
	}
	const seen: string[] = [];
	runtime.registerEvent(EventType.SERVICE_STARTED, async ({ serviceType }) => {
		if (serviceType !== type) return;
		expect(runtime.getService(type)).toBeInstanceOf(SlowSibling);
		seen.push(runtime.getServiceRegistrationStatus(type));
	});
	await runtime.registerService(FailingSibling);
	await runtime.registerService(SlowSibling);
	await runtime.getServiceLoadPromise(type);
	expect(seen).toEqual(["registered"]);
});

// TLA+ StopAtMostOnce: unloadPlugin racing runtime.stop() calls stop() once.
it("stops a service once when plugin unload races runtime stop", async () => {
	const runtime = await runtimeFixture("UnloadStop");
	const release = gate();
	let stops = 0;
	class OwnedService extends Service {
		static override serviceType = "unload-stop-model";
		capabilityDescription = "slow stop";
		static override async start(owner: IAgentRuntime) {
			return new OwnedService(owner);
		}
		override async stop() {
			stops += 1;
			await release.wait;
		}
	}
	const plugin: Plugin = {
		name: "unload-stop-fixture",
		description: "Owns one service",
		services: [OwnedService],
	};
	await runtime.registerPlugin(plugin);
	await runtime.getServiceLoadPromise(OwnedService.serviceType);
	const stopping = runtime.stop();
	await new Promise((resolve) => setTimeout(resolve, 5));
	const unloading = runtime.unloadPlugin(plugin.name);
	await new Promise((resolve) => setTimeout(resolve, 5));
	release.open();
	await Promise.all([stopping, unloading]);
	expect(stops).toBe(1);
});

// TLA+ NoOrphan: a sibling started while unload awaits stop() stays published.
it("keeps a sibling that started while plugin unload was stopping its class", async () => {
	const runtime = await runtimeFixture("UnloadSibling");
	const type = "unload-sibling-model";
	const release = gate();
	const stopped: string[] = [];
	class OwnedSibling extends Service {
		static override serviceType = type;
		capabilityDescription = "owned by the unloaded plugin";
		static override async start(owner: IAgentRuntime) {
			return new OwnedSibling(owner);
		}
		override async stop() {
			stopped.push("owned");
			await release.wait;
		}
	}
	class LateSibling extends Service {
		static override serviceType = type;
		capabilityDescription = "registered outside the plugin";
		static override async start(owner: IAgentRuntime) {
			return new LateSibling(owner);
		}
		override async stop() {
			stopped.push("late");
		}
	}
	const plugin: Plugin = {
		name: "unload-sibling-fixture",
		description: "Owns one sibling",
		services: [OwnedSibling],
	};
	await runtime.registerPlugin(plugin);
	await runtime.getServiceLoadPromise(type);
	await runtime.registerService(LateSibling);
	const unloading = runtime.unloadPlugin(plugin.name);
	await new Promise((resolve) => setTimeout(resolve, 5));
	await runtime.getServiceLoadPromise(type);
	release.open();
	await unloading;
	expect(runtime.getService(type)).toBeInstanceOf(LateSibling);
	await runtime.stop();
	expect(stopped).toEqual(["owned", "late"]);
});

// TLA+ NoOrphan: a sibling that publishes while plugin unload awaits its start
// rebuilds runtime.services without the withdrawn class; a runtime stop in
// that window must not leave the unloaded plugin's instance running.
it("stops the unloaded instance when runtime stop runs while unload awaits a sibling start", async () => {
	const runtime = await runtimeFixture("UnloadSiblingStop");
	const type = "unload-sibling-stop-model";
	const siblingStart = gate();
	const observer = gate();
	const stopped: string[] = [];
	let siblingStarting = false;
	class OwnedSibling extends Service {
		static override serviceType = type;
		capabilityDescription = "owned by the unloaded plugin";
		static override async start(owner: IAgentRuntime) {
			return new OwnedSibling(owner);
		}
		override async stop() {
			stopped.push("owned");
		}
	}
	class SlowSibling extends Service {
		static override serviceType = type;
		capabilityDescription = "still starting when the unload begins";
		static override async start(owner: IAgentRuntime) {
			siblingStarting = true;
			await siblingStart.wait;
			return new SlowSibling(owner);
		}
		override async stop() {
			stopped.push("sibling");
		}
	}
	const plugin: Plugin = {
		name: "unload-sibling-stop-fixture",
		description: "Owns one sibling",
		services: [OwnedSibling],
	};
	await runtime.registerPlugin(plugin);
	await runtime.getServiceLoadPromise(type);
	runtime.registerEvent(EventType.SERVICE_STARTED, async ({ serviceType }) => {
		if (serviceType === type) await observer.wait;
	});
	await runtime.registerService(SlowSibling);
	const loading = runtime.getServiceLoadPromise(type);
	while (!siblingStarting)
		await new Promise((resolve) => setTimeout(resolve, 1));

	const unloading = runtime.unloadPlugin(plugin.name).catch(() => null);
	await new Promise((resolve) => setTimeout(resolve, 5));
	siblingStart.open();
	await new Promise((resolve) => setTimeout(resolve, 5));
	await runtime.stop({ fast: true });
	observer.open();
	await Promise.allSettled([unloading, loading]);

	expect(stopped.sort()).toEqual(["owned", "sibling"]);
});

// TLA+ NoStatusWithoutClasses: the start that settles with its class gone
// marks the type "failed" before the unload sets the status, so a type with
// no classes left has no registration status.
it("leaves no registration status when unload runs while the only class is mid-start", async () => {
	const runtime = await runtimeFixture("UnloadMidStart");
	const type = "unload-mid-start-model";
	const release = gate();
	let starting = false;
	class OnlyService extends Service {
		static override serviceType = type;
		capabilityDescription = "still starting when the unload begins";
		static override async start(owner: IAgentRuntime) {
			starting = true;
			await release.wait;
			return new OnlyService(owner);
		}
	}
	const plugin: Plugin = {
		name: "unload-mid-start-fixture",
		description: "Owns the only class of its type",
		services: [OnlyService],
	};
	await runtime.registerPlugin(plugin);
	const loading = runtime.getServiceLoadPromise(type).catch(() => null);
	while (!starting) await new Promise((resolve) => setTimeout(resolve, 1));

	const unloading = runtime.unloadPlugin(plugin.name);
	await new Promise((resolve) => setTimeout(resolve, 5));
	release.open();
	await Promise.all([unloading, loading]);
	await new Promise((resolve) => setTimeout(resolve, 5));

	expect(runtime.getServiceRegistrationStatus(type)).toBe("unknown");
	expect(runtime.getService(type)).toBeNull();
});

// TLA+ NoStatusWithoutClasses: a later caller that reused the published
// instance replaces the startingServices entry; the unload still awaits the
// owned class's own start, which is still emitting SERVICE_STARTED.
it("leaves no registration status when unload runs while the only class emits its start event", async () => {
	const runtime = await runtimeFixture("UnloadStartEvent");
	const type = "unload-start-event-model";
	const observer = gate();
	let emitting = false;
	class OnlyService extends Service {
		static override serviceType = type;
		capabilityDescription = "published, still emitting SERVICE_STARTED";
		static override async start(owner: IAgentRuntime) {
			return new OnlyService(owner);
		}
	}
	runtime.registerEvent(EventType.SERVICE_STARTED, async ({ serviceType }) => {
		if (serviceType !== type) return;
		emitting = true;
		await observer.wait;
	});
	const plugin: Plugin = {
		name: "unload-start-event-fixture",
		description: "Owns the only class of its type",
		services: [OnlyService],
	};
	await runtime.registerPlugin(plugin);
	const loading = runtime.getServiceLoadPromise(type).catch(() => null);
	while (!emitting) await new Promise((resolve) => setTimeout(resolve, 1));
	await runtime.getServiceLoadPromise(type);

	const unloading = runtime.unloadPlugin(plugin.name);
	await new Promise((resolve) => setTimeout(resolve, 5));
	observer.open();
	await Promise.all([unloading, loading]);
	await new Promise((resolve) => setTimeout(resolve, 5));

	expect(runtime.getServiceRegistrationStatus(type)).toBe("unknown");
	expect(runtime.getService(type)).toBeNull();
});

// TLA+ NoStatusWithoutClasses: the caller that started the class writes the
// status a few microtasks after its start settled, after its
// startingServiceClasses entry and the replaced startingServices entry are
// gone, so an unload that finds nothing in flight still runs before it. The
// unload is called at every microtask offset across that window.
it("leaves no registration status at any tick after the only class's start settled", async () => {
	const phantom: number[] = [];
	for (let tick = 0; tick < 30; tick++) {
		const runtime = await runtimeFixture(`UnloadAfterSettle${tick}`);
		const type = `unload-after-settle-model-${tick}`;
		const observer = gate();
		let emitting = false;
		class OnlyService extends Service {
			static override serviceType = type;
			capabilityDescription = "published, then unloaded at a given tick";
			static override async start(owner: IAgentRuntime) {
				return new OnlyService(owner);
			}
		}
		runtime.registerEvent(
			EventType.SERVICE_STARTED,
			async ({ serviceType }) => {
				if (serviceType !== type) return;
				emitting = true;
				await observer.wait;
			},
		);
		const plugin: Plugin = {
			name: `unload-after-settle-fixture-${tick}`,
			description: "Owns the only class of its type",
			services: [OnlyService],
		};
		await runtime.registerPlugin(plugin);
		const loading = runtime.getServiceLoadPromise(type).catch(() => null);
		while (!emitting) await new Promise((resolve) => setTimeout(resolve, 1));
		await runtime.getServiceLoadPromise(type);

		observer.open();
		for (let i = 0; i < tick; i++) await null;
		const unloading = runtime.unloadPlugin(plugin.name);
		await Promise.all([unloading, loading]);
		await new Promise((resolve) => setTimeout(resolve, 5));

		if (runtime.getServiceRegistrationStatus(type) !== "unknown") {
			phantom.push(tick);
		}
	}
	expect(phantom).toEqual([]);
});
