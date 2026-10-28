/** Covers strict-versus-candidate ASR provenance enforcement against real manifest files. */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

	// chmod cannot remove read access for uid 0 or on Windows, where the read
	// succeeds and this assertion would fail despite correct behaviour.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"propagates an unreadable ASR GGUF instead of reporting no model files",
		() => {
			const root = writeManifest({});
			const model = path.join(root, "asr", "phonon-2-fv5.gguf");
			writeFileSync(model, gguf("parakeet-tdt"));
			chmodSync(model, 0o000);
			try {
				// A staged-but-unreadable model is a broken bundle, not a bundle
				// with no ASR artifacts: callers must not report "no ASR model is
				// staged". This is the read behind `Engine.startVoice()`'s
				// `useFfiBackend && bundleHasAsrModelFiles(bundleRoot)` provenance
				// gate (engine.ts) and `Engine.localAsrBlockersForBundle()`, so
				// throwing here fails that call instead of skipping the gate or
				// emitting `files.asr: no ASR model artifacts are staged`.
				expect(() => readGgufArchitecture(model)).toThrow(
					/failed to read GGUF header/,
				);
				expect(() => bundleHasAsrModelFiles(root)).toThrow(
					/failed to read GGUF header/,
				);
			} finally {
				chmodSync(model, 0o600);
			}
		},
	);

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"accepts a readable Parakeet GGUF beside an unreadable one",
		() => {
			const root = writeManifest({});
			const broken = path.join(root, "asr", "a-broken.gguf");
			writeFileSync(broken, gguf("parakeet-tdt"));
			writeFileSync(
				path.join(root, "asr", "z-phonon-2.gguf"),
				gguf("parakeet-tdt"),
			);
			chmodSync(broken, 0o000);
			try {
				// Listing order must not turn a usable bundle into a broken one.
				expect(bundleHasAsrModelFiles(root)).toBe(true);
			} finally {
				chmodSync(broken, 0o600);
			}
		},
	);

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"propagates an unreadable asr/ directory instead of reporting no model",
		() => {
			const root = writeManifest({});
			const asrDir = path.join(root, "asr");
			writeFileSync(
				path.join(asrDir, "phonon-2-fv5.gguf"),
				gguf("parakeet-tdt"),
			);
			chmodSync(asrDir, 0o000);
			try {
				expect(() => bundleHasAsrModelFiles(root)).toThrow(/EACCES/);
			} finally {
				chmodSync(asrDir, 0o700);
			}
		},
	);

	it("propagates an asr/ path that cannot be listed without relying on mode bits", () => {
		const root = writeManifest({});
		// `asr` is a regular file, so the listing fails with ENOTDIR for any uid.
		rmSync(path.join(root, "asr"), { recursive: true, force: true });
		writeFileSync(path.join(root, "asr"), "not a directory");
		expect(() => bundleHasAsrModelFiles(root)).toThrow(/ENOTDIR/);
	});

	it("treats a GGUF deleted mid-scan as absent, not unreadable", () => {
		// The directory listing and the header read are separate syscalls; a file
		// removed between them is legitimately "not there".
		expect(
			readGgufArchitecture(path.join(tmpdir(), "eliza-absent.gguf")),
		).toBeNull();
	});
});
