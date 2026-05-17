/**
 * Coordinates which model is currently loaded into the plugin-local-ai
 * runtime. Eliza runs one inference model at a time; switching models
 * unloads the previous one first so we don't double-allocate VRAM.
 *
 * This module *does not* talk to `node-llama-cpp` directly. The plugin
 * owns the native binding; we ask it to swap via a small runtime service
 * registered under the name "localInferenceLoader". When the plugin is not
 * enabled, we still track the user's preferred active model so the
 * preference survives enabling the plugin later.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ELIZA_1_PLACEHOLDER_IDS, FIRST_RUN_DEFAULT_MODEL_ID } from "./catalog";
import { recommendForFirstRun } from "./recommendation";
import type { ActiveModelState, InstalledModel } from "./types";

export type { KvOffloadMode, LocalInferenceLoadArgs } from "./load-args.js";
export {
  ELIZA_1_PLACEHOLDER_IDS,
  FIRST_RUN_DEFAULT_MODEL_ID,
  recommendForFirstRun,
};

import type { KvOffloadMode, LocalInferenceLoadArgs } from "./load-args.js";
export declare function isForkOnlyKvCacheType(
  name: string | undefined,
): boolean;
export declare function isStockKvCacheType(name: string | undefined): boolean;
/**
 * Validate per-load overrides against what the in-process backend can
 * honour. The AOSP loader has its own (broader) acceptance set — pass
 * `{ allowFork: true }` to skip the desktop-only restriction.
 *
 * Throws on the first illegal value so the caller (the API route) can
 * surface a 400 with a useful message instead of letting the load slip
 * through and silently degrade to fp16.
 */
export declare function validateLocalInferenceLoadArgs(
  args: Partial<LocalInferenceLoadArgs>,
  options?: {
    allowFork?: boolean;
  },
): void;
export interface LocalInferenceLoader {
  loadModel(args: LocalInferenceLoadArgs): Promise<void>;
  unloadModel(): Promise<void>;
  currentModelPath(): string | null;
  /**
   * Optional generation surface. When a loader implements this, the runtime
   * handler (`ensure-local-inference-handler.ts`) routes TEXT_SMALL /
   * TEXT_LARGE requests through it instead of the standalone engine. Mobile
   * builds populate this via the Capacitor adapter; desktop leaves it
   * unimplemented and falls back to the `LocalInferenceEngine`.
   */
  generate?(args: {
    prompt: string;
    stopSequences?: string[];
    maxTokens?: number;
    temperature?: number;
    /**
     * Optional `promptCacheKey` from the runtime cache plan. Loaders
     * that implement prefix caching (out-of-process llama-server,
     * in-process node-llama-cpp session pool) use this to pin
     * subsequent calls with the same key to the same KV cache slot.
     * Loaders without prefix caching can ignore the field.
     */
    cacheKey?: string;
  }): Promise<string>;
  /**
   * Optional embedding surface. When a loader implements this, the runtime
   * handler routes `TEXT_EMBEDDING` requests through it. The AOSP bun:ffi
   * loader populates this directly via `llama_get_embeddings_seq`; the
   * device-bridge loader populates it by dispatching an `embed` frame to
   * the connected device. Loaders that cannot embed leave this undefined,
   * and the runtime falls back to its non-local embedding provider chain.
   */
  embed?(args: { input: string }): Promise<{
    embedding: number[];
    tokens: number;
  }>;
}
/**
 * Per-load override fields the caller can set. Subset of `LocalInferenceLoadArgs`
 * minus `modelPath` (which the coordinator owns) and minus dflash-only
 * fields (which the catalog `runtime.dflash` block owns end-to-end). The
 * route layer accepts this shape on `POST /api/local-inference/active`.
 */
export interface LocalInferenceLoadOverrides {
  contextSize?: number;
  cacheTypeK?: string;
  cacheTypeV?: string;
  gpuLayers?: number;
  kvOffload?: KvOffloadMode;
  flashAttention?: boolean;
  mmap?: boolean;
  mlock?: boolean;
  useGpu?: boolean;
  maxThreads?: number;
}
export declare function resolveLocalInferenceLoadArgs(
  installed: InstalledModel,
  overrides?: LocalInferenceLoadOverrides,
): Promise<LocalInferenceLoadArgs>;
export declare class ActiveModelCoordinator {
  private state;
  private readonly listeners;
  snapshot(): ActiveModelState;
  subscribe(listener: (state: ActiveModelState) => void): () => void;
  private emit;
  /** Return the loader service from the current runtime, if registered. */
  private getLoader;
  switchTo(
    runtime: AgentRuntime | null,
    installed: InstalledModel,
    overrides?: LocalInferenceLoadOverrides,
  ): Promise<ActiveModelState>;
  unload(runtime: AgentRuntime | null): Promise<ActiveModelState>;
}
//# sourceMappingURL=active-model.d.ts.map
