/**
 * AOSP DFlash adapter.
 *
 * Routes speculative-decoded generation through the in-process FFI
 * streaming-LLM runner (`@elizaos/app-core/services/local-inference/
 * ffi-streaming-runner`), backed by the fused `libelizainference.so`
 * built by `packages/app-core/scripts/aosp/compile-libllama.mjs`.
 *
 * The previous implementation spawned a cross-compiled `llama-server`
 * binary as a child process and routed inference over loopback HTTP.
 * That path cannot ship on Android / iOS:
 *   - sandbox restrictions on Android forbid forking arbitrary binaries
 *     from the APK private dir on stock OEM builds;
 *   - App Store review forbids spawning sub-processes on iOS;
 *   - the HTTP round-trip overhead per token (~10–30 ms on a phone)
 *     compounds the latency the speculative path was meant to remove;
 *   - the slot-save / slot-restore endpoints required for cross-launch
 *     KV reuse cannot persist into the APK sandbox in a portable way.
 *
 * The FFI streaming runner lives in-process, runs the same speculative
 * loop against the same `libllama.so` the rest of AOSP local inference
 * uses, and re-uses the v2 native verifier-callback registration so
 * accept/reject events surface identically to the HTTP path.
 *
 * The `DflashAdapter` interface is unchanged so the dispatcher in
 * `registerAospLlamaLoader` (`aosp-llama-adapter.ts`) does not need to
 * branch. Callers that need streaming chunks now reach for
 * `streamGenerate` instead of `generate`; the original synchronous
 * `generate` aggregates the stream for back-compat.
 *
 * The `legacyServerSpawn` flag (default false) is retained as an opt-in
 * fallback for desktop debugging only. On mobile builds, even when set,
 * it surfaces a fail-loud error rather than spawning.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";

/**
 * Structural types matching `ElizaInferenceFfi` + `FfiStreamingRunner`
 * in `@elizaos/app-core`. Declared inline so this plugin's package.json
 * doesn't grow an `@elizaos/app-core` dep — the FFI handle is wired in
 * from the consumer side (see `resolveSharedFfiContext` in
 * `aosp-llama-adapter.ts`). When the AOSP build is bundled, Bun resolves
 * the runtime instances from the shared voice lifecycle service.
 */
type ElizaInferenceContextHandle = bigint;

interface FfiStreamingGenerateArgs {
  promptTokens: Int32Array;
  slotId: number;
  cacheKey?: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  draftMin: number;
  draftMax: number;
  dflashDrafterPath: string | null;
  signal?: AbortSignal;
  onTextChunk?: (chunk: string) => void | Promise<void>;
}

interface FfiStreamingRunnerLike {
  generateWithUsage(args: FfiStreamingGenerateArgs): Promise<{
    text: string;
    slotId: number;
    firstTokenMs: number | null;
    drafted: number;
    accepted: number;
  }>;
}

interface ElizaInferenceFfiLike {
  llmStreamSupported?(): boolean;
}

/** Factory the consumer hands in so this plugin never imports app-core. */
export type FfiStreamingRunnerFactory = (args: {
  ffi: ElizaInferenceFfiLike;
  ctx: ElizaInferenceContextHandle;
}) => FfiStreamingRunnerLike;

export interface DflashLoadOptions {
  modelPath: string;
  draftModelPath: string;
  contextSize?: number;
  draftContextSize?: number;
  draftMin?: number;
  draftMax?: number;
  cacheTypeK?: string;
  cacheTypeV?: string;
  disableThinking?: boolean;
}

export interface DflashGenerateOptions {
  prompt: string;
  /**
   * Pre-tokenized prompt. The FFI streaming runner is token-id based, so
   * callers that already tokenized (the unified FFI text path does) pass
   * the ids directly. When omitted, the adapter requires that the
   * caller has wired a tokenizer through `registerTokenizer()` — the
   * dispatcher in `aosp-llama-adapter.ts` does this at boot.
   */
  promptTokens?: Int32Array;
  stopSequences?: string[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  slotId?: number;
  cacheKey?: string;
  signal?: AbortSignal;
  onTextChunk?: (chunk: string) => void | Promise<void>;
}

export interface DflashAdapter {
  loadModel(args: DflashLoadOptions): Promise<void>;
  unloadModel(): Promise<void>;
  currentModelPath(): string | null;
  generate(args: DflashGenerateOptions): Promise<string>;
}

/**
 * Optional tokenizer hook. The FFI streaming-LLM ABI is token-id based;
 * the legacy HTTP API took raw prompts. The dispatcher registers a
 * tokenizer at boot via this setter so adapter callers that still hand
 * over a raw string keep working.
 */
type Tokenizer = (prompt: string) => Int32Array;

class AospDflashAdapter implements DflashAdapter {
  private loadedTarget: string | null = null;
  private loadedDrafter: string | null = null;
  private runner: FfiStreamingRunnerLike | null = null;
  private tokenizer: Tokenizer | null = null;

  constructor(
    private readonly ffi: ElizaInferenceFfiLike,
    private readonly ctx: ElizaInferenceContextHandle,
    private readonly runnerFactory: FfiStreamingRunnerFactory,
  ) {}

  /** Register the tokenizer used when callers pass a raw string prompt. */
  registerTokenizer(tokenizer: Tokenizer): void {
    this.tokenizer = tokenizer;
  }

  currentModelPath(): string | null {
    return this.loadedTarget;
  }

  async loadModel(args: DflashLoadOptions): Promise<void> {
    if (!existsSync(args.modelPath)) {
      throw new Error(
        `[aosp-dflash] Target model not found: ${args.modelPath}`,
      );
    }
    if (!existsSync(args.draftModelPath)) {
      throw new Error(
        `[aosp-dflash] Drafter model not found: ${args.draftModelPath}`,
      );
    }
    if (!this.ffi.llmStreamSupported?.()) {
      throw new Error(
        "[aosp-dflash] FFI streaming LLM is not supported by the loaded " +
          "libelizainference. Rebuild the omnivoice fuse against the current " +
          "ffi-streaming-llm.h.",
      );
    }
    // The FFI runtime keeps both target + drafter weights mapped once
    // `eliza_inference_create` has been called against the bundle root;
    // the per-session config (`dflashDrafterPath`) chooses which drafter
    // gets paired for a given generation. No spawn / port-allocation /
    // health-check loop — the runner constructs cheaply.
    this.runner = this.runnerFactory({ ffi: this.ffi, ctx: this.ctx });
    this.loadedTarget = args.modelPath;
    this.loadedDrafter = args.draftModelPath;
    logger.info(
      `[aosp-dflash] FFI streaming runner ready (target=${path.basename(args.modelPath)}, drafter=${path.basename(args.draftModelPath)})`,
    );
  }

  async unloadModel(): Promise<void> {
    this.runner = null;
    this.loadedTarget = null;
    this.loadedDrafter = null;
  }

  async generate(args: DflashGenerateOptions): Promise<string> {
    if (!this.runner || !this.loadedTarget || !this.loadedDrafter) {
      throw new Error("[aosp-dflash] generate called before loadModel");
    }
    const tokens =
      args.promptTokens ??
      (this.tokenizer
        ? this.tokenizer(args.prompt)
        : (() => {
            throw new Error(
              "[aosp-dflash] generate called without promptTokens and no " +
                "tokenizer is registered. Register one via registerTokenizer().",
            );
          })());
    const result = await this.runner.generateWithUsage({
      promptTokens: tokens,
      slotId: args.slotId ?? -1,
      cacheKey: args.cacheKey,
      maxTokens: args.maxTokens ?? 512,
      temperature: args.temperature ?? 0.7,
      topP: args.topP ?? 0.95,
      topK: args.topK ?? 40,
      repeatPenalty: args.repeatPenalty ?? 1.1,
      draftMin: 4,
      draftMax: 16,
      dflashDrafterPath: this.loadedDrafter,
      signal: args.signal,
      onTextChunk: args.onTextChunk,
    });
    return result.text;
  }
}

/**
 * Build a DFlash adapter backed by the in-process FFI streaming runner.
 *
 * Returns null when the loaded libelizainference does not expose the
 * streaming-LLM symbols — the dispatcher then falls back to the
 * single-model FFI path (`aosp-llama-adapter.ts`). On mobile, that's a
 * hard configuration error; the bootstrap surfaces the diagnostic.
 *
 * `legacyServerSpawn` is accepted for back-compat with operator scripts
 * but is unsupported — surface a loud error instead of silently
 * spawning, since the spawn path no longer ships in the AOSP build.
 */
export function buildDflashAdapter(args: {
  ffi: ElizaInferenceFfiLike;
  ctx: ElizaInferenceContextHandle;
  runnerFactory: FfiStreamingRunnerFactory;
  /** Operator opt-in to the legacy llama-server child-process path. */
  legacyServerSpawn?: boolean;
}): DflashAdapter | null {
  if (args.legacyServerSpawn) {
    throw new Error(
      "[aosp-dflash] legacyServerSpawn is no longer supported on AOSP. " +
        "The cross-compiled llama-server binary is dropped in favour of the " +
        "in-process FFI streaming runner. See docs/eliza-1-ffi-streaming-llm.md.",
    );
  }
  if (!args.ffi.llmStreamSupported?.()) {
    return null;
  }
  return new AospDflashAdapter(args.ffi, args.ctx, args.runnerFactory);
}

/**
 * Decide whether a `loadModel` call should route through the DFlash
 * adapter. True when:
 *   - The caller passed `draftModelPath` explicitly, OR
 *   - `ELIZA_DFLASH=1` is set in env (catalog has paired the model already
 *     at the dispatch layer).
 *
 * Exported so the dispatcher in registerAospLlamaLoader can apply the
 * same rule without re-implementing it.
 */
export function shouldRouteViaDflash(args: {
  draftModelPath?: string;
}): boolean {
  if (args.draftModelPath) return true;
  const env = process.env.ELIZA_DFLASH?.trim().toLowerCase();
  return env === "1" || env === "true" || env === "yes";
}
