/**
 * Desktop production `FfiBackendRuntime` over the FUSED `libelizainference`.
 *
 * The sibling of `desktop-ffi-backend-runtime.ts` (which drives the separate
 * libllama + eliza-llama-shim pair). This runtime routes desktop text
 * generation through the now-feature-complete fused library — the same
 * `eliza_inference_llm_stream_*` ABI (v8) the voice subsystem already loads —
 * so text + voice share one native lib, one GGML pin, and one resident text
 * model.
 *
 * Why this exists separately from the libllama runtime:
 *   - The fused lib's `eliza_inference_llm_stream_open` loads the bundle's text
 *     GGUF (`<bundleRoot>/text/*.gguf`) and applies same-file MTP speculative
 *     decoding + KV-cache quant + per-load GPU layers natively (ABI v8). The
 *     libllama path does the same through the shim; this routes through the
 *     fused lib instead, gated on the v8 capability probes
 *     (`llmStreamSupported && llmMtpSupported && llmKvQuantSupported`).
 *   - A fused lib that lacks MTP / KV-quant (a v7 build) MUST be refused so the
 *     engine falls back to libllama (which has those optimizations) — never to
 *     an unoptimized fused loop. `supported()` enforces that refusal.
 *
 * Tokenization seam:
 *   - The fused `libelizainference` statically links llama.cpp; it exports no
 *     `llama_*` symbols and no `eliza_inference_llm_stream_tokenize`. The
 *     `FfiStreamingRunner` consumes pre-tokenized `Int32Array`, so this runtime
 *     stands up a libllama sidecar (`loadDesktopLlama`) on the SAME text GGUF,
 *     used only for `tokenize()`. Both loads point at the identical file, so
 *     the vocab matches exactly. The sidecar is loaded with `gpuLayers: 0` and
 *     a tiny context — `mmap` shares the read-only weight pages with the fused
 *     load via the OS page cache, so the real RAM overhead is just the small
 *     tokenizer context, not a second copy of the weights.
 *
 * Lifecycle mirrors the libllama runtime: one fused context + one tokenizer
 * sidecar per loaded model; `acquire()` builds them, `release()` tears both
 * down. A throwing native free poisons the runtime (no new allocation over
 * leaked resources) exactly as the libllama runtime does.
 */

import fs from "node:fs";
import path from "node:path";

import type { BackendPlan } from "./backend";
import {
	type DesktopLlamaAdapter,
	desktopLlamaDylibsPresent,
	loadDesktopLlama,
} from "./desktop-llama-adapter";
import type {
	FfiBackendRuntime,
	FfiBackendSession,
} from "./ffi-streaming-backend";
import { FfiStreamingRunner } from "./ffi-streaming-runner";
import { wrapElizaInferenceFfi } from "./llm-streaming-binding";
import type { ElizaInferenceContextHandle } from "./voice/ffi-bindings";
import {
	type ElizaInferenceFfi,
	loadElizaInferenceFfi,
} from "./voice/ffi-bindings";

/**
 * Candidate filenames for the fused library, per platform. Mirrors
 * `samantha-preset-regenerator.ts::libraryFilenames` so the runtime and the
 * voice regenerator resolve the same artifact.
 */
function fusedLibraryFilenames(): string[] {
	if (process.platform === "darwin") return ["libelizainference.dylib"];
	if (process.platform === "win32") {
		return ["elizainference.dll", "libelizainference.dll"];
	}
	return ["libelizainference.so"];
}

/**
 * Resolve the on-disk path to the fused `libelizainference`. Precedence:
 *   1. `ELIZA_INFERENCE_LIBRARY` — an explicit absolute path.
 *   2. `<bundleRoot>/lib/<name>` — the bundle-local lib.
 *   3. `ELIZA_INFERENCE_LIB_DIR/<name>` — an explicit lib directory.
 * Returns null when none of the candidates exist on disk — the engine-side
 * gate then falls through to the libllama runtime.
 */
export function resolveFusedLibraryPath(
	bundleRoot: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const exact = env.ELIZA_INFERENCE_LIBRARY?.trim();
	if (exact && fs.existsSync(exact)) return exact;
	const dirs = [
		bundleRoot ? path.join(bundleRoot, "lib") : null,
		exact ? path.dirname(exact) : null,
		env.ELIZA_INFERENCE_LIB_DIR?.trim() || null,
	].filter((dir): dir is string => Boolean(dir));
	for (const dir of dirs) {
		for (const name of fusedLibraryFilenames()) {
			const candidate = path.join(dir, name);
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return null;
}

/**
 * Derive the bundle root (the dir the fused `create()` anchors at) from a
 * BackendPlan. Eliza-1 bundles set `overrides.bundleRoot` explicitly; otherwise
 * the GGUF lives at `<bundleRoot>/text/<file>.gguf`, so the bundle root is
 * `dirname(dirname(modelPath))`.
 */
function bundleRootForPlan(plan: BackendPlan): string {
	if (plan.overrides?.bundleRoot) return plan.overrides.bundleRoot;
	return path.dirname(path.dirname(plan.modelPath));
}

interface ActiveFusedSession {
	ffi: ElizaInferenceFfi;
	ctx: ElizaInferenceContextHandle;
	/** libllama sidecar held open only for `tokenize()`. */
	tokenizer: DesktopLlamaAdapter;
	session: FfiBackendSession;
}

export class DesktopFusedFfiBackendRuntime implements FfiBackendRuntime {
	private active: ActiveFusedSession | null = null;
	private poisonedError: Error | null = null;
	/** Cached `supported()` result so the engine gate and the dispatcher agree. */
	private supportedCache: boolean | null = null;

	/**
	 * Viable only when:
	 *   - bun:ffi resolves on the current runtime,
	 *   - the fused dylib is present AND reports ABI-v8 capability: the
	 *     streaming-LLM surface plus same-file MTP plus KV-cache quant.
	 * A v7 (or older) fused lib reports the probes as unsupported → refused so
	 * the engine falls back to libllama. The libllama tokenizer sidecar must
	 * also be present (we need its vocab to tokenize the prompt).
	 */
	supported(): boolean {
		if (this.supportedCache !== null) return this.supportedCache;
		this.supportedCache = this.computeSupported();
		return this.supportedCache;
	}

	/** Clear the cached `supported()` result (tests / lib swaps). */
	resetSupportedCache(): void {
		this.supportedCache = null;
	}

	private computeSupported(): boolean {
		try {
			require.resolve("bun:ffi");
		} catch {
			return false;
		}
		// The tokenizer seam needs the libllama dylib pair on disk.
		if (!desktopLlamaDylibsPresent()) return false;
		const libPath = resolveFusedLibraryPath(null);
		if (!libPath) return false;
		// Load the lib and probe the v8 capabilities. This dlopen is cheap (no
		// model load); we close it immediately after probing.
		let ffi: ElizaInferenceFfi | null = null;
		try {
			ffi = loadElizaInferenceFfi(libPath);
			const ok =
				typeof ffi.llmStreamSupported === "function" &&
				ffi.llmStreamSupported() === true &&
				typeof ffi.llmMtpSupported === "function" &&
				ffi.llmMtpSupported() === true &&
				typeof ffi.llmKvQuantSupported === "function" &&
				ffi.llmKvQuantSupported() === true;
			return ok;
		} catch {
			// dlopen / ABI-mismatch / non-Bun runtime → not viable; fall back.
			return false;
		} finally {
			ffi?.close();
		}
	}

	async acquire(plan: BackendPlan): Promise<FfiBackendSession> {
		if (this.poisonedError) {
			throw new Error(
				`[desktop-fused-ffi-runtime] native cleanup previously failed; restart required before acquiring a new session: ${this.poisonedError.message}`,
			);
		}
		if (this.active) {
			throw new Error(
				"[desktop-fused-ffi-runtime] acquire() called with a live session; release() first",
			);
		}
		const bundleRoot = bundleRootForPlan(plan);
		const libPath = resolveFusedLibraryPath(bundleRoot);
		if (!libPath) {
			throw new Error(
				`[desktop-fused-ffi-runtime] fused libelizainference not found for bundle ${bundleRoot}. ` +
					"Dispatcher should not have routed here; check supported().",
			);
		}

		// 1. Fused lib + bundle context for the generation path. `create()`
		//    anchors at the bundle root; the first `llmStreamOpen` loads
		//    `<bundleRoot>/text/*.gguf` and applies gpuLayers + KV-cache quant
		//    from the session config (threaded via loadConfig below).
		const ffi = loadElizaInferenceFfi(libPath);
		let ctx: ElizaInferenceContextHandle;
		try {
			ctx = ffi.create(bundleRoot);
		} catch (err) {
			ffi.close();
			throw err;
		}

		// 2. libllama tokenizer sidecar on the SAME text GGUF. gpuLayers: 0 and a
		//    tiny context keep it to vocab + a minimal ctx; mmap shares the
		//    read-only weight pages with the fused load.
		let tokenizer: DesktopLlamaAdapter;
		try {
			const loaded = await loadDesktopLlama({
				modelPath: plan.modelPath,
				contextSize: 256,
				gpuLayers: 0,
				useMmap: true,
			});
			if (!loaded) {
				throw new Error(
					"[desktop-fused-ffi-runtime] loadDesktopLlama returned null while building the tokenizer sidecar — " +
						"bun:ffi unavailable or libllama dylibs missing.",
				);
			}
			tokenizer = loaded.adapter;
		} catch (err) {
			ffi.destroy(ctx);
			ffi.close();
			throw err;
		}

		const binding = wrapElizaInferenceFfi(ffi);
		const runner = new FfiStreamingRunner(binding, ctx);
		const overrides = plan.overrides;
		const session: FfiBackendSession = {
			binding,
			ctx,
			runner,
			tokenize: (prompt) => tokenizer.tokenize(prompt),
			mtp: plan.catalog?.runtime?.mtp ?? null,
			draftModelPath: overrides?.draftModelPath ?? null,
			mmprojPath: overrides?.mmprojPath ?? null,
			// The fused path applies these at its first `llmStreamOpen`. Mirror
			// the libllama load decision: gpuLayers + KV-cache quant types.
			loadConfig: {
				gpuLayers:
					typeof overrides?.gpuLayers === "number"
						? overrides.gpuLayers
						: undefined,
				cacheTypeK: overrides?.cacheTypeK ?? null,
				cacheTypeV: overrides?.cacheTypeV ?? null,
			},
		};
		this.active = { ffi, ctx, tokenizer, session };
		return session;
	}

	parallelSlots(): number {
		return this.active?.tokenizer.parallelSlots?.() ?? 1;
	}

	async release(): Promise<void> {
		if (!this.active) return;
		const { ffi, ctx, tokenizer } = this.active;
		// Free both native handles. A throwing free poisons the runtime so a new
		// model cannot be allocated over leaked resources. Clear `active` in the
		// finally so a throwing free can't wedge the live-session guard.
		try {
			tokenizer.close();
			ffi.destroy(ctx);
			ffi.close();
		} catch (err) {
			this.poisonedError = err instanceof Error ? err : new Error(String(err));
			throw err;
		} finally {
			this.active = null;
		}
	}
}

/**
 * Convenience singleton — the engine constructs one per process and gates the
 * dispatcher's FFI slot between this fused runtime and the libllama runtime via
 * the v8 capability probes.
 */
export const desktopFusedFfiBackendRuntime =
	new DesktopFusedFfiBackendRuntime();
