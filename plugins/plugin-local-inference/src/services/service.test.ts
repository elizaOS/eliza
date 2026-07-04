/** Covers `LocalInferenceService` orchestration: activation prewarm and image-gen GPU vendor detection (#10727). Deterministic, mocked engine/hardware. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
	debug: vi.fn(),
	renderMessageHandlerStablePrefix: vi.fn(async () => "stable-stage1-prefix"),
}));

vi.mock("@elizaos/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@elizaos/core")>();
	return {
		...actual,
		logger: {
			...actual.logger,
			debug: coreMocks.debug,
		},
		renderMessageHandlerStablePrefix:
			coreMocks.renderMessageHandlerStablePrefix,
	};
});

import { logger } from "@elizaos/core";
import { ActiveModelCoordinator } from "./active-model";
import { localInferenceEngine } from "./engine";
import * as hardwareModule from "./hardware";
import {
	readRoutingPreferences,
	writeRoutingPreferences,
} from "./routing-preferences";
import { LocalInferenceService } from "./service";
import type { ActiveModelState, InstalledModel } from "./types";

function makeInstalledModel(id: string): InstalledModel {
	return {
		id,
		displayName: id,
		path: `/tmp/${id}.gguf`,
		sizeBytes: 1024,
		installedAt: "2026-05-15T00:00:00.000Z",
		lastUsedAt: null,
		source: "external-scan",
	};
}

function readyState(modelId: string): ActiveModelState {
	return {
		modelId,
		loadedAt: "2026-05-15T00:00:01.000Z",
		status: "ready",
		loadedContextSize: 32768,
		loadedCacheTypeK: "q8_0",
		loadedCacheTypeV: "q8_0",
		loadedGpuLayers: 99,
	};
}

function makeRuntime(): AgentRuntime {
	return {
		agentId: "agent-test",
	} as unknown as AgentRuntime;
}

describe("LocalInferenceService activation prewarm", () => {
	let originalStateDir: string | undefined;
	let tempStateDir: string | null = null;

	beforeEach(async () => {
		originalStateDir = process.env.ELIZA_STATE_DIR;
		tempStateDir = await mkdtemp(join(tmpdir(), "eliza-service-test-"));
		process.env.ELIZA_STATE_DIR = tempStateDir;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		coreMocks.debug.mockReset();
		coreMocks.renderMessageHandlerStablePrefix.mockClear();
		if (originalStateDir === undefined) {
			delete process.env.ELIZA_STATE_DIR;
		} else {
			process.env.ELIZA_STATE_DIR = originalStateDir;
		}
		if (tempStateDir) {
			await rm(tempStateDir, { recursive: true, force: true });
			tempStateDir = null;
		}
	});

	it("prewarms the Stage-1 system prefix after a model becomes active", async () => {
		const service = new LocalInferenceService();
		const runtime = makeRuntime();
		const installed = makeInstalledModel("eliza-1-test");
		const prewarm = vi
			.spyOn(localInferenceEngine, "prewarmConversation")
			.mockResolvedValue(true);
		const asrReady = vi
			.spyOn(localInferenceEngine, "ensureActiveBundleAsrReady")
			.mockResolvedValue({} as never);
		const transcribe = vi
			.spyOn(localInferenceEngine, "transcribePcm")
			.mockResolvedValue("");
		const synthesize = vi
			.spyOn(localInferenceEngine, "synthesizeSpeech")
			.mockResolvedValue(new Uint8Array());

		vi.spyOn(service, "getInstalled").mockResolvedValue([installed]);
		vi.spyOn(ActiveModelCoordinator.prototype, "switchTo").mockResolvedValue(
			readyState(installed.id),
		);
		vi.spyOn(localInferenceEngine, "hasLoadedModel").mockReturnValue(true);
		vi.spyOn(localInferenceEngine, "activeBackendId").mockReturnValue(
			"llama-cpp",
		);

		await expect(service.setActive(runtime, installed.id)).resolves.toEqual(
			expect.objectContaining({ modelId: installed.id, status: "ready" }),
		);

		await vi.waitFor(() => {
			expect(prewarm).toHaveBeenCalledWith(
				"__system_prefix__",
				"stable-stage1-prefix",
			);
		});
		expect(asrReady).toHaveBeenCalledOnce();
		expect(transcribe).toHaveBeenCalledWith({
			pcm: expect.any(Float32Array),
			sampleRate: 16_000,
		});
		expect(synthesize).toHaveBeenCalledWith("Hello.");
		expect(coreMocks.renderMessageHandlerStablePrefix).toHaveBeenCalledWith(
			runtime,
			"agent-test",
		);
	});

	it("does not prewarm when activation is not ready", async () => {
		const service = new LocalInferenceService();
		const runtime = makeRuntime();
		const installed = makeInstalledModel("eliza-1-test");
		const prewarm = vi.spyOn(localInferenceEngine, "prewarmConversation");

		vi.spyOn(service, "getInstalled").mockResolvedValue([installed]);
		vi.spyOn(ActiveModelCoordinator.prototype, "switchTo").mockResolvedValue({
			modelId: installed.id,
			loadedAt: null,
			status: "error",
			error: "load failed",
		});

		await expect(service.setActive(runtime, installed.id)).resolves.toEqual(
			expect.objectContaining({ modelId: installed.id, status: "error" }),
		);

		expect(prewarm).not.toHaveBeenCalled();
	});

	it("routes stale capacitor text preferences to eliza-local-inference after activation", async () => {
		const service = new LocalInferenceService();
		const installed = makeInstalledModel("eliza-1-test");

		await writeRoutingPreferences({
			preferredProvider: {
				TEXT_SMALL: "capacitor-llama",
				TEXT_LARGE: "capacitor-llama",
			},
			policy: {
				TEXT_SMALL: "manual",
				TEXT_LARGE: "manual",
			},
		});
		vi.spyOn(service, "getInstalled").mockResolvedValue([installed]);
		vi.spyOn(ActiveModelCoordinator.prototype, "switchTo").mockResolvedValue(
			readyState(installed.id),
		);

		await service.setActive(null, installed.id);

		await expect(readRoutingPreferences()).resolves.toMatchObject({
			preferredProvider: {
				TEXT_SMALL: "eliza-local-inference",
				TEXT_LARGE: "eliza-local-inference",
			},
			policy: {
				TEXT_SMALL: "manual",
				TEXT_LARGE: "manual",
			},
		});
	});

	it("does not overwrite an explicit cloud text provider during activation", async () => {
		const service = new LocalInferenceService();
		const installed = makeInstalledModel("eliza-1-test");

		await writeRoutingPreferences({
			preferredProvider: {
				TEXT_SMALL: "anthropic",
				TEXT_LARGE: "anthropic",
			},
			policy: {
				TEXT_SMALL: "manual",
				TEXT_LARGE: "manual",
			},
		});
		vi.spyOn(service, "getInstalled").mockResolvedValue([installed]);
		vi.spyOn(ActiveModelCoordinator.prototype, "switchTo").mockResolvedValue(
			readyState(installed.id),
		);

		await service.setActive(null, installed.id);

		await expect(readRoutingPreferences()).resolves.toMatchObject({
			preferredProvider: {
				TEXT_SMALL: "anthropic",
				TEXT_LARGE: "anthropic",
			},
			policy: {
				TEXT_SMALL: "manual",
				TEXT_LARGE: "manual",
			},
		});
	});
});

describe("LocalInferenceService image-gen GPU vendor detection (#10727)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Guards the SERVICE wiring (not just the pure mapper): loadImageGenBackend
	// must feed the real probe's GPU vendor into the profile, so a Linux/Windows
	// NVIDIA box reaches CUDA. If this seam is reverted to `gpu: undefined` these
	// assertions go red.
	it("maps a probed NVIDIA (cuda) host to the 'nvidia' image-gen vendor", async () => {
		vi.spyOn(hardwareModule, "probeHardware").mockResolvedValue({
			totalRamGb: 32,
			freeRamGb: 16,
			gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 24 },
			cpuCores: 16,
			cpuFeatures: {},
			platform: "linux",
			arch: "x64",
			appleSilicon: false,
			recommendedBucket: "performance",
			source: "os-fallback",
			openvino: { present: false, devices: [] },
		} as Awaited<ReturnType<typeof hardwareModule.probeHardware>>);
		const service = new LocalInferenceService();
		const vendor = await (
			service as unknown as {
				detectImageGenGpuVendor(): Promise<string | undefined>;
			}
		).detectImageGenGpuVendor();
		expect(vendor).toBe("nvidia");
	});

	it("degrades to the platform default (undefined) and WARNS when the probe fails", async () => {
		vi.spyOn(hardwareModule, "probeHardware").mockRejectedValue(
			new Error("nvidia-smi timed out"),
		);
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const service = new LocalInferenceService();
		const vendor = await (
			service as unknown as {
				detectImageGenGpuVendor(): Promise<string | undefined>;
			}
		).detectImageGenGpuVendor();
		expect(vendor).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("image-gen GPU probe failed"),
		);
	});
});
