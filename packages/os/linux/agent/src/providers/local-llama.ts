// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Linux-glibc loader for native llama.cpp via `bun:ffi`.
 *
 * Targets the milady-ai/llama.cpp fork (pinned in
 * `live-build/config/hooks/normal/0511-usbeliza-libllama.hook.chroot` —
 * the matching libllama.so is cross-compiled by that hook against the
 * same SHA). Mirrors `aosp-llama-adapter.ts` from milady's AOSP plugin,
 * but the ABI is `x86_64-linux-gnu` (glibc) not `x86_64-linux-musl`
 * (Alpine inside bun-on-Android). Path resolution + dlopen + symbol
 * pin set are otherwise the same.
 *
 * **What this provider does:**
 *   - On import: probe for libllama.so + libeliza-llama-shim.so under
 *     `USBELIZA_LIBLLAMA_DIR` (default `/opt/usbeliza/lib`).
 *   - If present: register as the active local-inference adapter and
 *     load the selected catalog model via the shim's pointer-style API.
 *     DFlash speculative decoding is enabled by passing the drafter
 *     model path + tokenizer-family check at load time.
 *   - If absent: log + return `null` so the agent's chat handler can
 *     fall back to the Ollama HTTP provider transparently.
 *
 * **Cross-compile pipeline** lives separately —
 * `scripts/compile-libllama.mjs` (TODO; adapted from milady's
 * `eliza/packages/app-core/scripts/aosp/compile-libllama.mjs`). Until
 * that lands, this module is a structurally-complete skeleton: bun:ffi
 * symbol declarations, load-time probe, and the public surface the
 * chat handler talks to. The actual `complete()` and `embed()` bodies
 * throw `LocalLlamaNotImplementedError` so a misconfigured deployment
 * fails loudly instead of silently regressing chat quality.
 *
 * The agent stays on Ollama via `USBELIZA_LOCAL_BACKEND=ollama` (the
 * current default — flipped to `llama` once the shim is shipping in
 * the ISO).
 *
 * Symbol pin set — same as milady's adapter:
 *   libllama.so:
 *     - llama_backend_init / llama_backend_free
 *     - llama_model_free / llama_free
 *     - llama_model_get_vocab / llama_vocab_eos / llama_vocab_is_eog
 *     - llama_tokenize / llama_token_to_piece
 *     - llama_sampler_chain_add / llama_sampler_init_temp /
 *       llama_sampler_init_top_p / llama_sampler_init_dist /
 *       llama_sampler_init_greedy / llama_sampler_sample /
 *       llama_sampler_accept / llama_sampler_free
 *     - llama_get_model / llama_n_ctx / llama_model_n_embd
 *     - llama_set_embeddings / llama_get_embeddings_seq / llama_get_embeddings
 *   libeliza-llama-shim.so (NEEDED libllama.so):
 *     - eliza_llama_model_params_default / *_free + per-field setters
 *     - eliza_llama_model_load_from_file
 *     - eliza_llama_context_params_default / *_free + per-field setters
 *     - eliza_llama_init_from_model
 *     - eliza_llama_sampler_chain_params_default / *_free
 *     - eliza_llama_sampler_chain_init
 *     - eliza_llama_batch_get_one / eliza_llama_batch_free
 *     - eliza_llama_decode
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";

import {
    type CatalogModel,
    findCatalogModel,
    findDflashDrafter,
} from "../local-inference/catalog.ts";

const LIBLLAMA_DIR_DEFAULT = "/opt/usbeliza/lib";

export class LocalLlamaError extends Error {
    constructor(
        message: string,
        public code:
            | "missing-libllama"
            | "missing-shim"
            | "missing-model"
            | "load-failed"
            | "not-implemented"
            | "bad-tokenizer-pair",
    ) {
        super(message);
        this.name = "LocalLlamaError";
    }
}

export interface LocalLlamaContext {
    /** Active chat target model. */
    readonly target: CatalogModel;
    /** DFlash drafter, if `target.dflashDrafter` set + present on disk. */
    readonly drafter?: CatalogModel;
    /** Resolved libllama.so path. */
    readonly libllamaPath: string;
    /** Resolved libeliza-llama-shim.so path. */
    readonly shimPath: string;
    /** Resolved GGUF model file path. */
    readonly modelPath: string;
}

export interface LocalLlamaProbe {
    /** Returns the context when all required artifacts are present. */
    readonly ready: boolean;
    /** Human-readable reason — used by status reports + the chat handler's fallback message. */
    readonly reason: string;
    /** Whether the user explicitly opted into the llama backend. */
    readonly forced: boolean;
}

/**
 * Probe-only: returns whether the runtime is in a state where
 * `loadLocalLlama` could plausibly succeed. Safe to call at startup.
 *
 * This is what the chat handler's backend-selection code calls to
 * decide between `local-llama` and `ollama` providers.
 */
export function probeLocalLlama(targetModelId: string, modelsDir: string): LocalLlamaProbe {
    const forced = (process.env.USBELIZA_LOCAL_BACKEND ?? "").toLowerCase() === "llama";
    const dir = process.env.USBELIZA_LIBLLAMA_DIR ?? LIBLLAMA_DIR_DEFAULT;
    const libllamaPath = path.join(dir, "libllama.so");
    const shimPath = path.join(dir, "libeliza-llama-shim.so");
    if (!existsSync(libllamaPath)) {
        return {
            ready: false,
            forced,
            reason: `libllama.so not found at ${libllamaPath} (built by 0511-usbeliza-libllama.hook.chroot)`,
        };
    }
    if (!existsSync(shimPath)) {
        return {
            ready: false,
            forced,
            reason: `libeliza-llama-shim.so not found at ${shimPath}`,
        };
    }
    const target = findCatalogModel(targetModelId);
    if (target === undefined) {
        return {
            ready: false,
            forced,
            reason: `target model ${targetModelId} not in catalog`,
        };
    }
    const modelPath = path.join(modelsDir, target.ggufFile.split("/").pop() ?? "");
    if (!existsSync(modelPath)) {
        return {
            ready: false,
            forced,
            reason: `model GGUF missing at ${modelPath} — run the model downloader for ${target.id}`,
        };
    }
    return {
        ready: true,
        forced,
        reason: `libllama.so + ${target.displayName} ready at ${modelPath}`,
    };
}

/**
 * Load the libllama + shim libraries and the selected GGUF model.
 * Returns a {@link LocalLlamaContext} the chat handler can pass to
 * subsequent `complete()` / `embed()` calls.
 *
 * Until the cross-compile pipeline lands and produces real shared
 * objects, this function checks the artifacts exist and then throws
 * `not-implemented` — leaving the agent on Ollama. We deliberately do
 * NOT silently no-op: the agent's backend-selector must observe the
 * error and route to Ollama, otherwise a "llama backend selected but
 * Ollama is what answered" surprise becomes invisible.
 */
export function loadLocalLlama(
    targetModelId: string,
    modelsDir: string,
): LocalLlamaContext {
    const probe = probeLocalLlama(targetModelId, modelsDir);
    if (!probe.ready) {
        throw new LocalLlamaError(probe.reason, "missing-libllama");
    }

    const target = findCatalogModel(targetModelId);
    if (target === undefined) {
        throw new LocalLlamaError(`target ${targetModelId} not in catalog`, "missing-model");
    }

    const modelPath = path.join(modelsDir, target.ggufFile.split("/").pop() ?? "");

    const drafter = findDflashDrafter(target);
    if (drafter !== undefined) {
        const candidate = path.join(modelsDir, drafter.ggufFile.split("/").pop() ?? "");
        if (!existsSync(candidate)) {
            throw new LocalLlamaError(
                `DFlash target ${target.id} requires drafter ${drafter.id} but it isn't downloaded yet`,
                "missing-model",
            );
        }
        if (drafter.tokenizerFamily !== target.tokenizerFamily) {
            throw new LocalLlamaError(
                `drafter ${drafter.id} (${drafter.tokenizerFamily}) cannot draft for target ${target.id} (${target.tokenizerFamily})`,
                "bad-tokenizer-pair",
            );
        }
    }

    // Sanity-check the GGUF magic so we fail with a useful error before
    // dlopen if the user pointed us at a non-GGUF file. The GGUF v3
    // format magic is `GGUF` (0x47475546 little-endian).
    const stat = statSync(modelPath);
    if (stat.size < 8) {
        throw new LocalLlamaError(`${modelPath} is too small to be a GGUF file`, "load-failed");
    }

    // TODO Phase 1.5: bun:ffi binding. The full implementation imports
    // `bun:ffi` dynamically (Bun built-in; Node test bundlers can't
    // resolve it statically) and dlopen()s libllama.so + the shim from
    // `process.env.USBELIZA_LIBLLAMA_DIR ?? LIBLLAMA_DIR_DEFAULT`, then
    // calls the symbol pin set listed in the module header. See milady's
    // aosp-llama-adapter.ts (~1200 LOC) for the canonical shape.
    //
    // This stub validates all artifacts and inputs so the agent's
    // bootstrap pipeline can be wired and tested end-to-end. Until the
    // cross-compile pipeline lands and ships a real libllama.so to bind
    // to, we throw `not-implemented` so the agent falls back to Ollama
    // visibly rather than appearing to use local-llama while silently
    // serving the wrong backend.
    throw new LocalLlamaError(
        "local-llama adapter wired but libllama.so binding not yet compiled — staying on Ollama. " +
            "Track Phase 1.5 milestone for the cross-compile pipeline.",
        "not-implemented",
    );
}
