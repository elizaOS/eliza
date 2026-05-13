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
import crypto from "node:crypto";
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
import {
  type DflashStreamEvent,
  type DflashTurnStats,
  parseDflashFieldFromSseChunk,
} from "./dflash-event-schema";
import {
  DflashMetricsCollector,
  dflashTurnHistory,
} from "./dflash-metrics-collector";
import {
  type DflashVerifyEvent,
  type DflashVerifyStats,
  parseDflashVerifyEventsFromSseChunk,
} from "./dflash-verify-event";
import { probeHardware } from "./hardware";
import { inferenceTelemetry } from "./inference-telemetry";
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
  repairStructuredOutput,
  resolveGrammarForParams,
  type StructuredGenerateParams,
  StructuredOutputRepairStream,
} from "./structured-output";
import type {
  CatalogModel,
  GpuProfile,
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
  /**
   * Catalog-default `--cache-type-k` / `--cache-type-v` for the target model
   * (the tier's `runtime.kvCache.typeK/typeV` — `qjl1_256` K + `q4_polar` V
   * for the >8k tiers, per `packages/inference/AGENTS.md` §3). The
   * `ELIZA_DFLASH_CACHE_TYPE_K` / `_V` env vars override these. `start()`
   * still runs `assertCacheTypeSupportedOnBackend` on whichever value wins,
   * so a binary whose `CAPABILITIES.json` lacks the kernel fails loudly.
   */
  cacheTypeK?: string;
  cacheTypeV?: string;
  disableThinking: boolean;
  /**
   * Target model parameter count (`"2B"`, `"27B"`, …). Used only to size
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
   * / draft-count / `--n-gpu-layers-draft` flags. `drafterModelPath`
   * is still carried in the plan so a subsequent re-arm can put it back.
   */
  disableDrafter?: boolean;
  /**
   * Diagnostic reason when the server intentionally launched without `-md`
   * even though the catalog declared a companion drafter. This is set when
   * the GGUF compatibility probe rejects the drafter before spawn.
   */
  disabledDrafterReason?: string;
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
  /**
   * Optional listener for native DFlash speculative-decoding events
   * (`docs/dflash-native-events-protocol.md`). Fired only when the C-side
   * llama-server advertises `capabilities.dflashNativeEvents` AND the
   * bundle opts in via `optimizations.nativeDflashEvents`. When neither
   * is true the legacy synthesized accept-only stream is what runs and
   * this callback is never invoked.
   */
  onDflashEvent?: (event: DflashStreamEvent) => void | Promise<void>;
  /**
   * L1 — optional listener for the per-step `dflashVerify` event
   * (`docs/eliza-1-dflash-events-wire.md`). Fires only when BOTH the
   * bundle opts in via `optimizations.useNativeDflashEvents` AND the
   * running server advertises `capabilities.dflashVerifyEvents`. When
   * either gate is false the verify event on the SSE stream is silently
   * ignored and the legacy synthesized `onVerifierEvent` accept stream
   * runs unchanged. The event carries exact reject indices and per-token
   * logprobs the legacy synthesis cannot derive — see the wire-format
   * doc for the autotuner / voice rollback consumers.
   */
  onDflashVerifyEvent?: (event: DflashVerifyEvent) => void | Promise<void>;
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
  /**
   * Time-to-first-token in milliseconds, measured from the moment the
   * outbound `fetch` was issued to the first SSE chunk arriving (L5
   * instrumentation). `null` when the request was non-streaming or the
   * stream ended before any chunk landed.
   */
  firstTokenMs: number | null;
  /**
   * Per-turn DFlash speculative-decoding stats computed from native
   * accept/reject events on the SSE stream. Populated only when the
   * C-side llama-server advertises `capabilities.dflashNativeEvents`
   * AND the bundle opts in. When undefined, callers should fall back
   * to scraping `/metrics` via `usage.dflash_drafted_tokens` etc.
   */
  dflashStats?: DflashTurnStats;
  /**
   * L1 — per-step verify-event stats derived from the `dflashVerify`
   * SSE field. Populated only when BOTH the bundle opts in via
   * `optimizations.useNativeDflashEvents` AND the running server
   * advertises `capabilities.dflashVerifyEvents`. `null` when the
   * feature is off OR when no verify event arrived (a stock binary
   * with the flag flipped will still produce `null` here).
   *
   * Cross-check this against `dflashStats`: `dflashStats.drafted`
   * should equal `dflashVerifyStats.draftedTokens` and
   * `dflashStats.accepted` should equal `acceptedTokens`. Divergence
   * is evidence the SSE stream dropped chunks or the fork's emission
   * is mis-aligned with the speculative loop.
   */
  dflashVerifyStats?: DflashVerifyStats | null;
  /**
   * L1 — Prometheus `/metrics` delta for the two new counters
   * (`llamacpp:n_drafted_rejected_total`,
   * `llamacpp:n_verify_steps_total`). `null` when the fork did not
   * expose those counters (stock build) or the scrape failed. The
   * acceptanceRate sub-field is null here; compose it from
   * `usage.dflash_drafted_tokens` / `usage.dflash_accepted_tokens`.
   */
  dflashRawMetrics?: {
    rejectedTokens: number;
    verifySteps: number;
    acceptanceRate: number | null;
  } | null;
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
  tbq3_0: "turbo3",
  turbo4: "turbo4",
  turbo4_0: "turbo4",
  tbq4_0: "turbo4",
  turbo3_tcq: "turbo3_tcq",
  tbq3_tcq: "turbo3_tcq",
  // turbo2* are the older naming for the same families — gate on turbo3.
  turbo2: "turbo3",
  turbo2_0: "turbo3",
  turbo2_tcq: "turbo3_tcq",
  qjl1_256: "qjl_full",
  qjl_full: "qjl_full",
  q4_polar: "polarquant",
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
  const samples = new Map<
    string,
    { unlabeled: number | null; labeledSum: number }
  >();
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

/**
 * L1 — env-gated feature flag for native `dflash-verify` SSE events.
 *
 * Set `ELIZA_NATIVE_DFLASH_EVENTS=1` to enable. When this flag is OFF
 * (the default), the new `dflash-verify` event type is never emitted
 * from the TypeScript layer — the legacy synthesized accept-only stream
 * runs unchanged and the metrics collector receives no verify events.
 * This is the regression-safe production default until the C-side patch
 * lands and is validated.
 *
 * When ON, the `DflashMetricsCollector` will accumulate `dflash-verify`
 * events and the `/metrics` scrape will include the four new counters:
 * `dflash_drafted_tokens_total`, `dflash_accepted_tokens_total`,
 * `dflash_rejected_tokens_total`, `dflash_acceptance_rate`.
 */
export function useNativeDflashEvents(): boolean {
  return readBool("ELIZA_NATIVE_DFLASH_EVENTS");
}

export function shouldRequireActiveDflashForRequest(
  plan:
    | Pick<DflashServerPlan, "disableDrafter" | "draftMin">
    | null
    | undefined,
  maxTokens: number | null | undefined,
  observedOutputTokens?: number | null,
): boolean {
  if (!plan || plan.disableDrafter || allowZeroDraftForDiagnostics()) {
    return false;
  }
  const minDraftableTokens = Math.max(1, plan.draftMin) + 2;
  if (Number.isFinite(maxTokens) && maxTokens != null) {
    if (maxTokens < minDraftableTokens) return false;
  }
  if (Number.isFinite(observedOutputTokens) && observedOutputTokens != null) {
    if (observedOutputTokens < minDraftableTokens) return false;
  }
  if (!Number.isFinite(maxTokens) || maxTokens == null) return true;
  // The verifier can only test a draft after the first target token, and
  // llama.cpp's server refuses drafts smaller than draftMin. One-token
  // prewarm and tiny control probes should not be mistaken for a skipped
  // DFlash path.
  return maxTokens >= minDraftableTokens;
}

export function attachDflashSpeculativeRequestFields(
  payload: Record<string, unknown>,
  plan:
    | Pick<DflashServerPlan, "disableDrafter" | "draftMin" | "draftMax">
    | null
    | undefined,
): void {
  if (!plan || plan.disableDrafter) return;
  payload["speculative.n_min"] = Math.max(0, plan.draftMin);
  payload["speculative.n_max"] = Math.max(
    Math.max(0, plan.draftMin),
    plan.draftMax,
  );
  payload["speculative.type"] = "dflash";
}

export function estimateOutputTokensForDflashEvidence(
  usage: Pick<LocalUsageBlock, "output_tokens">,
  text: string,
): number {
  if (Number.isFinite(usage.output_tokens) && usage.output_tokens > 0) {
    return usage.output_tokens;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  // Streaming chat responses on some llama-server builds omit
  // n_tokens_predicted_total. Use a conservative BPE-ish estimate only for
  // the DFlash activity assertion, so generated visible text cannot hide a
  // zero-draft server path behind missing metrics.
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

/**
 * Developer-only escape hatch from the always-on speculative-decoding
 * contract (`packages/inference/AGENTS.md` §4: "DFlash is always on… If
 * the user disables speculative decoding for debugging, that is a
 * developer-only flag (`ELIZA_DFLASH_DISABLE=1`), it is not a user
 * setting, and it MUST log a loud warning every turn.").
 *
 * This is NOT a product setting — there is no UI surface and no
 * `ELIZA_LOCAL_*` mapping. It exists so a developer can bisect a
 * suspected DFlash regression. When set, `dflashEnabled()` returns false
 * (the dispatcher then routes to node-llama-cpp) and every generation
 * turn that runs while it is set logs `logDflashDevDisabledWarning()`.
 */
export function dflashDevDisabled(): boolean {
  return readBool("ELIZA_DFLASH_DISABLE");
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
    "[local-inference] ⚠️  ELIZA_DFLASH_DISABLE=1 — speculative decoding is OFF. " +
      "This is a developer-only debug flag, NOT a product setting. Eliza-1's " +
      "always-on DFlash contract is violated for this turn; voice latency and " +
      "throughput are degraded. Unset ELIZA_DFLASH_DISABLE to restore the " +
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
/**
 * Resolve the llama-server fork backend tag for the current host.
 *
 * Precedence:
 *   1. `ELIZA_DFLASH_BACKEND` — explicit operator override (any value).
 *   2. `darwin` → always `metal`.
 *   3. `HIP_VISIBLE_DEVICES` / `ROCR_VISIBLE_DEVICES` set → `rocm`.
 *   4. `CUDA_VISIBLE_DEVICES` set (and not `-1`) → `cuda`.
 *   5. **Installed-build probe** — if an accelerated fork build directory
 *      exists under `<root>/bin/dflash/<platform>-<arch>-<backend>[-fused]/`
 *      with a `llama-server` binary in it, prefer that backend (cuda before
 *      vulkan before rocm). This is what makes a downloaded/built CUDA fork
 *      artifact actually get used on a fresh Windows/Linux desktop install,
 *      where none of the `*_VISIBLE_DEVICES` env vars are set — without it
 *      the runtime always keyed `…-cpu` and silently ran the CPU fork even
 *      with a CUDA build sitting on disk.
 *   6. Fall back to `cpu`.
 *
 * `suffix` is `"-fused"` for the omnivoice-grafted build dir, `""` for the
 * stock build dir.
 */
function accelBackendKey(suffix: "" | "-fused"): string {
  const forced = process.env.ELIZA_DFLASH_BACKEND?.trim().toLowerCase();
  if (forced) return `${process.platform}-${process.arch}-${forced}${suffix}`;
  if (process.platform === "darwin") {
    return `${process.platform}-${process.arch}-metal${suffix}`;
  }
  if (process.env.HIP_VISIBLE_DEVICES || process.env.ROCR_VISIBLE_DEVICES) {
    return `${process.platform}-${process.arch}-rocm${suffix}`;
  }
  if (
    process.env.CUDA_VISIBLE_DEVICES &&
    process.env.CUDA_VISIBLE_DEVICES !== "-1"
  ) {
    return `${process.platform}-${process.arch}-cuda${suffix}`;
  }
  for (const backend of ["cuda", "vulkan", "rocm"] as const) {
    const dir = path.join(
      localInferenceRoot(),
      "bin",
      "dflash",
      `${process.platform}-${process.arch}-${backend}${suffix}`,
    );
    if (fs.existsSync(path.join(dir, "llama-server"))) {
      return `${process.platform}-${process.arch}-${backend}${suffix}`;
    }
  }
  return `${process.platform}-${process.arch}-cpu${suffix}`;
}

function fusedBackendKey(): string {
  return accelBackendKey("-fused");
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
  /** True when the binary can load GGUFs with `general.architecture=dflash-draft`. */
  dflashDraftArchitecture?: boolean;
  /** GGUF architecture names the binary advertises as loadable. */
  supportedArchitectures?: string[];
  /** Draft-model GGUF architecture names the binary advertises as loadable. */
  draftArchitectures?: string[];
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
  /** True when the build passed the required-kernel gate at install time. */
  publishable?: boolean;
  /** Required kernels missing at install time; empty means the build gate passed. */
  missingRequiredKernels?: string[];
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
export function readDflashBinaryCapabilities(
  binaryPath: string | null = resolveDflashBinary(),
): DflashBinaryCapabilities | null {
  const capsPath = binaryPath
    ? path.join(path.dirname(binaryPath), "CAPABILITIES.json")
    : managedDflashCapabilitiesPath();
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

/**
 * Refuse a `--cache-type-k/v` value when the installed llama-server binary
 * doesn't advertise the required kernel in `CAPABILITIES.json`. The blocklist
 * is no longer static: `kernel-patches/[metal,vulkan]-kernels.mjs` compile the
 * turbo / qjl / polar kernels into the fork now, and `build-llama-cpp-dflash.mjs`
 * records which ones actually shipped under `kernels.*`. So a Metal binary
 * built with the kernel patches enabled passes; one without them is refused
 * with an actionable "rebuild your fork" message. `CAPABILITIES.json` is not
 * sufficient by itself: stale installs can leave a new capability file beside
 * an old binary, so the resolved `llama-server --help` surface must also
 * advertise the requested cache type.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function helpAdvertisesCacheType(binaryPath: string, value: string): boolean {
  const help = llamaServerHelpText(binaryPath).toLowerCase();
  if (!help) return false;
  return new RegExp(`\\b${escapeRegExp(value.toLowerCase())}\\b`).test(help);
}

function helpAdvertisesDflashSpecType(binaryPath: string): boolean {
  const help = llamaServerHelpText(binaryPath).toLowerCase();
  if (!help) return false;
  return help.includes("--spec-type") && /\bdflash\b/.test(help);
}

function capabilitiesAreFreshForBinary(binaryPath: string): boolean {
  try {
    const capsStat = fs.statSync(
      path.join(path.dirname(binaryPath), "CAPABILITIES.json"),
    );
    const binStat = fs.statSync(binaryPath);
    return capsStat.mtimeMs >= binStat.mtimeMs;
  } catch {
    return false;
  }
}

function capabilitiesAdvertiseDflashSpecType(binaryPath: string): boolean {
  const caps = readDflashBinaryCapabilities(binaryPath);
  if (!caps) return false;
  return Boolean(
    capabilitiesAreFreshForBinary(binaryPath) &&
      caps.publishable === true &&
      caps.kernels?.dflash === true &&
      caps.dflashDraftArchitecture === true &&
      (caps.missingRequiredKernels?.length ?? 0) === 0 &&
      (caps.binaries ?? []).includes("llama-server") &&
      ((caps.supportedArchitectures ?? []).includes("dflash-draft") ||
        (caps.draftArchitectures ?? []).includes("dflash-draft")),
  );
}

function helpAdvertisesFlag(binaryPath: string, flag: string): boolean {
  return llamaServerHelpText(binaryPath).includes(flag);
}

export function appendDflashDraftTuningFlags(
  args: string[],
  opts: {
    binaryPath: string;
    draftContextSize: number;
    draftMin: number;
    draftMax: number;
  },
): void {
  if (helpAdvertisesFlag(opts.binaryPath, "--ctx-size-draft")) {
    args.push("--ctx-size-draft", String(opts.draftContextSize));
  }

  args.push(
    helpAdvertisesFlag(opts.binaryPath, "--spec-draft-n-min")
      ? "--spec-draft-n-min"
      : "--draft-min",
    String(opts.draftMin),
  );
  args.push(
    helpAdvertisesFlag(opts.binaryPath, "--spec-draft-n-max")
      ? "--spec-draft-n-max"
      : "--draft-max",
    String(opts.draftMax),
  );
}

function assertCacheTypeSupportedOnBackend(
  name: string,
  value: string,
  binaryPath: string,
): void {
  const requiredKernel = CACHE_TYPE_REQUIRED_KERNEL[value.toLowerCase()];
  if (!requiredKernel) return; // stock cache type (f16/q8_0/...) — always ok
  const caps = readDflashBinaryCapabilities(binaryPath);
  if (caps && caps.kernels[requiredKernel] !== true) {
    throw new Error(
      `${name}=${value} requires the '${requiredKernel}' kernel, but the installed llama-server binary's CAPABILITIES.json reports it absent. Rebuild the fork with the matching kernel patches (node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target <triple>) or use a stock KV cache type (f16/q8_0).`,
    );
  }
  if (!helpAdvertisesCacheType(binaryPath, value)) {
    throw new Error(
      `${name}=${value} requires llama-server at ${binaryPath} to advertise '${value}' in --cache-type-k/v allowed values. CAPABILITIES.json alone is not trusted because stale installs can lie; rebuild the fork or select a stock KV cache type (f16/q8_0).`,
    );
  }
}

function assertDflashSpecSupportedOnBackend(binaryPath: string): void {
  const caps = readDflashBinaryCapabilities(binaryPath);
  if (caps && caps.kernels.dflash !== true) {
    throw new Error(
      `[dflash] ${binaryPath} has CAPABILITIES.json but kernels.dflash is false; refusing to launch target-only because Eliza-1 requires DFlash. Rebuild packages/app-core/scripts/build-llama-cpp-dflash.mjs --target <triple>.`,
    );
  }
  if (!helpAdvertisesDflashSpecType(binaryPath)) {
    // Runtime `--help` is the strongest stale-binary guard, but native test
    // and sandbox runners can occasionally return an empty help surface while
    // the exact same product binary is valid when probed from the shell. Allow
    // the build-script capability file as a narrow fallback only when it is
    // fresh relative to the binary and records a publishable DFlash build.
    if (capabilitiesAdvertiseDflashSpecType(binaryPath)) return;
    throw new Error(
      `[dflash] ${binaryPath} does not advertise '--spec-type ... dflash' in --help; refusing to launch because Eliza-1 requires DFlash drafting.`,
    );
  }
}

/**
 * Cache for `probeCtxCheckpointsSupported`. Keyed by absolute binary path —
 * `start()` may resolve different binaries across the process lifetime so
 * the cache key isn't process-global.
 *
 * Upstream llama.cpp exposes `--ctx-checkpoints N` / `--ctx-checkpoint-interval M`
 * for mid-prefill KV snapshots (used by the voice optimistic-rollback path).
 * Our fork hasn't merged the feature yet — the runtime probe lets the JS
 * side ship now and start passing the flags automatically once the binary
 * advertises them via `--help`.
 */
const ctxCheckpointsProbeCache = new Map<string, boolean>();

/**
 * Probe whether the installed `llama-server` binary supports the
 * `--ctx-checkpoints` family of flags. Runs `<binary> --help` and greps for
 * the option name. Cached per binary path so repeated server starts amortize
 * the spawn cost. Returns `false` when the binary errors, the probe times
 * out, or the help text doesn't mention the flag — in any of those cases the
 * caller MUST proceed without the flags rather than fail startup.
 */
export function probeCtxCheckpointsSupported(binaryPath: string): boolean {
  const cached = ctxCheckpointsProbeCache.get(binaryPath);
  if (cached !== undefined) return cached;
  let supported = false;
  try {
    const result = spawnSync(binaryPath, ["--help"], {
      encoding: "utf8",
      // Cold Metal/fused binaries can spend several seconds loading native
      // libraries before printing the full arg table. A short timeout creates
      // a false "no --spec-type dflash" negative and blocks otherwise-valid
      // Eliza-1 launches.
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    supported = /--ctx-checkpoints\b/.test(text);
  } catch {
    supported = false;
  }
  if (!supported) {
    console.warn(
      `[local-inference] llama-server at ${binaryPath} does not advertise --ctx-checkpoints; optimistic-rollback voice path will run without mid-prefill snapshots until the upstream merge lands.`,
    );
  }
  ctxCheckpointsProbeCache.set(binaryPath, supported);
  return supported;
}

/**
 * Test-only — reset the probe cache between mocked binaries.
 */
export function __resetCtxCheckpointsProbeCacheForTests(): void {
  ctxCheckpointsProbeCache.clear();
}

export function __setCtxCheckpointsProbeCacheForTests(
  binaryPath: string,
  supported: boolean,
): void {
  ctxCheckpointsProbeCache.set(binaryPath, supported);
}

/** Default number of mid-prefill KV snapshots the server keeps per slot. */
export const DEFAULT_CTX_CHECKPOINTS = 4;
/** Default token interval between automatic mid-prefill snapshots. */
export const DEFAULT_CTX_CHECKPOINT_INTERVAL = 256;

/**
 * Append `--ctx-checkpoints N --ctx-checkpoint-interval M` to `args` when:
 *   - `enableCheckpoints` is not explicitly `false`, AND
 *   - the runtime probe says the binary supports the flags.
 *
 * Values are sourced from `optimizations` when present; otherwise the
 * module-level defaults (`DEFAULT_CTX_CHECKPOINTS` = 4,
 * `DEFAULT_CTX_CHECKPOINT_INTERVAL` = 256) apply. This means all spawn-mode
 * servers automatically advertise checkpoint support once the upstream merge
 * lands — no per-model catalog entry is required.
 *
 * No-op when `enableCheckpoints === false` or when the binary doesn't
 * advertise the flags (so older fork builds without the merge start cleanly).
 */
export function appendCtxCheckpointFlags(
  args: string[],
  optimizations: LocalRuntimeOptimizations | null,
  binaryPath: string,
  enableCheckpoints = true,
): void {
  if (!enableCheckpoints) return;
  const caps = readDflashBinaryCapabilities(binaryPath);
  if (caps?.backend === "metal") {
    // The current llama.cpp checkpoint path uses SET_ROWS during graph
    // reserve. On Metal, a reshaped Metal-resident KV tensor can select
    // SET_ROWS and abort before the server starts. Keep optimistic rollback
    // enabled at the JS level, but do not pass native ctx-checkpoint flags on
    // Metal until the backend advertises a Metal-safe checkpoint primitive.
    return;
  }
  if (!probeCtxCheckpointsSupported(binaryPath)) return;
  const ckpt = optimizations?.ctxCheckpoints ?? DEFAULT_CTX_CHECKPOINTS;
  const interval =
    optimizations?.ctxCheckpointInterval ?? DEFAULT_CTX_CHECKPOINT_INTERVAL;
  if (
    helpAdvertisesFlag(binaryPath, "--ctx-checkpoints") &&
    typeof ckpt === "number" &&
    Number.isInteger(ckpt) &&
    ckpt > 0
  ) {
    args.push("--ctx-checkpoints", String(ckpt));
  }
  if (
    helpAdvertisesFlag(binaryPath, "--ctx-checkpoint-interval") &&
    typeof interval === "number" &&
    Number.isInteger(interval) &&
    interval > 0
  ) {
    args.push("--ctx-checkpoint-interval", String(interval));
  }
}

const disableThinkingProbeCache = new Map<string, string[]>();
const llamaServerHelpTextOverrideForTests = new Map<string, string>();

function llamaServerHelpText(binaryPath: string): string {
  const override = llamaServerHelpTextOverrideForTests.get(binaryPath);
  if (override !== undefined) return override;
  try {
    const result = spawnSync(binaryPath, ["--help"], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  } catch {
    return "";
  }
}

export function __setLlamaServerHelpTextForTests(
  binaryPath: string,
  helpText: string,
): void {
  llamaServerHelpTextOverrideForTests.set(binaryPath, helpText);
}

export function __resetLlamaServerHelpTextForTests(): void {
  llamaServerHelpTextOverrideForTests.clear();
}

export function resolveDisableThinkingFlags(binaryPath: string): string[] {
  const cached = disableThinkingProbeCache.get(binaryPath);
  if (cached) return [...cached];

  const help = llamaServerHelpText(binaryPath);
  const flags: string[] = [];
  if (/(^|\n).*--reasoning(?:[,\s]|$)/.test(help)) {
    flags.push("--reasoning", "off");
    if (/(^|\n).*--reasoning-budget(?:[,\s]|$)/.test(help)) {
      flags.push("--reasoning-budget", "0");
    }
  } else if (/(^|\n).*--reasoning-format(?:[,\s]|$)/.test(help)) {
    flags.push("--reasoning-format", "none");
  } else if (/(^|\n).*--chat-template-kwargs(?:[,\s]|$)/.test(help)) {
    flags.push("--chat-template-kwargs", '{"enable_thinking":false}');
  }
  if (flags.length === 0) {
    console.warn(
      `[local-inference] llama-server at ${binaryPath} does not advertise reasoning/chat-template controls; disableThinking requested but no compatible flag is available.`,
    );
  }
  disableThinkingProbeCache.set(binaryPath, flags);
  return [...flags];
}

export function appendMetalSafeStartupFlags(
  args: string[],
  binaryPath: string,
): void {
  const caps = readDflashBinaryCapabilities(binaryPath);
  if (caps?.backend !== "metal") return;
  const help = llamaServerHelpText(binaryPath);
  if (/(^|\n)\s*(?:-fit,|-fit\b|--fit\b)/.test(help)) {
    // The automatic fit probe constructs a temporary context before normal
    // serving. With Qwen3.5 hybrid attention + compressed KV, that graph can
    // still route QJL/Polar cache tensors through generic Metal attention
    // kernels before the dedicated compressed-KV graph route is selected.
    // Disable the probe on Metal; explicit ctx/gpu-layer values are already
    // supplied by the catalog/active-model planner.
    args.push("-fit", "off");
  }
}

const METAL_COMPRESSED_KV_FALLBACK = "q8_0";
const METAL_COMPRESSED_KV_UNSUPPORTED = new Set(["qjl1_256", "q4_polar"]);
const metalCompressedKvWarnings = new Set<string>();

export function resolveMetalRuntimeCacheTypes(opts: {
  binaryPath: string;
  targetModelPath: string;
  cacheTypeK: string | undefined;
  cacheTypeV: string | undefined;
  emitWarning?: boolean;
}): {
  cacheTypeK: string | undefined;
  cacheTypeV: string | undefined;
  downgraded: boolean;
  reason: string | null;
} {
  const caps = readDflashBinaryCapabilities(opts.binaryPath);
  const k = opts.cacheTypeK?.trim();
  const v = opts.cacheTypeV?.trim();
  const kLower = k?.toLowerCase();
  const vLower = v?.toLowerCase();
  const usesMetalCompressedKv =
    (kLower !== undefined && METAL_COMPRESSED_KV_UNSUPPORTED.has(kLower)) ||
    (vLower !== undefined && METAL_COMPRESSED_KV_UNSUPPORTED.has(vLower));

  if (
    caps?.backend !== "metal" ||
    !usesMetalCompressedKv ||
    readBool("ELIZA_DFLASH_METAL_COMPRESSED_KV") ||
    readBool("ELIZA_DFLASH_ALLOW_UNSAFE_METAL_COMPRESSED_KV")
  ) {
    return {
      cacheTypeK: k,
      cacheTypeV: v,
      downgraded: false,
      reason: null,
    };
  }

  const cacheTypeK =
    kLower !== undefined && METAL_COMPRESSED_KV_UNSUPPORTED.has(kLower)
      ? METAL_COMPRESSED_KV_FALLBACK
      : k;
  const cacheTypeV =
    vLower !== undefined && METAL_COMPRESSED_KV_UNSUPPORTED.has(vLower)
      ? METAL_COMPRESSED_KV_FALLBACK
      : v;
  const reason =
    "Metal runtime graph dispatch for Qwen3.5 hybrid attention still routes compressed QJL/Polar KV tensors through generic attention/MUL_MAT in the built decoder graph; using q8_0 KV keeps the fused Metal+DFlash+voice path live until the graph selects the dedicated compressed-KV attention ops.";

  if (opts.emitWarning !== false) {
    const warningKey = `${path.resolve(opts.binaryPath)}:${cacheTypeK}:${cacheTypeV}`;
    if (!metalCompressedKvWarnings.has(warningKey)) {
      metalCompressedKvWarnings.add(warningKey);
      console.warn(
        `[local-inference] ${reason} Set ELIZA_DFLASH_METAL_COMPRESSED_KV=1 only for kernel-runtime experiments; standalone QJL/Polar Metal shaders are verified, but the current built-fork graph path is not production-safe.`,
      );
    }
  }

  return {
    cacheTypeK,
    cacheTypeV,
    downgraded: true,
    reason,
  };
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
  return accelBackendKey("");
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
  const capabilities = readDflashBinaryCapabilities(binary);
  if (!dflashEnabled()) {
    const reason = dflashDevDisabled()
      ? "DFlash is disabled by the developer-only ELIZA_DFLASH_DISABLE flag. This is NOT a product setting — unset it to restore the always-on speculative-decoding contract."
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

const GGUF_METADATA_READ_LIMIT_BYTES = 256 * 1024 * 1024;
const GGUF_ARRAY = 9;
const GGUF_STRING = 8;

const DFLASH_TOKENIZER_HASH_KEYS = [
  "tokenizer.ggml.model",
  "tokenizer.ggml.pre",
  "tokenizer.ggml.tokens",
  "tokenizer.ggml.token_type",
  "tokenizer.ggml.merges",
  "tokenizer.ggml.eos_token_id",
  "tokenizer.ggml.bos_token_id",
  "tokenizer.ggml.padding_token_id",
  "tokenizer.ggml.add_bos_token",
] as const;

type DflashTokenizerHashKey = (typeof DFLASH_TOKENIZER_HASH_KEYS)[number];

interface DflashGgufMetadata {
  file: string;
  architecture: string | null;
  tokenizerModel: string | null;
  tokenizerPre: string | null;
  tokenizerHashes: Record<DflashTokenizerHashKey, string | null>;
  tokenizerLengths: Record<DflashTokenizerHashKey, number | null>;
}

export interface DflashDrafterCompatibilityReport {
  compatible: boolean;
  reason: string;
  target: Pick<
    DflashGgufMetadata,
    "file" | "architecture" | "tokenizerModel" | "tokenizerPre"
  >;
  drafter: Pick<
    DflashGgufMetadata,
    "file" | "architecture" | "tokenizerModel" | "tokenizerPre"
  >;
  tokenizerMismatches: Array<{
    key: DflashTokenizerHashKey;
    targetHash: string | null;
    drafterHash: string | null;
  }>;
}

function readGgufPrefix(file: string): Buffer {
  const stat = fs.statSync(file);
  const size = Math.min(stat.size, GGUF_METADATA_READ_LIMIT_BYTES);
  const fd = fs.openSync(file, "r");
  try {
    const out = Buffer.allocUnsafe(size);
    const read = fs.readSync(fd, out, 0, size, 0);
    return read === size ? out : out.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function assertGgufAvailable(buf: Buffer, offset: number, bytes: number): void {
  if (offset + bytes > buf.length) {
    throw new Error(
      `GGUF metadata exceeds ${Math.floor(
        GGUF_METADATA_READ_LIMIT_BYTES / 1024 / 1024,
      )} MiB validation window`,
    );
  }
}

function readGgufU64(buf: Buffer, off: { value: number }): number {
  assertGgufAvailable(buf, off.value, 8);
  const value = buf.readBigUInt64LE(off.value);
  off.value += 8;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`GGUF value too large for validation: ${value}`);
  }
  return Number(value);
}

function readGgufString(buf: Buffer, off: { value: number }): string {
  const len = readGgufU64(buf, off);
  assertGgufAvailable(buf, off.value, len);
  const value = buf.toString("utf8", off.value, off.value + len);
  off.value += len;
  return value;
}

function skipGgufScalar(
  buf: Buffer,
  off: { value: number },
  type: number,
): void {
  switch (type) {
    case 0:
    case 1:
    case 7:
      assertGgufAvailable(buf, off.value, 1);
      off.value += 1;
      return;
    case 2:
    case 3:
      assertGgufAvailable(buf, off.value, 2);
      off.value += 2;
      return;
    case 4:
    case 5:
    case 6:
      assertGgufAvailable(buf, off.value, 4);
      off.value += 4;
      return;
    case GGUF_STRING:
      readGgufString(buf, off);
      return;
    case 10:
    case 11:
    case 12:
      assertGgufAvailable(buf, off.value, 8);
      off.value += 8;
      return;
    default:
      throw new Error(`unsupported GGUF scalar type ${type}`);
  }
}

function readGgufScalar(
  buf: Buffer,
  off: { value: number },
  type: number,
): unknown {
  switch (type) {
    case 0: {
      assertGgufAvailable(buf, off.value, 1);
      const value = buf.readUInt8(off.value);
      off.value += 1;
      return value;
    }
    case 1: {
      assertGgufAvailable(buf, off.value, 1);
      const value = buf.readInt8(off.value);
      off.value += 1;
      return value;
    }
    case 2: {
      assertGgufAvailable(buf, off.value, 2);
      const value = buf.readUInt16LE(off.value);
      off.value += 2;
      return value;
    }
    case 3: {
      assertGgufAvailable(buf, off.value, 2);
      const value = buf.readInt16LE(off.value);
      off.value += 2;
      return value;
    }
    case 4: {
      assertGgufAvailable(buf, off.value, 4);
      const value = buf.readUInt32LE(off.value);
      off.value += 4;
      return value;
    }
    case 5: {
      assertGgufAvailable(buf, off.value, 4);
      const value = buf.readInt32LE(off.value);
      off.value += 4;
      return value;
    }
    case 6: {
      assertGgufAvailable(buf, off.value, 4);
      const value = buf.readFloatLE(off.value);
      off.value += 4;
      return value;
    }
    case 7: {
      assertGgufAvailable(buf, off.value, 1);
      const value = buf.readUInt8(off.value) !== 0;
      off.value += 1;
      return value;
    }
    case GGUF_STRING:
      return readGgufString(buf, off);
    case 10:
      return readGgufU64(buf, off);
    case 11: {
      assertGgufAvailable(buf, off.value, 8);
      const value = buf.readBigInt64LE(off.value);
      off.value += 8;
      return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
        value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value.toString();
    }
    case 12: {
      assertGgufAvailable(buf, off.value, 8);
      const value = buf.readDoubleLE(off.value);
      off.value += 8;
      return value;
    }
    default:
      throw new Error(`unsupported GGUF scalar type ${type}`);
  }
}

function skipGgufValue(
  buf: Buffer,
  off: { value: number },
  type: number,
): { arrayLength: number | null } {
  if (type !== GGUF_ARRAY) {
    skipGgufScalar(buf, off, type);
    return { arrayLength: null };
  }
  assertGgufAvailable(buf, off.value, 4);
  const innerType = buf.readUInt32LE(off.value);
  off.value += 4;
  const length = readGgufU64(buf, off);
  for (let i = 0; i < length; i += 1) {
    skipGgufScalar(buf, off, innerType);
  }
  return { arrayLength: length };
}

function readDflashGgufMetadata(file: string): DflashGgufMetadata {
  const buf = readGgufPrefix(file);
  const off = { value: 0 };
  assertGgufAvailable(buf, 0, 16);
  if (buf.toString("utf8", 0, 4) !== "GGUF") {
    throw new Error(`${file} is not a GGUF file`);
  }
  off.value = 4;
  off.value += 4; // version
  readGgufU64(buf, off); // tensor count
  const kvCount = readGgufU64(buf, off);
  const metadata = new Map<string, unknown>();
  const hashes = new Map<string, string>();
  const lengths = new Map<string, number>();

  for (let i = 0; i < kvCount; i += 1) {
    const key = readGgufString(buf, off);
    assertGgufAvailable(buf, off.value, 4);
    const type = buf.readUInt32LE(off.value);
    off.value += 4;
    const valueStart = off.value;
    if (
      key === "general.architecture" ||
      key === "tokenizer.ggml.model" ||
      key === "tokenizer.ggml.pre"
    ) {
      metadata.set(key, readGgufScalar(buf, off, type));
    } else {
      const skipped = skipGgufValue(buf, off, type);
      if (skipped.arrayLength !== null) lengths.set(key, skipped.arrayLength);
    }
    const valueEnd = off.value;
    if (
      (DFLASH_TOKENIZER_HASH_KEYS as readonly string[]).includes(key) &&
      valueEnd >= valueStart
    ) {
      hashes.set(
        key,
        crypto
          .createHash("sha256")
          .update(buf.subarray(valueStart, valueEnd))
          .digest("hex"),
      );
    }
  }

  const tokenizerHashes = Object.fromEntries(
    DFLASH_TOKENIZER_HASH_KEYS.map((key) => [key, hashes.get(key) ?? null]),
  ) as Record<DflashTokenizerHashKey, string | null>;
  const tokenizerLengths = Object.fromEntries(
    DFLASH_TOKENIZER_HASH_KEYS.map((key) => [key, lengths.get(key) ?? null]),
  ) as Record<DflashTokenizerHashKey, number | null>;
  const architecture = metadata.get("general.architecture");
  const tokenizerModel = metadata.get("tokenizer.ggml.model");
  const tokenizerPre = metadata.get("tokenizer.ggml.pre");

  return {
    file,
    architecture: typeof architecture === "string" ? architecture : null,
    tokenizerModel: typeof tokenizerModel === "string" ? tokenizerModel : null,
    tokenizerPre: typeof tokenizerPre === "string" ? tokenizerPre : null,
    tokenizerHashes,
    tokenizerLengths,
  };
}

function binarySupportsDflashDraftArchitecture(binaryPath: string): boolean {
  const caps = readCapabilitiesAt(
    path.join(path.dirname(binaryPath), "CAPABILITIES.json"),
  );
  if (!caps) return false;
  const raw = caps as DflashBinaryCapabilities & Record<string, unknown>;
  if (raw.dflashDraftArchitecture === true) return true;
  const draftArchitectures = raw.draftArchitectures;
  if (
    Array.isArray(draftArchitectures) &&
    draftArchitectures.includes("dflash-draft")
  ) {
    return true;
  }
  const supportedArchitectures = raw.supportedArchitectures;
  return (
    Array.isArray(supportedArchitectures) &&
    supportedArchitectures.includes("dflash-draft")
  );
}

export function validateDflashDrafterCompatibility(args: {
  targetModelPath: string;
  drafterModelPath: string;
  binaryPath: string;
}): DflashDrafterCompatibilityReport {
  const target = readDflashGgufMetadata(args.targetModelPath);
  const drafter = readDflashGgufMetadata(args.drafterModelPath);
  const tokenizerMismatches = DFLASH_TOKENIZER_HASH_KEYS.filter((key) => {
    const targetHash = target.tokenizerHashes[key];
    const drafterHash = drafter.tokenizerHashes[key];
    if (key === "tokenizer.ggml.merges") {
      const usesGpt2 =
        target.tokenizerModel === "gpt2" || drafter.tokenizerModel === "gpt2";
      return usesGpt2 && targetHash !== drafterHash;
    }
    return targetHash !== drafterHash;
  }).map((key) => ({
    key,
    targetHash: target.tokenizerHashes[key],
    drafterHash: drafter.tokenizerHashes[key],
  }));

  const failures: string[] = [];
  if (
    drafter.architecture === "dflash-draft" &&
    !binarySupportsDflashDraftArchitecture(args.binaryPath)
  ) {
    failures.push(
      "drafter GGUF architecture is 'dflash-draft', but the installed llama-server does not advertise dflash-draft GGUF loader support",
    );
  }
  if (!target.architecture) {
    failures.push("target GGUF is missing general.architecture metadata");
  }
  if (!drafter.architecture) {
    failures.push("drafter GGUF is missing general.architecture metadata");
  }
  if (tokenizerMismatches.length > 0) {
    failures.push(
      `target/drafter tokenizer metadata mismatch (${tokenizerMismatches
        .map((m) => m.key)
        .join(", ")})`,
    );
  }

  return {
    compatible: failures.length === 0,
    reason:
      failures.length === 0
        ? "target and drafter GGUF metadata are compatible"
        : `${failures.join("; ")}. Install a drafter distilled from this exact target checkpoint with the same tokenizer metadata, or rebuild llama-server with explicit dflash-draft GGUF support if this is an upstream dflash-draft artifact.`,
    target: {
      file: target.file,
      architecture: target.architecture,
      tokenizerModel: target.tokenizerModel,
      tokenizerPre: target.tokenizerPre,
    },
    drafter: {
      file: drafter.file,
      architecture: drafter.architecture,
      tokenizerModel: drafter.tokenizerModel,
      tokenizerPre: drafter.tokenizerPre,
    },
    tokenizerMismatches,
  };
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
    /**
     * Native DFlash event listener. When provided AND the parsed SSE
     * chunk carries a well-formed `dflash` field, the parsed event(s) are
     * forwarded here in addition to the legacy `onVerifierEvent` synthesis
     * path. The caller decides whether native events should suppress the
     * synthesized accept event (see `suppressSynthesizedVerifierEvent`).
     */
    onDflashEvent?: (event: DflashStreamEvent) => void | Promise<void>;
    /**
     * L1 — listener for the `dflashVerify` per-step events. Fires
     * alongside the existing OpenAI delta (additive). The caller plumbs
     * the feature-flag gate; when the flag is OFF, the caller MUST NOT
     * pass this callback so the legacy synthesis path runs byte-
     * identical to before. See `useNativeDflashVerifyEvents()`.
     */
    onDflashVerifyEvent?: (event: DflashVerifyEvent) => void | Promise<void>;
    /**
     * When true, do NOT fire the legacy synthesized `accept` event for
     * each text chunk — the native event stream is authoritative. Set
     * by the caller when `nativeDflashEventsEnabled()` resolved true.
     */
    suppressSynthesizedVerifierEvent?: boolean;
  },
  repairStream?: StructuredOutputRepairStream | null,
  externalSignal?: AbortSignal,
  startIndex = 0,
): Promise<{
  text: string;
  firstTokenMs: number | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  dflash?: { drafted: number; accepted: number };
}> {
  const controller = new AbortController();
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // L5 — capture t0 immediately before the outbound fetch so first-token
  // latency reflects the full request round-trip (DNS + connect + server
  // queue + first SSE chunk).
  const t0 = performance.now();
  let firstTokenMs: number | null = null;
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
    let responseUsage:
      | { prompt_tokens?: number; completion_tokens?: number }
      | undefined;
    let responseDflash: { drafted: number; accepted: number } | undefined;
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
      const timingRecord =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>).timings
          : null;
      if (timingRecord && typeof timingRecord === "object") {
        const timings = timingRecord as Record<string, unknown>;
        const prompt = timings.prompt_n;
        const predicted = timings.predicted_n;
        const drafted = timings.draft_n;
        const accepted = timings.draft_n_accepted;
        const usage: { prompt_tokens?: number; completion_tokens?: number } =
          {};
        if (typeof prompt === "number" && Number.isFinite(prompt)) {
          usage.prompt_tokens = prompt;
        }
        if (typeof predicted === "number" && Number.isFinite(predicted)) {
          usage.completion_tokens = predicted;
        }
        if (Object.keys(usage).length > 0) responseUsage = usage;
        if (
          typeof drafted === "number" &&
          Number.isFinite(drafted) &&
          typeof accepted === "number" &&
          Number.isFinite(accepted)
        ) {
          responseDflash = {
            drafted: Math.max(0, drafted),
            accepted: Math.max(0, accepted),
          };
        }
      }

      // Native DFlash protocol — parse the `dflash` field first. When the
      // C-side fork advertises `capabilities.dflashNativeEvents` and the
      // bundle opts in, the SSE chunk carries one or more
      // `DflashStreamEvent` payloads. They are additive: the chunk still
      // has the standard OpenAI `choices[].delta.content` for text.
      if (callbacks.onDflashEvent) {
        const nativeEvents = parseDflashFieldFromSseChunk(parsed);
        for (const ev of nativeEvents) {
          await callbacks.onDflashEvent(ev);
        }
      }

      // L1 — per-step verify events on the `dflashVerify` top-level
      // field. Parsed independently of the union-shape events above so
      // a binary can ship either or both protocols. The caller-side
      // feature flag (useNativeDflashVerifyEvents) gates whether
      // `callbacks.onDflashVerifyEvent` is wired; when unwired the
      // event is silently ignored even if the C side emits it.
      if (callbacks.onDflashVerifyEvent) {
        const verifyEvents = parseDflashVerifyEventsFromSseChunk(parsed);
        for (const ev of verifyEvents) {
          await callbacks.onDflashVerifyEvent(ev);
        }
      }

      // Legacy native reject-range — single-event shape predating the
      // discriminated-union protocol. Kept for compatibility with builds
      // that emit `verifier.rejected` without the richer `dflash` field.
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

      let chunk = extractStreamingChatDelta(parsed);
      if (!chunk) return;
      if (repairStream) chunk = repairStream.push(chunk);
      if (!chunk) return;
      // L5 — first usable chunk: record latency BEFORE emitting so the
      // first verifier-event payload carries it.
      if (firstTokenMs === null) {
        firstTokenMs = performance.now() - t0;
      }
      text += chunk;
      if (
        callbacks.onVerifierEvent &&
        !callbacks.suppressSynthesizedVerifierEvent
      ) {
        const event: VerifierStreamEvent = {
          kind: "accept",
          tokens: [{ index: nextIndex++, text: chunk }],
        };
        if (firstTokenMs !== null && nextIndex - 1 === startIndex) {
          event.meta = { firstTokenMs };
        }
        await callbacks.onVerifierEvent(event);
      } else if (callbacks.suppressSynthesizedVerifierEvent) {
        // Still advance nextIndex so the structured-output repair path
        // and the final flush continue to use a consistent counter.
        nextIndex += 1;
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
    const finalRepair = repairStream?.flush() ?? "";
    if (finalRepair) {
      text += finalRepair;
      if (
        callbacks.onVerifierEvent &&
        !callbacks.suppressSynthesizedVerifierEvent
      ) {
        await callbacks.onVerifierEvent({
          kind: "accept",
          tokens: [{ index: nextIndex++, text: finalRepair }],
        });
      } else if (callbacks.suppressSynthesizedVerifierEvent) {
        nextIndex += 1;
      }
      await callbacks.onTextChunk?.(finalRepair);
    }
    return {
      text,
      firstTokenMs,
      ...(responseUsage ? { usage: responseUsage } : {}),
      ...(responseDflash ? { dflash: responseDflash } : {}),
    };
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
 * `[2, MAX_AUTO_PARALLEL]`. With a 2B model at 32k that's many slots;
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
 * Inject a `GpuProfile`'s tuned flags into an in-progress llama-server
 * command line. Pure addition — call this *after* `appendOptimizationFlags`
 * so env-var overrides still win, but the profile wins over a catalog
 * default that left the flag unset.
 *
 * The helper is intentionally conservative:
 *  - It does NOT push `--n-gpu-layers` (the spawn site already handles
 *    `gpuLayers` from the DFlash plan; overriding it from a profile would
 *    fight with the explicit catalog value).
 *  - It does NOT push `--ctx-size` (sized per-bundle by the caller).
 *  - It DOES push `--cache-type-k/-v`, `--parallel`, `--batch-size`,
 *    `--ubatch-size`, `--mlock`, `--no-mmap`, `-fa on`,
 *    `--no-kv-offload` (when `kvSpillToCpu` is set), and DFlash
 *    `--draft-min` / `--draft-max`.
 *
 * Idempotent on flags already present: if `args` already contains a
 * `--batch-size` token, we don't push a second copy.
 */
export function applyGpuProfile(args: string[], profile: GpuProfile): string[] {
  if (!args.includes("--cache-type-k")) {
    args.push("--cache-type-k", profile.kvCacheTypeK);
  }
  if (!args.includes("--cache-type-v")) {
    args.push("--cache-type-v", profile.kvCacheTypeV);
  }
  if (!args.includes("--parallel")) {
    args.push("--parallel", String(profile.parallel));
  }
  if (!args.includes("--batch-size")) {
    args.push("--batch-size", String(profile.batchSize));
  }
  if (!args.includes("--ubatch-size")) {
    args.push("--ubatch-size", String(profile.ubatchSize));
  }
  if (profile.flashAttn && !args.includes("-fa")) {
    args.push("-fa", "on");
  }
  if (profile.mlock && !args.includes("--mlock")) {
    args.push("--mlock");
  }
  if (profile.noMmap && !args.includes("--no-mmap")) {
    args.push("--no-mmap");
  }
  if (profile.kvSpillToCpu && !args.includes("--no-kv-offload")) {
    args.push("--no-kv-offload");
  }
  if (!args.includes("--draft-min")) {
    args.push("--draft-min", String(profile.dflashDraftMin));
  }
  if (!args.includes("--draft-max")) {
    args.push("--draft-max", String(profile.dflashDraftMax));
  }
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
  /**
   * P3 — per-slot single-flight lock. The llama-server itself serializes
   * requests to the same slot, but the JS layer didn't reflect that:
   * two concurrent `generateWithUsage()` calls against the same `slotId`
   * could interleave their metrics-diff windows, producing nonsense
   * usage numbers and (in streaming mode) interleaving SSE events. This
   * lock makes the JS side wait for the prior in-flight call to a pinned
   * slot before issuing the next one. Slot id `-1` ("any free slot") is
   * intentionally NOT locked — it routes to whichever slot is free, so
   * serializing on it would block unrelated work.
   */
  private readonly slotInFlight = new Map<number, Promise<void>>();

  /**
   * Cached result of the `/health` capability probe — does the running
   * llama-server advertise `capabilities.dflashNativeEvents: true`? The
   * probe runs at most once per server lifetime; `null` means "not yet
   * probed", `false` means "probed and missing or absent".
   */
  private nativeDflashEventsCapability: boolean | null = null;

  /**
   * L1 — long-lived collector that accumulates `dflash-verify` events
   * across all turns for the lifetime of the server instance. Active
   * only when `useNativeDflashEvents()` returns true. Used by
   * `scrapeCollectorMetrics()` to serve Prometheus-formatted counters.
   */
  private readonly verifyCollector = new DflashMetricsCollector();

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
    if (this.loadedPlan?.disableDrafter) return null;
    return this.loadedPlan?.drafterModelPath ?? null;
  }

  /** Reason the drafter was omitted from the current launch, when known. */
  disabledDrafterReason(): string | null {
    return this.loadedPlan?.disabledDrafterReason ?? null;
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
   * L1 — Return Prometheus-format lines for the native `dflash-verify`
   * counters accumulated by the long-lived `verifyCollector`.
   *
   * When the `/metrics` endpoint is scraped by an external Prometheus
   * instance, callers append this output to the llama-server scrape body
   * so the four new counters appear alongside the existing ones:
   *
   * ```
   * dflash_drafted_tokens_total <N>
   * dflash_accepted_tokens_total <N>
   * dflash_rejected_tokens_total <N>
   * dflash_acceptance_rate <0.0-1.0>
   * ```
   *
   * Returns an empty string when `useNativeDflashEvents()` is false (the
   * flag-off production-safe default) or when no `dflash-verify` events
   * have been received yet.
   */
  scrapeCollectorMetrics(): string {
    if (!useNativeDflashEvents()) return "";
    return this.verifyCollector.formatPrometheusMetrics();
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

    // Catalog KV-cache types (`runtime.kvCache.typeK/typeV` — `qjl1_256` K +
    // `q4_polar` V for the >8k Eliza-1 tiers, per inference/AGENTS.md §3).
    // A per-load override (`overrides.cacheTypeK/V`) wins; `start()` then runs
    // `assertCacheTypeSupportedOnBackend` on whichever value it ends up with,
    // and the `ELIZA_DFLASH_CACHE_TYPE_K/_V` env vars override even that.
    const kvCache = catalog?.runtime?.kvCache;
    const cacheTypeK =
      typeof overrides?.cacheTypeK === "string"
        ? overrides.cacheTypeK
        : kvCache?.typeK;
    const cacheTypeV =
      typeof overrides?.cacheTypeV === "string"
        ? overrides.cacheTypeV
        : kvCache?.typeV;

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
        cacheTypeK,
        cacheTypeV,
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
    const status = getDflashRuntimeStatus();
    if (!status.enabled || !status.binaryPath) {
      throw new Error(`[dflash] ${status.reason}`);
    }

    const drafterEnabled = !plan.disableDrafter;
    let disabledDrafterReason = plan.disabledDrafterReason;
    if (drafterEnabled) {
      assertDflashSpecSupportedOnBackend(status.binaryPath);
    }
    const drafterModelPath = drafterEnabled
      ? maybeRepairDflashDrafter(
          status.binaryPath,
          plan.targetModelPath,
          plan.drafterModelPath,
        )
      : plan.drafterModelPath;
    if (drafterEnabled) {
      try {
        const compatibility = validateDflashDrafterCompatibility({
          targetModelPath: plan.targetModelPath,
          drafterModelPath,
          binaryPath: status.binaryPath,
        });
        if (!compatibility.compatible) {
          throw new Error(
            `[dflash] DFlash drafter rejected before llama-server startup; refusing to launch target-only because Eliza-1 requires DFlash. ${compatibility.reason}`,
          );
        }
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.startsWith("[dflash] DFlash drafter rejected")
        ) {
          throw err;
        }
        disabledDrafterReason = `could not validate DFlash drafter GGUF metadata (${err instanceof Error ? err.message : String(err)})`;
        throw new Error(
          `[dflash] DFlash drafter rejected before llama-server startup; refusing to launch target-only because Eliza-1 requires DFlash. ${disabledDrafterReason}`,
        );
      }
    }
    const effectivePlan: DflashServerPlan = {
      ...plan,
      drafterModelPath,
      disableDrafter: !drafterEnabled,
      disabledDrafterReason,
    };
    if (
      this.child &&
      this.loadedPlan?.targetModelPath === effectivePlan.targetModelPath &&
      this.loadedPlan.drafterModelPath === effectivePlan.drafterModelPath &&
      (this.loadedPlan.disableDrafter ?? false) ===
        (effectivePlan.disableDrafter ?? false) &&
      this.loadedPlan.parallelOverride === effectivePlan.parallelOverride
    ) {
      return;
    }
    await this.stop();

    const port = await resolvePort();
    const host = process.env.ELIZA_DFLASH_HOST?.trim() || DEFAULT_HOST;
    const requestedCacheTypeK =
      process.env.ELIZA_DFLASH_CACHE_TYPE_K?.trim() || effectivePlan.cacheTypeK;
    const requestedCacheTypeV =
      process.env.ELIZA_DFLASH_CACHE_TYPE_V?.trim() || effectivePlan.cacheTypeV;
    const runtimeCacheTypes = resolveMetalRuntimeCacheTypes({
      binaryPath: status.binaryPath,
      targetModelPath: effectivePlan.targetModelPath,
      cacheTypeK: requestedCacheTypeK,
      cacheTypeV: requestedCacheTypeV,
    });
    const cacheTypeK = runtimeCacheTypes.cacheTypeK;
    const cacheTypeV = runtimeCacheTypes.cacheTypeV;
    const usableRamMb =
      Math.round(os.totalmem() / BYTES_PER_MB_DFLASH) - ramHeadroomReserveMb();
    const parallel = resolveParallel(
      optimizations?.parallel,
      effectivePlan.params
        ? {
            contextSize: effectivePlan.contextSize,
            params: effectivePlan.params,
            usableRamMb,
          }
        : undefined,
      effectivePlan.parallelOverride,
    );
    this.lastOptimizations = optimizations ?? null;
    const kvOffload = effectivePlan.kvOffload ?? resolveDflashKvOffload(null);
    const modelHash = buildModelHash({
      targetModelPath: effectivePlan.targetModelPath,
      drafterModelPath,
      cacheTypeK: cacheTypeK ?? null,
      cacheTypeV: cacheTypeV ?? null,
      extra: `ctx=${effectivePlan.contextSize};parallel=${parallel};kv=${kvOffload ?? "default"};drafter=${drafterEnabled ? "on" : "off"}`,
    });
    const slotDir = slotSavePath(modelHash);
    // llama-server's slot API treats `filename` as a basename relative to
    // --slot-save-path. Keep per-conversation KV files in that same root so
    // save and restore agree on the exact path.
    const conversationKvDir = slotDir;
    fs.mkdirSync(slotDir, { recursive: true });
    // Pre-create a checkpoints/ subdir inside the slot-save directory so the
    // server's mid-prefill KV snapshots (`--ctx-checkpoints`) land in a
    // known location. The files are named by CheckpointManager and stored
    // directly under --slot-save-path; this subdir is kept for any future
    // path-prefix conventions and so operators can find checkpoint files
    // without sifting through slot KV blobs.
    const checkpointsDir = path.join(slotDir, "checkpoints");
    fs.mkdirSync(checkpointsDir, { recursive: true });
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
      effectivePlan.targetModelPath,
      ...(drafterEnabled
        ? [
            "-md",
            drafterModelPath,
            "--spec-type",
            "dflash",
            "--n-gpu-layers-draft",
            normalizeGpuLayers(effectivePlan.draftGpuLayers),
          ]
        : []),
      "--host",
      host,
      "--port",
      String(port),
      "--n-gpu-layers",
      normalizeGpuLayers(effectivePlan.gpuLayers),
      "--ctx-size",
      String(effectivePlan.contextSize),
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
    if (drafterEnabled) {
      appendDflashDraftTuningFlags(args, {
        binaryPath: status.binaryPath,
        draftContextSize: effectivePlan.draftContextSize,
        draftMin: effectivePlan.draftMin,
        draftMax: effectivePlan.draftMax,
      });
    }
    if (effectivePlan.disableThinking) {
      args.push(...resolveDisableThinkingFlags(status.binaryPath));
    }
    const cacheTypeKSource = process.env.ELIZA_DFLASH_CACHE_TYPE_K?.trim()
      ? "ELIZA_DFLASH_CACHE_TYPE_K"
      : "runtime.kvCache.typeK";
    const cacheTypeVSource = process.env.ELIZA_DFLASH_CACHE_TYPE_V?.trim()
      ? "ELIZA_DFLASH_CACHE_TYPE_V"
      : "runtime.kvCache.typeV";
    if (cacheTypeK) {
      assertCacheTypeSupportedOnBackend(
        cacheTypeKSource,
        cacheTypeK,
        status.binaryPath,
      );
      args.push("--cache-type-k", cacheTypeK);
    }
    if (cacheTypeV) {
      assertCacheTypeSupportedOnBackend(
        cacheTypeVSource,
        cacheTypeV,
        status.binaryPath,
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
    appendKvSpillFlags(args, effectivePlan.kvSpillPlan);
    // Mid-prefill KV checkpoints (upstream llama.cpp `--ctx-checkpoints` +
    // `--ctx-checkpoint-interval`). Gated by a `--help` probe so older fork
    // builds without the feature merged in still start cleanly — see
    // `appendCtxCheckpointFlags` + `probeCtxCheckpointsSupported`. The voice
    // optimistic-rollback path (`OptimisticRollbackController`) reads these
    // snapshots over `/slots/<id>/save` + `/restore`.
    appendCtxCheckpointFlags(args, optimizations ?? null, status.binaryPath);
    appendMetalSafeStartupFlags(args, status.binaryPath);

    // Fused omnivoice TTS: when the resolved binary is the omnivoice-fused
    // `llama-server` and the bundle ships its TTS GGUFs, hand them to the
    // server so it mounts `POST /v1/audio/speech` in-process (AGENTS.md §4
    // — one process, not a second `llama-omnivoice-server` over IPC). The
    // route handler in the fork's `server.cpp` (guarded by
    // `#ifdef ELIZA_FUSE_OMNIVOICE`) lazy-`ov_init`s from these paths.
    const runningBinaryIsFused =
      resolveFusedDflashBinary() !== null &&
      path.resolve(status.binaryPath) ===
        path.resolve(resolveFusedDflashBinary() ?? "");
    if (
      runningBinaryIsFused &&
      effectivePlan.ttsModelPath &&
      effectivePlan.ttsCodecPath
    ) {
      args.push("--omnivoice-model", effectivePlan.ttsModelPath);
      args.push("--omnivoice-codec", effectivePlan.ttsCodecPath);
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
          assertCacheTypeSupportedOnBackend(
            tokens[i],
            tokens[i + 1],
            status.binaryPath,
          );
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
    this.loadedPlan = effectivePlan;
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
    this.nativeDflashEventsCapability = null;
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
   * Probe the running llama-server for native DFlash event support. Result
   * is cached for the lifetime of the spawned process. Returns false on
   * any error or when the field is absent — the legacy synthesis path is
   * always the safe fallback. Visible for tests via `probeNativeDflashEvents`.
   */
  private async probeNativeDflashEventsCapability(): Promise<boolean> {
    if (this.nativeDflashEventsCapability !== null) {
      return this.nativeDflashEventsCapability;
    }
    const baseUrl = this.baseUrl;
    if (!baseUrl) {
      this.nativeDflashEventsCapability = false;
      return false;
    }
    let detected = false;
    try {
      const res = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        const body = (await res.json()) as unknown;
        if (body && typeof body === "object") {
          const caps = (body as Record<string, unknown>).capabilities;
          if (caps && typeof caps === "object") {
            const capRecord = caps as Record<string, unknown>;
            detected = capRecord.dflashNativeEvents === true;
          }
        }
      }
    } catch {
      detected = false;
    }
    this.nativeDflashEventsCapability = detected;
    return detected;
  }

  /**
   * Decide whether native DFlash events should drive this turn's verifier
   * callback. Native mode is enabled when ALL of:
   *  1. The loaded bundle opts in (`optimizations.nativeDflashEvents`).
   *  2. The running server advertises `capabilities.dflashNativeEvents`.
   * Otherwise the legacy synthesized accept-only stream runs unchanged.
   */
  private async nativeDflashEventsEnabled(): Promise<boolean> {
    const bundleOptIn = Boolean(this.lastOptimizations?.nativeDflashEvents);
    if (!bundleOptIn) return false;
    return this.probeNativeDflashEventsCapability();
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
    // P3 — single-flight per pinned slot. -1 ("any free slot") is
    // unlocked because the server routes each unpinned call to whichever
    // slot is free, so serializing on -1 would block unrelated work.
    if (slotId < 0) {
      return this.runGenerate(baseUrl, dflashArgs, args, slotId);
    }
    const prior = this.slotInFlight.get(slotId);
    // Chain our work after the prior tail; the new tail is what future
    // callers will await. Errors don't break the chain (`.catch`).
    const run = (prior ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.runGenerate(baseUrl, dflashArgs, args, slotId));
    // Store the void-typed continuation so subsequent callers can await
    // completion without inheriting our result type.
    const tail = run.then(
      () => {},
      () => {},
    );
    this.slotInFlight.set(slotId, tail);
    try {
      return await run;
    } finally {
      // Only clear the entry if no later caller has chained on top.
      if (this.slotInFlight.get(slotId) === tail) {
        this.slotInFlight.delete(slotId);
      }
    }
  }

  private async runGenerate(
    baseUrl: string,
    dflashArgs: DflashGenerateArgs,
    args: DflashGenerateArgs | BackendGenerateArgs,
    slotId: number,
  ): Promise<DflashGenerateResult> {
    const streaming = Boolean(
      args.onTextChunk ||
        dflashArgs.onVerifierEvent ||
        dflashArgs.onDflashEvent,
    );
    const prefill =
      typeof dflashArgs.prefill === "string" && dflashArgs.prefill.length > 0
        ? dflashArgs.prefill
        : "";
    const payload = buildChatCompletionBody(dflashArgs, slotId, streaming);
    attachDflashSpeculativeRequestFields(payload, this.loadedPlan);
    if (readBool("ELIZA_DFLASH_DEBUG_REQUEST")) {
      console.error(
        "[dflash] request",
        JSON.stringify({
          streaming,
          slotId,
          maxTokens: payload.max_tokens,
          speculativeType: payload["speculative.type"] ?? null,
          speculativeMin: payload["speculative.n_min"] ?? null,
          speculativeMax: payload["speculative.n_max"] ?? null,
          loadedPlan: this.loadedPlan
            ? {
                draftMin: this.loadedPlan.draftMin,
                draftMax: this.loadedPlan.draftMax,
                disableDrafter: this.loadedPlan.disableDrafter ?? false,
              }
            : null,
        }),
      );
    }
    const before = await fetchMetricsSnapshot(baseUrl);
    let json: Record<string, unknown> | null = null;
    let text: string;
    let firstTokenMs: number | null = null;
    let streamingResponseUsage:
      | { prompt_tokens?: number; completion_tokens?: number }
      | undefined;
    let streamingDflash: { drafted: number; accepted: number } | undefined;
    // Native DFlash event collector. Active only when the bundle opts in
    // AND the running server advertises the capability. When inactive,
    // `nativeEventsActive` is false and the existing JS synthesis path
    // runs unchanged — `dflashStats` is omitted from the result.
    const nativeEventsActive = streaming
      ? await this.nativeDflashEventsEnabled()
      : false;
    const collector = nativeEventsActive ? new DflashMetricsCollector() : null;
    if (streaming) {
      const repairStream =
        dflashArgs.responseSkeleton || dflashArgs.responseSchema
          ? new StructuredOutputRepairStream({
              skeleton: dflashArgs.responseSkeleton,
              jsonSchema: dflashArgs.responseSchema,
            })
          : null;
      // When the assistant turn is prefilled, the model only streams the
      // continuation — surface the full assistant message (prefill + tail)
      // and fire the prefill chunk through the callbacks first so the voice
      // bridge / structured-field tracker sees a complete envelope.
      let idx = 0;
      let streamedPrefix = prefill;
      if (prefill.length > 0) {
        streamedPrefix = repairStream?.push(prefill) ?? prefill;
        await dflashArgs.onVerifierEvent?.({
          kind: "accept",
          tokens: [{ index: idx++, text: streamedPrefix }],
        });
        await args.onTextChunk?.(streamedPrefix);
      }
      const onDflashEvent = nativeEventsActive
        ? async (event: DflashStreamEvent) => {
            collector?.record(event);
            // L1 — when native dflash-verify events are enabled, also feed
            // the long-lived verifyCollector so Prometheus scrapes see
            // cumulative totals across turns (not just per-turn).
            if (useNativeDflashEvents()) {
              this.verifyCollector.record(event);
            }
            await dflashArgs.onDflashEvent?.(event);
          }
        : undefined;
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
          onDflashEvent,
          suppressSynthesizedVerifierEvent: nativeEventsActive,
        },
        repairStream,
        args.signal,
        idx,
      );
      text = streamedPrefix + tail.text;
      firstTokenMs = tail.firstTokenMs;
      streamingResponseUsage = tail.usage;
      streamingDflash = tail.dflash;
      if (readBool("ELIZA_DFLASH_DEBUG_REQUEST")) {
        console.error(
          "[dflash] streaming-tail",
          JSON.stringify({
            usage: streamingResponseUsage ?? null,
            dflash: streamingDflash ?? null,
          }),
        );
      }
      // L5 — emit first-token latency metrics now that we have the value.
      // `inference.ttfa_ms` is the time from fetch() to the first HTTP chunk
      // (time-to-first-arrival); `inference.first_token_ms` captures the same
      // measurement from the request's own perspective (they are identical here
      // since we record on the first SSE chunk that carries decoded text). Both
      // are recorded so downstream consumers can choose their preferred name.
      if (firstTokenMs !== null) {
        const telTags = {
          tier: this.loadedPlan?.params ?? "unknown",
          backend: "dflash-llama",
          slot_id: slotId,
        };
        inferenceTelemetry.record("inference.ttfa_ms", firstTokenMs, telTags);
        inferenceTelemetry.record(
          "inference.first_token_ms",
          firstTokenMs,
          telTags,
        );
      }
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
      if (dflashArgs.responseSkeleton) {
        text = repairStructuredOutput(text, {
          skeleton: dflashArgs.responseSkeleton,
          jsonSchema: dflashArgs.responseSchema,
        }).text;
      } else if (dflashArgs.responseSchema) {
        text = repairStructuredOutput(text, {
          jsonSchema: dflashArgs.responseSchema,
        }).text;
      }
    }
    const after = await fetchMetricsSnapshot(baseUrl);
    const responseUsage = json
      ? extractResponseUsage(json)
      : streamingResponseUsage;
    let usage = diffSnapshots(before, after, responseUsage);
    if (
      streamingDflash &&
      streamingDflash.drafted > 0 &&
      (usage.dflash_drafted_tokens ?? 0) <= 0
    ) {
      usage = {
        ...usage,
        dflash_drafted_tokens: streamingDflash.drafted,
        dflash_accepted_tokens: streamingDflash.accepted,
        dflash_acceptance_rate:
          streamingDflash.accepted / streamingDflash.drafted,
      };
    }
    const observedOutputTokens = estimateOutputTokensForDflashEvidence(
      usage,
      text,
    );
    const maxTokens =
      typeof payload.max_tokens === "number" ? payload.max_tokens : null;
    const metricsCanProveDflashActivity =
      before.scrapeOk === true &&
      after.scrapeOk === true &&
      before.hasGenerationCounters === true &&
      after.hasGenerationCounters === true;
    if (
      shouldRequireActiveDflashForRequest(
        this.loadedPlan,
        maxTokens,
        observedOutputTokens,
      ) &&
      metricsCanProveDflashActivity &&
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
    let dflashStats: DflashTurnStats | undefined;
    if (collector) {
      const summary = collector.finalize();
      dflashStats = {
        drafted: summary.drafted,
        accepted: summary.accepted,
        rounds: summary.rounds,
        acceptanceRate: summary.acceptanceRate,
      };
      // Fire-and-forget: history push logs + notifies listeners. Errors
      // from listeners must not affect the caller's completion result,
      // so we don't await it here.
      void dflashTurnHistory.push(summary);
    }
    return { text, usage, slotId, firstTokenMs, dflashStats };
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
