/**
 * Standalone llama.cpp engine.
 *
 * Owns one `Llama` binding instance, at most one loaded `LlamaModel`, and
 * a cached `LlamaChatSession` that wraps it. Model swap is unload-then-load
 * so we never double-allocate VRAM.
 *
 * Two consumption paths:
 *   1. The Model Hub UI calls `load()` / `unload()` to make "Activate" work.
 *   2. The agent runtime calls `generate()` via the registered
 *      `ModelType.TEXT_SMALL` / `TEXT_LARGE` handlers (see
 *      `ensure-local-inference-handler.ts`).
 *
 * Dynamic import keeps the binding optional: if `node-llama-cpp` is not
 * installed, `available()` returns false and callers surface a clear error
 * instead of crashing the process.
 */

import type { LocalInferenceLoadArgs } from "./active-model";
import type {
  GenerateArgs as BackendGenerateArgs,
  BackendPlan,
  LocalInferenceBackend,
} from "./backend";
import { BackendDispatcher, gpuLayersForKvOffload } from "./backend";
import { findCatalogModel } from "./catalog";
import {
  type ConversationHandle,
  conversationRegistry,
} from "./conversation-registry";
import {
  type DflashGenerateResult,
  type DflashServerPlan,
  dflashLlamaServer,
  dflashRequired,
  getDflashRuntimeStatus,
} from "./dflash-server";
import type { LocalUsageBlock } from "./llama-server-metrics";
import { listInstalledModels } from "./registry";
import {
  DEFAULT_SESSION_KEY,
  resolveDefaultPoolSize,
  SessionPool,
} from "./session-pool";
import {
  EngineVoiceBridge,
  type EngineVoiceBridgeOptions,
  VoiceStartupError,
} from "./voice/engine-bridge";
import type {
  RejectedTokenRange,
  TextToken,
  TranscriptionAudio,
  VerifierStreamEvent,
} from "./voice/types";

// Re-exported from backend.ts so consumers can keep importing GenerateArgs
// from engine.ts without churn. backend.ts owns the canonical shape,
// including the optional `cacheKey` for prefix reuse via the session pool.
export type GenerateArgs = BackendGenerateArgs;

/**
 * Map a friendly KV cache type name (`"f16"`, `"q8_0"`, `"bf16"`, etc.) to
 * the `keyof typeof GgmlType` shape node-llama-cpp expects for its
 * experimental KV cache options. The binding's `resolveGgmlTypeOption`
 * accepts case-sensitive keys (`F16`, `Q8_0`, `BF16`), so we uppercase
 * the input.
 *
 * AOSP fork additions (`tbq3_0`, `tbq4_0`, `qjl1_256`) are caught by the
 * desktop-only validation in active-model.ts before they reach here; this
 * helper is intentionally agnostic so the same mapping can be reused if
 * the in-process binding ever ships with the fork's GGML type table.
 */
function normalizeKvCacheTypeForBinding(name: string): string {
  return name.trim().toUpperCase();
}

/**
 * Project a fully-resolved `LocalInferenceLoadArgs` onto the subset that
 * the dispatcher cares about. Keeps `BackendLoadOverrides` framework-free
 * (no dependency on active-model.ts here) so backend.ts and engine.ts stay
 * cycle-free.
 */
function toBackendLoadOverrides(
  args: LocalInferenceLoadArgs,
): BackendPlan["overrides"] {
  const overrides: BackendPlan["overrides"] = {};
  if (args.contextSize !== undefined) overrides.contextSize = args.contextSize;
  if (args.cacheTypeK !== undefined) overrides.cacheTypeK = args.cacheTypeK;
  if (args.cacheTypeV !== undefined) overrides.cacheTypeV = args.cacheTypeV;
  if (args.gpuLayers !== undefined) overrides.gpuLayers = args.gpuLayers;
  if (args.kvOffload !== undefined) overrides.kvOffload = args.kvOffload;
  if (args.flashAttention !== undefined) {
    overrides.flashAttention = args.flashAttention;
  }
  if (args.mmap !== undefined) overrides.mmap = args.mmap;
  if (args.mlock !== undefined) overrides.mlock = args.mlock;
  if (args.useGpu !== undefined) overrides.useGpu = args.useGpu;
  return overrides;
}

interface LlamaContextSequence {
  dispose(): Promise<void>;
}

interface LlamaContext {
  getSequence(): LlamaContextSequence;
  dispose(): Promise<void>;
}

interface LlamaChatSession {
  prompt(
    text: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
      topP?: number;
      stopOnAbortSignal?: AbortSignal;
      customStopTriggers?: string[];
    },
  ): Promise<string>;
  /**
   * Reset the accumulated chat history. Agent model handlers are stateless
   * per-call; without this, `LlamaChatSession.prompt()` would thread prior
   * turns into each new generation and gradually derail outputs.
   */
  resetChatHistory?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

interface LlamaChatSessionCtor {
  new (args: { contextSequence: LlamaContextSequence }): LlamaChatSession;
}

/**
 * KV cache type names accepted by the in-process binding. We pass the
 * lowercase string name through to node-llama-cpp's `experimentalKvCache*`
 * options — the binding's `resolveGgmlTypeOption` accepts either the enum
 * value or the `keyof typeof GgmlType` string. Stock builds reject the
 * apothic fork additions (`tbq3_0`, `tbq4_0`, `qjl1_256`); validation in
 * `validateLocalInferenceLoadArgs` rejects those before they reach this
 * layer on desktop.
 */
type StockKvCacheTypeName = string;

interface LlamaModel {
  createContext(args?: {
    contextSize?: number | "auto" | { min?: number; max?: number };
    /**
     * Per-context sequence count. Each `LlamaChatSession` lives on its own
     * sequence, and the session pool needs at least `poolSize` sequences
     * available — otherwise `getSequence()` throws once the pool is full.
     */
    sequences?: number;
    flashAttention?: boolean;
    /**
     * Experimental KV cache key/value type override. node-llama-cpp 3.18.x
     * exposes these as deprecated/experimental on `LlamaContextOptions`;
     * we rely on them so the desktop path can honour `cacheTypeK/V`.
     * Stock builds only accept entries from the `GgmlType` enum.
     */
    experimentalKvCacheKeyType?: StockKvCacheTypeName;
    experimentalKvCacheValueType?: StockKvCacheTypeName;
  }): Promise<LlamaContext>;
  dispose(): Promise<void>;
}

interface Llama {
  loadModel(args: {
    modelPath: string;
    gpuLayers?: number | "max" | "auto";
    useMmap?: boolean;
    useMlock?: boolean;
    defaultContextFlashAttention?: boolean;
  }): Promise<LlamaModel>;
}

interface LlamaBindingModule {
  getLlama(options?: { gpu?: "auto" | false }): Promise<Llama>;
  LlamaChatSession: LlamaChatSessionCtor;
}

/**
 * In-process llama.cpp backend backed by `node-llama-cpp` 3.18.1.
 *
 * Stock GGUF only. Does NOT support `--lookahead`, n-gram drafter, MoE
 * expert offload (`-ot`), `--parallel` continuous batching, or DFlash
 * speculative decoding. Models that declare any of those in their catalog
 * `runtime.optimizations` must route to `llama-server` via the dispatcher.
 *
 * `useMmap`, `useMlock`, and `defaultContextFlashAttention` are honored
 * when present in the catalog optimizations block — those map cleanly onto
 * `LlamaModelOptions`.
 */
export class NodeLlamaCppBackend implements LocalInferenceBackend {
  readonly id = "node-llama-cpp" as const;

  private llama: Llama | null = null;
  private loadedModel: LlamaModel | null = null;
  private loadedContext: LlamaContext | null = null;
  private loadedPath: string | null = null;
  private bindingChecked = false;
  private bindingModule: LlamaBindingModule | null = null;
  /** Serialises generate calls so concurrent requests don't corrupt session state. */
  private generationQueue: Promise<unknown> = Promise.resolve();
  /**
   * Per-cache-key chat sessions. Created on first use, LRU-evicted, and
   * torn down on `unload()`. The `_default` slot is reset every turn so
   * callers without a `cacheKey` see the historical stateless behaviour.
   */
  private sessionPool: SessionPool<LlamaChatSession> | null = null;

  async available(): Promise<boolean> {
    if (!this.bindingChecked) {
      this.bindingModule = await this.loadBinding();
      this.bindingChecked = true;
    }
    return this.bindingModule !== null;
  }

  currentModelPath(): string | null {
    return this.loadedPath;
  }

  hasLoadedModel(): boolean {
    return this.loadedModel !== null;
  }

  async unload(): Promise<void> {
    if (!this.loadedModel) return;
    const pool = this.sessionPool;
    const context = this.loadedContext;
    const model = this.loadedModel;
    this.sessionPool = null;
    this.loadedContext = null;
    this.loadedModel = null;
    this.loadedPath = null;
    // Dispose bottom-up: every cached session first, then the context,
    // then the model. Pool.close() drains its own dispose() failures.
    if (pool) await pool.close();
    try {
      await context?.dispose();
    } catch {
      // Best effort: the underlying context may already be released; we
      // still need to dispose the model below.
    }
    await model.dispose();
  }

  async load(plan: BackendPlan): Promise<void> {
    const modelPath = plan.modelPath;
    if (this.loadedPath === modelPath && this.loadedModel) return;

    if (!(await this.available()) || !this.bindingModule) {
      throw new Error(
        "node-llama-cpp is not installed in this build; add it as a dependency to enable local inference",
      );
    }

    if (this.loadedModel) {
      await this.unload();
    }

    if (!this.llama) {
      this.llama = await this.bindingModule.getLlama({ gpu: "auto" });
    }

    // Catalog-driven node-llama-cpp load options. The binding only exposes
    // a subset of the fork's optimizations (no MoE offload, no lookahead,
    // no n-gram drafter) — those force the dispatcher to llama-server
    // instead. mmap/mlock/flash-attention flow through cleanly here.
    const optimizations =
      plan.catalog?.runtime?.optimizations ??
      (plan.modelId
        ? findCatalogModel(plan.modelId)?.runtime?.optimizations
        : undefined);
    const overrides = plan.overrides;

    // Resolve gpuLayers. Per-load override wins over `useGpu` opt-out
    // (explicit `gpuLayers: N` from the API beats both the env default
    // and the implicit "GPU on for chat models" assumption).
    let gpuLayers: number | "max" | "auto" = "auto";
    if (overrides?.gpuLayers !== undefined) {
      gpuLayers = overrides.gpuLayers;
    } else if (overrides?.kvOffload !== undefined) {
      gpuLayers = gpuLayersForKvOffload(overrides.kvOffload);
    } else if (overrides?.useGpu === false) {
      gpuLayers = 0;
    }

    const loadOptions: {
      modelPath: string;
      gpuLayers: number | "max" | "auto";
      useMmap?: boolean;
      useMlock?: boolean;
      defaultContextFlashAttention?: boolean;
    } = {
      modelPath,
      gpuLayers,
    };
    // Per-load overrides win over catalog defaults. The validation in
    // `validateLocalInferenceLoadArgs` (called from active-model.ts)
    // already rejected illegal values, so any value reaching here is
    // safe to forward.
    if (overrides?.mmap !== undefined) {
      loadOptions.useMmap = overrides.mmap;
    } else if (optimizations?.noMmap) {
      loadOptions.useMmap = false;
    }
    if (overrides?.mlock !== undefined) {
      loadOptions.useMlock = overrides.mlock;
    } else if (optimizations?.mlock) {
      loadOptions.useMlock = true;
    }
    if (overrides?.flashAttention !== undefined) {
      loadOptions.defaultContextFlashAttention = overrides.flashAttention;
    } else if (optimizations?.flashAttention !== undefined) {
      loadOptions.defaultContextFlashAttention = optimizations.flashAttention;
    }

    const poolSize = resolveDefaultPoolSize(
      process.env.ELIZA_LOCAL_SESSION_POOL_SIZE,
    );
    const model = await this.llama.loadModel(loadOptions);
    // Reserve one sequence per pool slot. node-llama-cpp throws on
    // `getSequence()` once `sequencesLeft` hits 0, so the context must
    // be sized to the pool from the start.
    //
    // contextSize: thread the per-load override into the binding's
    // `LlamaContextOptions.contextSize`. Without this, the binding falls
    // back to `"auto"` which adapts to current VRAM but never exceeds
    // the smallest fitting size — a 128k-trained model loaded on a host
    // with plenty of RAM would still get a 4-8k window. That was the
    // exact "claims-128k-but-actually-8k" larp this task is fixing.
    const ctxOptions: {
      sequences: number;
      contextSize?: number;
      flashAttention?: boolean;
      experimentalKvCacheKeyType?: string;
      experimentalKvCacheValueType?: string;
    } = { sequences: poolSize };
    if (overrides?.contextSize !== undefined) {
      ctxOptions.contextSize = overrides.contextSize;
    }
    if (overrides?.flashAttention !== undefined) {
      ctxOptions.flashAttention = overrides.flashAttention;
    }
    if (overrides?.cacheTypeK !== undefined) {
      ctxOptions.experimentalKvCacheKeyType = normalizeKvCacheTypeForBinding(
        overrides.cacheTypeK,
      );
    }
    if (overrides?.cacheTypeV !== undefined) {
      ctxOptions.experimentalKvCacheValueType = normalizeKvCacheTypeForBinding(
        overrides.cacheTypeV,
      );
    }
    const context = await model.createContext(ctxOptions);

    const bindingModule = this.bindingModule;
    const sessionPool = new SessionPool<LlamaChatSession>({
      maxSize: poolSize,
      factory: async () => {
        const sequence = context.getSequence();
        return new bindingModule.LlamaChatSession({
          contextSequence: sequence,
        });
      },
    });

    this.loadedModel = model;
    this.loadedContext = context;
    this.sessionPool = sessionPool;
    this.loadedPath = modelPath;
  }

  /**
   * Generate text from the loaded model. Serialised — a new call waits
   * for any in-flight generation to finish so chat session state stays
   * consistent. When `args.cacheKey` is set, repeated calls with the
   * same key reuse the underlying `LlamaChatSession` (and therefore the
   * KV cache) so the prefix doesn't have to be re-prefilled. Calls
   * without a cache key share the synthetic `_default` slot, which is
   * reset every turn to preserve the historical stateless behaviour.
   */
  async generate(args: GenerateArgs): Promise<string> {
    // Backwards-compat shim: if a previous version of the code activated
    // the DFlash llama-server directly (bypassing the dispatcher), and a
    // caller still routes generation through the node-llama-cpp engine
    // singleton, forward to the running server instead of throwing.
    // New callsites should use the BackendDispatcher, which picks the
    // right backend at load time and skips this path entirely.
    if (dflashLlamaServer.hasLoadedModel()) {
      return dflashLlamaServer.generate(args);
    }
    const pool = this.sessionPool;
    if (!pool) {
      throw new Error(
        "No local model is active. Select one in Settings → Local models before using local inference.",
      );
    }
    const cacheKey =
      args.cacheKey && args.cacheKey.length > 0
        ? args.cacheKey
        : DEFAULT_SESSION_KEY;
    const run = async (): Promise<string> => {
      const session = await pool.acquire(cacheKey);
      // Default slot mirrors the historical "stateless per call" semantics
      // — no cache hint means the caller does not want prefix reuse.
      // Keyed slots intentionally retain history so the prefix KV stays
      // hot across turns.
      if (cacheKey === DEFAULT_SESSION_KEY) {
        await session.resetChatHistory?.();
      }
      const promptOpts: {
        maxTokens?: number;
        temperature?: number;
        topP?: number;
        stopOnAbortSignal?: AbortSignal;
        customStopTriggers?: string[];
      } = {
        maxTokens: args.maxTokens ?? 2048,
        temperature: args.temperature ?? 0.7,
        topP: args.topP ?? 0.9,
      };
      if (args.stopSequences) {
        promptOpts.customStopTriggers = args.stopSequences;
      }
      if (args.signal) {
        // node-llama-cpp's `stopOnAbortSignal` aborts the generation loop
        // on the next sampler tick when the signal is aborted. Wiring this
        // is the canonical way to make local inference cancellable.
        promptOpts.stopOnAbortSignal = args.signal;
      }
      const text = await session.prompt(args.prompt, promptOpts);
      if (text.length > 0) {
        await args.onTextChunk?.(text);
      }
      return text;
    };
    const job = this.generationQueue.then(run, run);
    this.generationQueue = job.catch(() => {
      // Swallow upstream rejection so the queue stays usable; the failed
      // job's caller still sees the original error via its own promise.
    });
    return job;
  }

  /**
   * Diagnostic snapshot of in-process session-pool state. Returns null
   * when no model is active so callers can distinguish "no pool" from
   * "empty pool".
   */
  describeSessionPool(): {
    size: number;
    maxSize: number;
    keys: string[];
  } | null {
    const pool = this.sessionPool;
    if (!pool) return null;
    return {
      size: pool.size(),
      maxSize: this.sessionPoolMaxSize(),
      keys: pool.keys(),
    };
  }

  private sessionPoolMaxSize(): number {
    return resolveDefaultPoolSize(process.env.ELIZA_LOCAL_SESSION_POOL_SIZE);
  }

  private async loadBinding(): Promise<LlamaBindingModule | null> {
    try {
      const mod = (await import("node-llama-cpp")) as unknown;
      if (
        mod &&
        typeof mod === "object" &&
        "getLlama" in mod &&
        "LlamaChatSession" in mod &&
        typeof (mod as { getLlama: unknown }).getLlama === "function"
      ) {
        return mod as LlamaBindingModule;
      }
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Public engine facade.
 *
 * Pre-existing API: `load(modelPath)`, `unload()`, `generate(args)`,
 * plus the activity probes used by router/handler/active-model code. The
 * implementation now sits behind the unified backend dispatcher; the
 * shape is preserved so callers (active-model, router-handler, the agent
 * runtime handler) keep working unchanged.
 *
 * The previous behaviour of "DFlash hijack inside the engine" lives in
 * the dispatcher's decision tree now — `decideBackend()` picks
 * `llama-server` when DFlash is configured, when a kernel is required,
 * or when the catalog `preferredBackend` is `llama-server`.
 */
export class LocalInferenceEngine {
  private readonly nodeBackend = new NodeLlamaCppBackend();
  private readonly dispatcher = new BackendDispatcher(
    this.nodeBackend,
    dflashLlamaServer,
    () => getDflashRuntimeStatus().enabled,
    () => dflashRequired(),
    () => getDflashRuntimeStatus().capabilities?.kernels ?? null,
  );
  /**
   * Active voice-streaming bridge (`EngineVoiceBridge`). Only set when an
   * Eliza-1 bundle has been activated AND `startVoice()` has succeeded —
   * see `packages/inference/AGENTS.md` §3 + §4. The engine never lazily
   * stands up a voice session: callers either start it explicitly or get
   * a hard error.
   */
  private voiceBridge: EngineVoiceBridge | null = null;

  async available(): Promise<boolean> {
    return this.dispatcher.available();
  }

  currentModelPath(): string | null {
    return this.dispatcher.currentModelPath();
  }

  hasLoadedModel(): boolean {
    return this.dispatcher.hasLoadedModel();
  }

  activeBackendId(): "node-llama-cpp" | "llama-server" | null {
    return this.dispatcher.activeBackendId();
  }

  async unload(): Promise<void> {
    const bridge = this.voiceBridge;
    if (bridge) {
      // Drop voice resources before tearing down text. Disarm is a
      // no-op when the lifecycle is already in voice-off, so this is
      // safe even if the caller never called startVoice().
      try {
        await bridge.disarm();
        await bridge.settle();
      } finally {
        bridge.dispose();
        if (this.voiceBridge === bridge) this.voiceBridge = null;
      }
    }
    await this.dispatcher.unload();
  }

  async load(
    modelPath: string,
    resolved?: LocalInferenceLoadArgs,
  ): Promise<void> {
    const installed = await listInstalledModels();
    const target = installed.find((m) => m.path === modelPath);
    const catalog = target ? findCatalogModel(target.id) : undefined;

    // Resolved args (when provided) carry the merged catalog defaults +
    // per-load overrides from the active-model coordinator. Project them
    // onto the dispatcher-level overrides shape — engine.load is also
    // called directly by legacy callers that pass only a `modelPath`,
    // in which case `resolved` is undefined and we keep the historical
    // behaviour of trusting catalog defaults inside the backend.
    const overrides = resolved ? toBackendLoadOverrides(resolved) : undefined;

    const plan: BackendPlan = {
      modelPath,
      modelId: target?.id,
      catalog,
      overrides,
    };

    // Backwards compat with the previous "DFlash configured = pre-build the
    // dflash plan and start the server" path. The dispatcher's `load()`
    // calls `dflashLlamaServer.load(plan)`, which used to take a
    // `DflashServerPlan` rather than a `BackendPlan`. The llama-server
    // backend now accepts the unified `BackendPlan`, derives the dflash
    // settings from the catalog entry, and resolves the drafter from the
    // installed registry — see `dflash-server.ts`.
    try {
      await this.dispatcher.load(plan);
      return;
    } catch (err) {
      // Only a soft catalog preference may fall back to node-llama-cpp.
      // Kernel-required loads are the mandatory-optimization path: falling
      // back would silently run an unoptimized bundle, which violates the
      // Eliza-1 startup contract.
      const decision = this.dispatcher.decide(plan);
      if (
        decision.backend === "llama-server" &&
        decision.reason === "preferred-backend" &&
        !dflashRequired()
      ) {
        console.warn(
          "[local-inference] llama-server backend unavailable; falling back to node-llama-cpp:",
          err instanceof Error ? err.message : String(err),
        );
        await this.nodeBackend.load(plan);
        return;
      }
      throw err;
    }
  }

  async generate(args: GenerateArgs): Promise<string> {
    const streaming = this.voiceStreamingArgs(args);
    const text = await this.dispatcher.generate(streaming.args);
    await streaming.finish(text);
    return text;
  }

  /**
   * Diagnostic snapshot of in-process node-llama-cpp session-pool state.
   * Returns null when no node-backend pool is active (model not loaded,
   * or running on the llama-server backend).
   */
  describeSessionPool(): {
    size: number;
    maxSize: number;
    keys: string[];
  } | null {
    return this.nodeBackend.describeSessionPool();
  }

  /**
   * Reserve a slot for a long-lived conversation. Subsequent
   * `generateInConversation` calls reuse the same slot, so the prefix
   * KV survives across turns regardless of hash collisions with other
   * concurrent conversations.
   *
   * Idempotent for the same (conversationId, modelId): repeated open
   * calls return the same handle. The runtime side should call this
   * lazily on the first turn of a conversation and `closeConversation`
   * when the chat session ends.
   */
  openConversation(args: {
    conversationId: string;
    modelId: string;
    ttlMs?: number;
  }): ConversationHandle {
    const parallel = this.activeParallel();
    const handle = conversationRegistry.open({
      conversationId: args.conversationId,
      modelId: args.modelId,
      parallel,
      ttlMs: args.ttlMs,
    });
    // Lazy-restore previously-persisted KV state for this conversation.
    // Fire-and-forget — a missing or unreadable file just means the
    // conversation cold-prefills on the next request, which is the
    // pre-restore default. Only meaningful for the llama-server backend;
    // node-llama-cpp owns its own session pool.
    if (this.activeBackendId() === "llama-server") {
      void dflashLlamaServer
        .restoreConversationKv(args.conversationId, handle.slotId)
        .catch(() => {
          // KV restore failures must never break the open call — the
          // conversation just doesn't get its old prefix back.
        });
    }
    return handle;
  }

  /**
   * Run one generation pinned to a previously-opened conversation
   * handle. Cache key, slot id, and (for llama-server) kv-restore are
   * all owned by the registry — callers don't need to thread them.
   *
   * Returns the Anthropic-shape `LocalUsageBlock` alongside the text so
   * agentic callers can surface cache-hit telemetry without re-scraping
   * `/metrics` themselves. Falls back to a zero-counter usage block on
   * the node-llama-cpp backend (which doesn't expose Prometheus
   * metrics).
   */
  async generateInConversation(
    handle: ConversationHandle,
    args: Omit<GenerateArgs, "cacheKey">,
  ): Promise<{ text: string; usage: LocalUsageBlock; slotId: number }> {
    if (handle.closed) {
      throw new Error(
        `[local-inference] Conversation ${handle.conversationId} has been closed; reopen before generating`,
      );
    }
    handle.lastUsedMs = Date.now();
    const cacheKey = `conv:${handle.conversationId}`;
    const streaming = this.voiceStreamingArgs(args);
    if (this.activeBackendId() === "llama-server") {
      const result: DflashGenerateResult =
        await dflashLlamaServer.generateWithUsage({
          ...streaming.args,
          cacheKey,
          slotId: handle.slotId,
        });
      await streaming.finish(result.text);
      return result;
    }
    // node-llama-cpp path: forward via the dispatcher and synthesize a
    // zero-counter usage block. The session pool already pins by
    // cacheKey, so cache reuse still works — we just don't have
    // observability on this backend.
    const text = await this.dispatcher.generate({
      ...streaming.args,
      cacheKey,
    });
    await streaming.finish(text);
    return {
      text,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      slotId: handle.slotId,
    };
  }

  /**
   * Close + drop a conversation handle. Persists the final KV state to
   * disk so a future open with the same id can lazy-restore. Idempotent;
   * closing an unknown id is a no-op.
   */
  async closeConversation(handle: ConversationHandle): Promise<void> {
    if (handle.closed) return;
    if (this.activeBackendId() === "llama-server") {
      // Snapshot KV before deregistering so the slot id is still valid.
      await dflashLlamaServer
        .persistConversationKv(handle.conversationId, handle.slotId)
        .catch(() => {
          // A failed save must not block close — the slot will fall back
          // to the in-RAM-only path on next open.
        });
    }
    conversationRegistry.close(handle.conversationId, handle.modelId);
  }

  /**
   * Read-side accessor for the conversation registry. The runtime handler
   * uses this to look up an existing handle before opening a new one,
   * avoiding the need to thread a handle through every layer.
   */
  conversation(
    conversationId: string,
    modelId: string,
  ): ConversationHandle | null {
    return conversationRegistry.get(conversationId, modelId);
  }

  /**
   * Largest concurrent open-conversation count seen this process lifetime.
   * The auto-tune-parallel path consults this and warns when it exceeds
   * the running server's slot count.
   */
  conversationHighWaterMark(): number {
    return conversationRegistry.highWater();
  }

  /**
   * Auto-tune diagnostic. Returns the recommended `--parallel` value
   * given the current high-water mark plus a small headroom (max(2,
   * 25%)). When the active backend is llama-server and this exceeds the
   * running server's `parallelSlots()`, callers should restart the
   * server with the new value to pick up the higher slot count — or
   * surface a warning when restart is too expensive.
   */
  recommendedParallel(): number {
    const highWater = conversationRegistry.highWater();
    const headroom = Math.max(2, Math.ceil(highWater * 0.25));
    return Math.max(1, highWater + headroom);
  }

  /**
   * Convenience: emit a one-line warning when the running parallel slot
   * count is below the recommended value. Returns true when a warning
   * was emitted (caller can use this signal to drive a restart, or just
   * for diagnostics). No-op for the node-llama-cpp backend, which has
   * its own session-pool sizing.
   */
  warnIfParallelTooLow(logger?: { warn: (msg: string) => void }): boolean {
    if (this.activeBackendId() !== "llama-server") return false;
    const recommended = this.recommendedParallel();
    const actual = dflashLlamaServer.parallelSlots();
    if (recommended <= actual) return false;
    const message = `[local-inference] Conversation high-water mark (${conversationRegistry.highWater()}) exceeds running --parallel ${actual}. Recommended: ${recommended}. Restart llama-server with ELIZA_LOCAL_PARALLEL=${recommended} or higher to avoid slot thrashing.`;
    if (logger?.warn) {
      logger.warn(message);
    } else {
      console.warn(message);
    }
    return true;
  }

  /**
   * Start the voice-streaming pipeline against an already-activated
   * Eliza-1 bundle. Per AGENTS.md §3, voice is mandatory for Eliza-1
   * tiers — every required artifact (speaker preset, fused FFI when
   * `useFfiBackend`, bundle root) is checked up front and missing
   * pieces surface as `VoiceStartupError`. There is no silent fallback
   * to text-only, no log-and-continue.
   *
   * Idempotent guard: starting twice without `stopVoice()` between
   * surfaces a hard error so callers do not double-allocate the
   * scheduler.
   */
  startVoice(opts: EngineVoiceBridgeOptions): EngineVoiceBridge {
    if (this.voiceBridge) {
      throw new VoiceStartupError(
        "already-started",
        "[voice] Voice session is already active. Call stopVoice() before starting a new one.",
      );
    }
    this.voiceBridge = EngineVoiceBridge.start(opts);
    return this.voiceBridge;
  }

  /**
   * Arm the voice lifecycle on the active bridge — lazily loads the TTS
   * mmap region, optional ASR region when present, voice caches, and
   * voice scheduler nodes via the shared resource registry. Throws
   * `VoiceLifecycleError` if any
   * required artifact is unavailable (RAM pressure, mmap fail, kernel
   * missing) — see `voice/lifecycle.ts` for the structured codes.
   *
   * Required before sustained voice use; `startVoice()` only stands up
   * the cold scheduler and bridge. Splitting setup from arming lets
   * the engine keep the voice surface in voice-off (no heavy weights
   * mapped) until the user actually toggles voice on.
   */
  async armVoice(): Promise<void> {
    const bridge = this.voiceBridge;
    if (!bridge) {
      throw new VoiceStartupError(
        "not-started",
        "[voice] Cannot arm: no voice session active. Call startVoice() first.",
      );
    }
    await bridge.arm();
  }

  /**
   * Disarm the voice lifecycle — drains the ring buffer, settles the
   * scheduler, and drops TTS/ASR weights from RAM via `evictPages()`
   * (madvise / VirtualUnlock equivalent — see voice/engine-bridge.ts).
   * No-op when not armed.
   */
  async disarmVoice(): Promise<void> {
    const bridge = this.voiceBridge;
    if (!bridge) return;
    await bridge.disarm();
  }

  /**
   * Tear down the active voice bridge. Idempotent; calling when no
   * voice session is active is a no-op. Disarms the lifecycle first
   * (drops voice weights via `evictPages`), then settles any in-flight
   * TTS so audio committed to the ring buffer surfaces to the sink
   * before the bridge is dropped.
   */
  async stopVoice(): Promise<void> {
    const bridge = this.voiceBridge;
    if (!bridge) return;
    try {
      await bridge.disarm();
      await bridge.settle();
    } finally {
      bridge.dispose();
      if (this.voiceBridge === bridge) this.voiceBridge = null;
    }
  }

  async synthesizeSpeech(text: string): Promise<Uint8Array> {
    return this.requireVoiceBridge("synthesize speech").synthesizeTextToWav(
      text,
    );
  }

  async transcribePcm(args: TranscriptionAudio): Promise<string> {
    return this.requireVoiceBridge("transcribe audio").transcribePcm(args);
  }

  /**
   * Active voice bridge, or null when voice mode is not running.
   * Callers (router, UI, agent runtime) read this to decide whether to
   * forward verifier events. Voice is mandatory for Eliza-1 tiers but
   * the bridge is still created lazily — `startVoice()` MUST be called
   * before `voice()` returns non-null.
   */
  voice(): EngineVoiceBridge | null {
    return this.voiceBridge;
  }

  private requireVoiceBridge(action: string): EngineVoiceBridge {
    const bridge = this.voiceBridge;
    if (!bridge) {
      throw new VoiceStartupError(
        "not-started",
        `[voice] Cannot ${action}: no voice session active. Call startVoice() and armVoice() first.`,
      );
    }
    return bridge;
  }

  private voiceStreamingArgs<T extends Omit<GenerateArgs, "cacheKey">>(
    args: T,
  ): {
    args: T;
    finish: (finalText: string) => Promise<void>;
  } {
    const bridge = this.voiceBridge;
    const voiceOn = bridge?.lifecycle.current().kind === "voice-on";
    if (!voiceOn || !bridge) {
      return {
        args,
        finish: async () => {},
      };
    }

    let nextIndex = 0;
    let streamedAny = false;
    const callerOnTextChunk = args.onTextChunk;
    const wrapped = {
      ...args,
      onTextChunk: async (chunk: string) => {
        if (chunk.length > 0) {
          streamedAny = true;
          const token: TextToken = { index: nextIndex++, text: chunk };
          await bridge.pushAcceptedToken(token);
        }
        await callerOnTextChunk?.(chunk);
      },
    } as T;

    return {
      args: wrapped,
      finish: async (finalText: string) => {
        if (!streamedAny && finalText.length > 0) {
          await bridge.pushAcceptedToken({ index: nextIndex++, text: finalText });
        }
        await bridge.settle();
      },
    };
  }

  /**
   * Forward a verifier-stream event (DFlash drafter ↔ target verifier
   * output) into the voice scheduler. Accepted tokens flow into the
   * phrase chunker; rejected ranges trigger the rollback queue. No-op
   * when voice is not active so callers can fan out events
   * unconditionally.
   *
   * AGENTS.md §4: "When DFlash + target produce an accepted text
   * token, the phrase chunker MUST hand the chunk to TTS within the
   * same scheduler tick — no buffering past phrase boundaries."
   */
  async pushVerifierEvent(event: VerifierStreamEvent): Promise<void> {
    const bridge = this.voiceBridge;
    if (!bridge) return;
    if (event.kind === "accept") {
      const now = Date.now();
      for (const tok of event.tokens) {
        await bridge.pushAcceptedToken(tok, now);
      }
      return;
    }
    if (event.tokens.length === 0) return;
    const range: RejectedTokenRange = {
      fromIndex: event.tokens[0].index,
      toIndex: event.tokens[event.tokens.length - 1].index,
    };
    await bridge.pushRejectedRange(range);
  }

  /**
   * Mic VAD → barge-in. Per AGENTS.md §4, the PCM ring buffer MUST
   * drain immediately and any in-flight TTS forward pass MUST be
   * cancelled at the next kernel boundary. The scheduler enforces both
   * — this is a thin pass-through.
   */
  triggerBargeIn(): void {
    this.voiceBridge?.triggerBargeIn();
  }

  /**
   * Test surface: fan an accepted-token list into the bridge in one
   * call. Production callers should prefer `pushVerifierEvent` so the
   * accept/reject discriminator stays explicit; this exists so the
   * voice integration test can drive the scheduler without
   * reconstructing `VerifierStreamEvent` boilerplate.
   */
  async pushAcceptedTokens(tokens: ReadonlyArray<TextToken>): Promise<void> {
    await this.pushVerifierEvent({ kind: "accept", tokens: [...tokens] });
  }

  /**
   * Active server's parallel slot count, or 1 when no llama-server
   * backend is running (the node-llama-cpp path has its own pool).
   */
  private activeParallel(): number {
    if (this.activeBackendId() === "llama-server") {
      return dflashLlamaServer.parallelSlots();
    }
    // node-llama-cpp: each session pool slot is effectively a "parallel"
    // for slot allocation purposes.
    return resolveDefaultPoolSize(process.env.ELIZA_LOCAL_SESSION_POOL_SIZE);
  }

  /**
   * Internal: build a DFlash server plan from a catalog entry. Exposed so
   * the llama-server backend can derive its full launch args from a unified
   * `BackendPlan` without reaching back into the engine.
   */
  static async resolveDflashPlanForPath(
    modelPath: string,
  ): Promise<DflashServerPlan | null> {
    const installed = await listInstalledModels();
    const target = installed.find((m) => m.path === modelPath);
    if (!target) return null;
    const catalog = findCatalogModel(target.id);
    const dflash = catalog?.runtime?.dflash;
    if (!dflash) return null;

    const status = getDflashRuntimeStatus();
    if (!status.enabled) {
      if (status.required) throw new Error(`[dflash] ${status.reason}`);
      return null;
    }

    const drafter = installed.find((m) => m.id === dflash.drafterModelId);
    if (!drafter) {
      const message = `[dflash] ${catalog.displayName} requires companion drafter ${dflash.drafterModelId}. Download the model again or start a download for the companion id.`;
      if (status.required) throw new Error(message);
      console.warn(`${message} Falling back to node-llama-cpp.`);
      return null;
    }

    return {
      targetModelPath: target.path,
      drafterModelPath: drafter.path,
      contextSize: dflash.contextSize,
      draftContextSize: dflash.draftContextSize,
      draftMin: dflash.draftMin,
      draftMax: dflash.draftMax,
      gpuLayers: dflash.gpuLayers,
      draftGpuLayers: dflash.draftGpuLayers,
      disableThinking: dflash.disableThinking,
    };
  }
}

export const localInferenceEngine = new LocalInferenceEngine();
