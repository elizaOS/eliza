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
import { type Eliza1TierId, findCatalogModel } from "./catalog";
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
  logDflashDevDisabledWarning,
} from "./dflash-server";
import type { LocalUsageBlock } from "./llama-server-metrics";
import { MemoryMonitor } from "./memory-monitor";
import { listInstalledModels } from "./registry";
import {
  DEFAULT_SESSION_KEY,
  resolveDefaultPoolSize,
  SessionPool,
} from "./session-pool";
import { resolveGrammarForParams } from "./structured-output";
import {
  buildLocalEmbeddingRoute,
  type LocalEmbeddingRoute,
} from "./voice/embedding";
import {
  EngineVoiceBridge,
  type EngineVoiceBridgeOptions,
  VoiceStartupError,
} from "./voice/engine-bridge";
import type { VoicePipelineEvents } from "./voice/pipeline";
import { dflashTextRunner } from "./voice/pipeline-impls";
import {
  createEvictableModelRole,
  SharedResourceRegistry,
} from "./voice/shared-resources";
import type {
  RejectedTokenRange,
  TextToken,
  TranscriptionAudio,
  VerifierStreamEvent,
} from "./voice/types";

/**
 * Default DFlash draft window per round for voice turns. Small (≤8) so a
 * rollback is cheap (AGENTS.md §4 — "small chunk = low latency cost on
 * rollback"). Overridable per call via `runVoiceTurn({ maxDraftTokens })`.
 */
const DEFAULT_VOICE_MAX_DRAFT_TOKENS = 8;

/**
 * Idle-unload timeout (J3). After this long with no `useModel` activity
 * (text generation, embeddings, voice turns) the engine unloads the active
 * text model so its weights are reclaimed when the agent is quiet; the next
 * `useModel` lazy-reloads via the runtime handler. `0` disables it. Default
 * 15 minutes. Override via `ELIZA_LOCAL_IDLE_UNLOAD_MS`.
 */
const DEFAULT_IDLE_UNLOAD_MS = 15 * 60 * 1000;
/** How often the idle-unload timer checks the activity clock. */
const IDLE_UNLOAD_CHECK_INTERVAL_MS = 60 * 1000;

export function resolveIdleUnloadMs(): number {
  const raw = process.env.ELIZA_LOCAL_IDLE_UNLOAD_MS?.trim();
  if (raw === undefined) return DEFAULT_IDLE_UNLOAD_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_IDLE_UNLOAD_MS;
  return parsed;
}

/**
 * Cap on how many speculative voice responses the turn-controller (W9) may
 * have in flight at once — derived from the running server's slot count
 * (each speculative response needs a slot's KV) but never more than half of
 * them (the other half stays available for confirmed turns + tool calls).
 * Floors at 1. Override via `ELIZA_LOCAL_MAX_SPECULATIVE_RESPONSES`.
 */
export function resolveMaxConcurrentSpeculativeResponses(
  parallelSlots: number,
): number {
  const raw = process.env.ELIZA_LOCAL_MAX_SPECULATIVE_RESPONSES?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  return Math.max(1, Math.floor(parallelSlots / 2));
}

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

/**
 * Resolve the GBNF source for a node-llama-cpp constrained-decode call.
 * Precedence: an explicit `grammar` string on the args, then a compiled
 * forced skeleton (single-value enums collapsed to literals). Returns null
 * when neither is set — generation is unconstrained as before. node-llama-cpp
 * has no `grammar_lazy`, so a lazy grammar from the skeleton is applied
 * eagerly here; that's still correct (the leading literal is the trigger).
 */
function resolveBindingGrammarSource(args: GenerateArgs): string | null {
  const grammar = resolveGrammarForParams(args);
  return grammar ? grammar.source : null;
}

interface LlamaGrammar {
  // Opaque to us — passed straight back to `session.prompt({ grammar })`.
  readonly _grammarBrand?: never;
}

interface LlamaGrammarCtor {
  new (
    llama: Llama,
    options: { grammar: string; rootRuleName?: string },
  ): LlamaGrammar;
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
      grammar?: LlamaGrammar;
      onTextChunk?: (chunk: string) => void;
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
  LlamaGrammar: LlamaGrammarCtor;
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
    // Resolve a grammar from `args.grammar` (explicit GBNF) or a forced
    // skeleton. node-llama-cpp can do constrained decoding even though it
    // can't stream — wire the schema/grammar path here. The no-streaming
    // limitation means `streamStructured` degrades to one final chunk on
    // this backend.
    const grammarSource = resolveBindingGrammarSource(args);
    const grammar =
      grammarSource && this.bindingModule && this.llama
        ? new this.bindingModule.LlamaGrammar(this.llama, {
            grammar: grammarSource,
          })
        : undefined;
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
        grammar?: LlamaGrammar;
        onTextChunk?: (chunk: string) => void;
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
      if (grammar) promptOpts.grammar = grammar;
      // Assistant-turn prefill: node-llama-cpp has no first-class "continue
      // this assistant message" knob, so we seed the prompt text with the
      // partial assistant turn and re-prepend it to the result so callers
      // see the full assistant message.
      const prefill = typeof args.prefill === "string" ? args.prefill : "";
      const promptText =
        prefill.length > 0 ? `${args.prompt}\n${prefill}` : args.prompt;
      if (args.onTextChunk || args.onVerifierEvent) {
        let idx = 0;
        if (prefill.length > 0) {
          await args.onVerifierEvent?.({
            kind: "accept",
            tokens: [{ index: idx++, text: prefill }],
          });
          await args.onTextChunk?.(prefill);
        }
        promptOpts.onTextChunk = (chunk: string) => {
          if (chunk.length === 0) return;
          void args.onVerifierEvent?.({
            kind: "accept",
            tokens: [{ index: idx++, text: chunk }],
          });
          void args.onTextChunk?.(chunk);
        };
        const tail = await session.prompt(promptText, promptOpts);
        return prefill + tail;
      }
      // No callbacks were supplied (the `if` above returned otherwise) — plain
      // string return, no per-token fan-out.
      const tail = await session.prompt(promptText, promptOpts);
      return prefill + tail;
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
        "LlamaGrammar" in mod &&
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

  /**
   * The general onload/offload coordinator (W10 / J5). One registry per
   * engine: text + voice both ref-count their shared resources against it,
   * and every resident model role registers an `EvictableModelRole` here so
   * the `MemoryMonitor` can walk them ascending-priority under RAM pressure.
   * The voice bridge gets this passed in (see `startVoice`) so it doesn't
   * spin up a private one.
   */
  private readonly sharedResources = new SharedResourceRegistry({
    logger: {
      debug: (m) => console.debug(m),
      warn: (m) => console.warn(m),
      info: (m) => console.info(m),
    },
  });

  /**
   * RAM-pressure monitor (J2). Started when a model loads, stopped when the
   * engine unloads. Evicts the lowest-priority resident role when free RAM
   * crosses the low-water line.
   */
  private readonly memoryMonitor = new MemoryMonitor({
    registry: this.sharedResources,
    logger: {
      info: (m) => console.info(m),
      warn: (m) => console.warn(m),
      debug: (m) => console.debug(m),
    },
  });

  /** Wall-clock ms of the last `useModel`-style activity. */
  private lastActivityMs = Date.now();
  /** Idle-unload timer (J3); null when disabled or no model loaded. */
  private idleUnloadTimer: NodeJS.Timeout | null = null;
  /** Evictable text-target role id registered on `sharedResources`, or null. */
  private textTargetRoleId: string | null = null;
  /** Evictable drafter role id registered on `sharedResources`, or null. */
  private drafterRoleId: string | null = null;

  /**
   * The general onload/offload coordinator for this engine. Exposed so the
   * voice lifecycle, the embedding route, and any other resident model role
   * can register an `EvictableModelRole` against the same registry the
   * `MemoryMonitor` walks under pressure.
   */
  getSharedResources(): SharedResourceRegistry {
    return this.sharedResources;
  }

  /** The RAM-pressure monitor. Exposed for diagnostics / tests. */
  getMemoryMonitor(): MemoryMonitor {
    return this.memoryMonitor;
  }

  /** Record `useModel`-style activity so the idle-unload timer stays armed. */
  private markActivity(): void {
    this.lastActivityMs = Date.now();
  }

  /**
   * Once a model is resident: register the text-target (+ drafter when the
   * dflash server is running with one) as evictable roles, start the memory
   * monitor, and arm the idle-unload timer. Idempotent.
   */
  private startBackgroundManagement(): void {
    this.markActivity();
    this.registerResidentRoles();
    if (!this.memoryMonitor.isRunning()) this.memoryMonitor.start();
    this.armIdleUnloadTimer();
  }

  /** Stop the memory monitor + idle timer and deregister evictable roles. */
  private async stopBackgroundManagement(): Promise<void> {
    if (this.idleUnloadTimer) {
      clearInterval(this.idleUnloadTimer);
      this.idleUnloadTimer = null;
    }
    this.memoryMonitor.stop();
    await this.deregisterResidentRoles();
  }

  private registerResidentRoles(): void {
    if (this.textTargetRoleId === null) {
      const role = createEvictableModelRole({
        role: "text-target",
        isResident: () => this.hasLoadedModel(),
        evict: async () => {
          // Last thing to go. Evicting the text target = unload it; the
          // next `useModel` lazy-reloads via the runtime handler.
          await this.unload();
        },
      });
      this.sharedResources.acquire(role);
      this.textTargetRoleId = role.id;
    }
    if (this.drafterRoleId === null) {
      const role = createEvictableModelRole({
        role: "drafter",
        isResident: () =>
          this.activeBackendId() === "llama-server" &&
          dflashLlamaServer.drafterEnabled(),
        evict: async () => {
          await dflashLlamaServer.restartWithoutDrafter();
        },
      });
      this.sharedResources.acquire(role);
      this.drafterRoleId = role.id;
    }
  }

  private async deregisterResidentRoles(): Promise<void> {
    const ids = [this.textTargetRoleId, this.drafterRoleId].filter(
      (id): id is string => id !== null,
    );
    this.textTargetRoleId = null;
    this.drafterRoleId = null;
    for (const id of ids) {
      try {
        await this.sharedResources.release(id);
      } catch {
        // Already released (e.g. unload→release ran twice) — fine.
      }
    }
  }

  private armIdleUnloadTimer(): void {
    if (this.idleUnloadTimer) return;
    const idleMs = resolveIdleUnloadMs();
    if (idleMs <= 0) return;
    const timer = setInterval(() => {
      if (!this.hasLoadedModel()) return;
      if (Date.now() - this.lastActivityMs < idleMs) return;
      console.info(
        `[local-inference] No useModel activity for >${Math.round(idleMs / 1000)}s — unloading the active text model to reclaim RAM. It will reload on the next request.`,
      );
      void this.unload().catch((err) => {
        console.warn(
          `[local-inference] idle-unload failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, IDLE_UNLOAD_CHECK_INTERVAL_MS);
    timer.unref();
    this.idleUnloadTimer = timer;
  }

  /**
   * Cap on concurrent speculative voice responses (W9 / J4): derived from
   * the running server's slot count (each speculative response needs a KV
   * slot), never more than half of them, floored at 1. The voice
   * turn-controller reads this before kicking a speculative response.
   */
  maxConcurrentSpeculativeResponses(): number {
    return resolveMaxConcurrentSpeculativeResponses(this.activeParallel());
  }

  /**
   * Auto-tune the running server's `--parallel` (J4): when the conversation
   * high-water mark has outgrown the configured slot count AND there's RAM
   * headroom for the extra KV slots, restart llama-server with the larger
   * value so new conversations get their own slot instead of thrashing.
   * Returns `true` when a resize was performed. No-op on the node-llama-cpp
   * backend (its session pool sizes itself). Best-effort: a failed restart
   * leaves the old `--parallel` in place and logs.
   */
  async maybeAutoResizeParallel(): Promise<boolean> {
    if (this.activeBackendId() !== "llama-server") return false;
    if (!dflashLlamaServer.hasLoadedModel()) return false;
    const running = dflashLlamaServer.parallelSlots();
    const recommended = conversationRegistry.recommendedParallel(running);
    if (recommended <= running) return false;
    // Only grow when free RAM is comfortably above the low-water line —
    // adding KV slots under pressure would just trigger the monitor.
    const sample = await this.memoryMonitor.sample();
    if (this.memoryMonitor.isUnderPressure(sample)) {
      console.warn(
        `[local-inference] Conversation high-water mark wants --parallel ${recommended} (running ${running}) but RAM is tight (free ${sample.effectiveFreeMb} MB) — not resizing. Slot thrashing may occur; consider a smaller tier or more RAM.`,
      );
      return false;
    }
    try {
      const resized = await dflashLlamaServer.resizeParallel(recommended);
      if (resized) {
        console.info(
          `[local-inference] Resized llama-server --parallel ${running} → ${recommended} (conversation high-water mark grew).`,
        );
      }
      return resized;
    } catch (err) {
      console.warn(
        `[local-inference] --parallel resize to ${recommended} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

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
    // Stop the memory monitor + idle timer and deregister evictable roles
    // before anything else — they reference the model that's about to go.
    await this.stopBackgroundManagement();
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
      this.startBackgroundManagement();
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
        this.startBackgroundManagement();
        return;
      }
      throw err;
    }
  }

  async generate(args: GenerateArgs): Promise<string> {
    this.markActivity();
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
    this.markActivity();
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
   * KV-prefill a conversation's pinned slot with a known prompt prefix
   * (system prompt + provider context + tool/action schema block + the
   * assistant-turn start), before the real request lands. This is item I1 /
   * C1 of the voice swarm — fire it the moment a message arrives / STT
   * starts so the response-handler prompt is already in the slot's KV when
   * the user's tokens are appended.
   *
   * `conversationOrId` may be a `ConversationHandle` (preferred — pins to
   * the handle's slot) or a raw conversation id (a handle is opened on the
   * fly so the slot derivation matches the real request). Idempotent /
   * cheap to call repeatedly: `cache_prompt: true` reuses the prefix so a
   * second call is a no-op forward pass. Only meaningful on the
   * llama-server backend — the node-llama-cpp session pool already pins
   * by cache key, so this is a no-op (returns false) there. Returns true
   * when a pre-warm request was issued.
   */
  async prewarmConversation(
    conversationOrId: ConversationHandle | string,
    promptPrefix: string,
    opts: { modelId?: string } = {},
  ): Promise<boolean> {
    if (this.activeBackendId() !== "llama-server") return false;
    this.markActivity();
    let slotId: number;
    let cacheKey: string;
    if (typeof conversationOrId === "string") {
      const modelId =
        opts.modelId ?? this.currentModelPath() ?? "default-local-model";
      const handle =
        this.conversation(conversationOrId, modelId) ??
        this.openConversation({ conversationId: conversationOrId, modelId });
      slotId = handle.slotId;
      cacheKey = `conv:${handle.conversationId}`;
    } else {
      if (conversationOrId.closed) return false;
      slotId = conversationOrId.slotId;
      cacheKey = `conv:${conversationOrId.conversationId}`;
    }
    return dflashLlamaServer.prewarmConversation(promptPrefix, {
      slotId,
      cacheKey,
    });
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
   * Recommended `--parallel` value given the current conversation
   * high-water mark plus a small headroom (max(2, 25%)), never below the
   * running slot count. Delegates to `ConversationRegistry.recommendedParallel`
   * so the math lives in one place. When this exceeds `parallelSlots()` the
   * engine can grow the running server (`maybeAutoResizeParallel`).
   */
  recommendedParallel(): number {
    return conversationRegistry.recommendedParallel(this.activeParallel());
  }

  /**
   * Emit a one-line warning when the running `--parallel` slot count is
   * below the recommended value (high-water mark + headroom). Returns true
   * when a warning was emitted. No-op for the node-llama-cpp backend (its
   * session pool sizes itself). The actual resize is `maybeAutoResizeParallel()`
   * — kept separate from this hot-path check so a `useModel` call never
   * blocks on (or is interrupted by) a server restart; the auto-resize is
   * opted into via `ELIZA_LOCAL_AUTO_RESIZE_PARALLEL=1`, in which case this
   * also kicks one off fire-and-forget.
   */
  warnIfParallelTooLow(logger?: { warn: (msg: string) => void }): boolean {
    if (this.activeBackendId() !== "llama-server") return false;
    const actual = dflashLlamaServer.parallelSlots();
    const recommended = conversationRegistry.recommendedParallel(actual);
    if (recommended <= actual) return false;
    const message = `[local-inference] Conversation high-water mark (${conversationRegistry.highWater()}) exceeds running --parallel ${actual}. Recommended: ${recommended}. Restart llama-server with ELIZA_LOCAL_PARALLEL=${recommended} or higher (or set ELIZA_LOCAL_AUTO_RESIZE_PARALLEL=1) to avoid slot thrashing.`;
    if (logger?.warn) {
      logger.warn(message);
    } else {
      console.warn(message);
    }
    if (process.env.ELIZA_LOCAL_AUTO_RESIZE_PARALLEL === "1") {
      void this.maybeAutoResizeParallel().catch(() => {
        // Best-effort; the warning above already told the operator what to do.
      });
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
    // Pass the engine's shared-resource registry through so voice ref-counts
    // against the same canonical resources as text and the `MemoryMonitor`
    // sees voice's evictable roles too. The engine's registry is canonical —
    // callers don't get to substitute their own.
    this.voiceBridge = EngineVoiceBridge.start({
      ...opts,
      sharedResources: this.sharedResources,
    });
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
   * Assemble + run the full live voice loop on top of `startVoice()` /
   * `armVoice()`: mic → (`pipeMicToRingBuffer` + `VadDetector.pushFrame`)
   * per frame → `StreamingTranscriber.feed` (VAD-gated) → `VoiceTurnController`
   * (speculative-on-pause, abort-on-resume, finalize/promote, barge-in) →
   * `VoiceScheduler` → TTS → audio sink.
   *
   * Gated behind a complete real backend chain (AGENTS.md §3 — no silent
   * stub-mode "voice"):
   *   - a `MicSource` (caller-supplied, or `DesktopMicSource` under Electrobun),
   *   - a Silero ONNX VAD (caller-supplied detector, or `createSileroVadDetector()`),
   *   - a working ASR (the bridge's `createStreamingTranscriber` throws
   *     `AsrUnavailableError` when neither the fused decoder nor whisper.cpp
   *     is available),
   *   - a real OmniVoice TTS backend on the bridge (the `StubOmniVoiceBackend`
   *     is rejected — it emits zeros).
   * Any missing piece fails loudly with the specific component named.
   *
   * `prewarm` defaults to `this.prewarmConversation(roomId, "")` (best-effort
   * KV-prefill); a caller with the response-handler stable prefix (W6) should
   * pass its own. `generate` is required — it builds the message and runs the
   * runtime turn (streaming `replyText` into TTS via this engine's
   * `generate({ onTextChunk })`, which routes through the voice scheduler).
   */
  async startVoiceSession(opts: {
    roomId: string;
    /** Mic source. Defaults to a `DesktopMicSource` (Electrobun). */
    micSource?: import("./voice/types").MicSource;
    /** VAD detector. Defaults to `createSileroVadDetector()`. */
    vad?: import("./voice/vad").VadDetector;
    /** Run one turn: build the message + stream `replyText` into TTS. Required. */
    generate: (
      request: import("./voice/turn-controller").VoiceGenerateRequest,
    ) => Promise<import("./voice/turn-controller").VoiceTurnOutcome>;
    /** KV-prefill / response-handler-prefix prewarm. Defaults to `prewarmConversation`. */
    prewarm?: (roomId: string) => void | Promise<void>;
    speculatePauseMs?: number;
    events?: import("./voice/turn-controller").VoiceTurnControllerEvents;
  }): Promise<import("./voice/turn-controller").VoiceTurnController> {
    const bridge = this.requireVoiceBridge("start a voice session");
    if (bridge.lifecycle.current().kind !== "voice-on") {
      throw new VoiceStartupError(
        "not-started",
        "[voice] Cannot start a voice session: voice lifecycle is not armed. Call armVoice() first.",
      );
    }
    const backendId = (bridge.backend as { id?: string }).id;
    if (backendId === "stub") {
      throw new VoiceStartupError(
        "missing-fused-build",
        "[voice] Cannot start a live voice session on the StubOmniVoiceBackend (it emits silence). Start the bridge with useFfiBackend:true or a real backendOverride.",
      );
    }

    const [
      { DesktopMicSource, pipeMicToRingBuffer },
      vadMod,
      { VoiceTurnController },
      { InMemoryAudioSink },
    ] = await Promise.all([
      import("./voice/mic-source"),
      import("./voice/vad"),
      import("./voice/turn-controller"),
      import("./voice/ring-buffer"),
    ]);

    const micSource = opts.micSource ?? new DesktopMicSource();
    const vad = opts.vad ?? (await vadMod.createSileroVadDetector());

    // ASR — throws `AsrUnavailableError` when neither the fused decoder nor
    // whisper.cpp is present. Gated on the VAD so silent frames aren't
    // decoded.
    const transcriber = bridge.createStreamingTranscriber({ vad });

    const controller = new VoiceTurnController(
      {
        vad,
        transcriber,
        scheduler: bridge.scheduler,
        prewarm:
          opts.prewarm ??
          ((roomId: string) => {
            void this.prewarmConversation(roomId, "");
          }),
        generate: opts.generate,
      },
      {
        roomId: opts.roomId,
        ...(opts.speculatePauseMs !== undefined
          ? { speculatePauseMs: opts.speculatePauseMs }
          : {}),
      },
      opts.events ?? {},
    );

    // Mic → ring buffer (the buffer the ASR / instrumentation can read from)
    // + per-frame fan-out to the VAD and the streaming transcriber.
    const { unsubscribe: stopMicRing } = pipeMicToRingBuffer(
      micSource,
      new InMemoryAudioSink(),
    );
    const unsubFrame = micSource.onFrame((frame) => {
      // The VAD forward pass is serialized internally; fire-and-forget so a
      // slow frame doesn't backpressure the mic (the VAD records overruns).
      void vad.pushFrame(frame);
      transcriber.feed(frame);
    });

    controller.start();
    await micSource.start();

    // Single teardown knob: stopping the controller stops the mic chain too.
    const origStop = controller.stop.bind(controller);
    controller.stop = () => {
      origStop();
      unsubFrame();
      stopMicRing();
      void micSource.stop();
      transcriber.dispose();
    };
    return controller;
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
    this.markActivity();
    return this.requireVoiceBridge("synthesize speech").synthesizeTextToWav(
      text,
    );
  }

  async prewarmVoicePhrases(
    texts: ReadonlyArray<string>,
    opts: { concurrency?: number } = {},
  ): Promise<{ warmed: number; cached: number }> {
    return this.requireVoiceBridge("prewarm voice phrases").prewarmPhrases(
      texts,
      opts,
    );
  }

  /**
   * Idle-time auto-prewarm: synthesize the canonical common-phrase seed so
   * the phrase cache is warm before the next turn. No-op unless a real TTS
   * backend is present and voice is armed. Callers (the voice bridge /
   * connector) invoke this when the loop is idle.
   */
  async prewarmIdleVoicePhrases(
    opts: { concurrency?: number } = {},
  ): Promise<{ warmed: number; cached: number }> {
    return this.requireVoiceBridge(
      "prewarm idle voice phrases",
    ).prewarmIdlePhrases(opts);
  }

  /**
   * Play the first-audio filler (a short cached acknowledgement) — the seam
   * W9's turn controller calls the instant VAD fires `speech-start` to mask
   * first-token latency. Returns the played filler text, or `null` if none
   * was played. No-op without a real TTS backend / armed voice.
   */
  playFirstAudioFiller(): string | null {
    return this.requireVoiceBridge(
      "play first-audio filler",
    ).playFirstAudioFiller();
  }

  async transcribePcm(args: TranscriptionAudio): Promise<string> {
    this.markActivity();
    return this.requireVoiceBridge("transcribe audio").transcribePcm(args);
  }

  /**
   * Run one fused mic→speech voice turn through the overlapped
   * `VoicePipeline` (`packages/inference/AGENTS.md` §4): ASR → {DFlash
   * drafts ∥ target verifies} → phrase chunker → OmniVoice → PCM ring
   * buffer, with rollback-on-reject and barge-in cancel. The drafter and
   * verifier are wired against the running DFlash llama-server; the ASR is
   * the fused ABI's ASR. Requires `startVoice()` + `armVoice()` first.
   *
   * Resolves with the turn's exit reason (`done` / `token-cap` /
   * `cancelled`). A missing ASR region in voice mode surfaces as a
   * `VoiceStartupError` — no silent cloud fallback (AGENTS.md §3).
   */
  async runVoiceTurn(
    audio: TranscriptionAudio,
    opts: {
      maxDraftTokens?: number;
      maxGeneratedTokens?: number;
      events?: VoicePipelineEvents;
    } = {},
  ): Promise<"done" | "token-cap" | "cancelled"> {
    this.markActivity();
    const bridge = this.requireVoiceBridge("run a voice turn");
    return bridge.runVoiceTurn(
      audio,
      dflashTextRunner(dflashLlamaServer),
      {
        maxDraftTokens: opts.maxDraftTokens ?? DEFAULT_VOICE_MAX_DRAFT_TOKENS,
        maxGeneratedTokens: opts.maxGeneratedTokens,
      },
      opts.events,
    );
  }

  /**
   * Build the local-embedding route for an activated Eliza-1 bundle.
   * On `0_6b` the embedding model is the text backbone with `--pooling
   * last` (no separate GGUF); on `1_7b`/`9b`/`27b`/`27b-256k`/`27b-1m` a
   * dedicated 1024-dim Matryoshka `embedding/` region is used. See
   * AGENTS.md §1. Throws `VoiceStartupError` when a non-`0_6b` tier is
   * missing its dedicated region — no fallback to pooled text (which would
   * regress the dimension contract).
   */
  localEmbeddingRoute(args: {
    bundleRoot: string;
    tierId: Eliza1TierId;
    textModelPath?: string;
  }): LocalEmbeddingRoute {
    const textModelPath = args.textModelPath ?? this.currentModelPath() ?? "";
    return buildLocalEmbeddingRoute({
      bundleRoot: args.bundleRoot,
      tierId: args.tierId,
      textModelPath,
    });
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
    // AGENTS.md §4: when the developer kill-switch disables DFlash, every
    // generation turn must log a loud warning. No-op when the flag is unset.
    // Called before the voice early-return so text-only turns warn too.
    logDflashDevDisabledWarning();

    const bridge = this.voiceBridge;
    const voiceOn = bridge?.lifecycle.current().kind === "voice-on";
    if (!voiceOn || !bridge) {
      return {
        args,
        finish: async () => {},
      };
    }

    // Barge-in → LLM/drafter abort. A `hard-stop` from the scheduler's
    // barge-in controller (ASR-confirmed words, or `triggerBargeIn()`)
    // aborts this controller; we hand its signal to `dispatcher.generate`
    // so generation stops at the next kernel boundary — not just TTS
    // (AGENTS.md §4 / brief item 2). Composed with the caller's signal so
    // an external cancel still works.
    const bargeAbort = new AbortController();
    const detachBarge = bridge.scheduler.bargeIn.onSignal((signal) => {
      if (signal.type === "hard-stop" && !bargeAbort.signal.aborted) {
        bargeAbort.abort();
      }
    });
    const callerSignal = args.signal;
    if (callerSignal) {
      if (callerSignal.aborted) bargeAbort.abort();
      else
        callerSignal.addEventListener(
          "abort",
          () => {
            if (!bargeAbort.signal.aborted) bargeAbort.abort();
          },
          { once: true },
        );
    }

    let nextIndex = 0;
    let streamedAny = false;
    let verifierHandled = false;
    const callerOnTextChunk = args.onTextChunk;
    const callerOnVerifierEvent = args.onVerifierEvent;
    const wrapped = {
      ...args,
      signal: bargeAbort.signal,
      onVerifierEvent: async (event: VerifierStreamEvent) => {
        verifierHandled = true;
        if (event.kind === "accept" && event.tokens.length > 0) {
          streamedAny = true;
          const last = event.tokens[event.tokens.length - 1];
          nextIndex = Math.max(nextIndex, last.index + 1);
        }
        await this.pushVerifierEvent(event);
        await callerOnVerifierEvent?.(event);
      },
      onTextChunk: async (chunk: string) => {
        if (chunk.length > 0 && !verifierHandled) {
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
        try {
          if (
            !streamedAny &&
            finalText.length > 0 &&
            !bargeAbort.signal.aborted
          ) {
            await bridge.pushAcceptedToken({
              index: nextIndex++,
              text: finalText,
            });
          }
          await bridge.settle();
        } finally {
          detachBarge();
        }
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
   * Real `DflashDrafterHandle` backed by the running llama-server's `-md`
   * drafter, or null when no llama-server is running with a drafter
   * configured (node-llama-cpp has no drafter — text-only, no speculative
   * decoding). The voice lifecycle wraps this in its shared-resource
   * registry so the drafter is refcounted alongside the text weights
   * (AGENTS.md §4 — the drafter is always wired and shared by text + voice
   * modes). The engine doesn't cache the handle: `createDflashDrafterHandle`
   * is cheap and the registry deduplicates by id.
   */
  async dflashDrafterHandle(): Promise<
    import("./voice/shared-resources").DflashDrafterHandle | null
  > {
    if (this.activeBackendId() !== "llama-server") return null;
    const drafterPath = dflashLlamaServer.loadedDrafterModelPath();
    if (!drafterPath) return null;
    const installed = await listInstalledModels();
    const drafter = installed.find((m) => m.path === drafterPath);
    const { createDflashDrafterHandle } = await import(
      "./voice/shared-resources"
    );
    return createDflashDrafterHandle({
      drafterModelId: drafter?.id ?? drafterPath,
      drafterModelPath: drafterPath,
    });
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
