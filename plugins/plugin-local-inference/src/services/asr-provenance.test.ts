/** Covers strict-versus-candidate ASR provenance enforcement against real manifest files. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	bundleHasAsrModelFiles,
	readBundleAsrProvenanceBlockers,
	readGgufArchitecture,
} from "./asr-provenance";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

/** A GGUF v3 header whose first entries are a u32 and general.architecture. */
function gguf(architecture: string): Buffer {
	const str = (value: string) => {
		const bytes = Buffer.from(value, "utf8");
		const length = Buffer.alloc(8);
		length.writeBigUInt64LE(BigInt(bytes.length));
		return Buffer.concat([length, bytes]);
	};
	const head = Buffer.alloc(24);
	head.write("GGUF", 0, "ascii");
	head.writeUInt32LE(3, 4);
	head.writeBigUInt64LE(0n, 8);
	head.writeBigUInt64LE(2n, 16);
	const u32 = Buffer.alloc(8);
	u32.writeUInt32LE(4, 0);
	u32.writeUInt32LE(1, 4);
	const stringType = Buffer.alloc(4);
	stringType.writeUInt32LE(8);
	return Buffer.concat([
		head,
		str("general.quantization_version"),
		u32,
		str("general.architecture"),
		stringType,
		str(architecture),
	]);
}

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

	it("does not apply the Eliza-1 lineage block to the staged Phonon-2 ASR", () => {
		// A strict Eliza-1 manifest with no ASR lineage, plus the Phonon-2 GGUF
		// that the Android/AOSP agent stages from the mobile-voice catalog.
		const root = writeManifest({ defaultEligible: true, version: "1.0.0" });
		writeFileSync(
			path.join(root, "asr", "phonon-2-fv5.gguf"),
			gguf("parakeet-tdt"),
		);
		writeFileSync(
			path.join(root, "asr", "voice-files.json"),
			JSON.stringify({
				schema: "eliza-mobile-voice-group-v1",
				dir: "asr",
				files: [{ id: "phonon-2-fv5", role: "asr-parakeet" }],
			}),
		);

		expect(bundleHasAsrModelFiles(root)).toBe(true);
		expect(readBundleAsrProvenanceBlockers(root)).toEqual([]);
	});

	it("keeps metadata-free manifests behind the production provenance bar", () => {
		const root = writeManifest({
			lineage: { asr: { base: "ggml-org/Qwen3-ASR" } },
		});

		expect(readBundleAsrProvenanceBlockers(root)).toHaveLength(1);
	});

	it("propagates a corrupt manifest instead of reporting no provenance blockers", () => {
		const root = mkdtempSync(path.join(tmpdir(), "eliza-asr-provenance-"));
		roots.push(root);
		writeFileSync(
			path.join(root, "eliza-1.manifest.json"),
			'{"defaultEligible":true,',
		);

		expect(() => readBundleAsrProvenanceBlockers(root)).toThrow(
			/failed to read ASR provenance manifest/,
		);
	});

	it("treats a missing manifest as no provenance claim", () => {
		const root = mkdtempSync(path.join(tmpdir(), "eliza-asr-provenance-"));
		roots.push(root);

		expect(readBundleAsrProvenanceBlockers(root)).toEqual([]);
	});
});

describe("bundle ASR artifacts", () => {
	it("does not accept a text model + projector pair", () => {
		const root = writeManifest({});
		const asrDir = path.join(root, "asr");

		expect(bundleHasAsrModelFiles(root)).toBe(false);
		writeFileSync(path.join(asrDir, "eliza-1-asr-mmproj.gguf"), "projector");
		writeFileSync(path.join(asrDir, "eliza-1-asr.gguf"), gguf("qwen3"));
		expect(bundleHasAsrModelFiles(root)).toBe(false);
	});

	it("accepts a Parakeet-TDT GGUF (Phonon-2) on its own", () => {
		const root = writeManifest({});
		const asrDir = path.join(root, "asr");
		writeFileSync(path.join(asrDir, "phonon-2-fv5.gguf"), gguf("parakeet-tdt"));
		expect(readGgufArchitecture(path.join(asrDir, "phonon-2-fv5.gguf"))).toBe(
			"parakeet-tdt",
		);
		expect(bundleHasAsrModelFiles(root)).toBe(true);
		// A GGUF with another architecture is not an ASR model.
		const other = writeManifest({});
		writeFileSync(path.join(other, "asr", "qwen.gguf"), gguf("qwen3"));
		expect(bundleHasAsrModelFiles(other)).toBe(false);
		writeFileSync(path.join(other, "asr", "not-gguf.gguf"), "GGUX");
		expect(readGgufArchitecture(path.join(other, "asr", "not-gguf.gguf"))).toBe(
			null,
		);
	});

	it("does not treat unrelated ASR-directory files as a loadable model", () => {
		const root = writeManifest({});
		writeFileSync(path.join(root, "asr", "README.md"), "not a model");

		expect(bundleHasAsrModelFiles(root)).toBe(false);
	});
});
