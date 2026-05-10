/**
 * Out-of-process llama-server backend for DFlash speculative decoding.
 *
 * DFlash needs llama-server flags (`-md`, `--spec-type dflash`) that the
 * in-process node-llama-cpp API does not expose. This backend is deliberately
 * small: spawn a compatible llama-server, wait for health, and use the
 * OpenAI-compatible chat endpoint so llama-server applies the model chat
 * template and reasoning controls consistently with LlamaChatSession.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { localInferenceRoot } from "./paths";

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
}

export interface DflashRuntimeStatus {
  enabled: boolean;
  required: boolean;
  binaryPath: string | null;
  reason: string;
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
    throw new Error(
      `${name}=${value} is not production-safe on Metal in the DFlash fork. Turbo4 currently crashes during slot initialization, and TCQ/QJL kernels are only implemented for CUDA/ROCm. Use f16 KV on Metal or run this variant on CUDA/ROCm.`,
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
  if (!dflashEnabled()) {
    const managedBinaryExists = fs.existsSync(managedDflashBinaryPath());
    const reason =
      managedBinaryExists && isMetalDflashRuntime()
        ? "DFlash Metal binary found but auto-disabled because the local Qwen 3.5 4B ablation is slower than target-only Metal decode; set ELIZA_DFLASH_ENABLED=1 or ELIZA_DFLASH_METAL_AUTO=1 to force it."
        : "DFlash auto-enables when the managed llama-server binary is installed; set ELIZA_DFLASH_ENABLED=1 to force a PATH/explicit binary, or run packages/app-core/scripts/build-llama-cpp-dflash.mjs.";
    return {
      enabled: false,
      required: dflashRequired(),
      binaryPath: binary,
      reason,
    };
  }
  if (!binary) {
    return {
      enabled: false,
      required: dflashRequired(),
      binaryPath: null,
      reason:
        "No compatible llama-server found. Set ELIZA_DFLASH_LLAMA_SERVER or run packages/app-core/scripts/build-llama-cpp-dflash.mjs.",
    };
  }
  return {
    enabled: true,
    required: dflashRequired(),
    binaryPath: binary,
    reason: "DFlash llama-server binary found.",
  };
}

function normalizeGpuLayers(value: number | "auto"): string {
  return value === "auto" ? "99" : String(value);
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

async function fetchText(
  url: string,
  timeoutMs = 5_000,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Cumulative speculative-decoding counters scraped from llama-server `/metrics`. */
export interface DflashMetricsSnapshot {
  drafted: number;
  accepted: number;
  decoded: number;
  acceptanceRate: number;
}

/**
 * Parse the cumulative speculative-decoding counters from llama-server's
 * Prometheus-format `/metrics` endpoint. Returns null when none of the
 * expected counters are present (older builds, server started without
 * `--metrics`, drafter not yet engaged).
 */
export function parseDflashMetrics(
  text: string,
): DflashMetricsSnapshot | null {
  const counters: Record<string, number> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.replace(/\{[^}]*\}/, "");
    const space = stripped.indexOf(" ");
    if (space <= 0) continue;
    const name = stripped.slice(0, space);
    const valueStr = stripped.slice(space + 1).trim();
    const value = Number.parseFloat(valueStr);
    if (!Number.isFinite(value)) continue;
    counters[name] = value;
  }
  const decoded =
    counters["llamacpp:n_decode_total"] ?? counters["llamacpp:n_decode"];
  const drafted =
    counters["llamacpp:n_drafted_total"] ?? counters["llamacpp:n_drafted"];
  const accepted =
    counters["llamacpp:n_drafted_accepted_total"] ??
    counters["llamacpp:n_drafted_accepted"];
  if (
    decoded === undefined &&
    drafted === undefined &&
    accepted === undefined
  ) {
    return null;
  }
  const safeDrafted = drafted ?? 0;
  const safeAccepted = accepted ?? 0;
  const acceptanceRate =
    safeDrafted > 0 ? safeAccepted / safeDrafted : Number.NaN;
  return {
    drafted: safeDrafted,
    accepted: safeAccepted,
    decoded: decoded ?? 0,
    acceptanceRate,
  };
}

export class DflashLlamaServer {
  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private stderrTail: string[] = [];
  private loadedPlan: DflashServerPlan | null = null;
  /** Last cumulative metrics scraped from `/metrics` for delta-rate logging. */
  private lastMetrics: DflashMetricsSnapshot | null = null;

  hasLoadedModel(): boolean {
    return this.child !== null && this.loadedPlan !== null;
  }

  currentModelPath(): string | null {
    return this.loadedPlan?.targetModelPath ?? null;
  }

  async start(plan: DflashServerPlan): Promise<void> {
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

    // Catalog enforces drafter-target tokenizer parity (see catalog.test.ts
    // "DFlash pairs share a tokenizer family"), so the drafter GGUF can be
    // handed directly to llama-server with no metadata repair. The previous
    // `maybeRepairDflashDrafter` Python shim only paved over a single-pair
    // SmolLM2/Bonsai vocab-mismatch bug; that pair was deleted from the
    // catalog and the repair path is now dead. See
    // docs/porting/dflash-drafter-strategy.md for the replacement (Qwen3-0.6B
    // drafter for the Qwen3-vocab Bonsai target).
    const drafterModelPath = plan.drafterModelPath;
    const port = await resolvePort();
    const host = process.env.ELIZA_DFLASH_HOST?.trim() || DEFAULT_HOST;
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
      process.env.ELIZA_DFLASH_PARALLEL?.trim() || "1",
      "--metrics",
      "--jinja",
    ];
    if (plan.disableThinking) {
      args.push("--reasoning", "off");
      args.push("--chat-template-kwargs", '{"enable_thinking":false}');
    }
    const cacheTypeK = process.env.ELIZA_DFLASH_CACHE_TYPE_K?.trim();
    const cacheTypeV = process.env.ELIZA_DFLASH_CACHE_TYPE_V?.trim();
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
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.baseUrl = null;
    this.loadedPlan = null;
    this.lastMetrics = null;
    if (!child) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      sleep(5_000).then(() => {
        if (!child.killed) child.kill("SIGKILL");
      }),
    ]);
  }

  async generate(args: DflashGenerateArgs): Promise<string> {
    if (!this.baseUrl) {
      throw new Error("[dflash] llama-server is not running");
    }
    const payload = {
      model: "local-dflash",
      messages: [{ role: "user", content: args.prompt }],
      max_tokens: args.maxTokens ?? 2048,
      temperature: args.temperature ?? 0.7,
      top_p: args.topP ?? 0.9,
      stop: args.stopSequences,
      stream: false,
    };
    const json = (await fetchJson(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })) as Record<string, unknown>;
    void this.scrapeAndLogAcceptance();
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
   * Scrape llama-server's `/metrics` endpoint and return the current
   * cumulative speculative-decoding counters. Returns null when the
   * server isn't running, the endpoint isn't reachable, or the response
   * doesn't contain the expected counters.
   */
  async getMetrics(): Promise<DflashMetricsSnapshot | null> {
    if (!this.baseUrl) return null;
    const text = await fetchText(`${this.baseUrl}/metrics`);
    if (text === null) return null;
    return parseDflashMetrics(text);
  }

  private async scrapeAndLogAcceptance(): Promise<void> {
    const snapshot = await this.getMetrics().catch(() => null);
    if (!snapshot) return;
    const prev = this.lastMetrics;
    this.lastMetrics = snapshot;
    if (!prev) return;
    const draftedDelta = snapshot.drafted - prev.drafted;
    const acceptedDelta = snapshot.accepted - prev.accepted;
    const decodedDelta = snapshot.decoded - prev.decoded;
    if (draftedDelta <= 0) return;
    const turnRate = acceptedDelta / draftedDelta;
    console.info(
      `[DFlash] acceptance_rate=${turnRate.toFixed(2)} (drafted=${draftedDelta}, accepted=${acceptedDelta}, decoded=${decodedDelta})`,
    );
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
