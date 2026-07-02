import { describe, expect, it } from "vitest";
import {
	buildLocalModelLifecycleMatrix,
	formatLocalModelLifecycleMatrixMarkdown,
	type LifecycleLoadRunCheck,
	type LifecycleLocalFileCheck,
	type LifecycleRemoteCheck,
} from "./local-model-lifecycle-matrix";
import type { CatalogModel, HardwareProbe, InstalledModel } from "./types";

function hardware(overrides: Partial<HardwareProbe> = {}): HardwareProbe {
	return {
		totalRamGb: 64,
		freeRamGb: 42,
		gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 24 },
		cpuCores: 16,
		platform: "linux",
		arch: "x64",
		appleSilicon: false,
		recommendedBucket: "large",
		source: "os-fallback",
		...overrides,
	};
}

function catalogModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
	return {
		id: "eliza-1-4b",
		displayName: "eliza-1-4B",
		hfRepo: "elizaos/eliza-1",
		hfPathPrefix: "bundles/4b",
		ggufFile: "text/eliza-1-4b-128k.gguf",
		bundleManifestFile: "eliza-1.manifest.json",
		params: "4B",
		quant: "Eliza-1 optimized local runtime",
		sizeGb: 2.6,
		minRamGb: 6,
		category: "chat",
		bucket: "mid",
		blurb: "test",
		contextLength: 131072,
		runtimeClass: "fused-eliza1",
		runtime: {
			preferredBackend: "llama-cpp",
			optimizations: {
				requiresKernel: ["turbo3", "turbo4"],
			},
		},
		quantization: {
			defaultVariantId: "q4_k_m",
			variants: [
				{
					id: "q4_k_m",
					label: "4-bit",
					ggufFile: "text/eliza-1-4b-128k.gguf",
					sizeGb: 2.6,
					minRamGb: 6,
					status: "published",
				},
				{
					id: "q8_0",
					label: "8-bit",
					ggufFile: "text/eliza-1-4b-128k-q8_0.gguf",
					sizeGb: 5.1,
					minRamGb: 11,
					status: "planned",
				},
			],
		},
		sourceModel: {
			finetuned: false,
			components: {
				text: {
					repo: "elizaos/eliza-1",
					file: "bundles/4b/text/eliza-1-4b-128k.gguf",
				},
				voice: {
					repo: "elizaos/eliza-1",
					file: "bundles/4b/tts/kokoro/kokoro-82m-v1_0.gguf",
				},
				vad: {
					repo: "elizaos/eliza-1",
					file: "bundles/4b/vad/silero-vad-v5.gguf",
				},
				embedding: {
					repo: "elizaos/eliza-1",
					file: "bundles/4b/embedding/eliza-1-embedding.gguf",
				},
				vision: {
					repo: "elizaos/eliza-1",
					file: "bundles/4b/vision/mmproj-4b.gguf",
				},
				litert: {
					repo: "elizaos/eliza-1",
					file: "bundles/4b/text/eliza-1-4b.litertlm",
				},
				mtp: {
					repo: "elizaos/eliza-1",
					file: "bundles/4b/mtp/drafter-4b.gguf",
				},
			},
		},
		publishStatus: "published",
		...overrides,
	};
}

function installedModel(
	overrides: Partial<InstalledModel> = {},
): InstalledModel {
	return {
		id: "eliza-1-4b",
		displayName: "eliza-1-4B",
		path: "/tmp/eliza-1-4b/text/eliza-1-4b-128k.gguf",
		sizeBytes: 1024,
		bundleRoot: "/tmp/eliza-1-4b",
		manifestPath: "/tmp/eliza-1-4b/eliza-1.manifest.json",
		installedAt: "2026-07-01T00:00:00.000Z",
		lastUsedAt: null,
		source: "eliza-download",
		bundleVerifiedAt: "2026-07-01T00:05:00.000Z",
		...overrides,
	};
}

describe("buildLocalModelLifecycleMatrix", () => {
	it("records installed, verified bundles and accelerated backend policy", () => {
		const remote: LifecycleRemoteCheck = {
			status: "pass",
			detail: "HTTP 200",
			checkedAt: "2026-07-01T00:10:00.000Z",
			httpStatus: 200,
		};
		const localFile: LifecycleLocalFileCheck = {
			status: "present",
			detail: "component file present",
			path: "/tmp/eliza-1-4b/text/eliza-1-4b-128k.gguf",
			sizeBytes: 1024,
		};

		const matrix = buildLocalModelLifecycleMatrix({
			catalog: [catalogModel()],
			installed: [installedModel()],
			assignments: { TEXT_SMALL: "eliza-1-4b", TEXT_LARGE: "eliza-1-4b" },
			hardware: hardware(),
			observedAt: "2026-07-01T00:15:00.000Z",
			remoteChecks: { "eliza-1-4b:text": remote },
			bundleChecks: {
				"eliza-1-4b": {
					status: "pass",
					detail: "12 manifest file(s) passed remote checks",
					checkedAt: "2026-07-01T00:10:00.000Z",
					manifestUrl:
						"https://huggingface.co/elizaos/eliza-1/resolve/main/bundles/4b/eliza-1.manifest.json?download=true",
					fileCount: 12,
					failingFiles: [],
				},
			},
			localFileChecks: { "eliza-1-4b:text": localFile },
		});

		const text = matrix.rows.find((row) => row.component === "text");
		expect(text?.checks.downloadable.status).toBe("pass");
		expect(text?.checks.bundleClosure.status).toBe("pass");
		expect(text?.checks.installed.status).toBe("pass");
		expect(text?.checks.loadsAndRunsOnDevice.status).toBe("pass");
		expect(text?.runtime.expectedPrimaryBackend).toBe("cuda");
		expect(text?.runtime.cpuFallbackAllowed).toBe(false);
		expect(text?.local.assignedSlots).toEqual(["TEXT_SMALL", "TEXT_LARGE"]);
		expect(matrix.summary.failingRows).toBeGreaterThan(0);
	});

	it("allows CPU fallback when the detected accelerator is unsupported by the tier", () => {
		const matrix = buildLocalModelLifecycleMatrix({
			catalog: [catalogModel({ id: "eliza-1-2b", displayName: "eliza-1-2B" })],
			installed: [],
			assignments: {},
			hardware: hardware({
				gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 24 },
			}),
			observedAt: "2026-07-01T00:00:00.000Z",
		});

		const text = matrix.rows.find((row) => row.component === "text");
		expect(text?.runtime.supportedBackends).not.toContain("cuda");
		expect(text?.runtime.expectedPrimaryBackend).toBe("cpu");
		expect(text?.runtime.cpuFallbackAllowed).toBe(true);
		expect(text?.checks.backendPolicy.status).toBe("skipped");
		expect(text?.checks.backendPolicy.detail).toContain(
			"not supported by this model tier",
		);
	});

	it("uses an accelerator when the host and tier support the same backend", () => {
		const matrix = buildLocalModelLifecycleMatrix({
			catalog: [catalogModel({ id: "eliza-1-2b", displayName: "eliza-1-2B" })],
			installed: [],
			assignments: {},
			hardware: hardware({
				gpu: { backend: "vulkan", totalVramGb: 8, freeVramGb: 8 },
			}),
			observedAt: "2026-07-01T00:00:00.000Z",
		});

		const text = matrix.rows.find((row) => row.component === "text");
		expect(text?.runtime.expectedPrimaryBackend).toBe("vulkan");
		expect(text?.runtime.cpuFallbackAllowed).toBe(false);
		expect(text?.checks.backendPolicy.status).toBe("pass");
	});

	it("fails expected components that are not advertised by the catalog", () => {
		const model = catalogModel({
			sourceModel: {
				finetuned: false,
				components: {
					text: {
						repo: "elizaos/eliza-1",
						file: "bundles/4b/text/eliza-1-4b-128k.gguf",
					},
				},
			},
		});

		const matrix = buildLocalModelLifecycleMatrix({
			catalog: [model],
			installed: [],
			assignments: {},
			hardware: hardware({ gpu: null }),
			observedAt: "2026-07-01T00:00:00.000Z",
		});

		const asr = matrix.rows.find((row) => row.component === "asr");
		expect(asr?.catalogAdvertised).toBe(false);
		expect(asr?.checks.implemented.status).toBe("fail");
		expect(asr?.blockers.join("\n")).toContain("no catalog source file");
		expect(matrix.host.expectedPrimaryBackend).toBe("cpu");
		expect(matrix.host.cpuFallbackAllowed).toBe(true);
	});

	it("reconciles unadvertised MTP rows as a publish gap, not an implementation gap (#10727)", () => {
		// eliza-1-4b is in ELIZA_1_MTP_TIER_IDS; the catalog gates advertisement
		// on ELIZA_1_HOSTED_MTP_TIER_IDS (empty), so real catalog tiers carry no
		// mtp source component. Model the real shape: sourceModel without mtp.
		const model = catalogModel();
		const components = { ...model.sourceModel?.components };
		delete components.mtp;
		const matrix = buildLocalModelLifecycleMatrix({
			catalog: [
				{
					...model,
					sourceModel: { finetuned: false, components },
				},
			],
			installed: [],
			assignments: {},
			hardware: hardware(),
			observedAt: "2026-07-02T00:00:00.000Z",
		});

		const mtp = matrix.rows.find((row) => row.component === "mtp");
		expect(mtp?.knownGap?.kind).toBe("publish-pending");
		expect(mtp?.checks.implemented.status).toBe("pass");
		expect(mtp?.checks.implemented.detail).toContain(
			"ELIZA_1_HOSTED_MTP_TIER_IDS",
		);
		expect(mtp?.checks.published.status).toBe("fail");
		expect(mtp?.checks.published.detail).toContain("not hosted");
		expect(mtp?.checks.downloadable.status).toBe("fail");
		expect(mtp?.publishStatus).toBe("pending");
		// Still an honest red row — but attributed to publish, and counted with
		// the other pending-publish rows.
		expect(mtp?.blockers.length).toBeGreaterThan(0);
		expect(matrix.summary.pendingPublishRows).toBeGreaterThan(0);
	});

	it("records the product decision for a tier that ships no bundle embedding (#10727)", () => {
		// 2b-style tier: no embedding source component — TEXT_EMBEDDING is
		// served by the gte-small preset, so the row must not be a permanent
		// unfixable fail.
		const model = catalogModel({ id: "eliza-1-2b", displayName: "eliza-1-2B" });
		const components = { ...model.sourceModel?.components };
		delete components.embedding;
		delete components.mtp;
		const matrix = buildLocalModelLifecycleMatrix({
			catalog: [
				{
					...model,
					sourceModel: { finetuned: false, components },
				},
			],
			installed: [installedModel({ id: "eliza-1-2b" })],
			assignments: {},
			hardware: hardware(),
			observedAt: "2026-07-02T00:00:00.000Z",
		});

		const embedding = matrix.rows.find((row) => row.component === "embedding");
		expect(embedding?.knownGap?.kind).toBe("served-by-alternate-runtime");
		expect(embedding?.checks.implemented.status).toBe("skipped");
		expect(embedding?.checks.implemented.detail).toContain("gte-small");
		expect(embedding?.checks.published.status).toBe("skipped");
		expect(embedding?.checks.downloadable.status).toBe("skipped");
		expect(embedding?.checks.deployable.status).toBe("skipped");
		expect(embedding?.checks.installed.status).toBe("skipped");
		expect(embedding?.checks.loadsAndRunsOnDevice.status).toBe("skipped");
		expect(embedding?.blockers).toEqual([]);
	});

	it("still fails genuinely missing components (asr) even with known-gap reconciliation", () => {
		const model = catalogModel({
			sourceModel: {
				finetuned: false,
				components: {
					text: {
						repo: "elizaos/eliza-1",
						file: "bundles/4b/text/eliza-1-4b-128k.gguf",
					},
				},
			},
		});
		const matrix = buildLocalModelLifecycleMatrix({
			catalog: [model],
			installed: [],
			assignments: {},
			hardware: hardware(),
			observedAt: "2026-07-02T00:00:00.000Z",
		});
		const asr = matrix.rows.find((row) => row.component === "asr");
		expect(asr?.knownGap).toBeUndefined();
		expect(asr?.checks.implemented.status).toBe("fail");
	});

	it("prefers direct load-run evidence (tok/s + backend) over bundleVerifiedAt", () => {
		const loadRun: LifecycleLoadRunCheck = {
			status: "pass",
			detail:
				"loaded in 812 ms and decoded 48 tokens in 1370 ms via the FFI engine",
			checkedAt: "2026-07-02T00:10:00.000Z",
			backend: "metal",
			loadMs: 812,
			generateMs: 1370,
			promptTokens: 21,
			decodeTokens: 48,
			tokensPerSecond: 35.04,
		};
		const matrix = buildLocalModelLifecycleMatrix({
			catalog: [catalogModel()],
			installed: [installedModel({ bundleVerifiedAt: undefined })],
			assignments: {},
			hardware: hardware(),
			observedAt: "2026-07-02T00:15:00.000Z",
			loadRunChecks: { "eliza-1-4b": loadRun },
		});

		const text = matrix.rows.find((row) => row.component === "text");
		expect(text?.checks.loadsAndRunsOnDevice.status).toBe("pass");
		expect(text?.checks.loadsAndRunsOnDevice.detail).toContain("35.04 tok/s");
		expect(text?.checks.loadsAndRunsOnDevice.detail).toContain("metal");
		expect(matrix.summary.verifiedRows).toBeGreaterThan(0);

		// A failing load-run must surface as fail even when bundleVerifiedAt exists.
		const failing = buildLocalModelLifecycleMatrix({
			catalog: [catalogModel()],
			installed: [installedModel()],
			assignments: {},
			hardware: hardware(),
			observedAt: "2026-07-02T00:15:00.000Z",
			loadRunChecks: {
				"eliza-1-4b": {
					status: "fail",
					detail: "load/run threw: model file corrupt",
					checkedAt: "2026-07-02T00:10:00.000Z",
					backend: "metal",
				},
			},
		});
		const failingText = failing.rows.find((row) => row.component === "text");
		expect(failingText?.checks.loadsAndRunsOnDevice.status).toBe("fail");
		expect(failingText?.checks.loadsAndRunsOnDevice.detail).toContain(
			"model file corrupt",
		);
	});

	it("marks installed bundles without bundleVerifiedAt as not load/run verified", () => {
		const matrix = buildLocalModelLifecycleMatrix({
			catalog: [catalogModel()],
			installed: [installedModel({ bundleVerifiedAt: undefined })],
			assignments: {},
			hardware: hardware(),
			observedAt: "2026-07-01T00:00:00.000Z",
		});

		const text = matrix.rows.find((row) => row.component === "text");
		expect(text?.checks.loadsAndRunsOnDevice.status).toBe("fail");
		expect(text?.checks.loadsAndRunsOnDevice.detail).toContain(
			"bundleVerifiedAt",
		);
	});
});

describe("formatLocalModelLifecycleMatrixMarkdown", () => {
	it("renders a compact table with blockers", () => {
		const matrix = buildLocalModelLifecycleMatrix({
			catalog: [catalogModel({ publishStatus: "pending" })],
			installed: [],
			assignments: {},
			hardware: hardware(),
			observedAt: "2026-07-01T00:00:00.000Z",
		});

		const markdown = formatLocalModelLifecycleMatrixMarkdown(matrix);
		expect(markdown).toContain("# Local Model Lifecycle Matrix (#10727)");
		expect(markdown).toContain("| Model | Component | Publish |");
		expect(markdown).toContain("tier publish status is pending");
		expect(markdown).toContain("## Blockers");
	});
});
