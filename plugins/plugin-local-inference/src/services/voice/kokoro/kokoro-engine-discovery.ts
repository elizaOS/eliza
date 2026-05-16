/**
 * On-disk discovery for the Kokoro-only voice mode. Probes
 * `~/.eliza/local-inference/models/kokoro/` (or `$ELIZA_KOKORO_MODEL_DIR`)
 * for a model file (preferred order: fused-GGUF → quantized ONNX → fp32
 * ONNX) plus at least one voice `.bin` under `voices/`. Callers can pass an
 * explicit model root to probe bundle-local Kokoro artifacts first. Returns
 * null when anything is missing — no auto-download (AGENTS.md §3).
 *
 * The fused-GGUF path is produced by the elizaOS/llama.cpp fork's
 * `omnivoice/tools/convert_kokoro_to_gguf.py` and runs through the same
 * `libelizainference` shared library that already serves OmniVoice + ASR
 * + VAD. When both an ONNX and a GGUF are staged the discovery prefers
 * the GGUF — the ONNX stays around as a fallback for bundles that
 * pre-date the port (see kokoro-llama-cpp-feasibility.md §5).
 *
 * Env overrides:
 *   ELIZA_KOKORO_MODEL_DIR        — directory root
 *   ELIZA_KOKORO_MODEL_FILE       — exact filename inside the root
 *                                   (ONNX or GGUF; the loader auto-detects)
 *   ELIZA_KOKORO_DEFAULT_VOICE_ID — default voice id (e.g. `af_same`, `af_bella`)
 */

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KokoroModelLayout, KokoroVoicePack } from "./types";
import {
	KOKORO_DEFAULT_VOICE_ID,
	KOKORO_FALLBACK_VOICE_ID,
	KOKORO_VOICE_PACKS,
} from "./voice-presets";

/** Canonical Kokoro v1.0 output sample rate. */
export const KOKORO_DEFAULT_SAMPLE_RATE = 24_000;

/**
 * Filenames the loader will accept if `ELIZA_KOKORO_MODEL_FILE` is unset.
 * Order is preference-first: a fused-GGUF beats an ONNX of the same
 * quantization tier, and within ONNX the int8 export beats fp32.
 *
 * The Q4_K_M GGUF is what the elizaOS/llama.cpp fork's
 * `omnivoice/tools/convert_kokoro_to_gguf.py` produces for shipping
 * tiers; `kokoro-82m-v1_0.gguf` is the unquantized canonical filename
 * the runtime documents at `kokoro-runtime.ts:KOKORO_GGUF_REL_PATH`.
 */
const CANDIDATE_MODEL_FILES: ReadonlyArray<string> = [
	"kokoro-82m-v1_0-Q4_K_M.gguf",
	"kokoro-82m-v1_0.gguf",
	"kokoro-v1.0.int8.onnx",
	"kokoro-v1.0.onnx",
	"model_quantized.onnx",
	"model_q4.onnx",
	"model.onnx",
];

/** True iff the candidate filename routes to the fused GGUF path. */
export function isKokoroGgufFile(filename: string): boolean {
	return /\.gguf$/i.test(filename);
}

export interface KokoroEngineDiscoveryResult {
	layout: KokoroModelLayout;
	/**
	 * Resolved default voice id. Prefers the catalog default
	 * (`KOKORO_DEFAULT_VOICE_ID` = `af_same`, Samantha) when its preset is on
	 * disk; falls back loudly to `KOKORO_FALLBACK_VOICE_ID` (`af_bella`) when
	 * Samantha's preset has not been produced yet; otherwise picks the first
	 * voice pack whose `.bin` is actually staged.
	 */
	defaultVoiceId: string;
	/**
	 * Resolved runtime kind, derived from the model filename. The engine
	 * layer uses this to pick between `KokoroGgufRuntime` (fused FFI /
	 * `/v1/audio/speech`) and `KokoroOnnxRuntime` (onnxruntime-node).
	 *
	 * `gguf` = fused-llama.cpp Kokoro engine (preferred when staged).
	 * `onnx` = legacy onnxruntime-node path (kept for bundles published
	 *          before the port landed).
	 */
	runtimeKind: "gguf" | "onnx";
}

/** Returns the on-disk directory the discovery probes. */
export function kokoroEngineModelDir(rootOverride?: string): string {
	const explicit = rootOverride?.trim();
	if (explicit) return explicit;
	const env = process.env.ELIZA_KOKORO_MODEL_DIR?.trim();
	if (env) return env;
	return path.join(
		os.homedir(),
		".eliza",
		"local-inference",
		"models",
		"kokoro",
	);
}

/**
 * Probe disk for a usable Kokoro layout. Returns null when any required
 * piece is missing — the engine then falls back to its existing behaviour
 * (fused omnivoice or `StubOmniVoiceBackend`).
 */
export function resolveKokoroEngineConfig(
	rootOverride?: string,
): KokoroEngineDiscoveryResult | null {
	const root = kokoroEngineModelDir(rootOverride);
	if (!existsSync(root)) return null;

	const modelFile = resolveModelFile(root);
	if (!modelFile) return null;

	const voicesDir = path.join(root, "voices");
	if (!existsSync(voicesDir)) return null;

	const defaultVoiceId = resolveDefaultVoiceId(voicesDir);
	if (!defaultVoiceId) return null;

	return {
		layout: {
			root,
			modelFile,
			voicesDir,
			sampleRate: KOKORO_DEFAULT_SAMPLE_RATE,
		},
		defaultVoiceId,
		runtimeKind: isKokoroGgufFile(modelFile) ? "gguf" : "onnx",
	};
}

function resolveModelFile(root: string): string | null {
	const env = process.env.ELIZA_KOKORO_MODEL_FILE?.trim();
	if (env) {
		return existsSync(path.join(root, env)) ? env : null;
	}
	for (const candidate of CANDIDATE_MODEL_FILES) {
		if (existsSync(path.join(root, candidate))) return candidate;
	}
	return null;
}

function resolveDefaultVoiceId(voicesDir: string): string | null {
	const env = process.env.ELIZA_KOKORO_DEFAULT_VOICE_ID?.trim();
	if (env) {
		const pack = findVoicePack(env);
		if (pack && existsSync(path.join(voicesDir, pack.file))) return pack.id;
		return null;
	}
	// Prefer the catalog default (Samantha) when its file is staged.
	const defaultPack = findVoicePack(KOKORO_DEFAULT_VOICE_ID);
	if (defaultPack && existsSync(path.join(voicesDir, defaultPack.file))) {
		return defaultPack.id;
	}
	// Samantha preset bytes not staged — fall back to the bundled fallback
	// voice (af_bella). This MUST be loud so operators see the degradation:
	// the canonical default is Samantha and we only land here when the LoRA
	// pipeline has not produced a real `af_same.bin` yet.
	const fallbackPack = findVoicePack(KOKORO_FALLBACK_VOICE_ID);
	if (fallbackPack && existsSync(path.join(voicesDir, fallbackPack.file))) {
		// eslint-disable-next-line no-console -- this is the one place where
		// the runtime must surface the fallback to the operator console; the
		// structured logger is not yet bound at discovery time.
		console.warn(
			`[kokoro] default voice ${KOKORO_DEFAULT_VOICE_ID} preset not staged at ${path.join(voicesDir, defaultPack?.file ?? `${KOKORO_DEFAULT_VOICE_ID}.bin`)} — falling back to ${KOKORO_FALLBACK_VOICE_ID}. Run packages/training/scripts/voice/samantha_lora/RUNBOOK.md to produce a real Samantha preset, or regenerate via plugins/plugin-local-inference/scripts/regenerate-samantha-preset.mjs.`,
		);
		return fallbackPack.id;
	}
	// Otherwise pick the first catalog voice whose file is on disk. This
	// lets operators stage a single voice (any voice) and have it just work.
	const staged = listStagedVoiceIds(voicesDir);
	return staged[0] ?? null;
}

function findVoicePack(id: string): KokoroVoicePack | null {
	return KOKORO_VOICE_PACKS.find((v) => v.id === id) ?? null;
}

function listStagedVoiceIds(voicesDir: string): string[] {
	try {
		const present = new Set(readdirSync(voicesDir));
		return KOKORO_VOICE_PACKS.filter((v) => present.has(v.file)).map(
			(v) => v.id,
		);
	} catch {
		return [];
	}
}
