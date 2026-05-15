import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ActiveModelCoordinator,
	assertManifestEvalsPassed,
	assertModelFitsHost,
	assertVoiceBundleFitsHost,
	CandidateModelActivationError,
	isForkOnlyKvCacheType,
	isStockKvCacheType,
	ModelDoesNotFitError,
	resolveLocalInferenceLoadArgs,
	VoiceBundleDoesNotFitError,
	validateLocalInferenceLoadArgs,
} from "./active-model";
import { localInferenceEngine, resolveIdleUnloadMs } from "./engine";
import type { Eliza1Manifest } from "./manifest";
import type { HardwareProbe, InstalledModel } from "./types";

function makeInstalledModel(id: string, filePath: string): InstalledModel {
	return {
		id,
		displayName: id,
		path: filePath,
		sizeBytes: 1024,
		installedAt: "2026-05-08T00:00:00.000Z",
		lastUsedAt: null,
		source: "eliza-download",
	};
}

describe("resolveLocalInferenceLoadArgs", () => {
	it("threads catalog contextLength into loader args when no override is given", async () => {
		const target = makeInstalledModel("eliza-1-9b", "/tmp/eliza-1-9b.gguf");
		const args = await resolveLocalInferenceLoadArgs(target);
		expect(args.contextSize).toBe(65536);
	});

	it("per-load contextSize override beats catalog contextLength default", async () => {
		const target = makeInstalledModel("eliza-1-9b", "/tmp/eliza-1-9b.gguf");
		const args = await resolveLocalInferenceLoadArgs(target, {
			contextSize: 32768,
		});
		expect(args.contextSize).toBe(32768);
	});

	it("per-load gpuLayers/flashAttention/mmap/mlock overrides flow into args", async () => {
		const target = makeInstalledModel("eliza-1-2b", "/tmp/eliza-1-2b.gguf");
		const args = await resolveLocalInferenceLoadArgs(target, {
			gpuLayers: 16,
			flashAttention: true,
			mmap: false,
			mlock: true,
		});
		expect(args.gpuLayers).toBe(16);
		expect(args.flashAttention).toBe(true);
		expect(args.mmap).toBe(false);
		expect(args.mlock).toBe(true);
	});

	it("preserves kvOffload overrides for backend load resolution", async () => {
		const target = makeInstalledModel("eliza-1-9b", "/tmp/eliza-1-9b.gguf");
		const args = await resolveLocalInferenceLoadArgs(target, {
			kvOffload: { gpuLayers: 10 },
		});
		expect(args.kvOffload).toEqual({ gpuLayers: 10 });
	});
});

describe("validateLocalInferenceLoadArgs", () => {
	it("accepts stock KV cache types on desktop", () => {
		expect(() =>
			validateLocalInferenceLoadArgs(
				{ cacheTypeK: "f16", cacheTypeV: "q8_0" },
				{ allowFork: false },
			),
		).not.toThrow();
	});

	it("rejects fork-only KV cache types on desktop", () => {
		expect(() =>
			validateLocalInferenceLoadArgs(
				{ cacheTypeK: "tbq4_0" },
				{ allowFork: false },
			),
		).toThrow(/elizaOS\/llama\.cpp|fork/i);
		expect(() =>
			validateLocalInferenceLoadArgs(
				{ cacheTypeV: "qjl1_256" },
				{ allowFork: false },
			),
		).toThrow(/elizaOS\/llama\.cpp|fork/i);
	});

	it("accepts fork KV cache types when allowFork is true (AOSP path)", () => {
		expect(() =>
			validateLocalInferenceLoadArgs(
				{ cacheTypeK: "q4_polar", cacheTypeV: "tbq3_0" },
				{ allowFork: true },
			),
		).not.toThrow();
	});

	it("rejects unknown KV cache type names", () => {
		expect(() =>
			validateLocalInferenceLoadArgs(
				{ cacheTypeK: "nope_made_up" },
				{ allowFork: false },
			),
		).toThrow(/not a recognised KV cache type/);
	});

	it("rejects illegal contextSize / gpuLayers / kvOffload", () => {
		expect(() => validateLocalInferenceLoadArgs({ contextSize: 100 })).toThrow(
			/contextSize/,
		);
		expect(() => validateLocalInferenceLoadArgs({ gpuLayers: -1 })).toThrow(
			/gpuLayers/,
		);
		expect(() =>
			validateLocalInferenceLoadArgs({
				kvOffload: "magic" as never,
			}),
		).toThrow(/kvOffload/);
	});

	it("accepts every legal kvOffload shape", () => {
		expect(() =>
			validateLocalInferenceLoadArgs({ kvOffload: "cpu" }),
		).not.toThrow();
		expect(() =>
			validateLocalInferenceLoadArgs({ kvOffload: "gpu" }),
		).not.toThrow();
		expect(() =>
			validateLocalInferenceLoadArgs({ kvOffload: "split" }),
		).not.toThrow();
		expect(() =>
			validateLocalInferenceLoadArgs({ kvOffload: { gpuLayers: 32 } }),
		).not.toThrow();
	});
});

describe("KV cache type classifiers", () => {
	it("identifies fork-only KV cache types", () => {
		expect(isForkOnlyKvCacheType("tbq4_0")).toBe(true);
		expect(isForkOnlyKvCacheType("tbq3_0")).toBe(true);
		expect(isForkOnlyKvCacheType("qjl1_256")).toBe(true);
		expect(isForkOnlyKvCacheType("q4_polar")).toBe(true);
		expect(isForkOnlyKvCacheType("f16")).toBe(false);
		expect(isForkOnlyKvCacheType(undefined)).toBe(false);
	});

	it("identifies stock KV cache types", () => {
		expect(isStockKvCacheType("f16")).toBe(true);
		expect(isStockKvCacheType("q8_0")).toBe(true);
		expect(isStockKvCacheType("bf16")).toBe(true);
		expect(isStockKvCacheType("q4_polar")).toBe(false);
		expect(isStockKvCacheType("tbq4_0")).toBe(false);
		expect(isStockKvCacheType(undefined)).toBe(false);
	});
});

const noopManifestLoader = () => null;

const baseHardwareProbe: HardwareProbe = {
	totalRamGb: 32,
	freeRamGb: 24,
	gpu: { backend: "vulkan", totalVramGb: 16, freeVramGb: 12 },
	cpuCores: 8,
	platform: "linux",
	arch: "x64",
	appleSilicon: false,
	recommendedBucket: "large",
	source: "node-llama-cpp",
};

describe("ActiveModelCoordinator effective runtime reporting", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports the actual llama-server load config instead of requested catalog KV", async () => {
		const installed: InstalledModel = {
			...makeInstalledModel("external-runtime-model", "/tmp/runtime.gguf"),
			source: "external-scan",
		};
		vi.spyOn(localInferenceEngine, "load").mockResolvedValue(undefined);
		vi.spyOn(localInferenceEngine, "currentRuntimeLoadConfig").mockReturnValue({
			contextSize: 32768,
			cacheTypeK: null,
			cacheTypeV: null,
			gpuLayers: 99,
			parallel: 4,
			binaryPath: "/tmp/llama-server",
		});

		const coordinator = new ActiveModelCoordinator();
		const state = await coordinator.switchTo(
			null,
			installed,
			{
				contextSize: 65536,
				cacheTypeK: "qjl1_256",
				cacheTypeV: "q4_polar",
				gpuLayers: 12,
			},
			{ hardware: baseHardwareProbe, manifestLoader: noopManifestLoader },
		);

		expect(state.status).toBe("ready");
		expect(state.loadedContextSize).toBe(32768);
		expect(state.loadedCacheTypeK).toBeNull();
		expect(state.loadedCacheTypeV).toBeNull();
		expect(state.loadedGpuLayers).toBe(99);
	});
});

describe("assertModelFitsHost (RAM-budget admission control)", () => {
	it("returns fits when the host comfortably clears the recommended budget", () => {
		const m = makeInstalledModel("eliza-1-2b", "/tmp/eliza-1-2b.gguf");
		const r = assertModelFitsHost(m, 32 * 1024, {
			manifestLoader: noopManifestLoader,
		});
		expect(r.level).toBe("fits");
		expect(r.minMb).toBe(4 * 1024);
	});

	it("refuses with ModelDoesNotFitError and the specific numbers when too small", () => {
		const m = makeInstalledModel("eliza-1-27b", "/tmp/eliza-1-27b.gguf");
		let caught: unknown;
		try {
			assertModelFitsHost(m, 8 * 1024, { manifestLoader: noopManifestLoader });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ModelDoesNotFitError);
		const e = caught as ModelDoesNotFitError;
		expect(e.modelId).toBe("eliza-1-27b");
		expect(e.requiredMb).toBe(32 * 1024); // 27b minRamGb 32
		expect(e.hostRamMb).toBe(8 * 1024);
		expect(e.usableMb).toBeLessThan(e.requiredMb);
		// Message names the actual numbers, not a vague "won't fit".
		expect(e.message).toContain(String(e.requiredMb));
		expect(e.message).toContain("Refusing to load it");
		// No 27b variant fits a 8 GB host → the error says so.
		expect(e.fittingVariantId).toBeNull();
	});

	it("names the largest fitting context variant when one exists", () => {
		// 40 GB host: 27b (32 GB) fits, 27b-256k (96 GB) does not.
		// The fit hint stays inside the 27B context-variant line.
		const m = makeInstalledModel(
			"eliza-1-27b-256k",
			"/tmp/eliza-1-27b-256k.gguf",
		);
		let caught: unknown;
		try {
			assertModelFitsHost(m, 40 * 1024, {
				manifestLoader: noopManifestLoader,
				reserveMb: 1536,
			});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ModelDoesNotFitError);
		const e = caught as ModelDoesNotFitError;
		expect(e.fittingVariantId).toBe("eliza-1-27b");
		expect(e.message).toContain("eliza-1-27b");
	});

	it("reports tight (no throw) when usable RAM is between floor and recommended", () => {
		const m = makeInstalledModel("eliza-1-9b", "/tmp/eliza-1-9b.gguf");
		const floor = 12 * 1024; // 9b minRamGb 12
		// Just above the floor, below the recommended (floor + a few hundred MB of KV).
		const r = assertModelFitsHost(m, floor + 200, {
			manifestLoader: noopManifestLoader,
			reserveMb: 0,
		});
		expect(r.level).toBe("tight");
		expect(r.minMb).toBe(floor);
	});

	it("does not gate a model with no catalog entry (external HF blob)", () => {
		const external = makeInstalledModel(
			"external-blob-xyz",
			"/tmp/external.gguf",
		);
		const r = assertModelFitsHost(external, 256, {
			manifestLoader: noopManifestLoader,
		});
		expect(r.level).toBe("fits");
	});

	it("a manifest-declared budget makes the gate stricter than the catalog scalar", () => {
		const m = makeInstalledModel("eliza-1-2b", "/tmp/x/text/eliza-1-2b.gguf");
		const bigManifestLoader = () =>
			({
				id: "eliza-1-2b",
				tier: "2b",
				version: "1.0.0",
				publishedAt: "2025-01-01T00:00:00.000Z",
				lineage: {
					text: { base: "eliza-1-2b", license: "apache-2.0" },
					voice: { base: "omnivoice", license: "apache-2.0" },
					drafter: { base: "dflash", license: "apache-2.0" },
				},
				files: {
					text: [{ path: "t.gguf", sha256: "a".repeat(64), ctx: 32768 }],
					voice: [{ path: "v.gguf", sha256: "b".repeat(64) }],
					asr: [],
					vision: [],
					dflash: [{ path: "d.gguf", sha256: "c".repeat(64) }],
					cache: [{ path: "c.bin", sha256: "d".repeat(64) }],
				},
				kernels: {
					required: ["turboquant_q4", "qjl", "polarquant", "dflash"],
					optional: [],
					verifiedBackends: {
						metal: { status: "pass", atCommit: "x", report: "ok" },
						vulkan: { status: "pass", atCommit: "x", report: "ok" },
						cuda: { status: "pass", atCommit: "x", report: "ok" },
						rocm: { status: "pass", atCommit: "x", report: "ok" },
						cpu: { status: "pass", atCommit: "x", report: "ok" },
					},
				},
				evals: {
					textEval: { score: 0.9, passed: true },
					voiceRtf: { rtf: 0.5, passed: true },
					e2eLoopOk: true,
					thirtyTurnOk: true,
				},
				ramBudgetMb: { min: 60000, recommended: 60000 },
				defaultEligible: true,
			}) as any;
		expect(() =>
			assertModelFitsHost(m, 16 * 1024, { manifestLoader: bigManifestLoader }),
		).toThrow(ModelDoesNotFitError);
	});
});

describe("assertVoiceBundleFitsHost (R9 §1.4 cross-model admission)", () => {
	it("fits when host RAM comfortably exceeds the bundle peak", () => {
		const r = assertVoiceBundleFitsHost({
			tierSlot: "desktop-0_8b",
			deviceTier: "GOOD",
			hostRamMb: 32 * 1024,
		});
		expect(r.level).toBe("fits");
		expect(r.fits).toBe(true);
		expect(r.peakMb).toBeGreaterThan(r.steadyStateMb);
	});

	it("throws VoiceBundleDoesNotFitError when wontfit and strict (default)", () => {
		let caught: unknown;
		try {
			assertVoiceBundleFitsHost({
				tierSlot: "workstation-27b",
				deviceTier: "POOR",
				hostRamMb: 8 * 1024,
			});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VoiceBundleDoesNotFitError);
		const e = caught as VoiceBundleDoesNotFitError;
		expect(e.tierSlot).toBe("workstation-27b");
		expect(e.deviceTier).toBe("POOR");
		expect(e.requiredSteadyStateMb).toBeGreaterThan(e.usableMb);
		expect(e.message).toContain("voice bundle");
	});

	it("returns wontfit without throwing when strict=false", () => {
		const r = assertVoiceBundleFitsHost({
			tierSlot: "workstation-27b",
			deviceTier: "POOR",
			hostRamMb: 8 * 1024,
			strict: false,
		});
		expect(r.level).toBe("wontfit");
		expect(r.fits).toBe(false);
	});

	it("is permissive for unknown tier slots (delegates to per-tier check)", () => {
		const r = assertVoiceBundleFitsHost({
			tierSlot: "ad-hoc-experimental",
			deviceTier: "GOOD",
			hostRamMb: 8 * 1024,
		});
		expect(r.fits).toBe(true);
		expect(r.steadyStateMb).toBe(0);
	});
});

// #7679: refuse to activate a model whose own `eliza-1.manifest.json`
// reports `evals.textEval.passed=false` (candidate.* / weights-staged.*).
describe("assertManifestEvalsPassed (#7679 activation gate)", () => {
	function makeStrictManifest(
		overrides: Partial<Eliza1Manifest> = {},
	): Eliza1Manifest {
		return {
			id: "eliza-1-2b",
			tier: "2b",
			version: "1.0.0",
			publishedAt: "2026-05-14T00:00:00.000Z",
			lineage: {
				text: { base: "eliza-1-2b", license: "apache-2.0" },
				voice: { base: "omnivoice", license: "apache-2.0" },
				drafter: { base: "dflash", license: "apache-2.0" },
			},
			files: {
				text: [{ path: "t.gguf", sha256: "a".repeat(64), ctx: 32768 }],
				voice: [{ path: "v.gguf", sha256: "b".repeat(64) }],
				asr: [],
				vision: [],
				dflash: [{ path: "d.gguf", sha256: "c".repeat(64) }],
				cache: [{ path: "c.bin", sha256: "d".repeat(64) }],
			},
			kernels: {
				required: ["turboquant_q4", "qjl", "polarquant", "dflash"],
				optional: [],
				verifiedBackends: {
					metal: { status: "pass", atCommit: "x", report: "ok" },
					vulkan: { status: "pass", atCommit: "x", report: "ok" },
					cuda: { status: "pass", atCommit: "x", report: "ok" },
					rocm: { status: "pass", atCommit: "x", report: "ok" },
					cpu: { status: "pass", atCommit: "x", report: "ok" },
				},
			},
			evals: {
				textEval: { score: 0.9, passed: true },
				voiceRtf: { rtf: 0.5, passed: true },
				e2eLoopOk: true,
				thirtyTurnOk: true,
			},
			ramBudgetMb: { min: 4096, recommended: 6144 },
			defaultEligible: true,
			...overrides,
		} as Eliza1Manifest;
	}

	it("refuses activation when the manifest reports textEval.passed=false", () => {
		const installed = makeInstalledModel(
			"eliza-1-0_6b",
			"/tmp/bundle/eliza-1-0_6b.gguf",
		);
		const candidateManifest = makeStrictManifest({
			id: "eliza-1-0_6b",
			tier: "0_8b", // candidate tier in the manifest
			version: "1.0.0-candidate.1",
			defaultEligible: false,
			evals: {
				textEval: { score: 0.2, passed: false },
				voiceRtf: { rtf: 1.2, passed: false },
				e2eLoopOk: false,
				thirtyTurnOk: false,
			},
		});

		let caught: unknown;
		try {
			assertManifestEvalsPassed(installed, () => candidateManifest);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(CandidateModelActivationError);
		const e = caught as CandidateModelActivationError;
		expect(e.modelId).toBe("eliza-1-0_6b");
		expect(e.manifestVersion).toBe("1.0.0-candidate.1");
		expect(e.failedEvals).toContain("textEval");
		expect(e.failedEvals).toContain("voiceRtf");
		expect(e.failedEvals).toContain("e2eLoopOk");
		expect(e.failedEvals).toContain("thirtyTurnOk");
		// The error message names the manifest version + the failed evals so
		// downstream HTTP callers can render an actionable refusal.
		expect(e.message).toMatch(/candidate-only/);
		expect(e.message).toContain("1.0.0-candidate.1");
		expect(e.message).toContain("textEval");
	});

	it("allows activation when textEval.passed=true (strict release)", () => {
		const installed = makeInstalledModel(
			"eliza-1-2b",
			"/tmp/bundle/eliza-1-2b.gguf",
		);
		expect(() =>
			assertManifestEvalsPassed(installed, () => makeStrictManifest()),
		).not.toThrow();
	});

	it("passes through bundles with no manifest (external HF blobs)", () => {
		const installed = makeInstalledModel(
			"external-blob-xyz",
			"/tmp/external.gguf",
		);
		expect(() =>
			assertManifestEvalsPassed(installed, () => null),
		).not.toThrow();
	});

	it("aggregates every failed eval slot into failedEvals (not just textEval)", () => {
		const installed = makeInstalledModel(
			"eliza-1-0_6b",
			"/tmp/bundle/eliza-1-0_6b.gguf",
		);
		const candidateManifest = makeStrictManifest({
			version: "1.0.0-candidate.1",
			defaultEligible: false,
			evals: {
				textEval: { score: 0.1, passed: false },
				voiceRtf: { rtf: 2.0, passed: false },
				e2eLoopOk: true,
				thirtyTurnOk: true,
				asrWer: { wer: 0.4, passed: false },
				expressive: {
					tagFaithfulness: 0.1,
					mosExpressive: 2.0,
					tagLeakage: 0.5,
					passed: false,
				},
				dflash: { acceptanceRate: null, speedup: null, passed: false },
			},
		});

		let caught: CandidateModelActivationError | null = null;
		try {
			assertManifestEvalsPassed(installed, () => candidateManifest);
		} catch (err) {
			caught = err as CandidateModelActivationError;
		}
		expect(caught).not.toBeNull();
		const failed = caught?.failedEvals ?? [];
		expect(failed).toEqual(
			expect.arrayContaining([
				"textEval",
				"voiceRtf",
				"asrWer",
				"expressive",
				"dflash",
			]),
		);
		// e2eLoopOk / thirtyTurnOk passed in this fixture; they must not appear.
		expect(failed).not.toContain("e2eLoopOk");
		expect(failed).not.toContain("thirtyTurnOk");
	});
});

describe("idle-unload config (J3)", () => {
	const prev = process.env.ELIZA_LOCAL_IDLE_UNLOAD_MS;
	afterEach(() => {
		if (prev === undefined) delete process.env.ELIZA_LOCAL_IDLE_UNLOAD_MS;
		else process.env.ELIZA_LOCAL_IDLE_UNLOAD_MS = prev;
	});

	it("defaults to 15 minutes", () => {
		delete process.env.ELIZA_LOCAL_IDLE_UNLOAD_MS;
		expect(resolveIdleUnloadMs()).toBe(15 * 60 * 1000);
	});

	it("honours an explicit override", () => {
		process.env.ELIZA_LOCAL_IDLE_UNLOAD_MS = "300000";
		expect(resolveIdleUnloadMs()).toBe(300_000);
	});

	it("0 disables the idle-unload timer", () => {
		process.env.ELIZA_LOCAL_IDLE_UNLOAD_MS = "0";
		expect(resolveIdleUnloadMs()).toBe(0);
	});

	it("falls back to the default on a garbage value", () => {
		process.env.ELIZA_LOCAL_IDLE_UNLOAD_MS = "nope";
		expect(resolveIdleUnloadMs()).toBe(15 * 60 * 1000);
	});
});
