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
