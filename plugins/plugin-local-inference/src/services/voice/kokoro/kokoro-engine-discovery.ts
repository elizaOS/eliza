/**
 * On-disk discovery for the Kokoro-only voice mode. Probes
 * `<stateDir>/local-inference/models/kokoro/` (or `$ELIZA_KOKORO_MODEL_DIR`)
 * for a Kokoro GGUF model file plus at least one voice `.bin` under
 * `voices/`. Callers can pass an explicit model root to probe bundle-local
 * Kokoro artifacts first. Returns null when anything is missing — no
 * auto-download (AGENTS.md §3). GGUF-only: the ONNX path has been retired
 * (see `runtimeKind` below).
 *
 * TRANSPORT NOTE — Kokoro synthesizes in-process through the fused
 * `libelizainference` handle (`eliza_inference_kokoro_*`, added at ABI v10), the same
 * dlopen()-ed lib as OmniVoice. The fork links Kokoro's native engine
 * (`tools/kokoro/kokoro_lib`, its own GGUF reader + iSTFT decoder) into the
 * fused build, and `KokoroFfiRuntime` drives it via `kokoroLoad` /
 * `kokoroSynthesize`. This is the canonical path on every platform and the
 * only one that ships on iOS / Google Play (those forbid the app opening a
 * local TCP socket). The legacy `KokoroGgufRuntime` — POST `/v1/audio/speech`
 * on a Kokoro-capable llama-server (the MTP gateway launched with
 * `--kokoro-model`) — stays as an explicit dev/desktop opt-in
 * (`KOKORO_BACKEND=fork`) and is never resolved on the mobile path. The GGUF
 * is produced by the fork's `tools/kokoro/convert_kokoro_pth_to_gguf.py`.
 *
 * Env overrides:
 *   ELIZA_KOKORO_MODEL_DIR        — directory root
 *   ELIZA_KOKORO_MODEL_FILE       — exact filename inside the root
 *                                   (ONNX or GGUF; the loader auto-detects)
 *   ELIZA_KOKORO_DEFAULT_VOICE_ID — default voice id (e.g. `af_same`, `af_bella`)
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { elizaModelsDir } from "../../paths";
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
 * Prefer the quantized GGUF when both files are staged, but the published
 * Eliza-1 bundle currently uses the canonical `kokoro-82m-v1_0.gguf` name.
 */
const CANDIDATE_MODEL_FILES: ReadonlyArray<string> = [
	"kokoro-82m-v1_0-Q4_K_M.gguf",
	"kokoro-82m-v1_0.gguf",
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
	 * Resolved runtime kind. Always `"gguf"` — only GGUF model files are
	 * accepted by the discovery (ONNX paths have been retired).
	 */
	runtimeKind: "gguf";
}

/** Returns the on-disk directory the discovery probes. */
export function kokoroEngineModelDir(rootOverride?: string): string {
	const explicit = rootOverride?.trim();
	if (explicit) return explicit;
	const env = process.env.ELIZA_KOKORO_MODEL_DIR?.trim();
	if (env) return env;
	return path.join(elizaModelsDir(), "kokoro");
}

/**
 * Probe disk for a usable Kokoro layout. Returns null when any required
 * piece is missing — the engine then falls back to its existing behaviour
 * (fused omnivoice or `StubTtsBackend`).
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
		runtimeKind: "gguf",
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
		// structured logger is unavailable at discovery time.
		console.warn(
			`[kokoro] default voice ${KOKORO_DEFAULT_VOICE_ID} preset not staged at ${path.join(voicesDir, defaultPack?.file ?? `${KOKORO_DEFAULT_VOICE_ID}.bin`)} — falling back to ${KOKORO_FALLBACK_VOICE_ID}. Run packages/training/scripts/voice/samantha_lora/RUNBOOK.md to produce a real Samantha preset.`,
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
