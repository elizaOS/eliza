import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	isKokoroGgufFile,
	resolveKokoroEngineConfig,
} from "../kokoro-engine-discovery";
import {
	KOKORO_DEFAULT_VOICE_ID,
	KOKORO_FALLBACK_VOICE_ID,
} from "../voice-presets";

function makeStaged(opts: { modelFile?: string; voices?: string[] }): {
	root: string;
	cleanup: () => void;
} {
	const root = mkdtempSync(path.join(os.tmpdir(), "kokoro-engine-test-"));
	if (opts.modelFile) {
		writeFileSync(path.join(root, opts.modelFile), Buffer.alloc(4));
	}
	if (opts.voices && opts.voices.length > 0) {
		mkdirSync(path.join(root, "voices"), { recursive: true });
		for (const v of opts.voices) {
			writeFileSync(path.join(root, "voices", v), Buffer.alloc(1024));
		}
	}
	return {
		root,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

describe("resolveKokoroEngineConfig", () => {
	let cleanups: Array<() => void>;
	let origEnv: Record<string, string | undefined>;
	beforeEach(() => {
		cleanups = [];
		origEnv = {
			ELIZA_KOKORO_MODEL_DIR: process.env.ELIZA_KOKORO_MODEL_DIR,
			ELIZA_KOKORO_MODEL_FILE: process.env.ELIZA_KOKORO_MODEL_FILE,
			ELIZA_KOKORO_DEFAULT_VOICE_ID: process.env.ELIZA_KOKORO_DEFAULT_VOICE_ID,
		};
		delete process.env.ELIZA_KOKORO_MODEL_DIR;
		delete process.env.ELIZA_KOKORO_MODEL_FILE;
		delete process.env.ELIZA_KOKORO_DEFAULT_VOICE_ID;
	});
	afterEach(() => {
		for (const c of cleanups) c();
		for (const [k, v] of Object.entries(origEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	it("returns null when the model dir does not exist", () => {
		process.env.ELIZA_KOKORO_MODEL_DIR = path.join(
			os.tmpdir(),
			"kokoro-missing",
		);
		expect(resolveKokoroEngineConfig()).toBeNull();
	});

	it("returns null when the dir is staged but no GGUF is on disk", () => {
		const fx = makeStaged({ voices: [`${KOKORO_FALLBACK_VOICE_ID}.bin`] });
		cleanups.push(fx.cleanup);
		expect(resolveKokoroEngineConfig(fx.root)).toBeNull();
	});

	it("returns the GGUF layout when the canonical filename is staged", () => {
		const fx = makeStaged({
			modelFile: "kokoro-82m-v1_0.gguf",
			voices: [`${KOKORO_FALLBACK_VOICE_ID}.bin`],
		});
		cleanups.push(fx.cleanup);
		const cfg = resolveKokoroEngineConfig(fx.root);
		expect(cfg).not.toBeNull();
		expect(cfg?.layout.modelFile).toBe("kokoro-82m-v1_0.gguf");
		expect(cfg?.runtimeKind).toBe("gguf");
	});

	it("prefers the Q4_K_M GGUF over the unquantized one when both are staged", () => {
		const fx = makeStaged({
			voices: [`${KOKORO_FALLBACK_VOICE_ID}.bin`],
		});
		cleanups.push(fx.cleanup);
		writeFileSync(
			path.join(fx.root, "kokoro-82m-v1_0-Q4_K_M.gguf"),
			Buffer.alloc(4),
		);
		writeFileSync(path.join(fx.root, "kokoro-82m-v1_0.gguf"), Buffer.alloc(4));
		const cfg = resolveKokoroEngineConfig(fx.root);
		expect(cfg?.layout.modelFile).toBe("kokoro-82m-v1_0-Q4_K_M.gguf");
	});

	it("honours the ELIZA_KOKORO_MODEL_FILE override when present", () => {
		const fx = makeStaged({
			modelFile: "custom-export.gguf",
			voices: [`${KOKORO_FALLBACK_VOICE_ID}.bin`],
		});
		cleanups.push(fx.cleanup);
		process.env.ELIZA_KOKORO_MODEL_FILE = "custom-export.gguf";
		const cfg = resolveKokoroEngineConfig(fx.root);
		expect(cfg?.layout.modelFile).toBe("custom-export.gguf");
	});

	it("returns null when the canonical default voice and the fallback are both missing", () => {
		// Stage the GGUF but no voice file at all.
		const fx = makeStaged({
			modelFile: "kokoro-82m-v1_0.gguf",
			voices: [],
		});
		cleanups.push(fx.cleanup);
		// Voices dir doesn't exist yet — discovery should return null.
		expect(resolveKokoroEngineConfig(fx.root)).toBeNull();
	});

	it("falls back to KOKORO_FALLBACK_VOICE_ID when the default voice file is not staged", () => {
		const fx = makeStaged({
			modelFile: "kokoro-82m-v1_0.gguf",
			voices: [`${KOKORO_FALLBACK_VOICE_ID}.bin`],
		});
		cleanups.push(fx.cleanup);
		const cfg = resolveKokoroEngineConfig(fx.root);
		expect(cfg?.defaultVoiceId).toBe(KOKORO_FALLBACK_VOICE_ID);
	});

	it("uses KOKORO_DEFAULT_VOICE_ID when the corresponding voice file is staged", () => {
		const fx = makeStaged({
			modelFile: "kokoro-82m-v1_0.gguf",
			voices: [
				`${KOKORO_DEFAULT_VOICE_ID}.bin`,
				`${KOKORO_FALLBACK_VOICE_ID}.bin`,
			],
		});
		cleanups.push(fx.cleanup);
		const cfg = resolveKokoroEngineConfig(fx.root);
		expect(cfg?.defaultVoiceId).toBe(KOKORO_DEFAULT_VOICE_ID);
	});
});

describe("isKokoroGgufFile", () => {
	it("identifies .gguf files as GGUF", () => {
		expect(isKokoroGgufFile("kokoro-82m-v1_0.gguf")).toBe(true);
		expect(isKokoroGgufFile("kokoro-82m-v1_0-Q4_K_M.gguf")).toBe(true);
		expect(isKokoroGgufFile("custom-export.GGUF")).toBe(true);
	});

	it("identifies non-.gguf files as not GGUF", () => {
		expect(isKokoroGgufFile("kokoro-v1.0.onnx")).toBe(false);
		expect(isKokoroGgufFile("model.bin")).toBe(false);
		expect(isKokoroGgufFile("model.safetensors")).toBe(false);
	});
});
