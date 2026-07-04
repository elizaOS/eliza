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

import { existsSync } from "node:fs";
import { join as pathJoin } from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import {
  ELIZA_1_PLACEHOLDER_IDS,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
} from "./catalog";
import { localInferenceEngine } from "./engine";
import { recommendForFirstRun } from "./recommendation";
import { touchElizaModel } from "./registry";
import type { ActiveModelState, CatalogModel, InstalledModel } from "./types";

export type { KvOffloadMode, LocalInferenceLoadArgs } from "./load-args.js";
export {
  ELIZA_1_PLACEHOLDER_IDS,
  FIRST_RUN_DEFAULT_MODEL_ID,
  recommendForFirstRun,
};

import type { KvOffloadMode, LocalInferenceLoadArgs } from "./load-args.js";

/**
 * Allow-list for KV cache type strings. The eliza fork of node-llama-cpp
 * (v3.18.1-eliza.3+) extends `GgmlType` with TBQ3_0 (43), TBQ4_0 (44),
 * QJL1_256 (46), Q4_POLAR (47) so the binding accepts the lowercase
 * aliases below. Whether the C++ kernel actually runs depends on the
 * loaded `@node-llama-cpp/<platform>` binary — the elizaOS/llama.cpp
 * prebuild ships the kernels; upstream's prebuild does not.
 *
 * `validateLocalInferenceLoadArgs({ allowFork: false })` (the route-layer
 * default) still throws on these strings so a UI/API caller can't land
 * the desktop on a kernel that won't run; `allowFork: true` (the AOSP +
 * resolved-args path) lets them through.
 */
const FORK_ONLY_KV_CACHE_TYPES = new Set([
  "tbq1_0",
  "tbq2_0",
  "tbq3_0",
  "tbq4_0",
  "tbq3_0_tcq",
  "turbo2",
  "turbo3",
  "turbo4",
  "turbo2_0",
  "turbo3_0",
  "turbo4_0",
  "turbo2_tcq",
  "turbo3_tcq",
  "qjl1_256",
  "qjl1_512",
  "q4_polar",
]);

const STOCK_KV_CACHE_TYPES = new Set([
  "f16",
  "f32",
  "bf16",
  "q4_0",
  "q4_1",
  "q5_0",
  "q5_1",
  "q8_0",
  "q4_k",
  "q5_k",
  "q6_k",
  "q8_k",
  "iq4_nl",
]);

export function isForkOnlyKvCacheType(name: string | undefined): boolean {
  if (!name) return false;
  return FORK_ONLY_KV_CACHE_TYPES.has(name.trim().toLowerCase());
}

export function isStockKvCacheType(name: string | undefined): boolean {
  if (!name) return false;
  return STOCK_KV_CACHE_TYPES.has(name.trim().toLowerCase());
}

/**
 * Validate per-load overrides against what the in-process backend can
 * honour. The AOSP loader has its own (broader) acceptance set — pass
 * `{ allowFork: true }` to skip the desktop-only restriction.
 *
 * Throws on the first illegal value so the caller (the API route) can
 * surface a 400 with a useful message instead of letting the load slip
 * through and silently degrade to fp16.
 */
export function validateLocalInferenceLoadArgs(
  args: Partial<LocalInferenceLoadArgs>,
  options: { allowFork?: boolean } = {},
): void {
  const allowFork = options.allowFork === true;
  for (const field of ["cacheTypeK", "cacheTypeV"] as const) {
    const value = args[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${field} must be a non-empty string`);
    }
    if (!allowFork && isForkOnlyKvCacheType(value)) {
      throw new Error(
        `${field}="${value}" requires the elizaOS/llama.cpp kernel from the elizaOS fork. The elizaOS/node-llama-cpp binding accepts the string at the TS layer, but the upstream @node-llama-cpp/<platform> prebuild does not implement the underlying ggml type. Pass through the AOSP path or load the elizaOS/llama.cpp prebuilt binary. Stock-only types accepted here: ${[...STOCK_KV_CACHE_TYPES].join(", ")}.`,
      );
    }
    if (!allowFork && !isStockKvCacheType(value)) {
      throw new Error(
        `${field}="${value}" is not a recognised KV cache type. Stock builds accept ${[...STOCK_KV_CACHE_TYPES].join(", ")}.`,
      );
    }
  }
  if (args.contextSize !== undefined) {
    if (
      typeof args.contextSize !== "number" ||
      !Number.isInteger(args.contextSize) ||
      args.contextSize < 256
    ) {
      throw new Error(
        `contextSize must be a positive integer >= 256 (got ${String(args.contextSize)})`,
      );
    }
  }
  if (args.gpuLayers !== undefined) {
    if (
      typeof args.gpuLayers !== "number" ||
      !Number.isInteger(args.gpuLayers) ||
      args.gpuLayers < 0
    ) {
      throw new Error(
        `gpuLayers must be a non-negative integer (got ${String(args.gpuLayers)})`,
      );
    }
  }
  if (args.kvOffload !== undefined) {
    const v = args.kvOffload;
    if (typeof v === "string") {
      if (v !== "cpu" && v !== "gpu" && v !== "split") {
        throw new Error(
          `kvOffload must be "cpu", "gpu", "split", or { gpuLayers: number } (got "${v}")`,
        );
      }
    } else if (
      !v ||
      typeof v !== "object" ||
      typeof (v as { gpuLayers?: unknown }).gpuLayers !== "number"
    ) {
      throw new Error(
        `kvOffload must be "cpu", "gpu", "split", or { gpuLayers: number }`,
      );
    }
  }
  for (const field of ["flashAttention", "mmap", "mlock"] as const) {
    const value = args[field];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new Error(`${field} must be a boolean`);
    }
  }
}

export interface LocalInferenceLoader {
  loadModel(args: LocalInferenceLoadArgs): Promise<void>;
  unloadModel(): Promise<void>;
  currentModelPath(): string | null;
  /**
   * Optional generation surface. When a loader implements this, the runtime
   * handler (`ensure-local-inference-handler.ts`) routes TEXT_SMALL /
   * TEXT_LARGE requests through it instead of the standalone engine. Mobile
   * builds populate this via the Capacitor adapter; desktop leaves it undefined
   * and falls back to the `LocalInferenceEngine`.
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
 * minus `modelPath` (which the coordinator owns). The
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

function applyCatalogDefaults(
  args: LocalInferenceLoadArgs,
  catalog: CatalogModel | undefined,
): void {
  const runtime = catalog?.runtime;

  // KV cache types from the catalog runtime block. Per-call overrides
  // take precedence and are merged in afterwards.
  if (runtime?.kvCache?.typeK) args.cacheTypeK = runtime.kvCache.typeK;
  if (runtime?.kvCache?.typeV) args.cacheTypeV = runtime.kvCache.typeV;

  // Catalog-level model ceiling. Without a per-load override, plumb the
  // model's true `contextLength` so the loader picks an appropriate
  // window instead of falling back to whatever default the binding
  // happens to use ("auto" → smallest fitting, which historically meant
  // 4k or 8k even for 128k-trained models).
  if (catalog?.contextLength !== undefined && args.contextSize === undefined) {
    args.contextSize = catalog.contextLength;
  }

  // Catalog-declared GPU offload default — only apply when the caller
  // didn't override `gpuLayers`. Numeric `gpuLayers` is the canonical
  // shape; `"auto"` is the loader's default and we don't need to set
  // anything for it.
  if (
    catalog?.gpuLayers !== undefined &&
    typeof catalog.gpuLayers === "number" &&
    args.gpuLayers === undefined
  ) {
    args.gpuLayers = catalog.gpuLayers;
  }

  // flashAttention default from catalog optimizations block. Per-load
  // overrides win.
  if (
    runtime?.optimizations?.flashAttention !== undefined &&
    args.flashAttention === undefined
  ) {
    args.flashAttention = runtime.optimizations.flashAttention;
  }

  // mmap / mlock from catalog optimizations. `noMmap === true` means
  // disable mmap explicitly; otherwise leave the loader default.
  if (runtime?.optimizations?.noMmap !== undefined && args.mmap === undefined) {
    args.mmap = !runtime.optimizations.noMmap;
  }
  if (runtime?.optimizations?.mlock !== undefined && args.mlock === undefined) {
    args.mlock = runtime.optimizations.mlock;
  }
}

function mergeOverrides(
  args: LocalInferenceLoadArgs,
  overrides: LocalInferenceLoadOverrides | undefined,
): void {
  if (!overrides) return;
  if (overrides.contextSize !== undefined)
    args.contextSize = overrides.contextSize;
  if (overrides.cacheTypeK !== undefined)
    args.cacheTypeK = overrides.cacheTypeK;
  if (overrides.cacheTypeV !== undefined)
    args.cacheTypeV = overrides.cacheTypeV;
  if (overrides.gpuLayers !== undefined) args.gpuLayers = overrides.gpuLayers;
  if (overrides.kvOffload !== undefined) args.kvOffload = overrides.kvOffload;
  if (overrides.flashAttention !== undefined) {
    args.flashAttention = overrides.flashAttention;
  }
  if (overrides.mmap !== undefined) args.mmap = overrides.mmap;
  if (overrides.mlock !== undefined) args.mlock = overrides.mlock;
  if (overrides.useGpu !== undefined) args.useGpu = overrides.useGpu;
  if (overrides.maxThreads !== undefined)
    args.maxThreads = overrides.maxThreads;
}

function stripBundlePrefix(catalogFile: string, modelId: string): string {
  const slug = modelId.startsWith("eliza-1-")
    ? modelId.slice("eliza-1-".length)
    : modelId;
  const prefix = `bundles/${slug}/`;
  if (catalogFile.startsWith(prefix)) {
    return catalogFile.slice(prefix.length);
  }
  return catalogFile;
}

function resolveMtpDrafterPath(
  installed: InstalledModel,
  catalog: CatalogModel | undefined,
): string | undefined {
  const bundleRoot = installed.bundleRoot;
  if (!bundleRoot) return undefined;

  const catalogFile =
    catalog?.runtime?.mtp?.drafterFile ??
    catalog?.sourceModel?.components?.mtp?.file;
  if (!catalogFile) return undefined;

  const localPath = stripBundlePrefix(catalogFile, installed.id);
  const candidate = pathJoin(bundleRoot, localPath);
  return existsSync(candidate) ? candidate : undefined;
}

const DEFAULT_MOBILE_CONTEXT_CEILING = 8192;

/**
 * Whether on-device inference is running on a memory-constrained mobile
 * platform (iOS/Android), where the agent runs inside the embedded engine and
 * `process.env` carries the platform marker the host injects at start. Returns
 * false on desktop/server/web (no marker, or no `process`).
 */
function isMobileLocalInferenceRuntime(): boolean {
  if (typeof process === "undefined" || !process.env) return false;
  const platform = (
    process.env.ELIZA_MOBILE_PLATFORM ||
    process.env.ELIZA_PLATFORM ||
    ""
  )
    .trim()
    .toLowerCase();
  return platform === "ios" || platform === "android";
}

function mobileContextCeiling(): number {
  const raw = process.env?.ELIZA_MOBILE_CONTEXT_CEILING?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 256
    ? parsed
    : DEFAULT_MOBILE_CONTEXT_CEILING;
}

export async function resolveLocalInferenceLoadArgs(
  installed: InstalledModel,
  overrides?: LocalInferenceLoadOverrides,
): Promise<LocalInferenceLoadArgs> {
  const args: LocalInferenceLoadArgs = { modelPath: installed.path };
  const catalog = findCatalogModel(installed.id);
  const runtime = catalog?.runtime;

  applyCatalogDefaults(args, catalog);

  const mtp = runtime?.mtp;
  if (mtp) {
    // Same-file MTP (no `drafterFile`) embeds the NextN head in the text
    // GGUF and runs with no separate draft model; separate-drafter MTP
    // declares a `drafterFile` and needs the bundled drafter GGUF on disk.
    const sameFileMtp = !mtp.drafterFile;
    const drafterPath = sameFileMtp
      ? undefined
      : resolveMtpDrafterPath(installed, catalog);
    if (!sameFileMtp && !drafterPath) {
      // Back-compat with pre-MTP-cutover installs (#11517): bundles
      // downloaded before the tier's gemma4-assistant drafter was hosted
      // (and single-file installs with no bundleRoot) have no
      // `mtp/drafter-<tier>.gguf` on disk. The drafter is a perf-only
      // speculative-decoding artifact — never brick an installed model over
      // it. Load without MTP; re-downloading the bundle picks the drafter up.
      console.warn(
        `[local-inference] ${installed.id} declares a separate-drafter MTP but no drafter GGUF was found${
          installed.bundleRoot ? ` under ${installed.bundleRoot}` : ""
        }; loading without speculative decoding. Re-download the model to enable the MTP drafter.`,
      );
    } else {
      args.useGpu = true;
      args.draftModelPath = drafterPath;
      args.draftContextSize = args.contextSize;
      args.draftMin = mtp.draftMin;
      args.draftMax = mtp.draftMax;
      args.speculativeSamples = mtp.draftMax;
      args.mobileSpeculative = true;
      args.disableThinking = true;
    }
  }

  mergeOverrides(args, overrides);

  // Mobile context ceiling. A 128k-trained model's catalog `contextLength`
  // (e.g. 131072) implies a multi-GB KV cache — loading at that width on a
  // phone/simulator is impractically slow and OOMs, so the on-device agent's
  // first reply never lands. On iOS/Android, clamp the window (and any
  // speculative draft window) to a mobile-sane ceiling so local inference is
  // actually usable; desktop/server keep the full catalog ceiling. Override
  // with ELIZA_MOBILE_CONTEXT_CEILING for capable devices.
  if (args.contextSize !== undefined && isMobileLocalInferenceRuntime()) {
    const ceiling = mobileContextCeiling();
    if (args.contextSize > ceiling) args.contextSize = ceiling;
    if (
      args.draftContextSize !== undefined &&
      args.draftContextSize > ceiling
    ) {
      args.draftContextSize = ceiling;
    }
  }

  if (args.cacheTypeK) args.cacheTypeK = args.cacheTypeK.trim().toLowerCase();
  if (args.cacheTypeV) args.cacheTypeV = args.cacheTypeV.trim().toLowerCase();

  // Validate the final merged args. The route layer is the one
  // that calls `validateLocalInferenceLoadArgs` with `allowFork: false`
  // against just the overrides — see `local-inference-compat-routes.ts`.
  validateLocalInferenceLoadArgs(args, { allowFork: true });
  return args;
}

function isLoader(value: unknown): value is LocalInferenceLoader {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LocalInferenceLoader>;
  return (
    typeof candidate.loadModel === "function" &&
    typeof candidate.unloadModel === "function" &&
    typeof candidate.currentModelPath === "function"
  );
}

export class ActiveModelCoordinator {
  private state: ActiveModelState = {
    modelId: null,
    loadedAt: null,
    status: "idle",
  };

  private readonly listeners = new Set<(state: ActiveModelState) => void>();

  snapshot(): ActiveModelState {
    return { ...this.state };
  }

  subscribe(listener: (state: ActiveModelState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const current = { ...this.state };
    for (const listener of this.listeners) {
      try {
        listener(current);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }

  /** Return the loader service from the current runtime, if registered. */
  private getLoader(runtime: AgentRuntime | null): LocalInferenceLoader | null {
    if (!runtime) return null;
    const candidate = (
      runtime as {
        getService?: (name: string) => unknown;
      }
    ).getService?.("localInferenceLoader");
    return isLoader(candidate) ? candidate : null;
  }

  async switchTo(
    runtime: AgentRuntime | null,
    installed: InstalledModel,
    overrides?: LocalInferenceLoadOverrides,
  ): Promise<ActiveModelState> {
    this.state = {
      modelId: installed.id,
      loadedAt: null,
      status: "loading",
    };
    this.emit();

    // Prefer a runtime-registered loader (plugin-local-ai or equivalent)
    // when present — it will already have warmed up the right configuration.
    // Otherwise, fall back to the standalone engine, which is the default
    // path for users who haven't separately enabled plugin-local-ai.
    const loader = this.getLoader(runtime);

    try {
      const resolved = await resolveLocalInferenceLoadArgs(
        installed,
        overrides,
      );
      if (loader) {
        await loader.unloadModel();
        await loader.loadModel(resolved);
      } else {
        await localInferenceEngine.load(installed.path, resolved);
      }
      // Surface the effective load config so consumers (the benchmark
      // harness, the Settings UI, the active-model SSE) can verify the
      // requested overrides actually took hold instead of silently
      // falling back to a smaller context or fp16 KV.
      this.state = {
        modelId: installed.id,
        loadedAt: new Date().toISOString(),
        status: "ready",
        loadedContextSize: resolved.contextSize ?? null,
        loadedCacheTypeK: resolved.cacheTypeK ?? null,
        loadedCacheTypeV: resolved.cacheTypeV ?? null,
        loadedGpuLayers:
          typeof resolved.gpuLayers === "number" ? resolved.gpuLayers : null,
      };
      if (installed.source === "eliza-download") {
        await touchElizaModel(installed.id);
      }
    } catch (err) {
      this.state = {
        modelId: installed.id,
        loadedAt: null,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    this.emit();
    return this.snapshot();
  }

  async unload(runtime: AgentRuntime | null): Promise<ActiveModelState> {
    const loader = this.getLoader(runtime);
    try {
      if (loader) {
        await loader.unloadModel();
      } else {
        await localInferenceEngine.unload();
      }
    } catch (err) {
      this.state = {
        modelId: null,
        loadedAt: null,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        loadedContextSize: null,
        loadedCacheTypeK: null,
        loadedCacheTypeV: null,
        loadedGpuLayers: null,
      };
      this.emit();
      return this.snapshot();
    }
    this.state = {
      modelId: null,
      loadedAt: null,
      status: "idle",
      loadedContextSize: null,
      loadedCacheTypeK: null,
      loadedCacheTypeV: null,
      loadedGpuLayers: null,
    };
    this.emit();
    return this.snapshot();
  }
}
