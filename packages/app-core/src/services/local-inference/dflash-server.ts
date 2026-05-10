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
import {
  buildModelHash,
  type CacheStatsEntry,
  DEFAULT_CACHE_TTLS,
  deriveSlotId,
  evictExpired,
  readCacheStats,
  slotSavePath,
} from "./cache-bridge";
import { findCatalogModel } from "./catalog";
import {
  diffSnapshots,
  fetchMetricsSnapshot,
  type LocalUsageBlock,
} from "./llama-server-metrics";
import { localInferenceRoot } from "./paths";
import type { LocalRuntimeOptimizations } from "./types";

export interface DflashServerPlan {
  targetModelPath: string;
  drafterModelPath: string;
  contextSize: number;
  draftContextSize: number;
  draftMin: number;
  draftMax: number;
  gpuLayers: number | "auto";
  draftGpuLayers: number | "auto";
  disableThinking: boolean;
}

export interface DflashGenerateArgs {
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
const METAL_UNSUPPORTED_CACHE_TYPES = new Set([
  "turbo2",
  "turbo3",
  "turbo4",
  "turbo2_0",
  "turbo3_0",
  "turbo4_0",
  "turbo2_tcq",
  "turbo3_tcq",
]);

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
  const samples = new Map<string, number>();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(
      /^([a-zA-Z_:][\w:]*)(?:\{[^}]*\})?\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/,
    );
    if (!match) continue;
    const name = match[1];
    const value = Number(match[2]);
    if (!name || !Number.isFinite(value)) continue;
    samples.set(name, (samples.get(name) ?? 0) + value);
  }

  const readFirst = (aliases: readonly string[]): number | null => {
    for (const alias of aliases) {
      const value = samples.get(alias);
      if (value !== undefined) return value;
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

function managedDflashBinaryPath(): string {
  return path.join(
    localInferenceRoot(),
    "bin",
    "dflash",
    platformKey(),
    "llama-server",
  );
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

function assertCacheTypeSupportedOnBackend(name: string, value: string): void {
  if (
    isMetalDflashRuntime() &&
    METAL_UNSUPPORTED_CACHE_TYPES.has(value.toLowerCase())
  ) {
    // Wave-3 hardware-verified all 5 Metal kernels 8/8 PASS on Apple M4 Max
    // via the JIT harness, but the patch coverage audit (2026-05-10) found
    // the standalones do NOT actually ship in the v0.4.0-milady binary —
    // build-llama-cpp-dflash.mjs's patchMetal* hooks are decorative-only.
    // Until the shader-shipping work lands AND the shipped binary itself
    // is re-verified, the runtime correctly refuses these cache types on
    // Metal. Once capabilities.kernels.turbo3 etc. flip to true via a real
    // build, gate this on the capability instead of the static set.
    throw new Error(
      `${name}=${value} is not yet shipped in the Metal binary. Wave-3 verified the kernels in a JIT harness but the build pipeline doesn't compile them into the shipped artifact. Use f16 KV on Metal until the kernel-shipping work lands.`,
    );
  }
}

export function dflashEnabled(): boolean {
  if (readBool("ELIZA_DFLASH_DISABLED")) return false;
  if (readBool("ELIZA_DFLASH_ENABLED")) return true;
  if (!fs.existsSync(managedDflashBinaryPath())) return false;
  if (isMetalDflashRuntime()) return dflashMetalAutoEnabled();
  return true;
}

export function dflashRequired(): boolean {
  return readBool("ELIZA_DFLASH_REQUIRED");
}

function candidateBinaryPaths(): string[] {
  const explicit = process.env.ELIZA_DFLASH_LLAMA_SERVER?.trim();
  const out = explicit ? [explicit] : [];
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
    const reason =
      managedBinaryExists && isMetalDflashRuntime()
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
  if (readBool("ELIZA_DFLASH_REPAIR_DISABLED")) return drafterModelPath;
  if (!fs.existsSync(targetModelPath) || !fs.existsSync(drafterModelPath)) {
    return drafterModelPath;
  }

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
): Promise<unknown> {
  const controller = new AbortController();
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
  }
}

/**
 * Default `--parallel` when caching is enabled. Higher values give more
 * distinct cache slots so concurrent prefixes don't evict each other,
 * at the cost of KV memory. 4 is a balance that works for a single-user
 * desktop while still saturating a single GPU under load.
 */
const DEFAULT_CACHE_PARALLEL = 4;

/**
 * Resolve `--parallel`. Order: ELIZA_LOCAL_PARALLEL (generalised) →
 * ELIZA_DFLASH_PARALLEL (legacy) → catalog `optimizations.parallel` →
 * DEFAULT_CACHE_PARALLEL. The generalised env wins because it's the
 * operator's explicit override; the legacy DFlash-specific env stays
 * for back-compat.
 */
function resolveParallel(catalogParallel?: number): number {
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

export class DflashLlamaServer implements LocalInferenceBackend {
  readonly id = "llama-server" as const;

  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private stderrTail: string[] = [];
  private loadedPlan: DflashServerPlan | null = null;
  /**
   * Cache state captured at `start()`. The model hash + parallel count
   * stay constant for the lifetime of the spawned process so we record
   * them once and reuse them on every `generate()` call.
   */
  private cacheModelHash: string | null = null;
  private cacheParallel: number = DEFAULT_CACHE_PARALLEL;
  private cacheSlotDir: string | null = null;
  private evictionTimer: NodeJS.Timeout | null = null;
  /**
   * Per-conversation slot files persisted on shutdown for cross-restart
   * KV reuse. Distinct from the per-slot save dir: this directory keys
   * by conversation id, so a conversation that comes back with a different
   * slot id (e.g. after a --parallel resize) can still find its KV.
   */
  private conversationKvDir: string | null = null;
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
    const gpuLayers =
      typeof overrides?.gpuLayers === "number"
        ? overrides.gpuLayers
        : dflash.gpuLayers;

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
        disableThinking: dflash.disableThinking,
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
      this.loadedPlan.drafterModelPath === plan.drafterModelPath
    ) {
      return;
    }
    await this.stop();

    const status = getDflashRuntimeStatus();
    if (!status.enabled || !status.binaryPath) {
      throw new Error(`[dflash] ${status.reason}`);
    }

    const drafterModelPath = maybeRepairDflashDrafter(
      status.binaryPath,
      plan.targetModelPath,
      plan.drafterModelPath,
    );
    const port = await resolvePort();
    const host = process.env.ELIZA_DFLASH_HOST?.trim() || DEFAULT_HOST;
    const cacheTypeK = process.env.ELIZA_DFLASH_CACHE_TYPE_K?.trim();
    const cacheTypeV = process.env.ELIZA_DFLASH_CACHE_TYPE_V?.trim();
    const parallel = resolveParallel(optimizations?.parallel);
    const modelHash = buildModelHash({
      targetModelPath: plan.targetModelPath,
      drafterModelPath,
      cacheTypeK: cacheTypeK ?? null,
      cacheTypeV: cacheTypeV ?? null,
      extra: `ctx=${plan.contextSize};parallel=${parallel}`,
    });
    const slotDir = slotSavePath(modelHash);
    const conversationKvDir = path.join(slotDir, "conversations");
    fs.mkdirSync(slotDir, { recursive: true });
    fs.mkdirSync(conversationKvDir, { recursive: true });
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
      "-md",
      drafterModelPath,
      "--spec-type",
      "dflash",
      "--host",
      host,
      "--port",
      String(port),
      "--n-gpu-layers",
      normalizeGpuLayers(plan.gpuLayers),
      "--n-gpu-layers-draft",
      normalizeGpuLayers(plan.draftGpuLayers),
      "--ctx-size",
      String(plan.contextSize),
      "--ctx-size-draft",
      String(plan.draftContextSize),
      "--draft-min",
      String(plan.draftMin),
      "--draft-max",
      String(plan.draftMax),
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

    appendOptimizationFlags(args, optimizations ?? null);

    const extra = process.env.ELIZA_DFLASH_LLAMA_ARGS?.trim();
    if (extra && isMetalDflashRuntime()) {
      for (const cacheType of METAL_UNSUPPORTED_CACHE_TYPES) {
        if (extra.toLowerCase().split(/\s+/).includes(cacheType)) {
          throw new Error(
            `ELIZA_DFLASH_LLAMA_ARGS includes ${cacheType}, but that KV cache type is not production-safe on Metal in the DFlash fork. Use f16 KV on Metal or run this variant on CUDA/ROCm.`,
          );
        }
      }
    }
    if (extra) args.push(...extra.split(/\s+/).filter(Boolean));

    fs.mkdirSync(path.join(localInferenceRoot(), "logs"), { recursive: true });
    this.stderrTail = [];
    const child = spawn(status.binaryPath, args, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.baseUrl = `http://${host}:${port}`;
    this.loadedPlan = plan;

    child.stdout?.on("data", (chunk) => this.captureLog(chunk));
    child.stderr?.on("data", (chunk) => this.captureLog(chunk));
    child.on("exit", (code, signal) => {
      if (this.child && (code !== null || signal !== null)) {
        this.child = null;
        this.baseUrl = null;
        this.loadedPlan = null;
      }
    });

    await this.waitUntilReady(DEFAULT_START_TIMEOUT_MS);

    // Periodic eviction sweep — short TTL or shorter, capped to one
    // sweep per minute. Without this, stale slot files accumulate to
    // gigabytes over a long-running session because eviction was only
    // ever fired at startup.
    this.startEvictionTimer();
  }

  /**
   * Set up the periodic eviction sweep that keeps stale slot files from
   * accumulating. Runs `evictExpired` against both the per-slot save
   * directory (used by llama-server's own KV save) and the per-conversation
   * directory (used by our `persistConversationKv` saves) so neither can
   * grow without bound.
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
    }, intervalMs);
    timer.unref();
    this.evictionTimer = timer;
  }

  async stop(): Promise<void> {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    const child = this.child;
    const baseUrl = this.baseUrl;
    const conversationDir = this.conversationKvDir;
    this.child = null;
    this.baseUrl = null;
    this.loadedPlan = null;
    this.cacheModelHash = null;
    this.cacheSlotDir = null;
    this.conversationKvDir = null;
    this.cacheParallel = DEFAULT_CACHE_PARALLEL;
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
        `${handle.conversationId}.bin`,
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
    const targetPath = path.join(conversationDir, `${conversationId}.bin`);
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
    const sourcePath = path.join(conversationDir, `${conversationId}.bin`);
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
    const payload: Record<string, unknown> = {
      model: "local-dflash",
      messages: [{ role: "user", content: args.prompt }],
      max_tokens: args.maxTokens ?? 2048,
      temperature: args.temperature ?? 0.7,
      top_p: args.topP ?? 0.9,
      stop: args.stopSequences,
      stream: false,
      // `cache_prompt: true` is always safe — the worst case is the
      // server matches no prefix tokens and the request behaves like a
      // cold call. Pinning by `slot_id` only happens when the runtime
      // gave us a stable cache key.
      cache_prompt: true,
      slot_id: slotId,
    };
    const before = await fetchMetricsSnapshot(baseUrl);
    const json = (await fetchJson(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })) as Record<string, unknown>;
    const after = await fetchMetricsSnapshot(baseUrl);
    const text = extractCompletionText(json);
    const responseUsage = extractResponseUsage(json);
    const usage = diffSnapshots(before, after, responseUsage);
    return { text, usage, slotId };
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
