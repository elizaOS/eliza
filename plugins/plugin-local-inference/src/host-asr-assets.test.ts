import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PHONON_ASR_ASSETS, selectHostAsrAssets } from "./host-asr-assets";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function bundle(files: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "host-asr-assets-"));
	roots.push(root);
	mkdirSync(join(root, "asr"), { recursive: true });
	for (const file of files) writeFileSync(join(root, file), "x");
	return root;
}

const phonon = "asr/phonon-2-fv5.gguf";
const retiredPair = ["asr/eliza-1-asr.gguf", "asr/eliza-1-asr-mmproj.gguf"];

describe("host ASR asset selection", () => {
	it("selects the pinned Phonon-2 GGUF", () => {
		const assets = selectHostAsrAssets(bundle([phonon]), {});
		expect(assets).toBe(PHONON_ASR_ASSETS);
		expect(assets[0]?.sha256).toBe(
			"c0f6ad42f0a5b481904416077dde0a1a78e5b8642295fdf2356ace822588c3df",
		);
		expect(assets[0]?.bytes).toBe(208_932_352);
		expect(
			selectHostAsrAssets(bundle([phonon]), { ELIZA_ASR_BACKEND: "ggml" }),
		).toBe(PHONON_ASR_ASSETS);
		expect(
			selectHostAsrAssets(bundle([phonon]), {
				ELIZA_ASR_BACKEND: "GGML",
			}),
		).toBe(PHONON_ASR_ASSETS);
	});

	it("refuses a bundle that has no Phonon-2 GGUF", () => {
		// The retired text + mmproj pair is not a fallback.
		expect(() => selectHostAsrAssets(bundle(retiredPair), {})).toThrow(
			"Ambiguous speech ASR model",
		);
		expect(() => selectHostAsrAssets(bundle([]), {})).toThrow(
			"Ambiguous speech ASR model",
		);
	});

	it("refuses overrides the native ASR registry cannot serve", () => {
		for (const value of [
			"qwen3",
			"mtmd",
			"whisper",
			"parakeet",
			"auto",
			" ggml ",
		]) {
			expect(() =>
				selectHostAsrAssets(bundle([phonon]), { ELIZA_ASR_BACKEND: value }),
			).toThrow("Invalid speech ASR backend");
		}
	});

	it("matches native global fallback and per-operation precedence", () => {
		const root = bundle([phonon]);
		expect(() =>
			selectHostAsrAssets(root, { ELIZA_BACKEND: "parakeet" }),
		).toThrow("Invalid speech ASR backend");
		expect(() =>
			selectHostAsrAssets(root, {
				ELIZA_ASR_BACKEND: "",
				ELIZA_BACKEND: "auto",
			}),
		).toThrow("Invalid speech ASR backend");
		for (const value of [
			"ggml",
			"llama.cpp",
			"llamacpp",
			"llama",
			"intree",
			"default",
		]) {
			expect(selectHostAsrAssets(root, { ELIZA_BACKEND: value })).toBe(
				PHONON_ASR_ASSETS,
			);
			expect(
				selectHostAsrAssets(root, {
					ELIZA_ASR_BACKEND: value,
					ELIZA_BACKEND: "parakeet",
				}),
			).toBe(PHONON_ASR_ASSETS);
		}
	});

	it("refuses an asr/ directory with GGUFs it did not verify", () => {
		expect(() =>
			selectHostAsrAssets(bundle([phonon, ...retiredPair]), {}),
		).toThrow("Ambiguous speech ASR model");
		const root = bundle([phonon]);
		mkdirSync(join(root, "asr", "nested"));
		writeFileSync(join(root, "asr", "nested", "other.gguf"), "x");
		expect(() => selectHostAsrAssets(root, {})).toThrow(
			"Ambiguous speech ASR model",
		);
	});
});
