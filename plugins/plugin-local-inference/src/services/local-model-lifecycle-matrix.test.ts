import { describe, expect, it } from "vitest";
import {
	buildLocalModelLifecycleMatrix,
	formatLocalModelLifecycleMatrixMarkdown,
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
