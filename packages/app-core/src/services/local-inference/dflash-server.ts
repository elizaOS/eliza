/**
 * Out-of-process llama-server backend for DFlash speculative decoding.
 *
 * DFlash needs llama-server flags (`-md`, `--spec-type dflash`) that the
 * in-process node-llama-cpp API does not expose. This backend is deliberately
 * small: spawn a compatible llama-server, wait for health, and use the
 * OpenAI-compatible chat endpoint so llama-server applies the model chat
 * template and reasoning controls consistently with LlamaChatSession.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  GenerateArgs as BackendGenerateArgs,
  BackendPlan,
  LocalInferenceBackend,
} from "./backend";
import { gpuLayersForKvOffload } from "./backend";
import {
  buildModelHash,
  type CacheStatsEntry,
  DEFAULT_CACHE_TTLS,
  deriveSlotId,
  evictExpired,
  readCacheStats,
  slotCacheFileName,
  slotSavePath,
} from "./cache-bridge";
import { ELIZA_1_PLACEHOLDER_IDS, findCatalogModel } from "./catalog";
import { probeHardware } from "./hardware";
import {
  estimateQuantizedKvBytesPerToken,
  KV_SPILL_MIN_CONTEXT,
  type KvSpillPlan,
  planKvSpill,
  residentKvBudgetFromRamBudget,
  restoreClassForHardware,
} from "./kv-spill";
import {
  diffSnapshots,
  fetchMetricsSnapshot,
  type LocalUsageBlock,
} from "./llama-server-metrics";
import { localInferenceRoot } from "./paths";
import { ramHeadroomReserveMb, resolveRamBudget } from "./ram-budget";
import {
  grammarRequestFields,
  resolveGrammarForParams,
  type StructuredGenerateParams,
} from "./structured-output";
import type {
  CatalogModel,
  InstalledModel,
  LocalRuntimeOptimizations,
} from "./types";
import type { VerifierStreamEvent } from "./voice/types";

export interface DflashServerPlan {
  targetModelPath: string;
  drafterModelPath: string;
  contextSize: number;
  draftContextSize: number;
  draftMin: number;
  draftMax: number;
  gpuLayers: number | "auto";
  draftGpuLayers: number | "auto";
  kvOffload?: DflashKvOffloadMode;
  disableThinking: boolean;
  /**
   * Target model parameter count (`"1.7B"`, `"27B"`, …). Used only to size
   * the RAM-derived `--parallel` default — each slot's KV footprint scales
   * with `(params, contextSize)`. Optional: when absent, `resolveParallel`
   * falls back to the static default rather than the RAM heuristic.
   */
  params?: string;
  /**
   * KV-cache spill plan for context > 64k (packages/inference/AGENTS.md §3
   * item 7). Resolved in `load()` from the catalog + a hardware probe + the
   * bundle's RAM budget. `null`/absent when the context is short enough that
   * the whole cache fits resident. When `mode === "spill"` the server is
   * launched with `--no-kv-offload` so the cold pages live in host RAM, plus
   * a `--cache-ram` hint sized to the resident pages. A
   * `KvSpillUnsupportedError` thrown by `planKvSpill` propagates out of
   * `load()` so the engine surfaces a structured 4xx — there is no
   * silent-slow fallback.
   */
  kvSpillPlan?: KvSpillPlan | null;
  /**
   * Explicit `--parallel N` override, set by `resizeParallel()` when the
   * conversation high-water mark outgrows the running slot count and there
   * is RAM headroom. Wins over the env / catalog / RAM-derived defaults in
   * `resolveParallel`.
   */
  parallelOverride?: number;
  /**
   * Restart without the DFlash drafter (`-md`) — set by `restartWithoutDrafter()`
   * as the last-resort memory-pressure eviction for the drafter role (the
   * drafter is co-resident in this process, so dropping it means a relaunch).
   * When true, `start()` omits `-md`, `--spec-type dflash`, and the `--draft-*`
   * / `--ctx-size-draft` / `--n-gpu-layers-draft` flags. `drafterModelPath`
   * is still carried in the plan so a subsequent re-arm can put it back.
   */
  disableDrafter?: boolean;
  /**
   * Absolute paths to the bundle's OmniVoice GGUFs (`tts/omnivoice-*.gguf`
   * and `tts/omnivoice-tokenizer-*.gguf`). When BOTH are set AND the
   * resolved `llama-server` is the omnivoice-fused build, `start()` passes
   * `--omnivoice-model` / `--omnivoice-codec` so the same process serves
   * `POST /v1/audio/speech` (AGENTS.md §4 — fused, not an IPC second
   * process). Absent on non-voice bundles or non-fused builds, in which
   * case TTS goes through the FFI `ttsSynthesize` path instead.
   */
  ttsModelPath?: string;
  ttsCodecPath?: string;
}

export type DflashKvOffloadMode = "cpu" | "gpu" | "split";

export interface DflashGenerateArgs extends StructuredGenerateParams {
  prompt: string;
  stopSequences?: string[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /**
   * Optional `promptCacheKey` from the runtime cache plan. When set the
   * server pins the request to a deterministic `slot_id` so identical
   * keys reuse the same in-RAM KV cache, and the slot file on disk
   * preserves prefix tokens across restarts.
   */
  cacheKey?: string;
  /**
   * Explicit slot id, set when the caller already reserved a slot via
   * `conversationRegistry.open()`. Wins over `cacheKey` derivation. -1
   * disables slot pinning ("any free slot").
   */
  slotId?: number;
  /** Per-request abort signal forwarded to llama-server's HTTP request. */
  signal?: AbortSignal;
  /** Incremental accepted text chunks from streaming chat completions. */
  onTextChunk?: (chunk: string) => void | Promise<void>;
  /**
   * Speculative verifier event stream. Today this backend synthesizes
   * accept events from OpenAI streaming deltas; native DFlash builds can
   * replace that with exact accept/reject token ranges without changing
   * callers.
   */
  onVerifierEvent?: (event: VerifierStreamEvent) => void | Promise<void>;
}

/**
 * Per-call result from `generateWithUsage`. The `text` field matches the
 * existing `generate` return; `usage` is the Anthropic-shape block scraped
 * from llama-server's `/metrics` endpoint plus the response's own
 * per-call `usage` body. `slotId` is reported back so callers that did
 * not pre-reserve a slot can see which one the server picked.
 */
export interface DflashGenerateResult {
  text: string;
  usage: LocalUsageBlock;
  slotId: number;
}

export interface DflashMetricsSnapshot {
  decoded: number;
  drafted: number;
  accepted: number;
  acceptanceRate: number;
}

export interface DflashRuntimeStatus {
  enabled: boolean;
  required: boolean;
  binaryPath: string | null;
  reason: string;
  /**
   * Kernels actually compiled into the installed binary, parsed from
   * CAPABILITIES.json next to the binary. Null when the file is absent
   * (older fork builds, manually-installed binaries without the probe).
   * The dispatcher consults this before loading a catalog model with a
   * `requiresKernel` declaration that isn't satisfied here.
   */
  capabilities: DflashBinaryCapabilities | null;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_START_TIMEOUT_MS = 120_000;

/**
 * Map a llama-server `--cache-type-k/v` value to the `CAPABILITIES.json`
 * kernel bit that must be `true` in the installed binary for that cache type
 * to be safe. Cache types not in this map (`f16`, `q8_0`, …) are stock and
 * always allowed. Used by `assertCacheTypeSupportedOnBackend` so the refusal
 * keys off the *real* shipped-kernel set, not a static "decorative-only"
 * blocklist (L1 — the kernel-patches now do real work; see
 * `packages/app-core/scripts/kernel-patches/{metal,vulkan}-kernels.mjs`).
 */
const CACHE_TYPE_REQUIRED_KERNEL: Record<
  string,
  keyof DflashBinaryCapabilities["kernels"]
> = {
  turbo3: "turbo3",
  turbo3_0: "turbo3",
  turbo4: "turbo4",
  turbo4_0: "turbo4",
  turbo3_tcq: "turbo3_tcq",
  // turbo2* are the older naming for the same families — gate on turbo3.
  turbo2: "turbo3",
  turbo2_0: "turbo3",
  turbo2_tcq: "turbo3_tcq",
  qjl1_256: "qjl_full",
  qjl_full: "qjl_full",
  polar: "polarquant",
  polarquant: "polarquant",
};

const DFLASH_METRIC_ALIASES = {
  decoded: ["llamacpp:n_decode_total", "llamacpp:n_decode"],
  drafted: ["llamacpp:n_drafted_total", "llamacpp:n_drafted"],
  accepted: [
    "llamacpp:n_drafted_accepted_total",
    "llamacpp:n_drafted_accepted",
    "llamacpp:n_accepted_total",
    "llamacpp:n_accepted",
  ],
} as const;

export function parseDflashMetrics(body: string): DflashMetricsSnapshot | null {
  const samples = new Map<string, { unlabeled: number | null; labeledSum: number }>();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(
      /^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i,
    );
    if (!match) continue;
    const name = match[1];
    const labels = match[2];
    const value = Number(match[3]);
    if (!name || !Number.isFinite(value)) continue;
    const bucket = samples.get(name) ?? { unlabeled: null, labeledSum: 0 };
    if (labels) bucket.labeledSum += value;
    else bucket.unlabeled = value;
    samples.set(name, bucket);
  }

  const readFirst = (aliases: readonly string[]): number | null => {
    for (const alias of aliases) {
      const bucket = samples.get(alias);
      if (bucket !== undefined) return bucket.unlabeled ?? bucket.labeledSum;
    }
    return null;
  };

  const drafted = readFirst(DFLASH_METRIC_ALIASES.drafted);
  const accepted = readFirst(DFLASH_METRIC_ALIASES.accepted);
  if (drafted === null || accepted === null) return null;

  const decoded = readFirst(DFLASH_METRIC_ALIASES.decoded) ?? 0;
  return {
    decoded,
    drafted,
    accepted,
    acceptanceRate: drafted > 0 ? accepted / drafted : Number.NaN,
  };
}

function readBool(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function allowZeroDraftForDiagnostics(): boolean {
  return readBool("ELIZA_DFLASH_ALLOW_ZERO_DRAFT");
}

export function shouldRequireActiveDflashForRequest(
  plan: Pick<DflashServerPlan, "disableDrafter" | "draftMin"> | null | undefined,
  maxTokens: number | null | undefined,
): boolean {
  if (!plan || plan.disableDrafter || allowZeroDraftForDiagnostics()) {
    return false;
  }
  if (!Number.isFinite(maxTokens) || maxTokens == null) return true;
  // The verifier can only test a draft after the first target token, and
  // llama.cpp's server refuses drafts smaller than draftMin. One-token
  // prewarm and tiny control probes should not be mistaken for a skipped
  // DFlash path.
  return maxTokens >= Math.max(1, plan.draftMin) + 2;
}

/**
 * Developer-only escape hatch from the always-on speculative-decoding
 * contract (`packages/inference/AGENTS.md` §4: "DFlash is always on… If
 * the user disables speculative decoding for debugging, that is a
 * developer-only flag (`MILADY_DFLASH_DISABLE=1`), it is not a user
 * setting, and it MUST log a loud warning every turn.").
 *
 * This is NOT a product setting — there is no UI surface and no
 * `MILADY_LOCAL_*` mapping. It exists so a developer can bisect a
 * suspected DFlash regression. When set, `dflashEnabled()` returns false
 * (the dispatcher then routes to node-llama-cpp) and every generation
 * turn that runs while it is set logs `logDflashDevDisabledWarning()`.
 */
export function dflashDevDisabled(): boolean {
  return readBool("MILADY_DFLASH_DISABLE");
}

/**
 * Emit the loud, every-turn warning required by AGENTS.md §4 when the
 * developer kill-switch is active. Callers invoke this once per
 * generation turn (text or voice). No-op when the flag is unset, so the
 * call site can be unconditional.
 */
export function logDflashDevDisabledWarning(): void {
  if (!dflashDevDisabled()) return;
  console.warn(
    "[local-inference] ⚠️  MILADY_DFLASH_DISABLE=1 — speculative decoding is OFF. " +
      "This is a developer-only debug flag, NOT a product setting. Eliza-1's " +
      "always-on DFlash contract is violated for this turn; voice latency and " +
      "throughput are degraded. Unset MILADY_DFLASH_DISABLE to restore the " +
      "shipped path.",
  );
}

function managedDflashBinaryPath(): string {
  return path.join(
    localInferenceRoot(),
    "bin",
    "dflash",
    platformKey(),
    "llama-server",
  );
}

/**
 * Backend keys whose fused (`omnivoice-grafted`) build directory we probe
 * for a `llama-server` that also serves `/v1/audio/speech` in-process. The
 * fused build links `omnivoice-core` into `llama-server`, so launching it
 * means text + DFlash + TTS run in one process — `packages/inference/
 * AGENTS.md` §4 ("We do not run text and voice in two processes
 * communicating over IPC"). We prefer the fused binary over the stock one
 * whenever both exist for the active backend.
 */
function fusedBackendKey(): string {
  const forced = process.env.ELIZA_DFLASH_BACKEND?.trim().toLowerCase();
  const backend = forced
    ? forced
    : process.platform === "darwin"
      ? "metal"
      : process.env.HIP_VISIBLE_DEVICES || process.env.ROCR_VISIBLE_DEVICES
        ? "rocm"
        : process.env.CUDA_VISIBLE_DEVICES &&
            process.env.CUDA_VISIBLE_DEVICES !== "-1"
          ? "cuda"
          : "cpu";
  return `${process.platform}-${process.arch}-${backend}-fused`;
}

function managedFusedDflashDir(): string {
  return path.join(localInferenceRoot(), "bin", "dflash", fusedBackendKey());
}

/**
 * Path of the fused `llama-server` (`<...>/<platform>-<arch>-<backend>-
 * fused/llama-server`), or null when no fused build is installed for the
 * active backend or its `CAPABILITIES.json` does not advertise the
 * omnivoice fusion (`fused: true` / `omnivoice` non-null). When this
 * returns a path the spawn layer launches it as the single fused server
 * instead of the stock `llama-server` + a second `llama-omnivoice-server`
 * process.
 */
export function resolveFusedDflashBinary(): string | null {
  if (readBool("ELIZA_DFLASH_DISABLE_FUSED_SERVER")) return null;
  const dir = managedFusedDflashDir();
  const bin = path.join(dir, "llama-server");
  if (!fs.existsSync(bin)) return null;
  const caps = readCapabilitiesAt(path.join(dir, "CAPABILITIES.json"));
  if (!caps) return null;
  const fused =
    caps.fused === true ||
    (caps.binaries ?? []).some(
      (b) => /omnivoice/i.test(b) || /libelizainference/i.test(b),
    );
  return fused ? bin : null;
}

function managedDflashCapabilitiesPath(): string {
  return path.join(
    localInferenceRoot(),
    "bin",
    "dflash",
    platformKey(),
    "CAPABILITIES.json",
  );
}

/**
 * Shape of CAPABILITIES.json written by `build-llama-cpp-dflash.mjs` next to
 * each installed binary. Mirrors the build script's CapabilitiesJson type
 * — keep these in sync.
 */
export interface DflashBinaryCapabilities {
  target: string;
  platform: string;
  arch: string;
  backend: string;
  builtAt: string;
  fork: string;
  forkCommit: string;
  kernels: {
    dflash: boolean;
    turbo3: boolean;
    turbo4: boolean;
    turbo3_tcq: boolean;
    qjl_full: boolean;
    polarquant: boolean;
    lookahead: boolean;
    ngramDraft: boolean;
  };
  binaries: string[];
  /**
   * True for `*-fused` targets — the omnivoice-grafted build where
   * `llama-server` links `omnivoice-core` and serves `/v1/audio/speech`
   * in-process. Absent on older / non-fused builds.
   */
  fused?: boolean;
  /**
   * Omnivoice fusion metadata for `*-fused` builds (pin, commit, source
   * count, symbol-verify report). `null` on non-fused builds.
   */
  omnivoice?: unknown;
}

function readCapabilitiesAt(capsPath: string): DflashBinaryCapabilities | null {
  let raw: string;
  try {
    raw = fs.readFileSync(capsPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DflashBinaryCapabilities;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.kernels === "object" &&
      parsed.kernels !== null
    ) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

let capabilitiesCache: {
  path: string;
  mtimeMs: number;
  caps: DflashBinaryCapabilities;
} | null = null;

/**
 * Read CAPABILITIES.json for the currently-installed binary, if present.
 * Returns null when the file is missing or unreadable — older binaries
 * built before the capabilities probe landed simply don't have it.
 *
 * Cached by path+mtime so repeated probes are cheap.
 */
export function readDflashBinaryCapabilities(): DflashBinaryCapabilities | null {
  const capsPath = managedDflashCapabilitiesPath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(capsPath);
  } catch {
    return null;
  }
  if (
    capabilitiesCache &&
    capabilitiesCache.path === capsPath &&
    capabilitiesCache.mtimeMs === stat.mtimeMs
  ) {
    return capabilitiesCache.caps;
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(capsPath, "utf8"),
    ) as DflashBinaryCapabilities;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.kernels === "object" &&
      parsed.kernels !== null
    ) {
      capabilitiesCache = {
        path: capsPath,
        mtimeMs: stat.mtimeMs,
        caps: parsed,
      };
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

function isMetalDflashRuntime(): boolean {
  return platformKey().endsWith("-metal");
}

function dflashMetalAutoEnabled(): boolean {
  return (
    readBool("ELIZA_DFLASH_METAL_AUTO") ||
    readBool("ELIZA_DFLASH_METAL_ENABLED")
  );
}

/**
 * Refuse a `--cache-type-k/v` value when the installed llama-server binary
 * doesn't advertise the required kernel in `CAPABILITIES.json`. The blocklist
 * is no longer static: `kernel-patches/[metal,vulkan]-kernels.mjs` compile the
 * turbo / qjl / polar kernels into the fork now, and `build-llama-cpp-dflash.mjs`
 * records which ones actually shipped under `kernels.*`. So a Metal binary
 * built with the kernel patches enabled passes; one without them is refused
 * with an actionable "rebuild your fork" message. When `CAPABILITIES.json` is
 * absent (older / hand-built binaries) we trust the request and let the load
 * attempt clarify — same policy as the dispatcher's `unsatisfiedKernels`.
 */
function assertCacheTypeSupportedOnBackend(name: string, value: string): void {
  const requiredKernel = CACHE_TYPE_REQUIRED_KERNEL[value.toLowerCase()];
  if (!requiredKernel) return; // stock cache type (f16/q8_0/...) — always ok
  const caps = readDflashBinaryCapabilities();
  if (!caps) return; // no capability probe — trust the request, load clarifies
  if (caps.kernels[requiredKernel] === true) return; // shipped — allow
  throw new Error(
    `${name}=${value} requires the '${requiredKernel}' kernel, but the installed llama-server binary's CAPABILITIES.json reports it absent. Rebuild the fork with the matching kernel patches (node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target <triple>) or use a stock KV cache type (f16/q8_0).`,
  );
}

export function dflashEnabled(): boolean {
  // Developer kill-switch wins over everything, including ELIZA_DFLASH_ENABLED.
  // See dflashDevDisabled() — this is a debug-only hatch, never a product path.
  if (dflashDevDisabled()) return false;
  if (readBool("ELIZA_DFLASH_DISABLED")) return false;
  if (readBool("ELIZA_DFLASH_ENABLED")) return true;
  // A fused build's `llama-server` (omnivoice-grafted, serves
  // `/v1/audio/speech` in-process) counts as an installed managed binary.
  if (
    !fs.existsSync(managedDflashBinaryPath()) &&
    resolveFusedDflashBinary() === null
  ) {
    return false;
  }
  if (isMetalDflashRuntime()) return dflashMetalAutoEnabled();
  return true;
}

export function dflashRequired(): boolean {
  return readBool("ELIZA_DFLASH_REQUIRED");
}

function candidateBinaryPaths(): string[] {
  const explicit = process.env.ELIZA_DFLASH_LLAMA_SERVER?.trim();
  const out = explicit ? [explicit] : [];
  // Prefer the fused `llama-server` whenever a fused build is installed:
  // it serves text/DFlash AND `/v1/audio/speech` from one process, which
  // is the product target (AGENTS.md §4 — no IPC second TTS process). An
  // explicit override (ELIZA_DFLASH_LLAMA_SERVER) still wins.
  if (!explicit) {
    const fused = resolveFusedDflashBinary();
    if (fused) out.push(fused);
  }
  out.push(managedDflashBinaryPath());
  if (readBool("ELIZA_DFLASH_ENABLED")) out.push("llama-server");
  return out;
}

function platformKey(): string {
  const forced = process.env.ELIZA_DFLASH_BACKEND?.trim().toLowerCase();
  if (forced) return `${process.platform}-${process.arch}-${forced}`;
  const backend =
    process.platform === "darwin"
      ? "metal"
      : process.env.HIP_VISIBLE_DEVICES || process.env.ROCR_VISIBLE_DEVICES
        ? "rocm"
        : process.env.CUDA_VISIBLE_DEVICES &&
            process.env.CUDA_VISIBLE_DEVICES !== "-1"
          ? "cuda"
          : "cpu";
  return `${process.platform}-${process.arch}-${backend}`;
}

export function resolveDflashBinary(): string | null {
  for (const candidate of candidateBinaryPaths()) {
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const pathEnv = process.env.PATH ?? "";
    for (const dir of pathEnv.split(path.delimiter)) {
      const resolved = path.join(dir, candidate);
      if (fs.existsSync(resolved)) return resolved;
    }
  }
  return null;
}

export function getDflashRuntimeStatus(): DflashRuntimeStatus {
  const binary = resolveDflashBinary();
  const capabilities = readDflashBinaryCapabilities();
  if (!dflashEnabled()) {
    const managedBinaryExists = fs.existsSync(managedDflashBinaryPath());
    const reason = dflashDevDisabled()
      ? "DFlash is disabled by the developer-only MILADY_DFLASH_DISABLE flag. This is NOT a product setting — unset it to restore the always-on speculative-decoding contract."
      : managedBinaryExists && isMetalDflashRuntime()
        ? "DFlash Metal binary found but auto-disabled because the current Eliza-1 Metal path is faster target-only; set ELIZA_DFLASH_ENABLED=1 or ELIZA_DFLASH_METAL_AUTO=1 to force it."
        : "DFlash auto-enables when the managed llama-server binary is installed; set ELIZA_DFLASH_ENABLED=1 to force a PATH/explicit binary, or run packages/app-core/scripts/build-llama-cpp-dflash.mjs.";
    return {
      enabled: false,
      required: dflashRequired(),
      binaryPath: binary,
      reason,
      capabilities,
    };
  }
  if (!binary) {
    return {
      enabled: false,
      required: dflashRequired(),
      binaryPath: null,
      reason:
        "No compatible llama-server found. Set ELIZA_DFLASH_LLAMA_SERVER or run packages/app-core/scripts/build-llama-cpp-dflash.mjs.",
      capabilities,
    };
  }
  return {
    enabled: true,
    required: dflashRequired(),
    binaryPath: binary,
    reason: "DFlash llama-server binary found.",
    capabilities,
  };
}

function normalizeGpuLayers(value: number | "auto"): string {
  return value === "auto" ? "99" : String(value);
}

function resolveDflashGpuLayers(
  overrides: BackendPlan["overrides"],
  fallback: number | "auto",
): number | "auto" {
  if (typeof overrides?.gpuLayers === "number") return overrides.gpuLayers;
  if (overrides?.gpuLayers === "auto") return "auto";
  if (overrides?.gpuLayers === "max") return "auto";
  if (
    overrides?.kvOffload !== undefined &&
    typeof overrides.kvOffload === "object"
  ) {
    const mapped = gpuLayersForKvOffload(overrides.kvOffload);
    return mapped === "max" ? "auto" : mapped;
  }
  if (overrides?.useGpu === false) return 0;
  return fallback;
}

function normalizeDflashKvOffloadMode(
  value: string | undefined,
): DflashKvOffloadMode | null {
  const mode = value?.trim().toLowerCase();
  if (mode === "cpu" || mode === "gpu" || mode === "split") return mode;
  return null;
}

export function resolveDflashKvOffload(
  overrides: BackendPlan["overrides"] | null | undefined,
): DflashKvOffloadMode | null {
  if (typeof overrides?.kvOffload === "string") {
    return normalizeDflashKvOffloadMode(overrides.kvOffload);
  }
  return normalizeDflashKvOffloadMode(process.env.ELIZA_LOCAL_KV_OFFLOAD);
}

export function appendKvOffloadFlags(
  args: string[],
  mode: DflashKvOffloadMode | null,
): string[] {
  if (mode === "cpu") {
    args.push("--no-kv-offload");
  }
  return args;
}

/** True when `id` is one of the Eliza-1 tier ids (bundles that ship voice). */
function isEliza1TierCatalogId(id: string): boolean {
  return ELIZA_1_PLACEHOLDER_IDS.has(id);
}

/**
 * Resolve a bundle's OmniVoice GGUFs from the text model path. An Eliza-1
 * bundle is laid out `<bundle>/text/<text>.gguf` + `<bundle>/tts/
 * omnivoice-<size>.gguf` + `<bundle>/tts/omnivoice-tokenizer-<size>.gguf`
 * (see packages/inference/AGENTS.md §2 bundle layout). Returns `null` when
 * the layout doesn't match or either GGUF is missing — the caller then
 * leaves `ttsModelPath`/`ttsCodecPath` unset and TTS uses the FFI path.
 */
export function findBundleOmnivoiceAssets(
  textModelPath: string,
): { modelPath: string; codecPath: string } | null {
  const textDir = path.dirname(textModelPath);
  if (path.basename(textDir) !== "text") return null;
  const ttsDir = path.join(path.dirname(textDir), "tts");
  let entries: string[];
  try {
    entries = fs.readdirSync(ttsDir);
  } catch {
    return null;
  }
  const tokenizer = entries.find((e) =>
    /^omnivoice-tokenizer-[^/]*\.gguf$/i.test(e),
  );
  const model = entries.find(
    (e) => /^omnivoice-[^/]*\.gguf$/i.test(e) && !/tokenizer/i.test(e),
  );
  if (!model || !tokenizer) return null;
  return {
    modelPath: path.join(ttsDir, model),
    codecPath: path.join(ttsDir, tokenizer),
  };
}

/**
 * Resolve the KV-cache spill plan for a llama-server launch.
 *
 * Returns `null` when `contextSize <= 64k` (no spill by contract). For longer
 * contexts it consults a hardware probe + the bundle's RAM budget via
 * `planKvSpill`:
 *   - whole cache fits resident → `{ mode: "resident" }` (caller ignores it),
 *   - fits with paging inside the latency budget → `{ mode: "spill", ... }`,
 *   - would miss the latency budget → `planKvSpill` throws
 *     `KvSpillUnsupportedError`, which propagates so the engine returns a
 *     structured 4xx instead of half-loading.
 *
 * Exported for `dflash-server.test.ts`.
 */
export async function resolveKvSpillPlan(args: {
  contextSize: number;
  catalog: CatalogModel | undefined;
  installed: InstalledModel | undefined;
  voiceEnabled: boolean;
}): Promise<KvSpillPlan | null> {
  if (!args.contextSize || args.contextSize <= KV_SPILL_MIN_CONTEXT) {
    return null;
  }
  const hardware = await probeHardware();
  const ram = args.catalog
    ? resolveRamBudget(args.catalog, args.installed)
    : null;
  // Without a catalog row there is no RAM budget to size the resident slice
  // against — fall back to a conservative 1 GiB resident-KV budget so the
  // spill math is still defined and fails closed on small devices.
  const residentKvBudgetBytes = ram
    ? residentKvBudgetFromRamBudget(ram)
    : 1024 * 1024 * 1024;
  const bytesPerToken = estimateQuantizedKvBytesPerToken(
    args.catalog?.params ?? "27B",
  );
  const hasDiscreteGpu = hardware.gpu !== null && !hardware.appleSilicon;
  // CPU spill is available when the host has appreciable RAM headroom over
  // the resident budget. Apple Silicon always has unified RAM; x86 needs the
  // total to comfortably exceed the resident slice.
  const cpuSpillAvailable =
    hardware.appleSilicon ||
    hardware.totalRamGb * 1024 * 1024 * 1024 > residentKvBudgetBytes * 2;
  return planKvSpill({
    requestedContext: args.contextSize,
    geometry: { bytesPerToken, voiceEnabled: args.voiceEnabled },
    residentKvBudgetBytes,
    restoreClass: restoreClassForHardware({
      appleSilicon: hardware.appleSilicon,
      hasDiscreteGpu,
    }),
    cpuSpillAvailable,
  });
}

/**
 * Translate a resolved KV-spill plan into llama-server flags. `resident`
 * (and `null`) are no-ops; `spill` forces the cold KV into host RAM with
 * `--no-kv-offload` and hints the resident working set with `--cache-ram`.
 */
export function appendKvSpillFlags(
  args: string[],
  plan: KvSpillPlan | null | undefined,
): string[] {
  if (!plan || plan.mode !== "spill") return args;
  if (!args.includes("--no-kv-offload")) {
    args.push("--no-kv-offload");
  }
  const cacheRamMb = Math.max(1, Math.floor(plan.residentBytes / 1024 / 1024));
  args.push("--cache-ram", String(cacheRamMb));
  return args;
}

function findPython(): string | null {
  for (const candidate of ["python3", "python"]) {
    const result = spawnSync(candidate, ["--version"], {
      stdio: "ignore",
      env: process.env,
    });
    if (result.status === 0) return candidate;
  }
  return null;
}

function maybeRepairDflashDrafter(
  binaryPath: string,
  targetModelPath: string,
  drafterModelPath: string,
): string {
  return maybeRepairGgufMerges(binaryPath, targetModelPath, drafterModelPath);
}

/**
 * If `strippedGgufPath` ships without `tokenizer.ggml.merges` metadata,
 * copy the merges from `sourceWithMergesPath` (a GGUF that *does* carry
 * them — the text backbone in this lineage; all five Eliza-1 components
 * share the 151,936-token Qwen vocab, B1's finding) into a sidecar
 * `<name>.repaired.gguf` and return that path; otherwise return the
 * original path unchanged. Used for the DFlash drafter and — per B1's
 * handoff — generalized to ASR and embedding GGUFs that ship the same
 * stripped tokenizer. A no-op when `ELIZA_DFLASH_REPAIR_DISABLED` is set,
 * when either input is missing, when Python/gguf-py isn't available, or
 * when the stripped GGUF already has merges.
 */
export function maybeRepairGgufMerges(
  binaryPath: string,
  sourceWithMergesPath: string,
  strippedGgufPath: string,
): string {
  if (readBool("ELIZA_DFLASH_REPAIR_DISABLED")) return strippedGgufPath;
  if (
    !fs.existsSync(sourceWithMergesPath) ||
    !fs.existsSync(strippedGgufPath)
  ) {
    return strippedGgufPath;
  }
  const targetModelPath = sourceWithMergesPath;
  const drafterModelPath = strippedGgufPath;

  const repairedPath = drafterModelPath.replace(/\.gguf$/i, ".repaired.gguf");
  if (repairedPath === drafterModelPath) return drafterModelPath;
  if (fs.existsSync(repairedPath)) return repairedPath;

  const python = findPython();
  if (!python) return drafterModelPath;

  const bundledGgufPy = path.join(path.dirname(binaryPath), "gguf-py");
  const pythonPath = [
    fs.existsSync(bundledGgufPy) ? bundledGgufPy : null,
    process.env.PYTHONPATH,
  ]
    .filter((value): value is string => Boolean(value))
    .join(path.delimiter);

  const repairCode = `
import sys
from pathlib import Path

if len(sys.argv) != 4:
    raise SystemExit("usage: repair_dflash.py TARGET DRAFTER OUT")

target = Path(sys.argv[1])
drafter = Path(sys.argv[2])
out = Path(sys.argv[3])

import gguf
from gguf.scripts.gguf_new_metadata import MetadataDetails, copy_with_new_metadata, get_field_data

target_reader = gguf.GGUFReader(target, "r")
draft_reader = gguf.GGUFReader(drafter, "r")

if get_field_data(draft_reader, gguf.Keys.Tokenizer.MERGES):
    print(drafter)
    raise SystemExit(0)

merges = get_field_data(target_reader, gguf.Keys.Tokenizer.MERGES)
if not merges:
    raise SystemExit("target GGUF has no tokenizer.ggml.merges metadata")

arch = get_field_data(draft_reader, gguf.Keys.General.ARCHITECTURE)
writer = gguf.GGUFWriter(out, arch=arch, endianess=draft_reader.endianess)
alignment = get_field_data(draft_reader, gguf.Keys.General.ALIGNMENT)
if alignment is not None:
    writer.data_alignment = alignment
copy_with_new_metadata(
    draft_reader,
    writer,
    {gguf.Keys.Tokenizer.MERGES: MetadataDetails(gguf.GGUFValueType.ARRAY, merges, sub_type=gguf.GGUFValueType.STRING)},
    [],
)
print(out)
`;

  const result = spawnSync(
    python,
    ["-c", repairCode, targetModelPath, drafterModelPath, repairedPath],
    {
      env: {
        ...process.env,
        ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
      },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    console.warn(
      "[local-inference] DFlash drafter tokenizer repair failed; trying original drafter:",
      result.stderr || result.stdout,
    );
    return drafterModelPath;
  }

  const outputPath = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
  return outputPath && fs.existsSync(outputPath)
    ? outputPath
    : drafterModelPath;
}

function resolvePort(): Promise<number> {
  const explicit = Number.parseInt(process.env.ELIZA_DFLASH_PORT ?? "", 10);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Promise.resolve(explicit);
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, DEFAULT_HOST, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(
            new Error("Could not allocate a loopback port for llama-server"),
          );
        }
      });
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 60_000,
  externalSignal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `HTTP ${res.status} from ${url}${body ? `: ${body}` : ""}`,
      );
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  }
}

export function extractStreamingChatDelta(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const record = json as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  let out = "";
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const c = choice as Record<string, unknown>;
    const delta = c.delta;
    if (delta && typeof delta === "object") {
      const content = (delta as Record<string, unknown>).content;
      if (typeof content === "string") out += content;
      continue;
    }
    const text = c.text;
    if (typeof text === "string") out += text;
  }
  return out;
}

/**
 * Extract a DFlash verifier reject-range from a streaming SSE chunk, if the
 * fork's `--spec-type dflash` server attached one. The contract (see
 * docs/porting/dflash-drafter-strategy.md "DFlash↔TTS Rollback Coupling"):
 * when the target rejects a contiguous span of previously-streamed
 * drafted tokens, the chunk carries `{ "verifier": { "rejected": [a, b] } }`
 * (inclusive token-index range, in target output order). Returns the
 * `[a, b]` pair, or null when the chunk has no reject extension.
 *
 * Upstream llama-server does not emit this today — the field is the agreed
 * extension point for the native verifier-event stream (remaining-work
 * ledger "Native DFlash verifier event stream"). Until then this returns
 * null for every real chunk and the synthesized accept-only stream is what
 * runs in production. The shape is parsed (not faked) so the moment the
 * fork emits it, rollback is exact with no further runtime changes.
 */
export function extractVerifierRejectRange(
  json: unknown,
): [number, number] | null {
  if (!json || typeof json !== "object") return null;
  const verifier = (json as Record<string, unknown>).verifier;
  if (!verifier || typeof verifier !== "object") return null;
  const rejected = (verifier as Record<string, unknown>).rejected;
  if (
    Array.isArray(rejected) &&
    rejected.length === 2 &&
    typeof rejected[0] === "number" &&
    typeof rejected[1] === "number" &&
    Number.isInteger(rejected[0]) &&
    Number.isInteger(rejected[1]) &&
    rejected[0] >= 0 &&
    rejected[1] >= rejected[0]
  ) {
    return [rejected[0], rejected[1]];
  }
  return null;
}

async function fetchStreamingChatCompletion(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  callbacks: {
    onTextChunk?: (chunk: string) => void | Promise<void>;
    onVerifierEvent?: (event: VerifierStreamEvent) => void | Promise<void>;
  },
  externalSignal?: AbortSignal,
  startIndex = 0,
): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `HTTP ${res.status} from ${url}${body ? `: ${body}` : ""}`,
      );
    }
    if (!res.body) {
      throw new Error(`[dflash] Streaming response from ${url} had no body`);
    }

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = "";
    let text = "";
    let nextIndex = startIndex;
    const consumeEvent = async (raw: string): Promise<void> => {
      const dataLines = raw
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart());
      if (dataLines.length === 0) return;
      const data = dataLines.join("\n").trim();
      if (!data || data === "[DONE]") return;
      const parsed = JSON.parse(data);

      // Native DFlash reject-range, if the fork attached one: retract the
      // already-streamed drafted tokens in [a, b] and rewind the index
      // cursor so re-decoded tokens get the correct indices. The phrase
      // chunker drops the not-yet-spoken audio for the overlapping phrases.
      const rejectRange = extractVerifierRejectRange(parsed);
      if (rejectRange) {
        const [from, to] = rejectRange;
        if (callbacks.onVerifierEvent) {
          const tokens = [];
          for (let i = from; i <= to; i += 1)
            tokens.push({ index: i, text: "" });
          await callbacks.onVerifierEvent({ kind: "reject", tokens });
        }
        nextIndex = Math.min(nextIndex, from);
        return;
      }

      const chunk = extractStreamingChatDelta(parsed);
      if (!chunk) return;
      text += chunk;
      if (callbacks.onVerifierEvent) {
        await callbacks.onVerifierEvent({
          kind: "accept",
          tokens: [{ index: nextIndex++, text: chunk }],
        });
      }
      await callbacks.onTextChunk?.(chunk);
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.search(/\r?\n\r?\n/);
      while (sep !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(buffer[sep] === "\r" ? sep + 4 : sep + 2);
        await consumeEvent(raw);
        sep = buffer.search(/\r?\n\r?\n/);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await consumeEvent(buffer);
    return text;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  }
}

/**
 * Default `--parallel` when caching is enabled and nothing else (env,
 * catalog, RAM-derived sizing) applies. Higher values give more distinct
 * cache slots so concurrent prefixes don't evict each other, at the cost
 * of KV memory. 4 is a balance that works for a single-user desktop while
 * still saturating a single GPU under load.
 */
const DEFAULT_CACHE_PARALLEL = 4;
/** Upper bound on the auto-derived / auto-resized slot count. */
const MAX_AUTO_PARALLEL = 16;
const BYTES_PER_MB_DFLASH = 1024 * 1024;

/**
 * RAM-derived `--parallel` default: each slot holds one KV cache of size
 * `bytesPerSlot ≈ estimateQuantizedKvBytesPerToken(params) * contextSize`.
 * We let the slots' combined KV occupy at most ~25% of usable host RAM
 * (the weights + activations + OS need the rest), clamped to
 * `[2, MAX_AUTO_PARALLEL]`. With a 1.7B model at 32k that's many slots;
 * with a 27B model at 128k it collapses toward 2 — exactly the "scale
 * concurrency to the hardware" behaviour the brief asks for.
 */
function derivePreferredParallel(args: {
  contextSize: number;
  params: string;
  usableRamMb: number;
}): number {
  const bytesPerSlot =
    estimateQuantizedKvBytesPerToken(args.params) * args.contextSize;
  if (!Number.isFinite(bytesPerSlot) || bytesPerSlot <= 0) {
    return DEFAULT_CACHE_PARALLEL;
  }
  const slotBudgetMb = Math.max(0, args.usableRamMb * 0.25);
  const slotMb = bytesPerSlot / BYTES_PER_MB_DFLASH;
  if (slotMb <= 0) return DEFAULT_CACHE_PARALLEL;
  const fits = Math.floor(slotBudgetMb / slotMb);
  return Math.min(MAX_AUTO_PARALLEL, Math.max(2, fits));
}

/**
 * Resolve `--parallel`. Order: explicit `override` (from `resizeParallel`)
 * → ELIZA_LOCAL_PARALLEL (generalised) → ELIZA_DFLASH_PARALLEL (legacy) →
 * catalog `optimizations.parallel` → RAM-derived default (when a budget
 * context is supplied) → DEFAULT_CACHE_PARALLEL. The operator's env wins
 * over the catalog and the RAM heuristic; the explicit override wins over
 * everything (it's a deliberate auto-resize decision).
 */
function resolveParallel(
  catalogParallel?: number,
  budget?: { contextSize: number; params: string; usableRamMb: number },
  override?: number,
): number {
  if (
    typeof override === "number" &&
    Number.isFinite(override) &&
    override >= 1
  ) {
    return Math.min(MAX_AUTO_PARALLEL, Math.floor(override));
  }
  for (const raw of [
    process.env.ELIZA_LOCAL_PARALLEL,
    process.env.ELIZA_DFLASH_PARALLEL,
  ]) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  if (
    typeof catalogParallel === "number" &&
    Number.isFinite(catalogParallel) &&
    catalogParallel >= 1
  ) {
    return catalogParallel;
  }
  if (budget) return derivePreferredParallel(budget);
  return DEFAULT_CACHE_PARALLEL;
}

/**
 * Append optimization flags driven by env overrides + catalog metadata to a
 * llama-server arg list. Env wins over the catalog when both supply the
 * same knob — the operator's escape hatch.
 *
 * Env mapping (per AGENTS.md / task brief):
 *
 *   ELIZA_LOCAL_LOOKAHEAD=N        → --lookahead N
 *   ELIZA_LOCAL_NGRAM=on           → enable n-gram drafter (uses
 *                                    optimizations.ngramDraft when set,
 *                                    else conservative defaults)
 *   ELIZA_LOCAL_PARALLEL=N         → --parallel N (handled by resolveParallel
 *                                    at the call site, not here)
 *   ELIZA_LOCAL_CACHE_REUSE=N      → --cache-reuse N
 *   ELIZA_LOCAL_CACHE_RAM_MB=N     → --cache-ram N
 *   ELIZA_LOCAL_BATCH_SIZE=N       → --batch-size N
 *   ELIZA_LOCAL_UBATCH_SIZE=N      → --ubatch-size N
 *   ELIZA_LOCAL_CONT_BATCHING=0|1  → --cont-batching / --no-cont-batching
 *   ELIZA_LOCAL_KV_UNIFIED=0|1     → --kv-unified / --no-kv-unified
 *   ELIZA_LOCAL_OP_OFFLOAD=0|1     → --op-offload / --no-op-offload
 *   ELIZA_LOCAL_KV_OFFLOAD=cpu     → --no-kv-offload (handled by
 *                                    appendKvOffloadFlags at start)
 *   ELIZA_LOCAL_MOE_OFFLOAD=cpu    → -ot ".*=CPU"
 *   ELIZA_LOCAL_MLOCK=1            → --mlock
 *   ELIZA_LOCAL_NO_MMAP=1          → --no-mmap
 *   ELIZA_LOCAL_FLASH_ATTENTION=on → -fa on (DFlash already implies it via
 *                                    spec config; this is for non-DFlash
 *                                    llama-server use cases)
 */
function readBoolFlag(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined) return undefined;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") {
    return true;
  }
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return false;
  }
  return undefined;
}

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function appendPositiveIntFlag(
  args: string[],
  flag: string,
  value: number | undefined,
): void {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  ) {
    args.push(flag, String(value));
  }
}

function appendBooleanFlag(
  args: string[],
  enabledFlag: string,
  disabledFlag: string,
  value: boolean | undefined,
): void {
  if (value === true) args.push(enabledFlag);
  if (value === false) args.push(disabledFlag);
}

export function appendOptimizationFlags(
  args: string[],
  optimizations: LocalRuntimeOptimizations | null,
): string[] {
  // --lookahead N
  const lookaheadEnv = process.env.ELIZA_LOCAL_LOOKAHEAD?.trim();
  const lookaheadValue = lookaheadEnv
    ? Number.parseInt(lookaheadEnv, 10)
    : optimizations?.lookahead;
  if (
    typeof lookaheadValue === "number" &&
    Number.isFinite(lookaheadValue) &&
    lookaheadValue > 0
  ) {
    args.push("--lookahead", String(lookaheadValue));
  }

  // N-gram drafter — only meaningful when DFlash is NOT in use (mutually
  // exclusive). Caller is responsible for not setting ngramDraft on a
  // DFlash-configured catalog entry.
  const ngramEnvOn = readBoolFlag("ELIZA_LOCAL_NGRAM");
  const ngramConfig = optimizations?.ngramDraft;
  const ngramEffective =
    ngramEnvOn === false
      ? null
      : (ngramConfig ?? (ngramEnvOn ? { min: 4, max: 8, minProb: 0.5 } : null));
  if (ngramEffective) {
    args.push("--draft-min", String(ngramEffective.min));
    args.push("--draft-max", String(ngramEffective.max));
    args.push("--draft-min-prob", String(ngramEffective.minProb));
  }

  appendPositiveIntFlag(
    args,
    "--cache-reuse",
    readPositiveIntEnv("ELIZA_LOCAL_CACHE_REUSE") ?? optimizations?.cacheReuse,
  );
  appendPositiveIntFlag(
    args,
    "--cache-ram",
    readPositiveIntEnv("ELIZA_LOCAL_CACHE_RAM_MB") ?? optimizations?.cacheRamMb,
  );
  appendPositiveIntFlag(
    args,
    "--batch-size",
    readPositiveIntEnv("ELIZA_LOCAL_BATCH_SIZE") ?? optimizations?.batchSize,
  );
  appendPositiveIntFlag(
    args,
    "--ubatch-size",
    readPositiveIntEnv("ELIZA_LOCAL_UBATCH_SIZE") ?? optimizations?.ubatchSize,
  );
  appendBooleanFlag(
    args,
    "--cont-batching",
    "--no-cont-batching",
    readBoolFlag("ELIZA_LOCAL_CONT_BATCHING") ?? optimizations?.contBatching,
  );
  appendBooleanFlag(
    args,
    "--kv-unified",
    "--no-kv-unified",
    readBoolFlag("ELIZA_LOCAL_KV_UNIFIED") ?? optimizations?.kvUnified,
  );
  appendBooleanFlag(
    args,
    "--op-offload",
    "--no-op-offload",
    readBoolFlag("ELIZA_LOCAL_OP_OFFLOAD") ?? optimizations?.opOffload,
  );

  // -ot ".*=CPU" — MoE expert offload to CPU.
  const moeEnv = process.env.ELIZA_LOCAL_MOE_OFFLOAD?.trim().toLowerCase();
  const moeMode = moeEnv ?? optimizations?.moeOffload;
  if (moeMode === "cpu") {
    args.push("-ot", ".*=CPU");
  }

  // --mlock
  const mlockEnv = readBoolFlag("ELIZA_LOCAL_MLOCK");
  const mlock = mlockEnv ?? optimizations?.mlock;
  if (mlock === true) args.push("--mlock");

  // --no-mmap
  const noMmapEnv = readBoolFlag("ELIZA_LOCAL_NO_MMAP");
  const noMmap = noMmapEnv ?? optimizations?.noMmap;
  if (noMmap === true) args.push("--no-mmap");

  // --mmproj <path>
  const mmprojEnv = process.env.ELIZA_LOCAL_MMPROJ?.trim();
  const mmproj = mmprojEnv || optimizations?.mmproj;
  if (mmproj) args.push("--mmproj", mmproj);

  // --alias <name>
  const aliasEnv = process.env.ELIZA_LOCAL_ALIAS?.trim();
  const alias = aliasEnv || optimizations?.alias;
  if (alias) args.push("--alias", alias);

  // -fa on / -fa off (catalog default off so existing DFlash behaviour
  // — which compiles flash attention into the spec config — is unchanged
  // unless the operator opts in).
  const faEnv = readBoolFlag("ELIZA_LOCAL_FLASH_ATTENTION");
  const fa = faEnv ?? optimizations?.flashAttention;
  if (fa === true) args.push("-fa", "on");

  return args;
}

/**
 * Default eviction sweep interval. Set to 5 minutes to match the short
 * TTL — a slot file at most one short-TTL window stale before it's
 * deleted. Override via `ELIZA_LOCAL_EVICTION_INTERVAL_MS`.
 */
const DEFAULT_EVICTION_INTERVAL_MS = 5 * 60 * 1000;

function resolveEvictionIntervalMs(): number {
  const raw = process.env.ELIZA_LOCAL_EVICTION_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_EVICTION_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 60_000) {
    // Anything under a minute is almost certainly a typo; clamp to
    // protect the disk from sweep storms.
    return DEFAULT_EVICTION_INTERVAL_MS;
  }
  return parsed;
}

/**
 * Keep-alive sweep interval. Sits just under the short TTL (5 min) so an
 * idle-but-alive conversation gets its slot KV re-warmed before the radix
 * cache would evict it. Override via `ELIZA_LOCAL_KEEPALIVE_INTERVAL_MS`.
 */
const DEFAULT_KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000;
/** Re-warm a slot once it has been untouched for this fraction of the short TTL. */
const KEEPALIVE_STALE_FRACTION = 0.8;

function resolveKeepAliveIntervalMs(): number {
  const raw = process.env.ELIZA_LOCAL_KEEPALIVE_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_KEEPALIVE_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 30_000)
    return DEFAULT_KEEPALIVE_INTERVAL_MS;
  return parsed;
}

export class DflashLlamaServer implements LocalInferenceBackend {
  readonly id = "llama-server" as const;

  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private stderrTail: string[] = [];
  private loadedPlan: DflashServerPlan | null = null;
  /**
   * Absolute path of the `llama-server` binary the running process was
   * spawned from (the fused omnivoice-grafted build when one is installed,
   * else the stock build). Used to read the matching `CAPABILITIES.json`
   * — which lives next to the binary, not at the canonical non-fused path
   * — when reporting `audioSpeechRoute()`.
   */
  private loadedBinaryPath: string | null = null;
  /**
   * Cache state captured at `start()`. The model hash + parallel count
   * stay constant for the lifetime of the spawned process so we record
   * them once and reuse them on every `generate()` call.
   */
  private cacheModelHash: string | null = null;
  private cacheParallel: number = DEFAULT_CACHE_PARALLEL;
  private cacheSlotDir: string | null = null;
  /**
   * `optimizations` passed to the last successful `start()`, so a
   * `resizeParallel()` / `restartWithoutDrafter()` relaunch can re-apply
   * the same llama-server flags.
   */
  private lastOptimizations: LocalRuntimeOptimizations | null = null;
  private evictionTimer: NodeJS.Timeout | null = null;
  /**
   * Per-conversation slot files persisted on shutdown for cross-restart
   * KV reuse. Distinct from the per-slot save dir: this directory keys
   * by conversation id, so a conversation that comes back with a different
   * slot id (e.g. after a --parallel resize) can still find its KV.
   */
  private conversationKvDir: string | null = null;
  /** Keep-alive timer that re-warms slot KV before the short TTL elapses. */
  private keepAliveTimer: NodeJS.Timeout | null = null;
  /**
   * Last `prewarmConversation` prompt prefix issued per slot, plus the
   * wall-clock ms it (or a real generate against that slot) was last
   * touched. The keep-alive sweep re-issues the prefix for slots that
   * haven't been touched within ~80% of the short TTL so the radix KV
   * doesn't get evicted out from under an idle-but-alive conversation.
   */
  private readonly lastPrewarmBySlot = new Map<
    number,
    { prefix: string; touchedAtMs: number }
  >();
  /**
   * Track which conversation ids have written KV state so far this
   * process lifetime. Used for diagnostics and the "did the last save
   * actually happen" assertion in tests.
   */
  private readonly persistedConversations = new Set<string>();

  hasLoadedModel(): boolean {
    return this.child !== null && this.loadedPlan !== null;
  }

  currentModelPath(): string | null {
    return this.loadedPlan?.targetModelPath ?? null;
  }

  /**
   * Path of the DFlash drafter GGUF the running server was launched with
   * (`-md`), or null when no server is loaded. The drafter is co-resident
   * with the target the whole time the server runs — there is no separate
   * "load drafter" step; `start()` passes `-md` and the fork mmaps both.
   * The voice shared-resource registry wraps this in a `DflashDrafterHandle`
   * so the lifecycle can refcount it alongside the text weights (AGENTS.md
   * §4 — the drafter is always wired and shared by text + voice modes).
   */
  loadedDrafterModelPath(): string | null {
    return this.loadedPlan?.drafterModelPath ?? null;
  }

  /** Loopback base URL of the running server, or null. Used by tests/diagnostics. */
  currentBaseUrl(): string | null {
    return this.baseUrl;
  }

  /**
   * Absolute path of the `llama-server` binary the running process was
   * spawned from (the fused build when one is installed), or null when no
   * server is up. Used by tests / diagnostics to confirm the fused path
   * was taken.
   */
  currentBinaryPath(): string | null {
    return this.loadedBinaryPath;
  }

  /** CAPABILITIES.json for the binary the running server was launched from. */
  private runningBinaryCapabilities(): DflashBinaryCapabilities | null {
    if (this.loadedBinaryPath) {
      const caps = readCapabilitiesAt(
        path.join(path.dirname(this.loadedBinaryPath), "CAPABILITIES.json"),
      );
      if (caps) return caps;
    }
    return readDflashBinaryCapabilities();
  }

  /**
   * Merged HTTP route descriptor for the fused build (`packages/inference/
   * AGENTS.md` §4 + remaining-work-ledger P0 #3): when the running
   * `llama-server` is the omnivoice-fused build it serves `/v1/audio/speech`
   * *itself*, in the same process as `/completion` + `/v1/chat/completions`
   * + the DFlash speculative loop — there is no compat
   * `llama-omnivoice-server` second process and no IPC tax. Returns the
   * route info (loopback base URL + the `/v1/audio/speech` path, `fused:
   * true`) only when a fused server is running; returns `null` for a stock
   * llama-server (text/DFlash only — TTS goes through the FFI
   * `ttsSynthesize` path instead) or when no server is up.
   *
   * "Fused" is detected from `CAPABILITIES.json` next to the running
   * binary: the fused build sets `fused: true` and its `binaries` list
   * includes `llama-omnivoice-server` / `libelizainference`.
   */
  audioSpeechRoute(): {
    baseUrl: string;
    speechPath: "/v1/audio/speech";
    fused: true;
  } | null {
    if (!this.baseUrl || !this.hasLoadedModel()) return null;
    const caps = this.runningBinaryCapabilities();
    if (!caps) return null;
    const fused =
      caps.fused === true ||
      (caps.binaries ?? []).some(
        (b) => /omnivoice/i.test(b) || /libelizainference/i.test(b),
      );
    if (!fused) return null;
    return {
      baseUrl: this.baseUrl,
      speechPath: "/v1/audio/speech",
      fused: true,
    };
  }

  /**
   * Synthesize speech through the fused server's in-process
   * `POST /v1/audio/speech` route (OpenAI Audio Speech shape). Returns the
   * 24 kHz mono PCM as a `Float32Array` plus the sample rate; the request
   * asks the server for raw `f32` PCM (`response_format: "pcm"`) so there
   * is no WAV decode step on the JS side.
   *
   * Throws when no fused server is running (`audioSpeechRoute()` is null) —
   * callers MUST check that first and fall back to the FFI `ttsSynthesize`
   * path. There is no silent fallback here (AGENTS.md §3).
   */
  async synthesizeSpeech(args: {
    text: string;
    voice?: string;
    signal?: AbortSignal;
  }): Promise<{ pcm: Float32Array; sampleRate: number }> {
    const route = this.audioSpeechRoute();
    if (!route) {
      throw new Error(
        "[dflash] synthesizeSpeech requires a fused omnivoice llama-server; " +
          "none is running (audioSpeechRoute() === null). Build a *-fused target " +
          "and reload, or route TTS through the FFI ttsSynthesize path.",
      );
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(args.signal?.reason);
    if (args.signal?.aborted) onAbort();
    args.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`${route.baseUrl}${route.speechPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: args.text,
          ...(args.voice ? { voice: args.voice } : {}),
          response_format: "pcm",
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `[dflash] /v1/audio/speech HTTP ${res.status}${body ? `: ${body}` : ""}`,
        );
      }
      const buf = await res.arrayBuffer();
      const sampleRate = Number(res.headers.get("X-Sample-Rate") ?? "24000");
      // The fused route emits little-endian f32 mono PCM for
      // `response_format: "pcm"`. Copy into an aligned Float32Array.
      const aligned = new ArrayBuffer(buf.byteLength);
      new Uint8Array(aligned).set(new Uint8Array(buf));
      return {
        pcm: new Float32Array(aligned),
        sampleRate: Number.isFinite(sampleRate) ? sampleRate : 24000,
      };
    } finally {
      args.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Scrape the running llama-server's `/metrics` endpoint and return a
   * `DflashMetricsSnapshot` with `drafted` / `accepted` / `decoded` counts.
   * Returns `null` when no server is loaded, the endpoint isn't reachable,
   * or the response doesn't contain the expected speculative counters.
   * Mirrors the UI twin's API so `dflash-doctor` works against either copy.
   */
  async getMetrics(): Promise<DflashMetricsSnapshot | null> {
    if (!this.baseUrl) return null;
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/metrics`, {
        method: "GET",
      });
      if (!res.ok) return null;
      return parseDflashMetrics(await res.text());
    } catch {
      return null;
    }
  }

  /**
   * Parallel slot count negotiated at `start()`. Used by the engine's
   * conversation handle API to size new conversations into available
   * slots. Returns the static default when no server is running.
   */
  parallelSlots(): number {
    return this.cacheParallel;
  }

  /** True when a server is running with the DFlash drafter (`-md`) wired. */
  drafterEnabled(): boolean {
    return this.hasLoadedModel() && !(this.loadedPlan?.disableDrafter ?? false);
  }

  /**
   * Restart the running server with a different `--parallel`. Used by the
   * engine's auto-tune (J4): when the conversation high-water mark outgrows
   * the running slot count and there's RAM headroom, this relaunches with
   * `targetParallel` slots so the new conversations get their own KV slots
   * instead of thrashing. No-op (returns false) when no server is running,
   * `targetParallel <= current`, or the target equals the current count.
   * Per-conversation KV is persisted across the restart by the engine's
   * `closeConversation` flow + the conversation-keyed slot dir.
   */
  async resizeParallel(targetParallel: number): Promise<boolean> {
    if (!this.hasLoadedModel() || !this.loadedPlan) return false;
    if (
      !Number.isFinite(targetParallel) ||
      targetParallel <= this.cacheParallel
    ) {
      return false;
    }
    const clamped = Math.min(MAX_AUTO_PARALLEL, Math.floor(targetParallel));
    if (clamped === this.cacheParallel) return false;
    await this.start(
      { ...this.loadedPlan, parallelOverride: clamped },
      this.lastOptimizations,
    );
    return true;
  }

  /**
   * Last-resort memory-pressure eviction for the DFlash drafter role: relaunch
   * the server without `-md`. The drafter is co-resident in this process, so
   * dropping it is a restart, not a `madvise` — hence "last resort". Returns
   * false when no server is running or the drafter is already disabled. A
   * later re-arm puts the drafter back (the engine re-issues `load()`).
   */
  async restartWithoutDrafter(): Promise<boolean> {
    if (!this.hasLoadedModel() || !this.loadedPlan) return false;
    if (this.loadedPlan.disableDrafter) return false;
    await this.start(
      { ...this.loadedPlan, disableDrafter: true },
      this.lastOptimizations,
    );
    return true;
  }

  /** Soft probe — does the binary resolve and is DFlash enabled. */
  async available(): Promise<boolean> {
    return getDflashRuntimeStatus().enabled;
  }

  /**
   * Unified backend contract entry point. Resolves the catalog entry from
   * the plan and delegates to `start()` if a DFlash plan is configured.
   * For non-DFlash llama-server use (e.g. `requiresKernel` for turbo3
   * without spec decoding), the catalog can declare an `optimizations`
   * block without `dflash` and we still launch the server here.
   */
  async load(plan: BackendPlan): Promise<void> {
    const catalog =
      plan.catalog ??
      (plan.modelId ? findCatalogModel(plan.modelId) : undefined);
    const dflash = catalog?.runtime?.dflash;
    const optimizations = catalog?.runtime?.optimizations ?? null;

    if (!dflash) {
      throw new Error(
        `[dflash] llama-server backend currently requires a catalog 'runtime.dflash' block. Model '${plan.modelId ?? plan.modelPath}' has none — declare DFlash or route this model through node-llama-cpp.`,
      );
    }

    // The drafter is resolved from the registry by the engine before this
    // dispatcher call, but the engine no longer pre-builds the dflash plan,
    // so we resolve it here. Inline import avoids the engine ↔ dflash-server
    // import cycle.
    const { listInstalledModels } = await import("./registry");
    const installed = await listInstalledModels();
    const target =
      installed.find((m) => m.path === plan.modelPath) ??
      installed.find((m) => m.id === plan.modelId);
    if (!target) {
      throw new Error(
        `[dflash] No installed model matched plan path/id (${plan.modelPath}; ${plan.modelId ?? "no id"}).`,
      );
    }
    const drafter = installed.find((m) => m.id === dflash.drafterModelId);
    if (!drafter) {
      throw new Error(
        `[dflash] ${target.displayName} requires companion drafter ${dflash.drafterModelId}; install it first.`,
      );
    }

    // Per-load overrides win over catalog defaults. The active-model
    // coordinator merges these in before the dispatcher is called; this
    // keeps the same precedence on the llama-server path so a benchmark
    // run that asks for `contextSize: 131072` actually starts the server
    // with `--ctx-size 131072` instead of the smaller catalog default.
    const overrides = plan.overrides;
    const contextSize =
      typeof overrides?.contextSize === "number"
        ? overrides.contextSize
        : dflash.contextSize;
    const gpuLayers = resolveDflashGpuLayers(overrides, dflash.gpuLayers);
    const kvOffload = resolveDflashKvOffload(overrides);

    // KV-cache spill for context > 64k (AGENTS.md §3 item 7). Every Eliza-1
    // bundle ships the voice loop, so a tier-id match means the tighter voice
    // latency gate applies. A `KvSpillUnsupportedError` thrown here propagates
    // out of `load()` — the engine surfaces it to the UI verbatim.
    const kvSpillPlan = await resolveKvSpillPlan({
      contextSize,
      catalog,
      installed: target,
      voiceEnabled: catalog ? isEliza1TierCatalogId(catalog.id) : false,
    });

    // For an Eliza-1 bundle (`<bundle>/text/eliza-1-<tier>-<ctx>.gguf`) the
    // OmniVoice GGUFs live at `<bundle>/tts/`. When the resolved server is
    // the fused build, pass them so the same process serves
    // `/v1/audio/speech` (AGENTS.md §4). Non-bundle layouts / non-voice
    // tiers / non-fused builds: leave them unset and TTS uses the FFI path.
    const ttsAssets =
      catalog && isEliza1TierCatalogId(catalog.id)
        ? findBundleOmnivoiceAssets(target.path)
        : null;

    await this.start(
      {
        targetModelPath: target.path,
        drafterModelPath: drafter.path,
        contextSize,
        draftContextSize: dflash.draftContextSize,
        draftMin: dflash.draftMin,
        draftMax: dflash.draftMax,
        gpuLayers,
        draftGpuLayers: dflash.draftGpuLayers,
        kvOffload: kvOffload ?? undefined,
        disableThinking: dflash.disableThinking,
        kvSpillPlan,
        params: catalog?.params,
        ttsModelPath: ttsAssets?.modelPath,
        ttsCodecPath: ttsAssets?.codecPath,
      },
      optimizations,
    );
  }

  /** Backend interface alias for stop(). */
  async unload(): Promise<void> {
    await this.stop();
  }

  async start(
    plan: DflashServerPlan,
    optimizations?: LocalRuntimeOptimizations | null,
  ): Promise<void> {
    if (
      this.child &&
      this.loadedPlan?.targetModelPath === plan.targetModelPath &&
      this.loadedPlan.drafterModelPath === plan.drafterModelPath &&
      (this.loadedPlan.disableDrafter ?? false) ===
        (plan.disableDrafter ?? false) &&
      this.loadedPlan.parallelOverride === plan.parallelOverride
    ) {
      return;
    }
    await this.stop();

    const status = getDflashRuntimeStatus();
    if (!status.enabled || !status.binaryPath) {
      throw new Error(`[dflash] ${status.reason}`);
    }

    const drafterEnabled = !plan.disableDrafter;
    const drafterModelPath = drafterEnabled
      ? maybeRepairDflashDrafter(
          status.binaryPath,
          plan.targetModelPath,
          plan.drafterModelPath,
        )
      : plan.drafterModelPath;
    const port = await resolvePort();
    const host = process.env.ELIZA_DFLASH_HOST?.trim() || DEFAULT_HOST;
    const cacheTypeK = process.env.ELIZA_DFLASH_CACHE_TYPE_K?.trim();
    const cacheTypeV = process.env.ELIZA_DFLASH_CACHE_TYPE_V?.trim();
    const usableRamMb =
      Math.round(os.totalmem() / BYTES_PER_MB_DFLASH) - ramHeadroomReserveMb();
    const parallel = resolveParallel(
      optimizations?.parallel,
      plan.params
        ? { contextSize: plan.contextSize, params: plan.params, usableRamMb }
        : undefined,
      plan.parallelOverride,
    );
    this.lastOptimizations = optimizations ?? null;
    const kvOffload = plan.kvOffload ?? resolveDflashKvOffload(null);
    const modelHash = buildModelHash({
      targetModelPath: plan.targetModelPath,
      drafterModelPath,
      cacheTypeK: cacheTypeK ?? null,
      cacheTypeV: cacheTypeV ?? null,
      extra: `ctx=${plan.contextSize};parallel=${parallel};kv=${kvOffload ?? "default"}`,
    });
    const slotDir = slotSavePath(modelHash);
    // llama-server's slot API treats `filename` as a basename relative to
    // --slot-save-path. Keep per-conversation KV files in that same root so
    // save and restore agree on the exact path.
    const conversationKvDir = slotDir;
    fs.mkdirSync(slotDir, { recursive: true });
    // Fire-and-forget eviction: stale slot files on disk shouldn't block
    // server startup, but we don't want them to grow without bound.
    void evictExpired(slotDir, DEFAULT_CACHE_TTLS).catch(() => {
      // Best effort; an EACCES or similar should not prevent server start.
    });
    void evictExpired(conversationKvDir, DEFAULT_CACHE_TTLS).catch(() => {});
    this.cacheModelHash = modelHash;
    this.cacheParallel = parallel;
    this.cacheSlotDir = slotDir;
    this.conversationKvDir = conversationKvDir;
    const args = [
      "--model",
      plan.targetModelPath,
      ...(drafterEnabled
        ? [
            "-md",
            drafterModelPath,
            "--spec-type",
            "dflash",
            "--n-gpu-layers-draft",
            normalizeGpuLayers(plan.draftGpuLayers),
            "--ctx-size-draft",
            String(plan.draftContextSize),
            "--draft-min",
            String(plan.draftMin),
            "--draft-max",
            String(plan.draftMax),
          ]
        : []),
      "--host",
      host,
      "--port",
      String(port),
      "--n-gpu-layers",
      normalizeGpuLayers(plan.gpuLayers),
      "--ctx-size",
      String(plan.contextSize),
      "--parallel",
      String(parallel),
      // Persist per-slot KV state to disk so prefix reuse survives the
      // process lifetime. llama-server keys files by slot id, not by
      // prompt hash, but combined with deterministic slot_id derivation
      // this gives effective prefix caching across restarts.
      "--slot-save-path",
      slotDir,
      // Allow the server to fall back to a similar slot (>= 0.7
      // similarity) when an exact match isn't loaded — useful when
      // distinct keys land on the same slot due to hash collision.
      "--slot-prompt-similarity",
      "0.7",
      "--metrics",
      "--jinja",
    ];
    if (plan.disableThinking) {
      args.push("--reasoning", "off");
      args.push("--chat-template-kwargs", '{"enable_thinking":false}');
    }
    if (cacheTypeK) {
      assertCacheTypeSupportedOnBackend(
        "ELIZA_DFLASH_CACHE_TYPE_K",
        cacheTypeK,
      );
      args.push("--cache-type-k", cacheTypeK);
    }
    if (cacheTypeV) {
      assertCacheTypeSupportedOnBackend(
        "ELIZA_DFLASH_CACHE_TYPE_V",
        cacheTypeV,
      );
      args.push("--cache-type-v", cacheTypeV);
    }

    appendKvOffloadFlags(args, kvOffload);
    appendOptimizationFlags(args, optimizations ?? null);
    // CPU-offloaded KV spill for context > 64k. Forces `--no-kv-offload`
    // (cold pages live in host RAM) + a `--cache-ram` hint sized to the
    // resident pages — appended after the optimization flags so the spill
    // budget wins over any catalog `cacheRamMb`. `resident`/`null` plans
    // are no-ops.
    appendKvSpillFlags(args, plan.kvSpillPlan);

    // Fused omnivoice TTS: when the resolved binary is the omnivoice-fused
    // `llama-server` and the bundle ships its TTS GGUFs, hand them to the
    // server so it mounts `POST /v1/audio/speech` in-process (AGENTS.md §4
    // — one process, not a second `llama-omnivoice-server` over IPC). The
    // route handler in the fork's `server.cpp` (guarded by
    // `#ifdef MILADY_FUSE_OMNIVOICE`) lazy-`ov_init`s from these paths.
    const runningBinaryIsFused =
      resolveFusedDflashBinary() !== null &&
      path.resolve(status.binaryPath) ===
        path.resolve(resolveFusedDflashBinary() ?? "");
    if (runningBinaryIsFused && plan.ttsModelPath && plan.ttsCodecPath) {
      args.push("--omnivoice-model", plan.ttsModelPath);
      args.push("--omnivoice-codec", plan.ttsCodecPath);
    }

    const extra = process.env.ELIZA_DFLASH_LLAMA_ARGS?.trim();
    if (extra) {
      // Apply the same capability gate to any kernel cache type passed via
      // the raw-args escape hatch: a `--cache-type-k turbo3` here must be
      // backed by the shipped `turbo3` kernel just like the env-var path.
      const tokens = extra.split(/\s+/).filter(Boolean);
      for (let i = 0; i < tokens.length; i += 1) {
        if (
          (tokens[i] === "--cache-type-k" || tokens[i] === "--cache-type-v") &&
          i + 1 < tokens.length
        ) {
          assertCacheTypeSupportedOnBackend(tokens[i], tokens[i + 1]);
        }
      }
      args.push(...tokens);
    }

    fs.mkdirSync(path.join(localInferenceRoot(), "logs"), { recursive: true });
    this.stderrTail = [];
    const child = spawn(status.binaryPath, args, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.baseUrl = `http://${host}:${port}`;
    this.loadedPlan = plan;
    this.loadedBinaryPath = status.binaryPath;

    child.stdout?.on("data", (chunk) => this.captureLog(chunk));
    child.stderr?.on("data", (chunk) => this.captureLog(chunk));
    child.on("exit", (code, signal) => {
      if (this.child && (code !== null || signal !== null)) {
        this.child = null;
        this.baseUrl = null;
        this.loadedPlan = null;
        this.loadedBinaryPath = null;
      }
    });

    await this.waitUntilReady(DEFAULT_START_TIMEOUT_MS);

    // Periodic eviction sweep — short TTL or shorter, capped to one
    // sweep per minute. Without this, stale slot files accumulate to
    // gigabytes over a long-running session because eviction was only
    // ever fired at startup. Also drops idle conversation handles.
    this.startEvictionTimer();
    // Keep-alive sweep — re-warms pre-warmed slots before the short TTL
    // elapses so an idle-but-alive conversation keeps its KV resident.
    this.startKeepAliveTimer();
  }

  /**
   * Set up the periodic eviction sweep that keeps stale slot files from
   * accumulating. Each tick:
   *   - `evictExpired` against the per-slot save directory and the
   *     per-conversation directory (per-file TTL by encoded class), so
   *     neither can grow without bound;
   *   - `conversationRegistry.evictIdle()` to drop conversation handles
   *     that have been untouched past their TTL — persist each one's KV
   *     to disk and `close()` it so an idle handle gets flushed-and-dropped
   *     rather than lingering and inflating the parallel high-water mark.
   */
  private startEvictionTimer(): void {
    if (this.evictionTimer) return;
    const intervalMs = resolveEvictionIntervalMs();
    const timer = setInterval(() => {
      const slotDir = this.cacheSlotDir;
      const conversationDir = this.conversationKvDir;
      if (slotDir) {
        void evictExpired(slotDir, DEFAULT_CACHE_TTLS).catch(() => {
          // Don't crash the timer on a single failed sweep — we'll try again
          // on the next tick.
        });
      }
      if (conversationDir) {
        void evictExpired(conversationDir, DEFAULT_CACHE_TTLS).catch(() => {});
      }
      void this.evictIdleConversations().catch(() => {});
    }, intervalMs);
    timer.unref();
    this.evictionTimer = timer;
  }

  /**
   * Drop idle conversation handles from the registry, persisting each
   * one's KV to disk before close so a re-open can lazy-restore. Inline
   * import avoids a module-load cycle with the engine (which imports this
   * file at module load).
   */
  private async evictIdleConversations(): Promise<void> {
    const { conversationRegistry } = await import("./conversation-registry");
    // Snapshot slot ids before evictIdle drops the handles so we know
    // which slot to persist for each evicted conversation.
    const slotByConversation = new Map<string, number>();
    for (const handle of conversationRegistry.snapshot()) {
      slotByConversation.set(handle.conversationId, handle.slotId);
    }
    const dropped = conversationRegistry.evictIdle();
    if (dropped.length === 0) return;
    await Promise.all(
      dropped.map(async (conversationId) => {
        const slotId = slotByConversation.get(conversationId);
        if (slotId === undefined) return;
        this.lastPrewarmBySlot.delete(slotId);
        try {
          await this.persistConversationKv(conversationId, slotId);
        } catch {
          // A failed persist just means the idle conversation cold-prefills
          // when it next reopens — not worth crashing the timer over.
        }
      }),
    );
  }

  /**
   * Keep-alive sweep (item I3): for every slot that was previously
   * pre-warmed and hasn't been touched (pre-warm or generate) within
   * `KEEPALIVE_STALE_FRACTION` of the short TTL, re-issue the last
   * pre-warm prefix so the slot's radix KV stays resident.
   */
  private startKeepAliveTimer(): void {
    if (this.keepAliveTimer) return;
    const intervalMs = resolveKeepAliveIntervalMs();
    const staleThresholdMs =
      DEFAULT_CACHE_TTLS.short * KEEPALIVE_STALE_FRACTION;
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [slotId, entry] of [...this.lastPrewarmBySlot]) {
        if (now - entry.touchedAtMs < staleThresholdMs) continue;
        void this.prewarmConversation(entry.prefix, { slotId }).catch(() => {
          // Best-effort — a failed keep-alive just means the next real
          // request cold-prefills, which is the pre-keep-alive behaviour.
        });
      }
    }, intervalMs);
    timer.unref();
    this.keepAliveTimer = timer;
  }

  async stop(): Promise<void> {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    this.lastPrewarmBySlot.clear();
    const child = this.child;
    const baseUrl = this.baseUrl;
    const conversationDir = this.conversationKvDir;
    this.child = null;
    this.baseUrl = null;
    this.loadedPlan = null;
    this.loadedBinaryPath = null;
    this.cacheModelHash = null;
    this.cacheSlotDir = null;
    this.conversationKvDir = null;
    this.cacheParallel = DEFAULT_CACHE_PARALLEL;
    this.lastOptimizations = null;
    if (!child) return;
    // Best-effort: tell llama-server to flush per-conversation KV state
    // to disk before we kill it. If the dispatcher restarts the server
    // (or the whole process restarts), conversations re-opening with the
    // same id will lazy-restore from these files on first generate.
    if (baseUrl && conversationDir) {
      await this.persistAllConversationsBeforeStop(baseUrl, conversationDir);
    }
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      sleep(5_000).then(() => {
        if (!child.killed) child.kill("SIGKILL");
      }),
    ]);
  }

  /**
   * Issue `POST /slots/<slot_id>?action=save` for every conversation slot
   * the registry knows about. Best-effort — a single slot's save failing
   * must not block the rest of the shutdown sequence.
   *
   * The slot file path is `<conversationDir>/<conversationId>.bin`, which
   * is what `restoreConversationKv` reads on the next `generate` for the
   * same conversation id.
   */
  private async persistAllConversationsBeforeStop(
    baseUrl: string,
    conversationDir: string,
  ): Promise<void> {
    // Inline import to avoid a hard cycle with the engine, which imports
    // this file at module load time.
    const { conversationRegistry } = await import("./conversation-registry");
    const handles = conversationRegistry.snapshot();
    if (handles.length === 0) return;
    const tasks = handles.map(async (handle) => {
      const targetPath = path.join(
        conversationDir,
        slotCacheFileName(handle.conversationId, "long"),
      );
      try {
        await this.requestSlotSave(baseUrl, handle.slotId, targetPath);
        this.persistedConversations.add(handle.conversationId);
      } catch {
        // A single failed slot save must not block the stop path —
        // the worst case is that conversation cold-prefills on next use.
      }
    });
    await Promise.all(tasks);
  }

  /**
   * Issue a single slot save. Splits out so `persistConversationKv` can
   * call it from any path (graceful save, periodic checkpoint), not just
   * the shutdown path.
   *
   * The fork's REST API: `POST /slots/<id>?action=save` with a JSON
   * `{ filename: "<absolute-path>" }` body. llama-server writes the slot
   * KV to that absolute path. Filename MUST be a basename within the
   * directory llama-server was started with `--slot-save-path`; we
   * generate filenames inside that root so the constraint is satisfied
   * naturally.
   */
  private async requestSlotSave(
    baseUrl: string,
    slotId: number,
    targetPath: string,
  ): Promise<void> {
    if (slotId < 0) return;
    // llama-server expects `filename` as a basename inside the
    // --slot-save-path root, not a full path. Strip the path prefix
    // before sending; we reconstruct it from `cacheSlotDir` below.
    const baseName = path.basename(targetPath);
    await fetchJson(
      `${baseUrl}/slots/${slotId}?action=save`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: baseName }),
      },
      10_000,
    );
  }

  /**
   * Issue a single slot restore. Mirror of `requestSlotSave`. Skips when
   * the file doesn't exist — a fresh conversation has no KV to restore.
   */
  private async requestSlotRestore(
    baseUrl: string,
    slotId: number,
    sourcePath: string,
  ): Promise<boolean> {
    if (slotId < 0) return false;
    if (!fs.existsSync(sourcePath)) return false;
    const baseName = path.basename(sourcePath);
    await fetchJson(
      `${baseUrl}/slots/${slotId}?action=restore`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: baseName }),
      },
      10_000,
    );
    return true;
  }

  /**
   * Persist this conversation's KV state to a stable, cross-restart
   * filename. Callers should fire this on a long-cache TTL boundary, on
   * `closeConversation`, and at process shutdown.
   *
   * Returns true when a save was issued, false when there was no slot to
   * save (e.g. slot pinning disabled, server not running).
   */
  async persistConversationKv(
    conversationId: string,
    slotId: number,
  ): Promise<boolean> {
    const baseUrl = this.baseUrl;
    const conversationDir = this.conversationKvDir;
    if (!baseUrl || !conversationDir || slotId < 0) return false;
    const targetPath = path.join(
      conversationDir,
      slotCacheFileName(conversationId, "long"),
    );
    try {
      await this.requestSlotSave(baseUrl, slotId, targetPath);
      this.persistedConversations.add(conversationId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Lazy-restore a previously-persisted conversation's KV state into the
   * given slot. Called from the generate path on the first request for a
   * conversation id whose registry handle was just opened.
   */
  async restoreConversationKv(
    conversationId: string,
    slotId: number,
  ): Promise<boolean> {
    const baseUrl = this.baseUrl;
    const conversationDir = this.conversationKvDir;
    if (!baseUrl || !conversationDir || slotId < 0) return false;
    const sourcePath = path.join(
      conversationDir,
      slotCacheFileName(conversationId, "long"),
    );
    try {
      const restored = await this.requestSlotRestore(
        baseUrl,
        slotId,
        sourcePath,
      );
      return restored;
    } catch {
      return false;
    }
  }

  /** Diagnostic snapshot of the on-disk slot save directory for this server. */
  async describeCache(): Promise<{
    modelHash: string | null;
    slotDir: string | null;
    parallel: number;
    files: CacheStatsEntry[];
  }> {
    if (!this.cacheSlotDir) {
      return {
        modelHash: this.cacheModelHash,
        slotDir: null,
        parallel: this.cacheParallel,
        files: [],
      };
    }
    return {
      modelHash: this.cacheModelHash,
      slotDir: this.cacheSlotDir,
      parallel: this.cacheParallel,
      files: await readCacheStats(this.cacheSlotDir),
    };
  }

  async generate(
    args: DflashGenerateArgs | BackendGenerateArgs,
  ): Promise<string> {
    const result = await this.generateWithUsage(args);
    return result.text;
  }

  /**
   * Run one generation and return both the text AND the Anthropic-shape
   * usage block. The usage block is built by differencing two `/metrics`
   * snapshots taken before/after the request, plus the per-call
   * `usage` body the chat-completion response itself returns.
   *
   * Falls back to zero counters when the metrics scrape fails — the
   * response text is still surfaced. Callers that don't need usage can
   * keep using `generate()`.
   */
  async generateWithUsage(
    args: DflashGenerateArgs | BackendGenerateArgs,
  ): Promise<DflashGenerateResult> {
    const baseUrl = this.baseUrl;
    if (!baseUrl) {
      throw new Error("[dflash] llama-server is not running");
    }
    const dflashArgs = args as DflashGenerateArgs;
    const slotId =
      typeof dflashArgs.slotId === "number" && dflashArgs.slotId >= -1
        ? dflashArgs.slotId
        : deriveSlotId(args.cacheKey ?? "", this.cacheParallel);
    const streaming = Boolean(args.onTextChunk || dflashArgs.onVerifierEvent);
    const prefill =
      typeof dflashArgs.prefill === "string" && dflashArgs.prefill.length > 0
        ? dflashArgs.prefill
        : "";
    const payload = buildChatCompletionBody(dflashArgs, slotId, streaming);
    const before = await fetchMetricsSnapshot(baseUrl);
    let json: Record<string, unknown> | null = null;
    let text: string;
    if (streaming) {
      // When the assistant turn is prefilled, the model only streams the
      // continuation — surface the full assistant message (prefill + tail)
      // and fire the prefill chunk through the callbacks first so the voice
      // bridge / structured-field tracker sees a complete envelope.
      let idx = 0;
      if (prefill.length > 0) {
        await dflashArgs.onVerifierEvent?.({
          kind: "accept",
          tokens: [{ index: idx++, text: prefill }],
        });
        await args.onTextChunk?.(prefill);
      }
      const tail = await fetchStreamingChatCompletion(
        `${baseUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
        60_000,
        {
          onTextChunk: args.onTextChunk,
          onVerifierEvent: dflashArgs.onVerifierEvent,
        },
        args.signal,
        idx,
      );
      text = prefill + tail;
    } else {
      json = (await fetchJson(
        `${baseUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
        60_000,
        args.signal,
      )) as Record<string, unknown>;
      text = prefill + extractCompletionText(json);
    }
    const after = await fetchMetricsSnapshot(baseUrl);
    const responseUsage = json ? extractResponseUsage(json) : undefined;
    const usage = diffSnapshots(before, after, responseUsage);
    const maxTokens =
      typeof payload.max_tokens === "number" ? payload.max_tokens : null;
    if (
      shouldRequireActiveDflashForRequest(this.loadedPlan, maxTokens) &&
      (usage.dflash_drafted_tokens ?? 0) <= 0
    ) {
      throw new Error(
        "[dflash] speculative decoding was required for this Eliza-1 generation, " +
          "but llama-server produced zero drafted tokens. This usually means the " +
          "DFlash drafter path initialized as a generic draft model or the " +
          "bundle's drafter does not match the target checkpoint. Rebuild with " +
          "the native dflash-draft speculative path or set " +
          "ELIZA_DFLASH_ALLOW_ZERO_DRAFT=1 only for local diagnostics.",
      );
    }
    this.touchSlot(slotId);
    return { text, usage, slotId };
  }

  /**
   * Materialize the KV cache for `promptPrefix` on the slot a conversation
   * is pinned to, before the real request arrives. Fires a `max_tokens: 1`
   * chat completion with `cache_prompt: true` against the deterministic
   * slot, so the system-prompt / provider-context / tool-schema prefix is
   * already in the slot's KV when the user's tokens land. Idempotent and
   * cheap to call repeatedly — `cache_prompt` reuses the prefix so a second
   * call is a no-op forward pass over the same tokens.
   *
   * No-op when the server isn't running (returns false). W6 calls this from
   * the cache-precache path; W4 exposes it through the engine.
   */
  async prewarmConversation(
    promptPrefix: string,
    opts: { slotId?: number; cacheKey?: string } = {},
  ): Promise<boolean> {
    const baseUrl = this.baseUrl;
    if (!baseUrl) return false;
    if (!promptPrefix || promptPrefix.length === 0) return false;
    const slotId =
      typeof opts.slotId === "number" && opts.slotId >= -1
        ? opts.slotId
        : deriveSlotId(opts.cacheKey ?? "", this.cacheParallel);
    const payload: Record<string, unknown> = {
      model: "local-dflash",
      messages: [{ role: "user", content: promptPrefix }],
      max_tokens: 1,
      temperature: 0,
      cache_prompt: true,
      slot_id: slotId,
    };
    try {
      await fetchJson(
        `${baseUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
        30_000,
      );
      // Remember the prefix + touch time so the keep-alive sweep can
      // re-issue it before the radix KV ages out. Only pinned slots are
      // worth tracking — slot_id -1 is "any free slot" and not stable.
      if (slotId >= 0) {
        this.lastPrewarmBySlot.set(slotId, {
          prefix: promptPrefix,
          touchedAtMs: Date.now(),
        });
      }
      return true;
    } catch {
      // Pre-warm is best-effort by definition — a failure just means the
      // real request cold-prefills, which is the pre-prewarm behaviour.
      return false;
    }
  }

  /** Bump the keep-alive touch time for a slot after a real generate. */
  private touchSlot(slotId: number): void {
    if (slotId < 0) return;
    const entry = this.lastPrewarmBySlot.get(slotId);
    if (entry) entry.touchedAtMs = Date.now();
  }

  private captureLog(chunk: Buffer | string): void {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.stderrTail.push(trimmed);
      while (this.stderrTail.length > 30) this.stderrTail.shift();
    }
  }

  private async waitUntilReady(timeoutMs: number): Promise<void> {
    if (!this.baseUrl) throw new Error("[dflash] llama-server did not start");
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!this.child) {
        throw new Error(
          `[dflash] llama-server exited during startup: ${this.stderrTail.join(os.EOL)}`,
        );
      }
      try {
        await fetchJson(`${this.baseUrl}/health`, { method: "GET" }, 2_000);
        return;
      } catch {
        try {
          await fetchJson(
            `${this.baseUrl}/v1/models`,
            { method: "GET" },
            2_000,
          );
          return;
        } catch {
          await sleep(500);
        }
      }
    }
    const detail = this.stderrTail.length
      ? ` Last logs: ${this.stderrTail.join(os.EOL)}`
      : "";
    throw new Error(
      `[dflash] llama-server did not become ready within ${timeoutMs}ms.${detail}`,
    );
  }
}

export const dflashLlamaServer = new DflashLlamaServer();

/**
 * Build the `/v1/chat/completions` request body for a generation call,
 * folding in the structured-output extensions:
 *   - `prefill`        → a trailing partial assistant message + the fork's
 *     `continue_final_message: true` so the model continues it rather than
 *     starting a fresh assistant turn (recent llama.cpp/Jinja chat templates
 *     honour this; older builds simply ignore the extra message and the
 *     prefill is still re-prepended client-side).
 *   - `grammar` / `responseSkeleton` → `grammar` (+ `grammar_lazy` /
 *     `grammar_triggers` when the compiled skeleton is lazy).
 *
 * `cache_prompt: true` is always safe — the worst case is the server matches
 * no prefix tokens and the request behaves like a cold call. Pinning by
 * `slot_id` only happens when the runtime gave us a stable cache key.
 */
export function buildChatCompletionBody(
  args: DflashGenerateArgs,
  slotId: number,
  streaming: boolean,
): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [
    { role: "user", content: args.prompt },
  ];
  const prefill =
    typeof args.prefill === "string" && args.prefill.length > 0
      ? args.prefill
      : "";
  if (prefill.length > 0) {
    messages.push({ role: "assistant", content: prefill });
  }
  const payload: Record<string, unknown> = {
    model: "local-dflash",
    messages,
    max_tokens: args.maxTokens ?? 2048,
    temperature: args.temperature ?? 0.7,
    top_p: args.topP ?? 0.9,
    stop: args.stopSequences,
    stream: streaming,
    cache_prompt: true,
    slot_id: slotId,
  };
  if (prefill.length > 0) {
    // Continue the partial assistant turn instead of opening a new one.
    payload.continue_final_message = true;
    // Some fork builds spell it `add_generation_prompt: false` instead.
    payload.add_generation_prompt = false;
  }
  const grammar = resolveGrammarForParams(args);
  if (grammar) {
    Object.assign(payload, grammarRequestFields(grammar));
  }
  return payload;
}

/**
 * Extract the assistant text from a llama-server `/v1/chat/completions`
 * response. Throws when no recognised text shape is present — silently
 * returning empty would mask a real protocol mismatch.
 */
function extractCompletionText(json: Record<string, unknown>): string {
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  const message =
    choice && typeof choice === "object"
      ? (choice as { message?: unknown }).message
      : null;
  const content =
    message && typeof message === "object"
      ? (message as { content?: unknown }).content
      : null;
  if (typeof content === "string") return content;
  const text = json.text;
  if (typeof text === "string") return text;
  throw new Error(
    `[dflash] Unexpected llama-server response: ${JSON.stringify(json)}`,
  );
}

/**
 * Extract the per-call usage block from a llama-server response. Returns
 * undefined when the response did not include one — `diffSnapshots` then
 * falls back to the metric-delta input/output counts.
 */
function extractResponseUsage(
  json: Record<string, unknown>,
): { prompt_tokens?: number; completion_tokens?: number } | undefined {
  const usage = json.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const out: { prompt_tokens?: number; completion_tokens?: number } = {};
  if (typeof u.prompt_tokens === "number") {
    out.prompt_tokens = u.prompt_tokens;
  }
  if (typeof u.completion_tokens === "number") {
    out.completion_tokens = u.completion_tokens;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
