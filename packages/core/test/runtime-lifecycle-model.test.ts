/** Regression tests for counterexamples found by tla/RuntimeLifecycle.tla. */
import { expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime";
import type { Plugin } from "../src/types/plugin";
import type { IAgentRuntime } from "../src/types/runtime";
import { Service } from "../src/types/service";
import { createInitializedRuntime } from "./initialized-runtime";

const ROOM = "00000000-0000-4000-8000-000000000001";

// TLA+ NoStartOnFailedInit: a failed initialize() must not release eager starts.
it("does not start a plugin service when initialize() fails", async () => {
	const started: string[] = [];
	class EagerService extends Service {
		static override serviceType = "failed-init-eager";
		capabilityDescription = "eager start after failed init";
		static override async start(runtime: IAgentRuntime) {
			started.push("start");
			return new EagerService(runtime);
		}
	}
	const plugin: Plugin = {
		name: "failed-init-fixture",
		description: "Declares one eager service",
		services: [EagerService],
	};
	// No persistence plugin: _initializeCore throws after plugin registration.
	const runtime = new AgentRuntime({
		character: { name: "FailedInit", bio: [] },
		plugins: [plugin],
		logLevel: "fatal",
	});
	await expect(runtime.initialize()).rejects.toThrow(
		"Database adapter not initialized",
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	try {
		expect(runtime.getLifecycleState()).toBe("failed");
		expect(started).toEqual([]);
	} finally {
		await runtime.stop();
	}
});

// TLA+ TurnsAbortedAfterStop: a turn that enters runWith after stop() is aborted.
it("aborts a turn that was queued behind the room owner when stop() began", async () => {
	const runtime = await createInitializedRuntime({
		character: { name: "QueuedTurn", bio: [] },
		logLevel: "fatal",
	});
	let releaseFirst!: () => void;
	const firstHeld = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const first = runtime.roomHandlerQueue.withLease(ROOM, () =>
		runtime.turnControllers.runWith(ROOM, async () => {
			await firstHeld;
		}),
	);
	const second = runtime.roomHandlerQueue.withLease(ROOM, () =>
		runtime.turnControllers.runWith(ROOM, async (signal) => signal.aborted),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const stopping = runtime.stop();
	releaseFirst();
	await first;
	expect(await second).toBe(true);
	await stopping;
});

// TLA+ StoppedNotReachable: after stop() no stopped instance is published.
it("does not return a stopped service from getService after stop()", async () => {
	const runtime = await createInitializedRuntime({
		character: { name: "StoppedService", bio: [] },
		logLevel: "fatal",
	});
	class StoppedService extends Service {
		static override serviceType = "stopped-not-reachable";
		capabilityDescription = "stopped service reachability";
		static override async start(owner: IAgentRuntime) {
			return new StoppedService(owner);
		}
	}
	await runtime.registerService(StoppedService);
	await runtime.getServiceLoadPromise(StoppedService.serviceType);
	await runtime.stop();
	expect(runtime.getService(StoppedService.serviceType)).toBeNull();
});
