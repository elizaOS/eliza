/**
 * The activation gates in `ActiveModelCoordinator.switchTo` read the manifest
 * an installed bundle ships on disk. A manifest whose `kernels.required` omits
 * a tier kernel, or a strict release whose text eval failed, also breaks the
 * manifest contract, so the gates must not depend on the contract-validated
 * loader: that loader returns null for those manifests, and null means "no
 * manifest, not gated".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ActiveModelCoordinator,
	assertManifestEvalsPassed,
	assertRequiredKernelsPresent,
	CandidateModelActivationError,
	MissingRequiredKernelsError,
} from "./active-model.js";
import {
	REQUIRED_KERNELS_BY_TIER,
	validateManifest,
} from "./manifest/index.js";
import type { Eliza1Manifest } from "./manifest/types.js";
import { __resetManifestCacheForTests } from "./ram-budget.js";
import type { InstalledModel } from "./types.js";

const SHA = "0".repeat(64);

function validManifest(): Eliza1Manifest {
	const backend = {
		status: "pass" as const,
		atCommit: "abc1234",
		report: "r.txt",
	};
	return {
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
}

let bundleRoot: string;
let installed: InstalledModel;

function shipManifest(manifest: Eliza1Manifest): void {
	fs.writeFileSync(
		path.join(bundleRoot, "eliza-1.manifest.json"),
		JSON.stringify(manifest),
	);
}

beforeEach(() => {
	__resetManifestCacheForTests();
	bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "activation-gates-"));
	fs.mkdirSync(path.join(bundleRoot, "text"), { recursive: true });
	const modelPath = path.join(bundleRoot, "text", "eliza-1-9b-128k.gguf");
	fs.writeFileSync(modelPath, "");
	installed = {
		id: "eliza-1-9b",
		displayName: "Eliza-1 9B",
		path: modelPath,
		sizeBytes: 1,
		installedAt: "2026-05-10T00:00:00Z",
		lastUsedAt: null,
		source: "eliza-download",
	};
});

afterEach(() => {
	__resetManifestCacheForTests();
	fs.rmSync(bundleRoot, { recursive: true, force: true });
});

describe("activation gates read the manifest the bundle ships", () => {
	it("pass a bundle with no manifest and a bundle with a valid one", () => {
		expect(() => assertRequiredKernelsPresent(installed)).not.toThrow();
		expect(() => assertManifestEvalsPassed(installed)).not.toThrow();

		const manifest = validManifest();
		expect(validateManifest(manifest).ok).toBe(true);
		shipManifest(manifest);
		expect(() => assertRequiredKernelsPresent(installed)).not.toThrow();
		expect(() => assertManifestEvalsPassed(installed)).not.toThrow();
	});

	it("refuse a manifest whose kernels.required omits a tier kernel", () => {
		const manifest = validManifest();
		manifest.kernels.required = manifest.kernels.required.filter(
			(kernel) => kernel !== "turbo3_tcq",
		);
		// The contract rejects it too, which is why the gate cannot rely on the
		// contract-validated loader.
		expect(validateManifest(manifest).ok).toBe(false);
		shipManifest(manifest);

		let thrown: unknown;
		try {
			assertRequiredKernelsPresent(installed);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(MissingRequiredKernelsError);
		expect((thrown as MissingRequiredKernelsError).missing).toEqual([
			"turbo3_tcq",
		]);
	});

	it("refuse a strict release whose text eval failed", () => {
		const manifest = validManifest();
		manifest.evals.textEval = { score: 0.2, passed: false };
		expect(validateManifest(manifest).ok).toBe(false);
		shipManifest(manifest);

		let thrown: unknown;
		try {
			assertManifestEvalsPassed(installed);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(CandidateModelActivationError);
		expect((thrown as CandidateModelActivationError).failedEvals).toEqual([
			"textEval",
		]);
	});

	it("switchTo refuses the bundle before it reports loading", async () => {
		const manifest = validManifest();
		manifest.kernels.required = manifest.kernels.required.filter(
			(kernel) => kernel !== "turbo3_tcq",
		);
		shipManifest(manifest);

		const coordinator = new ActiveModelCoordinator();
		const states: string[] = [];
		coordinator.subscribe((state) => states.push(state.status));
		await expect(coordinator.switchTo(null, installed)).rejects.toBeInstanceOf(
			MissingRequiredKernelsError,
		);
		expect(states).toEqual([]);
		expect(coordinator.snapshot().status).toBe("idle");
	});
});
