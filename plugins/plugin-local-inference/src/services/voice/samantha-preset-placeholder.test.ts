import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	detectSamanthaPlaceholder,
	SAMANTHA_PLACEHOLDER_BYTE_LENGTH,
} from "./samantha-preset-placeholder";
import {
	VOICE_PRESET_MAGIC,
	VOICE_PRESET_VERSION_V1,
	writeVoicePresetFileV2,
} from "./voice-preset-format";

function writeLegacyV1Placeholder(): Uint8Array {
	const blob = new Uint8Array(SAMANTHA_PLACEHOLDER_BYTE_LENGTH);
	const view = new DataView(blob.buffer);
	view.setUint32(0, VOICE_PRESET_MAGIC, true);
	view.setUint32(4, VOICE_PRESET_VERSION_V1, true);
	view.setUint32(8, 24, true);
	view.setUint32(12, 256 * 4, true);
	view.setUint32(16, 24 + 256 * 4, true);
	view.setUint32(20, 4, true);
	view.setUint32(24 + 256 * 4, 0, true);
	return blob;
}

describe("detectSamanthaPlaceholder", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), "samantha-placeholder-test-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports `missing` when the file does not exist", () => {
		const out = detectSamanthaPlaceholder(path.join(dir, "absent.bin"));
		expect(out.kind).toBe("missing");
	});

	it("reports `real-preset` for files of the wrong byte length", () => {
		const p = path.join(dir, "tiny.bin");
		writeFileSync(p, Buffer.alloc(64));
		const out = detectSamanthaPlaceholder(p);
		expect(out.kind).toBe("real-preset");
		if (out.kind === "real-preset") {
			expect(out.reason).toMatch(/byte-length/);
		}
	});

	it("does not report a differently-shaped v2 zero preset as the shipped placeholder", () => {
		// Current v2 serialization has a different byte layout than the
		// 1052-byte I-wave placeholder staged in installed bundles.
		const blob = writeVoicePresetFileV2({
			embedding: new Float32Array(256), // all zeros
			phrases: [],
		});
		expect(blob.byteLength).not.toBe(SAMANTHA_PLACEHOLDER_BYTE_LENGTH);
		const p = path.join(dir, "voice-preset-default.bin");
		writeFileSync(p, blob);
		const out = detectSamanthaPlaceholder(p);
		expect(out.kind).toBe("real-preset");
	});

	it("reports `placeholder` for the legacy v1 zero-fill blob staged in current bundles", () => {
		const blob = writeLegacyV1Placeholder();
		expect(blob.byteLength).toBe(SAMANTHA_PLACEHOLDER_BYTE_LENGTH);
		const p = path.join(dir, "legacy-v1-placeholder.bin");
		writeFileSync(p, blob);
		const out = detectSamanthaPlaceholder(p);
		expect(out.kind).toBe("placeholder");
	});

	it("reports `real-preset` when the embedding has any non-zero sample", () => {
		const emb = new Float32Array(256);
		emb[42] = 0.001;
		const blob = writeVoicePresetFileV2({ embedding: emb, phrases: [] });
		const p = path.join(dir, "almost.bin");
		writeFileSync(p, blob);
		const out = detectSamanthaPlaceholder(p);
		expect(out.kind).toBe("real-preset");
	});

	it("reports `real-preset` when ref_audio_tokens or ref_text are populated", () => {
		const blob = writeVoicePresetFileV2({
			embedding: new Float32Array(256),
			phrases: [],
			refText: "Hello there.",
		});
		const p = path.join(dir, "with-ref.bin");
		writeFileSync(p, blob);
		const out = detectSamanthaPlaceholder(p);
		expect(out.kind).toBe("real-preset");
	});
});
