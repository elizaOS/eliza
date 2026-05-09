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

import type {
  GenerateArgs as BackendGenerateArgs,
  BackendPlan,
  LocalInferenceBackend,
} from "./backend";
import { BackendDispatcher } from "./backend";
import { findCatalogModel } from "./catalog";
import {
  type DflashServerPlan,
  dflashLlamaServer,
  dflashRequired,
  getDflashRuntimeStatus,
} from "./dflash-server";
import { listInstalledModels } from "./registry";
import {
  DEFAULT_SESSION_KEY,
  resolveDefaultPoolSize,
  SessionPool,
} from "./session-pool";

// Re-exported from backend.ts so consumers can keep importing GenerateArgs
// from engine.ts without churn. backend.ts owns the canonical shape,
// including the optional `cacheKey` for prefix reuse via the session pool.
export type GenerateArgs = BackendGenerateArgs;

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

interface LlamaModel {
  createContext(args?: {
    contextSize?: number;
    /**
     * Per-context sequence count. Each `LlamaChatSession` lives on its own
     * sequence, and the session pool needs at least `poolSize` sequences
     * available — otherwise `getSequence()` throws once the pool is full.
     */
    sequences?: number;
  }): Promise<LlamaContext>;
  dispose(): Promise<void>;
}

interface Llama {
  loadModel(args: {
    modelPath: string;
    gpuLayers?: number | "max" | "auto";
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
    const loadOptions: {
      modelPath: string;
      gpuLayers: number | "max" | "auto";
      useMmap?: boolean;
      useMlock?: boolean;
      defaultContextFlashAttention?: boolean;
    } = {
      modelPath,
      gpuLayers: "auto",
    };
    if (optimizations?.noMmap) loadOptions.useMmap = false;
    if (optimizations?.mlock) loadOptions.useMlock = true;
    if (optimizations?.flashAttention !== undefined) {
      loadOptions.defaultContextFlashAttention = optimizations.flashAttention;
    }

    const poolSize = resolveDefaultPoolSize(
      process.env.ELIZA_LOCAL_SESSION_POOL_SIZE,
    );
    const model = await this.llama.loadModel(loadOptions);
    // Reserve one sequence per pool slot. node-llama-cpp throws on
    // `getSequence()` once `sequencesLeft` hits 0, so the context must
    // be sized to the pool from the start.
    const context = await model.createContext({ sequences: poolSize });

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
      return session.prompt(args.prompt, {
        maxTokens: args.maxTokens ?? 2048,
        temperature: args.temperature ?? 0.7,
        topP: args.topP ?? 0.9,
        customStopTriggers: args.stopSequences,
      });
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
  );

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
    await this.dispatcher.unload();
  }

  async load(modelPath: string): Promise<void> {
    const installed = await listInstalledModels();
    const target = installed.find((m) => m.path === modelPath);
    const catalog = target ? findCatalogModel(target.id) : undefined;
    const plan: BackendPlan = {
      modelPath,
      modelId: target?.id,
      catalog,
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
      // If DFlash was the chosen backend but is not strictly required, fall
      // back to node-llama-cpp transparently. This preserves the prior
      // behaviour — the operator gets a working chat instead of an error
      // when the binary is missing.
      const decision = this.dispatcher.decide(plan);
      if (decision.backend === "llama-server" && !dflashRequired()) {
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
    return this.dispatcher.generate(args);
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
