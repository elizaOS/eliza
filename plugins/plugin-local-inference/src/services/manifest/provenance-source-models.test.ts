/**
 * `provenance.sourceModels` records the upstream repo of each component the
 * bundle ships. The publisher (`packages/training` `eliza1_manifest.py`,
 * `stage_base_v1_candidate.py`), `eliza-1.manifest.v1.json` and the base-v1
 * coverage rule in `validator.ts` all treat it as a partial map, so the
 * runtime schema must accept a block that leaves out components the bundle
 * does not ship (no bundle ships `imagegen` provenance today).
 */

import { describe, expect, it } from "vitest";
import { findCatalogModel } from "../catalog";
import { parseBundleManifestOrThrow } from "../downloader";
import { REQUIRED_KERNELS_BY_TIER, validateManifest } from "./index";
import type { Eliza1Manifest } from "./types";

const SHA = "0".repeat(64);

const catalog = findCatalogModel("eliza-1-4b");
if (!catalog) throw new Error("catalog entry eliza-1-4b missing");

type Provenance = NonNullable<Eliza1Manifest["provenance"]>;

function manifestWithProvenance(provenance: Provenance): Eliza1Manifest {
	const pass = { status: "pass" as const, atCommit: "08032d57", report: "r" };
	const skipped = {
		status: "skipped" as const,
		atCommit: "08032d57",
		report: "not-applicable",
	};
	return {
		id: "eliza-1-4b",
		tier: "4b",
		version: "1.0.0-candidate.1",
		publishedAt: "2026-10-01T00:00:00Z",
		lineage: {
			text: { base: "google/gemma-4-E4B", license: "gemma" },
			voice: { base: "kokoro", license: "apache-2.0" },
			asr: { base: "nvidia/parakeet-tdt", license: "cc-by-4.0" },
			vad: { base: "silero-vad", license: "mit" },
			vision: { base: "google/gemma-4-E4B", license: "gemma" },
			drafter: { base: "gemma-4-drafter", license: "gemma" },
		},
		files: {
			text: [{ path: catalog?.ggufFile ?? "", ctx: 131072, sha256: SHA }],
			voice: [{ path: "tts/kokoro.gguf", sha256: SHA }],
			asr: [{ path: "asr/asr.gguf", sha256: SHA }],
			vision: [{ path: "vision/mmproj-4b.gguf", sha256: SHA }],
			mtp: [{ path: "mtp/drafter-4b.gguf", sha256: SHA }],
			cache: [{ path: "cache/voice-preset-default.bin", sha256: SHA }],
			vad: [{ path: "vad/silero-vad-v5.gguf", sha256: SHA }],
		},
		kernels: {
			required: [...REQUIRED_KERNELS_BY_TIER["4b"]],
			optional: [],
			verifiedBackends: {
				metal: skipped,
				vulkan: skipped,
				cuda: pass,
				rocm: skipped,
				cpu: pass,
			},
		},
		evals: {
			textEval: { score: 0, passed: false },
			voiceRtf: { rtf: 0, passed: false },
			asrWer: { wer: 1, passed: false },
			vadLatencyMs: { median: 20, passed: false },
			mtp: { acceptanceRate: null, speedup: null, passed: false },
			e2eLoopOk: false,
			thirtyTurnOk: false,
		},
		ramBudgetMb: { min: 5000, recommended: 7000 },
		provenance,
		defaultEligible: false,
		mtp: "separate-drafter",
	};
}

// One source per component the fixture ships: no `embedding` or `imagegen`
// (`stage_base_v1_candidate.py` likewise writes no `imagegen` entry).
function shippedSources(): Provenance["sourceModels"] {
	return {
		text: { repo: "google/gemma-4-E4B" },
		voice: { repo: "hexgrad/Kokoro-82M" },
		asr: { repo: "nvidia/parakeet-tdt" },
		vad: { repo: "elizaos/silero-vad-gguf" },
		vision: { repo: "google/gemma-4-E4B" },
		drafter: { repo: "google/gemma-4-E4B" },
	};
}

describe("provenance.sourceModels", () => {
	it("accepts a block that names only the shipped components", () => {
		const manifest = manifestWithProvenance({
			releaseState: "base-v1-candidate",
			finetuned: true,
			sourceModels: shippedSources(),
		});

		expect(validateManifest(manifest)).toMatchObject({ ok: true });
		expect(() => parseBundleManifestOrThrow(manifest, catalog)).not.toThrow();
	});

	it("still requires base-v1 to name every shipped component", () => {
		const { vision: _vision, ...sourceModels } = shippedSources();
		const manifest = manifestWithProvenance({
			releaseState: "base-v1",
			finetuned: false,
			sourceModels,
		});

		const result = validateManifest(manifest);
		expect(result.ok).toBe(false);
		const errors = result.ok ? [] : result.errors;
		expect(errors.filter((error) => error.startsWith("provenance."))).toEqual([
			"provenance.sourceModels.vision: required for releaseState=base-v1 (component is in files.vision)",
		]);
	});

	it("still refuses a slot that is not a bundle component", () => {
		const manifest = manifestWithProvenance({
			releaseState: "base-v1-candidate",
			finetuned: true,
			sourceModels: {
				...shippedSources(),
				tts: { repo: "hexgrad/Kokoro-82M" },
			} as Provenance["sourceModels"],
		});

		expect(validateManifest(manifest).ok).toBe(false);
	});
});
