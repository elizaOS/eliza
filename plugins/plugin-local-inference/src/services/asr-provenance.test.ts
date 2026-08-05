/** Covers strict-versus-candidate ASR provenance enforcement against real manifest files. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	bundleHasAsrModelFiles,
	readBundleAsrProvenanceBlockers,
} from "./asr-provenance";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function writeManifest(manifest: unknown): string {
	const root = mkdtempSync(path.join(tmpdir(), "eliza-asr-provenance-"));
	roots.push(root);
	mkdirSync(path.join(root, "asr"));
	writeFileSync(
		path.join(root, "eliza-1.manifest.json"),
		JSON.stringify(manifest),
	);
	return root;
}

describe("bundle ASR provenance", () => {
	it("blocks Qwen ASR in production-shaped manifests", () => {
		const root = writeManifest({
			defaultEligible: true,
			version: "1.0.0",
			lineage: { asr: { base: "ggml-org/Qwen3-ASR" } },
		});

		expect(readBundleAsrProvenanceBlockers(root)).toEqual([
			expect.stringContaining("lineage.asr.base"),
		]);
	});

	it("permits Qwen ASR in an explicitly non-default staging bundle", () => {
		const root = writeManifest({
			defaultEligible: false,
			version: "0.0.1-local.1-gemma4",
			lineage: { asr: { base: "ggml-org/Qwen3-ASR" } },
		});

		expect(readBundleAsrProvenanceBlockers(root)).toEqual([]);
	});

	it("keeps metadata-free manifests behind the production provenance bar", () => {
		const root = writeManifest({
			lineage: { asr: { base: "ggml-org/Qwen3-ASR" } },
		});

		expect(readBundleAsrProvenanceBlockers(root)).toHaveLength(1);
	});
});

describe("bundle ASR artifacts", () => {
	it("requires both the text model and its projector", () => {
		const root = writeManifest({});
		const asrDir = path.join(root, "asr");

		expect(bundleHasAsrModelFiles(root)).toBe(false);
		writeFileSync(path.join(asrDir, "eliza-1-asr-mmproj.gguf"), "projector");
		expect(bundleHasAsrModelFiles(root)).toBe(false);
		writeFileSync(path.join(asrDir, "eliza-1-asr.gguf"), "model");
		expect(bundleHasAsrModelFiles(root)).toBe(true);
	});

	it("does not treat unrelated ASR-directory files as a loadable model", () => {
		const root = writeManifest({});
		writeFileSync(path.join(root, "asr", "README.md"), "not a model");

		expect(bundleHasAsrModelFiles(root)).toBe(false);
	});
});
