/**
 * Desktop production `FfiBackendRuntime` over the FUSED `libelizainference` —
 * the SOLE desktop text runtime now that libllama has been retired.
 *
 * Desktop text generation runs through the fused library: the same
 * `eliza_inference_llm_stream_*` ABI (v9) the voice subsystem already loads,
 * so text + voice share one native lib, one GGML pin, and one resident text
 * model.
 *
 *   - The fused lib's `eliza_inference_llm_stream_open` loads the bundle's text
 *     GGUF (`<bundleRoot>/text/*.gguf`) and applies same-file MTP speculative
 *     decoding + KV-cache quant + per-load GPU layers natively (ABI v9). The
 *     path is gated on the capability probes
 *     (`llmStreamSupported && llmMtpSupported && llmKvQuantSupported`).
 *   - A fused lib that lacks MTP / KV-quant / native tokenize is REFUSED by
 *     `supported()` → the engine raises LocalInferenceUnavailable. There is no
 *     libllama fallback and never an unoptimized fused loop.
 *
 * Tokenization runs over the fused handle's resident text vocab via ABI-v9
 * `eliza_inference_tokenize`: the fused `create()` + first `llmStreamOpen`
 * already made the text vocab resident, so no second model is loaded.
 * `tokenizeSupported()` gates this; a pre-v9 lib without the symbol is refused.
 *
 * Lifecycle: one fused context per loaded model; `acquire()` builds it,
 * `release()` tears it down. A throwing native free poisons the runtime so no
 * new allocation happens over leaked resources.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "@elizaos/core";

import type { BackendPlan } from "./backend";
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
 *   4. `<stateDir>/local-inference/lib/<name>` — the default staging dir written
 *      by `scripts/stage-desktop-fused-lib.mjs`, so a staged desktop build is
 *      found with no env wiring.
 * Returns null when none of the candidates exist on disk — `supported()` then
 * reports unavailable and the engine raises LocalInferenceUnavailable.
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
		path.join(resolveStateDir(env), "local-inference", "lib"),
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
	 *   - the fused dylib is present AND reports ABI-v9 capability: the
	 *     streaming-LLM surface, same-file MTP, KV-cache quant, AND native
	 *     tokenization (`eliza_inference_tokenize`).
	 * A pre-v9 fused lib reports the probes as unsupported → refused, and the
	 * engine raises LocalInferenceUnavailable. libllama has been retired; there
	 * is no fallback runtime and no tokenizer sidecar.
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
		const libPath = resolveFusedLibraryPath(null);
		if (!libPath) return false;
		// Load the lib and probe the v8 LLM capabilities. This dlopen is cheap (no
		// model load); we close it immediately after probing.
		let ffi: ElizaInferenceFfi | null = null;
		try {
			ffi = loadElizaInferenceFfi(libPath);
			const llmOk =
				typeof ffi.llmStreamSupported === "function" &&
				ffi.llmStreamSupported() === true &&
				typeof ffi.llmMtpSupported === "function" &&
				ffi.llmMtpSupported() === true &&
				typeof ffi.llmKvQuantSupported === "function" &&
				ffi.llmKvQuantSupported() === true;
			if (!llmOk) return false;
			// Native tokenization over the fused handle's resident text vocab
			// (ABI v9) is required: libllama has been retired, so there is no
			// tokenizer sidecar. A pre-v9 fused lib without `eliza_inference_tokenize`
			// is refused → the engine raises LocalInferenceUnavailable.
			const fusedTokenize =
				typeof ffi.tokenizeSupported === "function" &&
				ffi.tokenizeSupported() === true;
			if (!fusedTokenize) return false;
			return true;
		} catch {
			// dlopen / ABI-mismatch / non-Bun runtime → not viable.
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

		// 2. Tokenization over the fused handle's resident text vocab via ABI-v9
		//    `eliza_inference_tokenize` — no second model load. `supported()`
		//    already refused a pre-v9 lib, so the symbol is present here; this
		//    guard turns any surprise absence into a loud failure (the session is
		//    torn down) rather than a silent tokenizer gap. libllama is retired.
		const fusedTokenizeFn = ffi.tokenize;
		if (
			typeof ffi.tokenizeSupported !== "function" ||
			ffi.tokenizeSupported() !== true ||
			typeof fusedTokenizeFn !== "function"
		) {
			ffi.destroy(ctx);
			ffi.close();
			throw new Error(
				"[desktop-fused-ffi-runtime] fused lib lacks eliza_inference_tokenize (pre-v9). " +
					"libllama has been retired; rebuild the fused lib with the v9 tokenizer ABI.",
			);
		}
		const tokenizeFn = (prompt: string): Int32Array =>
			fusedTokenizeFn({ ctx, text: prompt });

		const binding = wrapElizaInferenceFfi(ffi);
		const runner = new FfiStreamingRunner(binding, ctx);
		const overrides = plan.overrides;
		const session: FfiBackendSession = {
			binding,
			ctx,
			runner,
			tokenize: (prompt) => tokenizeFn(prompt),
			mtp: plan.catalog?.runtime?.mtp ?? null,
			draftModelPath: overrides?.draftModelPath ?? null,
			mmprojPath: overrides?.mmprojPath ?? null,
			// The fused path applies these at its first `llmStreamOpen`:
			// gpuLayers + KV-cache quant types from the session config.
			loadConfig: {
				gpuLayers:
					typeof overrides?.gpuLayers === "number"
						? overrides.gpuLayers
						: undefined,
				cacheTypeK: overrides?.cacheTypeK ?? null,
				cacheTypeV: overrides?.cacheTypeV ?? null,
			},
		};
		this.active = { ffi, ctx, session };
		return session;
	}

	parallelSlots(): number {
		// The fused runtime holds one resident text context per loaded model;
		// multi-slot parallelism is not exposed by the fused ABI.
		return 1;
	}

	/**
	 * Whether the LIVE session can describe images through the fused
	 * `eliza_inference_describe_image`. Mirrors the FfiStreamingBackend gate:
	 * true only when a session is bound and the fused lib exposes vision.
	 */
	visionSupported(): boolean {
		if (!this.active) return false;
		return (
			typeof this.active.ffi.visionSupported === "function" &&
			this.active.ffi.visionSupported() === true &&
			typeof this.active.ffi.describeImage === "function"
		);
	}

	/**
	 * Vision describe through the fused `eliza_inference_describe_image`
	 * (ABI v9). Reuses the mtmd machinery linked for ASR over the bundle's text
	 * model + the passed mmproj projector. The `FfiStreamingBackend` forwards
	 * `describeImage`/`visionSupported` to this runtime by duck-typing.
	 */
	async describeImage(args: {
		imageBytes: Uint8Array;
		mmprojPath: string;
		prompt?: string;
		maxTokens?: number;
		temperature?: number;
		signal?: AbortSignal;
	}): Promise<{ text: string; projectorMs?: number; decodeMs?: number }> {
		if (!this.active) {
			throw new Error(
				"[desktop-fused-ffi-runtime] describeImage before acquire — no session",
			);
		}
		const { ffi, ctx } = this.active;
		if (
			typeof ffi.visionSupported !== "function" ||
			ffi.visionSupported() !== true ||
			typeof ffi.describeImage !== "function"
		) {
			throw new Error(
				"[desktop-fused-ffi-runtime] describeImage: fused lib was built without " +
					"vision (eliza_inference_vision_supported() == 0). Rebuild the fused " +
					"lib with -DELIZA_ENABLE_VISION=ON (verify-fused-symbols requires it).",
			);
		}
		const startedAt = Date.now();
		const text = ffi.describeImage({
			ctx,
			imageBytes: args.imageBytes,
			mmprojPath: args.mmprojPath,
			prompt: args.prompt,
		});
		return { text, decodeMs: Date.now() - startedAt };
	}

	async release(): Promise<void> {
		if (!this.active) return;
		const { ffi, ctx } = this.active;
		// Free the native handles. A throwing free poisons the runtime so a new
		// model cannot be allocated over leaked resources. Clear `active` in the
		// finally so a throwing free can't wedge the live-session guard.
		try {
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
 * Process singleton — the engine wires this as the sole `FfiBackendRuntime` for
 * the dispatcher's `"llama-cpp"` slot. The ABI-v9 capability probes in
 * `supported()` gate whether the fused lib serves text at all.
 */
export const desktopFusedFfiBackendRuntime =
	new DesktopFusedFfiBackendRuntime();
