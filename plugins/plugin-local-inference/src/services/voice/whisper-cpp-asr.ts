/**
 * whisper.cpp ASR decoder for the voice transcriber chain.
 *
 * Replaces the previous OpenVINO Whisper Python-worker path. Loads
 * `libwhisper_eliza_adapter.{so,dylib,dll}` (built by
 * `plugins/plugin-local-inference/native/build-whisper.mjs`) via `bun:ffi`
 * and exposes a `StreamingPcmDecoder` whose shape matches the previous
 * OpenVINO decoder, so the `OpenVinoStreamingTranscriber` sliding-window
 * harness in `transcriber.ts` can drive it unchanged.
 *
 * The adapter library wraps whisper.cpp's C API (`whisper_init_*` /
 * `whisper_full` / `whisper_full_get_segment_text` / `whisper_free`) behind
 * a flat three-call C ABI so bun:ffi only binds POD-argument functions:
 *
 *   whisper_eliza_open(path, n_threads, use_gpu) -> handle
 *   whisper_eliza_transcribe(handle, pcm, n_samples, lang, translate,
 *                            out_buf, out_buf_size, out_written) -> int
 *   whisper_eliza_close(handle)
 *
 * Available on every arch we ship to (x86_64, arm64, riscv64) because the
 * underlying GGML + whisper.cpp build is the same cross-compile matrix
 * `compile-libllama.mjs` / `build-omnivoice.mjs` use — no arch gate.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "@elizaos/core";

import type { StreamingPcmDecoder } from "./types";

/** Default greedy-decode buffer size for the C ABI out_text param. */
const TRANSCRIPT_BUFFER_BYTES = 16 * 1024;

/** ABI version the JS side was authored against. Must match the C header. */
export const WHISPER_ELIZA_ADAPTER_ABI_VERSION = 1 as const;

/** C-side return codes. Mirrors `whisper_eliza_adapter.h`. */
const WEA_OK = 0;
const WEA_ERR_BUFFER_TOO_SMALL = -4;

/**
 * Resolved runtime: the libwhisper_eliza_adapter path + the GGUF/GGML
 * whisper model file. Returns `null` when any required piece is missing;
 * the caller should fall through to the next transcriber tier (or surface
 * `AsrUnavailableError`).
 */
export interface WhisperCppRuntime {
	libraryPath: string;
	modelPath: string;
	language: string;
	translate: boolean;
	nThreads: number;
	useGpu: boolean;
}

/**
 * Decode language for the whisper greedy sampler. `"auto"` defers to
 * whisper.cpp's language detection (slightly slower first decode).
 */
export const WHISPER_DEFAULT_LANGUAGE = "en";

function firstExisting(
	candidates: ReadonlyArray<string | null | undefined>,
): string | null {
	for (const c of candidates) {
		if (c && existsSync(c)) return c;
	}
	return null;
}

function platformLibName(): string {
	if (process.platform === "darwin") return "libwhisper_eliza_adapter.dylib";
	if (process.platform === "win32") return "whisper_eliza_adapter.dll";
	return "libwhisper_eliza_adapter.so";
}

/** Locate `libwhisper_eliza_adapter` on disk. */
function resolveLibraryPath(): string | null {
	const env = process.env.ELIZA_WHISPER_LIBRARY?.trim();
	if (env) return existsSync(env) ? env : null;
	const here = path.dirname(new URL(import.meta.url).pathname);
	const libName = platformLibName();
	return firstExisting([
		// Repo-local host build via plugin-local-inference/native/build-whisper.mjs.
		// This file ships at <plugin>/src/services/voice (local mode) and
		// <plugin>/dist/services/voice (packages mode) — both three levels under
		// the plugin root, so three "../" reach it before native/build-whisper.
		path.resolve(here, "..", "..", "..", "native", "build-whisper", libName),
		// User-installed location populated by ensure-whisper-gguf.sh / installer.
		path.join(resolveStateDir(), "local-inference", "bin", "whisper", libName),
		// Linux per-host packaged location.
		`/usr/local/lib/${libName}`,
		`/usr/lib/${libName}`,
	]);
}

/** Locate the whisper GGUF/GGML model. */
function resolveModelPath(): string | null {
	const env = process.env.ELIZA_WHISPER_MODEL?.trim();
	if (env) return existsSync(env) ? env : null;
	const modelName = process.env.ELIZA_WHISPER_MODEL_NAME?.trim() || "base.en";
	const cache = process.env.ELIZA_WHISPER_MODEL_DIR?.trim();
	const candidates: string[] = [];
	if (cache) candidates.push(path.join(cache, `ggml-${modelName}.bin`));
	candidates.push(
		path.join(
			os.homedir(),
			".cache",
			"eliza",
			"whisper",
			`ggml-${modelName}.bin`,
		),
		path.join(
			resolveStateDir(),
			"local-inference",
			"whisper",
			`ggml-${modelName}.bin`,
		),
	);
	return firstExisting(candidates);
}

function readIntegerEnv(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (Number.isFinite(parsed) && parsed > 0) return parsed;
	return fallback;
}

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "1" ||
		normalized === "true" ||
		normalized === "yes" ||
		normalized === "on"
	) {
		return true;
	}
	if (
		normalized === "0" ||
		normalized === "false" ||
		normalized === "no" ||
		normalized === "off" ||
		normalized === ""
	) {
		return false;
	}
	return fallback;
}

export function resolveWhisperCppRuntime(): WhisperCppRuntime | null {
	const libraryPath = resolveLibraryPath();
	if (!libraryPath) return null;
	const modelPath = resolveModelPath();
	if (!modelPath) return null;
	return {
		libraryPath,
		modelPath,
		language:
			process.env.ELIZA_WHISPER_LANGUAGE?.trim() || WHISPER_DEFAULT_LANGUAGE,
		translate: readBooleanEnv(process.env.ELIZA_WHISPER_TRANSLATE, false),
		nThreads: readIntegerEnv(
			process.env.ELIZA_WHISPER_THREADS,
			Math.max(1, Math.floor((os.cpus()?.length ?? 4) / 2)),
		),
		useGpu: readBooleanEnv(process.env.ELIZA_WHISPER_USE_GPU, true),
	};
}

/* -------------------------------------------------------------------------- *
 *  bun:ffi loader
 * -------------------------------------------------------------------------- */

interface WhisperBindings {
	whisper_eliza_abi_version: () => number;
	whisper_eliza_open: (
		path: unknown,
		nThreads: number,
		useGpu: number,
	) => bigint;
	whisper_eliza_transcribe: (
		session: bigint,
		pcm: unknown,
		nSamples: bigint | number,
		language: unknown,
		translate: number,
		outText: unknown,
		outTextSize: bigint | number,
		outWritten: unknown,
	) => number;
	whisper_eliza_close: (session: bigint) => void;
}

interface BunFfiLib {
	symbols: WhisperBindings;
	close(): void;
}

interface BunFfiModule {
	dlopen(
		path: string,
		def: Record<string, { args: number[]; returns: number }>,
	): BunFfiLib;
	ptr(value: ArrayBufferView): unknown;
	FFIType: {
		ptr: number;
		i32: number;
		u64: number;
		usize: number;
		void: number;
	};
}

function isBunRuntime(): boolean {
	return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

function loadBunFfiModule(): BunFfiModule {
	const req: ((id: string) => unknown) | undefined = (
		globalThis as { Bun?: { __require?: (id: string) => unknown } }
	).Bun?.__require;
	if (typeof req === "function") {
		return req("bun:ffi") as BunFfiModule;
	}
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mod = require("node:module") as {
		createRequire: (filename: string) => (id: string) => unknown;
	};
	const r = mod.createRequire(import.meta.url);
	return r("bun:ffi") as BunFfiModule;
}

interface LoadedLibrary {
	bindings: WhisperBindings;
	close(): void;
	ptr(value: ArrayBufferView): unknown;
}

function loadLibrary(libraryPath: string): LoadedLibrary {
	if (!isBunRuntime()) {
		throw new Error(
			"[whisper-cpp-asr] bun:ffi is required; current runtime is not Bun",
		);
	}
	const ffi = loadBunFfiModule();
	const T = ffi.FFIType;
	const lib = ffi.dlopen(libraryPath, {
		whisper_eliza_abi_version: { args: [], returns: T.i32 },
		whisper_eliza_open: {
			args: [T.ptr, T.i32, T.i32],
			returns: T.u64,
		},
		whisper_eliza_transcribe: {
			args: [T.u64, T.ptr, T.usize, T.ptr, T.i32, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
		whisper_eliza_close: { args: [T.u64], returns: T.void },
	});
	return {
		bindings: lib.symbols,
		close: () => lib.close(),
		ptr: (v) => ffi.ptr(v),
	};
}

/* -------------------------------------------------------------------------- *
 *  Decoder factory
 * -------------------------------------------------------------------------- */

interface SessionState {
	lib: LoadedLibrary;
	handle: bigint;
	language: string;
	translate: boolean;
	disposed: boolean;
}

function nulTerminate(s: string): Uint8Array {
	return new TextEncoder().encode(`${s}\0`);
}

function decodeNulTerminatedUtf8(buf: Uint8Array, n: number): string {
	const clamped = Math.min(n, buf.length);
	return new TextDecoder("utf-8").decode(buf.subarray(0, clamped));
}

/**
 * Open a libwhisper_eliza_adapter session and return a `StreamingPcmDecoder`
 * bound to it plus a dispose hook the caller wires into transcriber teardown.
 *
 * Each `decoder(pcm16k)` call runs a synchronous greedy decode over the
 * whole supplied PCM window. The TS-side sliding-window harness in
 * `OpenVinoStreamingTranscriber` (now misnomered — feeds whisper.cpp here)
 * keeps each window bounded to a few seconds, which is well within the
 * realtime budget on CPU.
 */
export function makeWhisperCppDecoder(runtime: WhisperCppRuntime): {
	decoder: StreamingPcmDecoder;
	dispose: () => void;
} {
	const lib = loadLibrary(runtime.libraryPath);

	const abi = lib.bindings.whisper_eliza_abi_version();
	if (abi !== WHISPER_ELIZA_ADAPTER_ABI_VERSION) {
		lib.close();
		throw new Error(
			`[whisper-cpp-asr] ABI mismatch: binding expected v${WHISPER_ELIZA_ADAPTER_ABI_VERSION}, library reports v${abi}. Rebuild libwhisper_eliza_adapter via plugins/plugin-local-inference/native/build-whisper.mjs.`,
		);
	}

	const pathBuf = nulTerminate(runtime.modelPath);
	const handle = lib.bindings.whisper_eliza_open(
		lib.ptr(pathBuf),
		runtime.nThreads,
		runtime.useGpu ? 1 : 0,
	);
	if (handle === 0n) {
		lib.close();
		throw new Error(
			`[whisper-cpp-asr] whisper_eliza_open returned NULL for model=${runtime.modelPath}. Check the GGML/GGUF file is readable and matches a whisper.cpp release (see https://huggingface.co/ggerganov/whisper.cpp).`,
		);
	}

	const state: SessionState = {
		lib,
		handle,
		language: runtime.language,
		translate: runtime.translate,
		disposed: false,
	};

	// Chain serialization mirrors `openvino-whisper-asr.ts` — the adapter's C
	// side already takes a mutex, but serialising on the JS side too prevents
	// unnecessary contention and keeps deterministic ordering for callers.
	let chain: Promise<void> = Promise.resolve();

	const decoder: StreamingPcmDecoder = (
		pcm16k: Float32Array,
	): Promise<string> => {
		if (state.disposed) {
			return Promise.reject(
				new Error("[whisper-cpp-asr] decoder has been disposed"),
			);
		}
		const prev = chain;
		const work = (async (): Promise<string> => {
			await prev;
			if (state.disposed) {
				throw new Error("[whisper-cpp-asr] decoder has been disposed");
			}
			const langBuf = nulTerminate(state.language);
			let outBuf = new Uint8Array(TRANSCRIPT_BUFFER_BYTES);
			const writtenBuf = new BigUint64Array(1);
			let rc = state.lib.bindings.whisper_eliza_transcribe(
				state.handle,
				state.lib.ptr(pcm16k),
				BigInt(pcm16k.length),
				state.lib.ptr(langBuf),
				state.translate ? 1 : 0,
				state.lib.ptr(outBuf),
				BigInt(outBuf.length),
				state.lib.ptr(writtenBuf),
			);
			if (rc === WEA_ERR_BUFFER_TOO_SMALL) {
				// Adapter reports the needed size in writtenBuf — re-allocate and retry.
				const need = Number(writtenBuf[0]);
				outBuf = new Uint8Array(Math.max(need + 1, outBuf.length * 2));
				rc = state.lib.bindings.whisper_eliza_transcribe(
					state.handle,
					state.lib.ptr(pcm16k),
					BigInt(pcm16k.length),
					state.lib.ptr(langBuf),
					state.translate ? 1 : 0,
					state.lib.ptr(outBuf),
					BigInt(outBuf.length),
					state.lib.ptr(writtenBuf),
				);
			}
			if (rc !== WEA_OK) {
				throw new Error(
					`[whisper-cpp-asr] whisper_eliza_transcribe returned ${rc} (n_samples=${pcm16k.length})`,
				);
			}
			return decodeNulTerminatedUtf8(outBuf, Number(writtenBuf[0]));
		})();
		chain = work.then(
			() => undefined,
			() => undefined,
		);
		return work;
	};

	function dispose(): void {
		if (state.disposed) return;
		state.disposed = true;
		try {
			state.lib.bindings.whisper_eliza_close(state.handle);
		} catch {
			/* close hooks are best-effort */
		}
		try {
			state.lib.close();
		} catch {
			/* dlclose is best-effort */
		}
	}

	return { decoder, dispose };
}
