/**
 * defaultManifestLoader memoizes the manifest read+parse+validate keyed on the
 * installed bundle's `manifestSha256`. Proves: (1) a repeated load with the same
 * SHA does NOT re-read disk, (2) a changed SHA re-reads (self-invalidation), and
 * (3) the test reset clears it. The SHA is the validated manifest's content
 * hash, so a re-download with different RAM budgets never returns a stale value.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	REQUIRED_KERNELS_BY_TIER,
	validateManifest,
} from "./manifest/index.js";
import type { Eliza1Manifest } from "./manifest/types.js";
import {
	__resetManifestCacheForTests,
	defaultManifestLoader,
} from "./ram-budget.js";
import type { InstalledModel } from "./types.js";

const SHA = "0".repeat(64);

function validManifest(): Eliza1Manifest {
	const backend = {
		status: "pass" as const,
		atCommit: "abc1234",
		report: "r.txt",
	};
	const manifest: Eliza1Manifest = {
		id: "eliza-1-9b",
		tier: "9b",
		version: "1.0.0",
		publishedAt: "2026-05-10T00:00:00Z",
		lineage: {
			text: { base: "eliza-1-text-backbone", license: "apache-2.0" },
			voice: { base: "eliza-1-voice-backbone", license: "apache-2.0" },
			asr: { base: "eliza-1-asr", license: "apache-2.0" },
			vad: { base: "eliza-1-vad", license: "apache-2.0" },
			vision: { base: "eliza-1-vision", license: "apache-2.0" },
			drafter: { base: "eliza-1-drafter", license: "apache-2.0" },
		},
		files: {
			text: [{ path: "text/eliza-1-9b-128k.gguf", ctx: 131072, sha256: SHA }],
			voice: [{ path: "tts/omnivoice-base-Q4_K_M.gguf", sha256: SHA }],
			asr: [{ path: "asr/asr.gguf", sha256: SHA }],
			vision: [{ path: "vision/mmproj-9b.gguf", sha256: SHA }],
			mtp: [{ path: "mtp/drafter-9b.gguf", sha256: SHA }],
			cache: [{ path: "cache/voice-preset-default.bin", sha256: SHA }],
			vad: [{ path: "vad/silero-vad-v5.gguf", sha256: SHA }],
		},
		kernels: {
			required: [...REQUIRED_KERNELS_BY_TIER["9b"]],
			optional: [],
			verifiedBackends: {
				metal: backend,
				vulkan: backend,
				cuda: backend,
				rocm: backend,
				cpu: backend,
			},
		},
		evals: {
			textEval: { score: 0.71, passed: true },
			voiceRtf: { rtf: 0.42, passed: true },
			asrWer: { wer: 0.05, passed: true },
			vadLatencyMs: {
				median: 16,
				boundaryMs: 24,
				endpointMs: 80,
				falseBargeInRate: 0.01,
				passed: true,
			},
			mtp: { acceptanceRate: 0.72, speedup: 1.8, passed: true },
			e2eLoopOk: true,
			thirtyTurnOk: true,
		},
		ramBudgetMb: { min: 7000, recommended: 9500 },
		defaultEligible: true,
		mtp: "separate-drafter",
	};
	return manifest;
}

let dir: string;
let modelPath: string;

beforeEach(() => {
	__resetManifestCacheForTests();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "ram-budget-cache-"));
	// Canonical layout: GGUF in text/, manifest at the bundle root, so the
	// loader's dirname(dirname(path)) candidate hits on the first probe.
	fs.mkdirSync(path.join(dir, "text"), { recursive: true });
	modelPath = path.join(dir, "text", "eliza-1-9b-128k.gguf");
	const manifest = validManifest();
	expect(validateManifest(manifest).ok).toBe(true); // fixture sanity
	fs.writeFileSync(
		path.join(dir, "eliza-1.manifest.json"),
		JSON.stringify(manifest),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	__resetManifestCacheForTests();
	fs.rmSync(dir, { recursive: true, force: true });
});

function installed(sha: string): InstalledModel {
	return {
		id: "eliza-1-9b",
		displayName: "Eliza-1 9B",
		path: modelPath,
		sizeBytes: 1,
		manifestSha256: sha,
		installedAt: "2026-05-10T00:00:00Z",
		lastUsedAt: null,
		source: "eliza-download",
	};
}

function manifestReadCount(spy: ReturnType<typeof vi.spyOn>): number {
	return spy.mock.calls.filter(
		(c) => typeof c[0] === "string" && c[0].endsWith("eliza-1.manifest.json"),
	).length;
}

describe("defaultManifestLoader manifest cache", () => {
	it("reads disk once for repeated loads with the same manifestSha256", () => {
		const spy = vi.spyOn(fs, "readFileSync");
		const first = defaultManifestLoader("eliza-1-9b", installed("sha-A"));
		const second = defaultManifestLoader("eliza-1-9b", installed("sha-A"));
		expect(first?.ramBudgetMb.recommended).toBe(9500);
		expect(second).toBe(first); // identical cached object
		expect(manifestReadCount(spy)).toBe(1);
	});

	it("re-reads when the manifestSha256 changes (self-invalidation)", () => {
		const spy = vi.spyOn(fs, "readFileSync");
		defaultManifestLoader("eliza-1-9b", installed("sha-A"));
		defaultManifestLoader("eliza-1-9b", installed("sha-B"));
		expect(manifestReadCount(spy)).toBe(2);
	});

	it("does not cache when no manifestSha256 is present (legacy installs)", () => {
		const spy = vi.spyOn(fs, "readFileSync");
		const legacy: InstalledModel = {
			...installed("ignored"),
			manifestSha256: undefined,
		};
		defaultManifestLoader("eliza-1-9b", legacy);
		defaultManifestLoader("eliza-1-9b", legacy);
		expect(manifestReadCount(spy)).toBe(2);
	});

	it("__resetManifestCacheForTests forces a re-read", () => {
		const spy = vi.spyOn(fs, "readFileSync");
		defaultManifestLoader("eliza-1-9b", installed("sha-A"));
		__resetManifestCacheForTests();
		defaultManifestLoader("eliza-1-9b", installed("sha-A"));
		expect(manifestReadCount(spy)).toBe(2);
	});
});
