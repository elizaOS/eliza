import { describe, expect, it } from "vitest";
import {
	assertRequiredKernelsPresent,
	MissingRequiredKernelsError,
} from "./active-model";
import type { Eliza1Manifest } from "./manifest";
import { REQUIRED_KERNELS_BY_TIER } from "./manifest";
import type { ManifestLoader } from "./ram-budget";
import type { InstalledModel } from "./types";

function installed2b(): InstalledModel {
	return {
		id: "eliza-1-2b",
		displayName: "Eliza-1 2B",
		path: "/tmp/eliza-1-2b/text/model.gguf",
		sizeBytes: 1024,
		installedAt: "2026-05-15T00:00:00.000Z",
		lastUsedAt: null,
		source: "eliza-download",
	};
}

/**
 * `assertRequiredKernelsPresent` reads only `manifest.tier` and
 * `manifest.kernels.required`, so a minimal manifest is sufficient.
 */
function manifestWithKernels(required: readonly string[]): Eliza1Manifest {
	return {
		tier: "2b",
		kernels: { required },
	} as unknown as Eliza1Manifest;
}

describe("assertRequiredKernelsPresent (native/CLAUDE.md §3#5)", () => {
	it("is a no-op when no manifest is present (bare-GGUF/dev path)", () => {
		const noManifest: ManifestLoader = () => null;
		expect(() =>
			assertRequiredKernelsPresent(installed2b(), noManifest),
		).not.toThrow();
	});

	it("is a no-op when the manifest declares every required kernel", () => {
		const ok: ManifestLoader = () =>
			manifestWithKernels(REQUIRED_KERNELS_BY_TIER["2b"]);
		expect(() => assertRequiredKernelsPresent(installed2b(), ok)).not.toThrow();
	});

	it("throws MissingRequiredKernelsError when a required kernel is absent", () => {
		// The 2B tier requires `turboquant_q4`; a manifest that only declares an
		// optional KV kernel is missing it.
		const broken: ManifestLoader = () => manifestWithKernels(["qjl"]);
		let thrown: unknown;
		try {
			assertRequiredKernelsPresent(installed2b(), broken);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(MissingRequiredKernelsError);
		const err = thrown as MissingRequiredKernelsError;
		expect(err.tier).toBe("2b");
		expect(err.missing).toContain("turboquant_q4");
		expect(err.modelId).toBe("eliza-1-2b");
	});

	// AGENTS.md §3 "Gemma 4 exception": the head_dim=128 QJL/PolarQuant KV
	// kernels are OPTIONAL on Gemma (its MQA/SWA/shared-KV geometry never routes
	// through them). Only TurboQuant weight-quant is required. Enforce that
	// contract at the manifest-gate level.
	it("does NOT throw for a Gemma-tier manifest that omits QJL/PolarQuant (Gemma exception)", () => {
		// A real Gemma bundle declares only `turboquant_q4` and ships stock KV —
		// no qjl / polarquant / turbo3_tcq. The gate must accept it.
		const gemma: ManifestLoader = () => manifestWithKernels(["turboquant_q4"]);
		expect(() =>
			assertRequiredKernelsPresent(installed2b(), gemma),
		).not.toThrow();
	});

	it("still throws when TurboQuant is absent even though QJL/Polar are present", () => {
		// The inverse of the Gemma exception: QJL + Polar present but the
		// mandatory weight-quant missing is a hard error — the optional KV
		// kernels can never substitute for the one required kernel.
		const noTurbo: ManifestLoader = () =>
			manifestWithKernels(["qjl", "polarquant", "turbo3_tcq"]);
		let thrown: unknown;
		try {
			assertRequiredKernelsPresent(installed2b(), noTurbo);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(MissingRequiredKernelsError);
		expect((thrown as MissingRequiredKernelsError).missing).toContain(
			"turboquant_q4",
		);
	});
});
