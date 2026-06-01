import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ActiveModelCoordinator,
	type LocalInferenceLoadArgs,
	type LocalInferenceLoader,
} from "./active-model";
import type { HardwareProbe, InstalledModel } from "./types";

function makeInstalledModel(id: string): InstalledModel {
	return {
		id,
		displayName: id,
		// `external-scan` ids are absent from MODEL_CATALOG, so
		// assertModelFitsHost short-circuits and switchTo() exercises the
		// loader path without needing on-disk weights.
		path: `/tmp/${id}.gguf`,
		sizeBytes: 1024,
		installedAt: "2026-05-15T00:00:00.000Z",
		lastUsedAt: null,
		source: "external-scan",
	};
}

const PROBE: HardwareProbe = {
	totalRamGb: 64,
	freeRamGb: 48,
	gpu: null,
	cpuCores: 8,
	platform: "linux",
	arch: "x64",
	appleSilicon: false,
	recommendedBucket: "mid",
	source: "os-fallback",
};

/**
 * Fake loader satisfying `isLoader` (loadModel/unloadModel/currentModelPath).
 * `loadModel` rejects when `failNext` is set so we can simulate a load failure
 * mid-switch without touching the real engine.
 */
class FakeLoader implements LocalInferenceLoader {
	loaded: string | null = null;
	failNextPaths = new Set<string>();
	readonly loadCalls: string[] = [];
	readonly unloadCalls: number[] = [];

	async loadModel(args: LocalInferenceLoadArgs): Promise<void> {
		this.loadCalls.push(args.modelPath);
		if (this.failNextPaths.has(args.modelPath)) {
			throw new Error(`simulated load failure for ${args.modelPath}`);
		}
		this.loaded = args.modelPath;
	}

	async unloadModel(): Promise<void> {
		this.unloadCalls.push(this.unloadCalls.length);
		this.loaded = null;
	}

	currentModelPath(): string | null {
		return this.loaded;
	}
}

function makeRuntime(loader: LocalInferenceLoader): AgentRuntime {
	return {
		agentId: "agent-test",
		getService: (name: string) =>
			name === "localInferenceLoader" ? loader : null,
	} as unknown as AgentRuntime;
}

describe("ActiveModelCoordinator switchTo rollback (#13)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("restores the previously-active model when a switch fails to load", async () => {
		const loader = new FakeLoader();
		const runtime = makeRuntime(loader);
		const coordinator = new ActiveModelCoordinator();
		const modelA = makeInstalledModel("model-a");
		const modelB = makeInstalledModel("model-b");

		// First load succeeds → A is the active, known-good model.
		const first = await coordinator.switchTo(runtime, modelA, undefined, {
			hardware: PROBE,
		});
		expect(first).toMatchObject({ modelId: "model-a", status: "ready" });
		expect(loader.currentModelPath()).toBe(modelA.path);

		// Switching to B fails to load. The old model must be restored, not lost.
		loader.failNextPaths.add(modelB.path);
		const second = await coordinator.switchTo(runtime, modelB, undefined, {
			hardware: PROBE,
		});

		expect(second).toMatchObject({ modelId: "model-a", status: "ready" });
		// A working model is loaded — NOT zero models, NOT an error attributed
		// to the requested id.
		expect(second.status).not.toBe("error");
		expect(loader.currentModelPath()).toBe(modelA.path);
	});

	it("reports no model loaded (modelId null, error) when no prior model existed", async () => {
		const loader = new FakeLoader();
		const runtime = makeRuntime(loader);
		const coordinator = new ActiveModelCoordinator();
		const modelA = makeInstalledModel("model-a");

		loader.failNextPaths.add(modelA.path);
		const state = await coordinator.switchTo(runtime, modelA, undefined, {
			hardware: PROBE,
		});

		expect(state.status).toBe("error");
		// Honest: nothing is loaded, so the id is null rather than a phantom
		// "model-a" that callers would treat as a live model.
		expect(state.modelId).toBeNull();
		expect(loader.currentModelPath()).toBeNull();
	});

	it("reports no model loaded when both the switch and the restore fail", async () => {
		const loader = new FakeLoader();
		const runtime = makeRuntime(loader);
		const coordinator = new ActiveModelCoordinator();
		const modelA = makeInstalledModel("model-a");
		const modelB = makeInstalledModel("model-b");

		await coordinator.switchTo(runtime, modelA, undefined, {
			hardware: PROBE,
		});

		// Both the new load AND the restore of the old model fail.
		loader.failNextPaths.add(modelB.path);
		loader.failNextPaths.add(modelA.path);
		const state = await coordinator.switchTo(runtime, modelB, undefined, {
			hardware: PROBE,
		});

		expect(state.status).toBe("error");
		expect(state.modelId).toBeNull();
	});
});
