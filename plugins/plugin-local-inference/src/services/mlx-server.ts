// mlx-server.ts — Apple-Silicon MLX runtime adapter (convenience path).
//
// Mirrors the spawn-and-route shape of `dflash-server.ts` (DflashLlamaServer)
// but fronts `mlx_lm.server` (the OpenAI-compatible HTTP server shipped with
// the `mlx-lm` Python package) instead of the fork's `llama-server`. The
// engine picks this on Apple Silicon when (a) `mlx-lm` is importable and
// (b) an MLX-format eliza-1 text model directory is present (a Hugging-Face
// snapshot dir with `config.json` + `model.safetensors` / sharded weights and
// the MLX 4-bit/8-bit affine quant metadata).
//
// HONESTY CONTRACT — this is NOT a kernel-aware path:
//   * MLX has its own quantization (4-bit / 8-bit affine, GPTQ-ish). It does
//     NOT implement the §3 mandatory kernels — no TurboQuant K/V cache, no
//     QJL, no PolarQuant. So an MLX backend can NEVER satisfy the build/runtime
//     required-kernel contract; it is the same class as the reduced-optimization
//     local mode (`ELIZA_LOCAL_ALLOW_STOCK_KV=1`). `defaultEligible` bundles
//     keep requiring the verified fork kernels — MLX never flips
//     `verifiedBackends.mlx`.
//   * MLX does NOT carry OmniVoice TTS / Qwen3-ASR. The voice pipeline is NOT
//     routed through MLX — the fused `llama-server` (Metal) / in-process FFI is
//     the voice path on Apple. This module is text-completion only.
//   * It is a "works-on-Apple-Silicon-without-the-fork-build" convenience path,
//     not a publish path. Bundled `mlx` quants ship (if at all) as an *optional*
//     macOS-bundle artifact; absent that, MLX runs against user-supplied models.
//
// Opt-in: `ELIZA_LOCAL_MLX=1` (or `ELIZA_LOCAL_BACKEND=mlx-server`). When the
// flag is unset the engine never auto-selects MLX even on Apple Silicon — the
// fork `llama-server` / `node-llama-cpp` paths are the defaults.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { GenerateArgs } from "./backend";

/** Identifier surfaced in diagnostics / `/api/local-inference/active`. */
export const MLX_BACKEND_ID = "mlx-server" as const;

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * True only on Apple Silicon. MLX is Metal-only; on Intel macs / Linux /
 * Windows the package either isn't installed or falls back to CPU at a speed
 * that defeats the purpose. `process.arch === "arm64" && platform === "darwin"`.
 */
export function isAppleSilicon(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

/** `ELIZA_LOCAL_MLX=1` (the explicit opt-in for the convenience path). */
export function mlxOptIn(): boolean {
  return (
    envFlag("ELIZA_LOCAL_MLX") ||
    process.env.ELIZA_LOCAL_BACKEND?.trim().toLowerCase() === MLX_BACKEND_ID
  );
}

/**
 * Resolve the Python interpreter that has `mlx-lm` available. Order:
 *   1. `$ELIZA_MLX_PYTHON` (explicit)
 *   2. `$ELIZA_PYTHON` / `python3` on PATH
 * Returns null when no interpreter can `import mlx_lm`.
 */
export function resolveMlxPython(): string | null {
  const candidates = [
    process.env.ELIZA_MLX_PYTHON,
    process.env.ELIZA_PYTHON,
    "python3",
    "python",
  ].filter((c): c is string => !!c && c.trim().length > 0);
  for (const py of candidates) {
    try {
      const probe = spawnSync(
        py,
        ["-c", "import mlx_lm, mlx.core; print(mlx_lm.__version__)"],
        { encoding: "utf8", timeout: 8000 },
      );
      if (probe.status === 0 && /\d/.test(probe.stdout)) {
        return py;
      }
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Heuristic: is `dir` an MLX-format model snapshot? An MLX model is an HF
 * directory layout — `config.json` plus weights (`*.safetensors`) — that was
 * converted by `mlx_lm.convert` (which writes a `quantization` block in
 * `config.json` for quantized models, or leaves it for fp16). We accept a dir
 * with `config.json` + at least one `.safetensors` file. (We deliberately do
 * NOT accept a `.gguf` — that's the llama.cpp path.)
 */
export function looksLikeMlxModelDir(dir: string): boolean {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    if (!fs.existsSync(path.join(dir, "config.json"))) return false;
    const entries = fs.readdirSync(dir);
    return entries.some((e) => e.endsWith(".safetensors"));
  } catch {
    return false;
  }
}

/**
 * Locate a bundled / user-configured MLX eliza-1 text model.
 * Order:
 *   1. `$ELIZA_MLX_MODEL_DIR` (explicit)
 *   2. `<stateDir>/local-inference/mlx/eliza-1-*` (bundled, if Cluster 3 ever
 *      produces one — currently it does not, so this is forward-looking)
 *   3. `null` — caller must supply `--mlx-model` / set the env var.
 */
export function resolveMlxModelDir(): string | null {
  const explicit = process.env.ELIZA_MLX_MODEL_DIR?.trim();
  if (explicit && looksLikeMlxModelDir(explicit)) return explicit;
  const stateDir =
    process.env.ELIZA_STATE_DIR ||
    process.env.MILADY_STATE_DIR ||
    path.join(os.homedir(), ".milady");
  const mlxRoot = path.join(stateDir, "local-inference", "mlx");
  try {
    if (fs.existsSync(mlxRoot)) {
      for (const name of fs.readdirSync(mlxRoot)) {
        if (!name.startsWith("eliza-1")) continue;
        const cand = path.join(mlxRoot, name);
        if (looksLikeMlxModelDir(cand)) return cand;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Engine-routing eligibility: MLX can serve the text model iff it's opted in,
 * we're on Apple Silicon, a Python with `mlx-lm` exists, and an MLX model dir
 * is available. Never `true` without the explicit opt-in.
 */
export function mlxBackendEligible(): {
  eligible: boolean;
  reason: string;
  python: string | null;
  modelDir: string | null;
} {
  if (!mlxOptIn()) {
    return {
      eligible: false,
      reason: "ELIZA_LOCAL_MLX not set (convenience path is opt-in)",
      python: null,
      modelDir: null,
    };
  }
  if (!isAppleSilicon()) {
    return {
      eligible: false,
      reason: "not Apple Silicon (MLX is Metal-only)",
      python: null,
      modelDir: null,
    };
  }
  const python = resolveMlxPython();
  if (!python) {
    return {
      eligible: false,
      reason:
        "no Python interpreter with `mlx-lm` importable (pip install mlx-lm)",
      python: null,
      modelDir: null,
    };
  }
  const modelDir = resolveMlxModelDir();
  if (!modelDir) {
    return {
      eligible: false,
      reason:
        "no MLX model dir found (set ELIZA_MLX_MODEL_DIR or place one under <stateDir>/local-inference/mlx/eliza-1-*)",
      python,
      modelDir: null,
    };
  }
  return {
    eligible: true,
    reason: "mlx-lm + MLX model present",
    python,
    modelDir,
  };
}

interface MlxServerStatus {
  running: boolean;
  baseUrl: string | null;
  modelDir: string | null;
  pid: number | null;
}

/**
 * Spawn-and-route adapter for `mlx_lm.server`. Single-model, single-process.
 * Health-checks `GET /v1/models`; completions go through
 * `POST /v1/chat/completions` (OpenAI-compatible). Streaming deltas are passed
 * through `args.onTextChunk` like the llama-server path.
 */
export class MlxLocalServer {
  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private modelDir: string | null = null;
  private servedModelName: string | null = null;

  status(): MlxServerStatus {
    return {
      running: !!this.child && !this.child.killed,
      baseUrl: this.baseUrl,
      modelDir: this.modelDir,
      pid: this.child?.pid ?? null,
    };
  }

  hasLoadedModel(): boolean {
    return !!this.child && !this.child.killed && !!this.baseUrl;
  }

  currentModelPath(): string | null {
    return this.modelDir;
  }

  /**
   * Start `mlx_lm.server --model <dir> --host 127.0.0.1 --port <port>` and
   * wait until `GET /v1/models` answers. Idempotent for the same model dir.
   */
  async load(opts: {
    python?: string;
    modelDir: string;
    host?: string;
    port?: number;
    extraArgs?: string[];
    healthTimeoutMs?: number;
  }): Promise<void> {
    const python = opts.python ?? resolveMlxPython();
    if (!python) {
      throw new Error(
        "[mlx] no Python with `mlx-lm` importable — `pip install mlx-lm` on an Apple-Silicon mac",
      );
    }
    if (!looksLikeMlxModelDir(opts.modelDir)) {
      throw new Error(
        `[mlx] ${opts.modelDir} does not look like an MLX model dir (need config.json + *.safetensors)`,
      );
    }
    if (this.hasLoadedModel() && this.modelDir === opts.modelDir) return;
    if (this.child) await this.unload();

    const host = opts.host ?? "127.0.0.1";
    const port = opts.port ?? 8765;
    const args = [
      "-m",
      "mlx_lm.server",
      "--model",
      opts.modelDir,
      "--host",
      host,
      "--port",
      String(port),
      ...(opts.extraArgs ?? []),
    ];
    const child = spawn(python, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child = child;
    this.modelDir = opts.modelDir;
    this.baseUrl = `http://${host}:${port}`;

    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.baseUrl = null;
        if (code !== 0 && signal !== "SIGTERM") {
          console.warn(
            `[mlx] mlx_lm.server exited code=${code} signal=${signal}`,
          );
        }
      }
    });

    // Health-check.
    const deadline = Date.now() + (opts.healthTimeoutMs ?? 60_000);
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        const res = await this.fetchWithTimeout(
          `${this.baseUrl}/v1/models`,
          {},
          4000,
        );
        if (res.ok) {
          const json = (await res.json()) as { data?: Array<{ id?: string }> };
          this.servedModelName = json?.data?.[0]?.id ?? null;
          return;
        }
        lastErr = new Error(`/v1/models -> HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.unload();
    throw new Error(
      `[mlx] mlx_lm.server did not become healthy within ${opts.healthTimeoutMs ?? 60_000}ms: ${String(lastErr)}`,
    );
  }

  async unload(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.baseUrl = null;
    try {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    } catch {
      // best-effort teardown
    }
  }

  /**
   * Text completion via `/v1/chat/completions` (single user turn — the engine
   * has already rendered the prompt). Honours `maxTokens` / `temperature` /
   * `topP` / `stopSequences` and the abort signal; streams deltas to
   * `onTextChunk` when present.
   */
  async generate(args: GenerateArgs): Promise<string> {
    if (!this.hasLoadedModel() || !this.baseUrl) {
      throw new Error("[mlx] generate() called with no loaded model");
    }
    const wantStream = typeof args.onTextChunk === "function";
    const body = {
      model: this.servedModelName ?? "default",
      messages: [{ role: "user", content: args.prompt }],
      max_tokens: args.maxTokens ?? 2048,
      temperature: args.temperature ?? 0.7,
      top_p: args.topP ?? 0.9,
      ...(args.stopSequences && args.stopSequences.length > 0
        ? { stop: args.stopSequences }
        : {}),
      ...(wantStream ? { stream: true } : {}),
    };
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: args.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `[mlx] /v1/chat/completions HTTP ${res.status}: ${text.slice(0, 400)}`,
      );
    }
    if (!wantStream) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return json?.choices?.[0]?.message?.content ?? "";
    }
    // Stream SSE: lines `data: {...}`, terminated by `data: [DONE]`.
    let full = "";
    const reader = res.body?.getReader();
    if (!reader) {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return json?.choices?.[0]?.message?.content ?? "";
    }
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            await args.onTextChunk?.(delta);
          }
        } catch {
          // ignore malformed SSE chunk
        }
      }
    }
    return full;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  }
}

/** Process-wide singleton (mirrors `dflashLlamaServer`). */
export const mlxLocalServer = new MlxLocalServer();
