import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	isKokoroGgufFile,
	kokoroEngineModelDir,
	resolveKokoroEngineConfig,
} from "../kokoro-engine-discovery";

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
			`definitely-not-here-${Date.now()}`,
		);
		expect(resolveKokoroEngineConfig()).toBeNull();
	});

	it("returns null when the model dir exists but no ONNX is staged", () => {
		const fx = makeStaged({ voices: ["af_bella.bin"] });
		cleanups.push(fx.cleanup);
		process.env.ELIZA_KOKORO_MODEL_DIR = fx.root;
		expect(resolveKokoroEngineConfig()).toBeNull();
	});

	it("returns null when no voice .bin is staged", () => {
		const fx = makeStaged({ modelFile: "kokoro-v1.0.onnx" });
		cleanups.push(fx.cleanup);
		process.env.ELIZA_KOKORO_MODEL_DIR = fx.root;
		expect(resolveKokoroEngineConfig()).toBeNull();
	});

	it("returns the canonical Bella default when staged", () => {
		const fx = makeStaged({
			modelFile: "kokoro-v1.0.onnx",
			voices: ["af_same.bin", "af_bella.bin"],
		});
		cleanups.push(fx.cleanup);
		process.env.ELIZA_KOKORO_MODEL_DIR = fx.root;
		const cfg = resolveKokoroEngineConfig();
		expect(cfg).not.toBeNull();
		expect(cfg?.defaultVoiceId).toBe("af_bella");
		expect(cfg?.layout.modelFile).toBe("kokoro-v1.0.onnx");
		expect(cfg?.layout.sampleRate).toBe(24_000);
		expect(cfg?.layout.root).toBe(fx.root);
		expect(cfg?.layout.voicesDir).toBe(path.join(fx.root, "voices"));
	});

	it("falls back to af_bella with a console warning when Samantha preset is missing", () => {
		const fx = makeStaged({
			modelFile: "kokoro-v1.0.onnx",
			voices: ["af_bella.bin"], // Samantha (af_same) absent
		});
		cleanups.push(fx.cleanup);
		process.env.ELIZA_KOKORO_MODEL_DIR = fx.root;

		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (msg: unknown) => {
			warnings.push(String(msg));
		};
		try {
			const cfg = resolveKokoroEngineConfig();
			expect(cfg).not.toBeNull();
			expect(cfg?.defaultVoiceId).toBe("af_bella");
			expect(warnings).toEqual([]);
		} finally {
			console.warn = origWarn;
		}
	});

	it("auto-prefers the INT8 ONNX when it is the only one staged", () => {
		const fx = makeStaged({
			modelFile: "kokoro-v1.0.int8.onnx",
			voices: ["af_bella.bin"],
		});
		cleanups.push(fx.cleanup);
		process.env.ELIZA_KOKORO_MODEL_DIR = fx.root;
		const cfg = resolveKokoroEngineConfig();
		expect(cfg).not.toBeNull();
		expect(cfg?.layout.modelFile).toBe("kokoro-v1.0.int8.onnx");
	});

	it("picks any staged voice when the catalog default is missing", () => {
		const fx = makeStaged({
			modelFile: "model.onnx",
			voices: ["af_sarah.bin"], // not the default `af_bella`
		});
		cleanups.push(fx.cleanup);
		process.env.ELIZA_KOKORO_MODEL_DIR = fx.root;
		const cfg = resolveKokoroEngineConfig();
		expect(cfg).not.toBeNull();
		expect(cfg?.defaultVoiceId).toBe("af_sarah");
	});

	it("honours ELIZA_KOKORO_DEFAULT_VOICE_ID when set + staged", () => {
		const fx = makeStaged({
			modelFile: "model.onnx",
			voices: ["af_bella.bin", "af_nicole.bin"],
		});
		cleanups.push(fx.cleanup);
		process.env.ELIZA_KOKORO_MODEL_DIR = fx.root;
		process.env.ELIZA_KOKORO_DEFAULT_VOICE_ID = "af_nicole";
		const cfg = resolveKokoroEngineConfig();
		expect(cfg).not.toBeNull();
		expect(cfg?.defaultVoiceId).toBe("af_nicole");
	});

	it("returns null when ELIZA_KOKORO_DEFAULT_VOICE_ID is set but the .bin is missing", () => {
		const fx = makeStaged({
			modelFile: "model.onnx",
			voices: ["af_bella.bin"],
		});
		cleanups.push(fx.cleanup);
		process.env.ELIZA_KOKORO_MODEL_DIR = fx.root;
		process.env.ELIZA_KOKORO_DEFAULT_VOICE_ID = "af_nicole";
		expect(resolveKokoroEngineConfig()).toBeNull();
	});

	it("honours ELIZA_KOKORO_MODEL_FILE override when present", () => {
		const fx = makeStaged({
			modelFile: "custom-export.onnx",
			voices: ["af_bella.bin"],
		});
		cleanups.push(fx.cleanup);
		process.env.ELIZA_KOKORO_MODEL_DIR = fx.root;
		process.env.ELIZA_KOKORO_MODEL_FILE = "custom-export.onnx";
		const cfg = resolveKokoroEngineConfig();
		expect(cfg).not.toBeNull();
		expect(cfg?.layout.modelFile).toBe("custom-export.onnx");
	});

	it("reports runtimeKind=onnx for ONNX model files", () => {
		const fx = makeStaged({
			modelFile: "kokoro-v1.0.onnx",
			voices: ["af_bella.bin"],
		});
		cleanups.push(fx.cleanup);
		process.env.ELIZA_KOKORO_MODEL_DIR = fx.root;
		const cfg = resolveKokoroEngineConfig();
		expect(cfg).not.toBeNull();
		expect(cfg?.runtimeKind).toBe("onnx");
	});

	it("reports runtimeKind=gguf for fused-GGUF model files", () => {
		const fx = makeStaged({
			modelFile: "kokoro-82m-v1_0-Q4_K_M.gguf",
			voices: ["af_bella.bin"],
		});
		cleanups.push(fx.cleanup);
		process.env.ELIZA_KOKORO_MODEL_DIR = fx.root;
		const cfg = resolveKokoroEngineConfig();
		expect(cfg).not.toBeNull();
		expect(cfg?.runtimeKind).toBe("gguf");
		expect(cfg?.layout.modelFile).toBe("kokoro-82m-v1_0-Q4_K_M.gguf");
	});

	it("prefers the GGUF over an ONNX when both are staged", () => {
		// Stage both files; the discovery should pick the GGUF since the
		// fused path beats the ORT path on TTFB (see
		// kokoro-llama-cpp-feasibility.md §5).
		const root = mkdtempSync(path.join(os.tmpdir(), "kokoro-engine-test-"));
		writeFileSync(path.join(root, "kokoro-v1.0.onnx"), Buffer.alloc(4));
		writeFileSync(
			path.join(root, "kokoro-82m-v1_0-Q4_K_M.gguf"),
			Buffer.alloc(4),
		);
		mkdirSync(path.join(root, "voices"), { recursive: true });
		writeFileSync(
			path.join(root, "voices", "af_bella.bin"),
			Buffer.alloc(1024),
		);
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));

		process.env.ELIZA_KOKORO_MODEL_DIR = root;
		const cfg = resolveKokoroEngineConfig();
		expect(cfg).not.toBeNull();
		expect(cfg?.runtimeKind).toBe("gguf");
		expect(cfg?.layout.modelFile).toBe("kokoro-82m-v1_0-Q4_K_M.gguf");
	});
});

describe("isKokoroGgufFile", () => {
	it("identifies GGUF model files by extension", () => {
		expect(isKokoroGgufFile("kokoro-82m-v1_0.gguf")).toBe(true);
		expect(isKokoroGgufFile("kokoro-82m-v1_0-Q4_K_M.gguf")).toBe(true);
		expect(isKokoroGgufFile("KOKORO.GGUF")).toBe(true);
	});

	it("identifies ONNX model files as not GGUF", () => {
		expect(isKokoroGgufFile("kokoro-v1.0.onnx")).toBe(false);
		expect(isKokoroGgufFile("model.onnx")).toBe(false);
		expect(isKokoroGgufFile("model_quantized.onnx")).toBe(false);
		expect(isKokoroGgufFile("model_q4.onnx")).toBe(false);
	});
});

describe("kokoroEngineModelDir", () => {
	let origDir: string | undefined;
	beforeEach(() => {
		origDir = process.env.ELIZA_KOKORO_MODEL_DIR;
	});
	afterEach(() => {
		if (origDir === undefined) delete process.env.ELIZA_KOKORO_MODEL_DIR;
		else process.env.ELIZA_KOKORO_MODEL_DIR = origDir;
	});

	it("returns the env override when set", () => {
		process.env.ELIZA_KOKORO_MODEL_DIR = "/tmp/custom-kokoro";
		expect(kokoroEngineModelDir()).toBe("/tmp/custom-kokoro");
	});

	it("returns the canonical home path when env is unset", () => {
		delete process.env.ELIZA_KOKORO_MODEL_DIR;
		expect(kokoroEngineModelDir()).toBe(
			path.join(os.homedir(), ".eliza", "local-inference", "models", "kokoro"),
		);
	});
});
