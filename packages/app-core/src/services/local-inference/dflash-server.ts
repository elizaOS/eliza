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
const METAL_UNSUPPORTED_CACHE_TYPES = new Set(["turbo2_tcq", "turbo3_tcq"]);

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
      `${name}=${value} requires TCQ/QJL kernels that are implemented for CUDA/ROCm in the DFlash fork, but not Metal. Use turbo4 on Metal or run this variant on CUDA/ROCm.`,
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
  const backend =
    process.platform === "darwin"
      ? "metal"
      : process.env.HIP_VISIBLE_DEVICES || process.env.ROCR_VISIBLE_DEVICES
        ? "rocm"
        : process.env.CUDA_VISIBLE_DEVICES !== "-1"
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

export class DflashLlamaServer {
  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private stderrTail: string[] = [];
  private loadedPlan: DflashServerPlan | null = null;

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

    const drafterModelPath = maybeRepairDflashDrafter(
      status.binaryPath,
      plan.targetModelPath,
      plan.drafterModelPath,
    );
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
      assertCacheTypeSupportedOnBackend("ELIZA_DFLASH_CACHE_TYPE_K", cacheTypeK);
      args.push("--cache-type-k", cacheTypeK);
    }
    if (cacheTypeV) {
      assertCacheTypeSupportedOnBackend("ELIZA_DFLASH_CACHE_TYPE_V", cacheTypeV);
      args.push("--cache-type-v", cacheTypeV);
    }

    const extra = process.env.ELIZA_DFLASH_LLAMA_ARGS?.trim();
    if (extra && isMetalDflashRuntime()) {
      for (const cacheType of METAL_UNSUPPORTED_CACHE_TYPES) {
        if (extra.toLowerCase().split(/\s+/).includes(cacheType)) {
          throw new Error(
            `ELIZA_DFLASH_LLAMA_ARGS includes ${cacheType}, but Metal TCQ/QJL kernels are not implemented in the DFlash fork. Use turbo4 on Metal or run this variant on CUDA/ROCm.`,
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
