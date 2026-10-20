/**
 * Covers `EngineVoiceBridge.start()`'s ASR-bundle probe.
 *
 * `<bundle>/asr` being absent is legitimately "no ASR staged here", so the
 * bridge reports `asrAvailable === false`. A directory that IS present but
 * cannot be listed (`EACCES`, `EIO`, `EMFILE`) is a broken bundle: flattening
 * it into the same `false` made startup succeed as if nothing were staged and
 * made `createStreamingTranscriber()` throw `AsrUnavailableError("... no
 * bundled ASR model ...")` for a bundle that stages one.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineVoiceBridge } from "./engine-bridge";
import { writeVoicePresetFile } from "./voice-preset-format";

let bundleRoot: string;

function writePresetBundle(root: string): void {
	mkdirSync(path.join(root, "cache"), { recursive: true });
	const embedding = new Float32Array(16);
	for (let i = 0; i < embedding.length; i++) embedding[i] = (i + 1) / 100;
	writeFileSync(
		path.join(root, "cache", "voice-preset-default.bin"),
		Buffer.from(writeVoicePresetFile({ embedding, phrases: [] })),
	);
}

beforeEach(() => {
	bundleRoot = mkdtempSync(path.join(tmpdir(), "eliza-asr-probe-"));
	writePresetBundle(bundleRoot);
});

afterEach(() => {
	rmSync(bundleRoot, { recursive: true, force: true });
});

describe("EngineVoiceBridge ASR bundle probe", () => {
	it("treats an absent asr/ directory as no ASR staged", () => {
		const bridge = EngineVoiceBridge.start({
			bundleRoot,
			useFfiBackend: false,
		});

		expect(bridge.asrAvailable).toBe(false);
	});

	// chmod cannot remove read access for uid 0 or on Windows, where the
	// listing succeeds and this assertion would fail despite correct behaviour.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"fails startup when asr/ exists but cannot be listed",
		() => {
			const asrDir = path.join(bundleRoot, "asr");
			mkdirSync(asrDir, { recursive: true });
			writeFileSync(path.join(asrDir, "phonon-2-fv5.gguf"), "GGUF");
			chmodSync(asrDir, 0o000);
			try {
				// A staged-but-unlistable ASR directory must not be reported as
				// "no ASR model": start() has to fail with the read error so the
				// operator sees a broken bundle instead of a bundle that simply
				// carries no decoder, which is what `asrAvailable === false`
				// (and the downstream `AsrUnavailableError`) implies.
				expect(() =>
					EngineVoiceBridge.start({
						bundleRoot,
						useFfiBackend: false,
					}),
				).toThrow(/cannot be listed/);
			} finally {
				chmodSync(asrDir, 0o700);
			}
		},
	);
});
