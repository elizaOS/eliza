/** Verifies that local ASR provenance is explicit, readable, and Gemma-compatible. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	collectQwenAsrProvenanceBlockers,
	readBundleAsrProvenanceBlockers,
} from "./asr-provenance";

describe("ASR provenance", () => {
	it("names Qwen lineage and source repositories", () => {
		expect(
			collectQwenAsrProvenanceBlockers({
				lineage: { asr: { base: "ggml-org/Qwen3-ASR-0.6B" } },
				provenance: {
					sourceModels: { asr: { repo: "Qwen/Qwen3-ASR" } },
				},
			}),
		).toEqual([
			expect.stringContaining("lineage.asr.base"),
			expect.stringContaining("provenance.sourceModels.asr.repo"),
		]);
	});

	it("accepts explicit Gemma ASR provenance", () => {
		expect(
			collectQwenAsrProvenanceBlockers({
				lineage: { asr: { base: "elizaOS/Gemma-ASR" } },
			}),
		).toEqual([]);
	});

	it("surfaces missing and malformed bundle manifests", () => {
		const missing = mkdtempSync(path.join(os.tmpdir(), "eliza-asr-missing-"));
		const malformed = mkdtempSync(
			path.join(os.tmpdir(), "eliza-asr-malformed-"),
		);
		try {
			for (const bundleRoot of [missing, malformed]) {
				if (bundleRoot === malformed) {
					writeFileSync(
						path.join(malformed, "eliza-1.manifest.json"),
						"not json",
					);
				}
				try {
					readBundleAsrProvenanceBlockers(bundleRoot);
					throw new Error("expected provenance read to fail");
				} catch (error) {
					expect(error).toBeInstanceOf(ElizaError);
					expect((error as ElizaError).code).toBe(
						"LOCAL_ASR_MANIFEST_UNREADABLE",
					);
					expect((error as ElizaError).cause).toBeDefined();
				}
			}
		} finally {
			rmSync(missing, { recursive: true, force: true });
			rmSync(malformed, { recursive: true, force: true });
		}
	});
});
