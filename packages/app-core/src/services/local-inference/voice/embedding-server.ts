/**
 * Lazy embedding `llama-server` sidecar for Eliza-1 bundles.
 *
 * Per `packages/inference/AGENTS.md` §1, the embedding model is either the
 * text backbone with `--pooling last` (`0_8b`) or a dedicated
 * `embedding/eliza-1-embedding.gguf` (Qwen3-Embedding-0.6B) on the larger
 * tiers. This sidecar runs a *separate* `llama-server` against whichever
 * GGUF the route resolved:
 *   - `0_8b` pooled-text → the text backbone GGUF, with `--embeddings
 *     --pooling last` (the model is 0.8B; the OS shares the mmap pages
 *     with the chat server's already-mapped copy of the same file — no
 *     duplicate *bundle* weights, AGENTS.md §1).
 *   - `2b`/`9b`/`27b`/`27b-256k`/`27b-1m` → the dedicated
 *     `embedding/eliza-1-embedding.gguf` (Qwen3-Embedding-0.6B).
 * In both cases the process is started **lazily, on the first `embed()`
 * call**, so a voice-off / RAG-off agent never pages the embedding
 * weights. This is what gives the AGENTS.md §1 embedding region a real
 * caller (Commandment 10 — it was previously a descriptor with no
 * consumer). The chat `llama-server` is left untouched (completions-only).
 *
 * The sidecar reuses the bundle's one `llama-server` binary (the same
 * fused build that satisfies the kernel contract) — one llama.cpp build,
 * one GGML pin (AGENTS.md §4). It is intentionally small: spawn, wait for
 * `/health`, POST to `/v1/embeddings`, truncate to the requested
 * Matryoshka width.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { logger } from "@elizaos/core";
import { resolveDflashBinary } from "../dflash-server";
import {
  EMBEDDING_FULL_DIM,
  isValidEmbeddingDim,
  type LocalEmbeddingRoute,
  truncateMatryoshka,
} from "./embedding";
import { VoiceStartupError } from "./errors";

const HOST = "127.0.0.1";
const READY_TIMEOUT_MS = 60_000;
const EMBED_TIMEOUT_MS = 60_000;

/**
 * Logical / physical batch size for the embedding server. Embedding
 * throughput wants a *single* forward pass to cover as many short texts as
 * possible — so the physical micro-batch (`-ub`) is bumped to the logical
 * batch (`-b`) so a `/v1/embeddings` call with many inputs is one ubatch
 * rather than chunked. The Qwen3-Embedding-0.6B model is tiny (~600 MB
 * Q8_0), so a 4096-token batch is comfortable. (`llama-server` defaults
 * are 2048 / 512 — and 512 silently caps batching at ~512 tokens.)
 */
const EMBED_BATCH_SIZE = 4096;
const EMBED_UBATCH_SIZE = 4096;

/**
 * Parallel slots for the embedding server. With `--pooling last`,
 * llama-server processes each input on its own sequence; `--parallel N`
 * lets up to N of them ride the same forward pass instead of being
 * serialized one-by-one. 16 covers a typical RAG batch; each slot's KV is
 * tiny at 0.8B / 8k ctx.
 */
const EMBED_PARALLEL = 16;

/** Context window for the embedding server. Qwen3-Embedding-0.6B is 32k-ctx; cap modestly for RAM. */
const EMBED_CTX_SIZE = 8192;

interface EmbeddingServerConfig {
  /** GGUF the sidecar mmaps. For the dedicated-region mode this is the `embedding/` file. */
  modelPath: string;
  /** Extra `llama-server` flags — the route's `embeddingServerFlags` (`--embeddings --pooling last`). */
  serverFlags: ReadonlyArray<string>;
  /** GPU offload: `"auto"` (= all layers) for CPU/Vulkan/CUDA hosts, `0` to force CPU. */
  gpuLayers?: number | "auto";
  /** Thread count for the embedding forward pass. Defaults to the host's logical core count. */
  threads?: number;
}

async function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("could not allocate a loopback port"));
      });
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function extractEmbeddingVectors(json: unknown): number[][] {
  if (!json || typeof json !== "object") {
    throw new Error("[embedding-server] /v1/embeddings: non-object response");
  }
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error(
      "[embedding-server] /v1/embeddings: response.data is not an array",
    );
  }
  const out: number[][] = [];
  for (const row of data) {
    const vec = (row as { embedding?: unknown }).embedding;
    if (!Array.isArray(vec) || vec.some((x) => typeof x !== "number")) {
      throw new Error(
        "[embedding-server] /v1/embeddings: a row has no numeric embedding",
      );
    }
    out.push(vec as number[]);
  }
  return out;
}

/**
 * One lazily-started `llama-server` dedicated to embeddings. Created per
 * activated bundle from `embeddingServerForRoute()`. `embed()` starts the
 * process on first call and reuses it after.
 */
export class EmbeddingServer {
  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly config: EmbeddingServerConfig) {
    if (!existsSync(config.modelPath)) {
      throw new VoiceStartupError(
        "missing-bundle-root",
        `[embedding-server] embedding GGUF not found at ${config.modelPath}`,
      );
    }
  }

  isRunning(): boolean {
    return this.child !== null && this.baseUrl !== null;
  }

  /**
   * Embed one or more texts and return Matryoshka-truncated, L2-normalized
   * vectors. `dim` defaults to 1024 (the full width); pass 64/128/256/512/
   * 768 for storage savings (quality degrades gracefully — see the report).
   * Throws on an invalid `dim` or a server error — no zero-vector fallback
   * (Commandment 8).
   */
  async embed(
    texts: string[],
    dim: number = EMBEDDING_FULL_DIM,
  ): Promise<number[][]> {
    if (!isValidEmbeddingDim(dim)) {
      throw new Error(
        `[embedding-server] dim ${dim} is not a valid Matryoshka width`,
      );
    }
    if (texts.length === 0) return [];
    await this.ensureStarted();
    const baseUrl = this.baseUrl;
    if (!baseUrl) {
      throw new Error("[embedding-server] server is not running after start()");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: texts }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `[embedding-server] /v1/embeddings HTTP ${res.status}${body ? `: ${body}` : ""}`,
        );
      }
      const vectors = extractEmbeddingVectors(await res.json());
      if (vectors.length !== texts.length) {
        throw new Error(
          `[embedding-server] /v1/embeddings returned ${vectors.length} vectors for ${texts.length} inputs`,
        );
      }
      return vectors.map((v) => truncateMatryoshka(v, dim));
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.isRunning()) return;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async start(): Promise<void> {
    const binary = resolveDflashBinary();
    if (!binary) {
      throw new VoiceStartupError(
        "not-started",
        "[embedding-server] no llama-server binary available (run packages/app-core/scripts/build-llama-cpp-dflash.mjs)",
      );
    }
    const port = await pickPort();
    const threads = this.config.threads ?? Math.max(1, os.cpus().length);
    const gpuLayers = this.config.gpuLayers ?? "auto";
    const args = [
      "-m",
      this.config.modelPath,
      "--host",
      HOST,
      "--port",
      String(port),
      "--ctx-size",
      String(EMBED_CTX_SIZE),
      "--batch-size",
      String(EMBED_BATCH_SIZE),
      "--ubatch-size",
      String(EMBED_UBATCH_SIZE),
      "--threads",
      String(threads),
      "--n-gpu-layers",
      gpuLayers === "auto" ? "99" : String(gpuLayers),
      // Embedding-only server: N parallel slots so a batch of inputs rides
      // one forward pass; no jinja chat template needed.
      "--parallel",
      String(EMBED_PARALLEL),
      ...this.config.serverFlags,
    ];
    logger.info(
      `[embedding-server] starting ${binary} on ${HOST}:${port} (model=${this.config.modelPath})`,
    );
    const child = spawn(binary, args, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.baseUrl = `http://${HOST}:${port}`;
    child.stderr?.on("data", () => {});
    child.stdout?.on("data", () => {});
    child.on("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.baseUrl = null;
      }
    });
    await this.waitUntilReady(port);
  }

  private async waitUntilReady(port: number): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const healthUrl = `http://${HOST}:${port}/health`;
    while (Date.now() < deadline) {
      if (!this.child) {
        throw new VoiceStartupError(
          "not-started",
          "[embedding-server] llama-server exited before becoming ready",
        );
      }
      try {
        const res = await fetch(healthUrl);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await sleep(200);
    }
    await this.stop();
    throw new VoiceStartupError(
      "not-started",
      `[embedding-server] llama-server did not become healthy within ${READY_TIMEOUT_MS}ms`,
    );
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.baseUrl = null;
    if (!child) return;
    child.kill("SIGTERM");
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    await Promise.race([exited, sleep(2000)]);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}

/**
 * Build a lazy `EmbeddingServer` for a route's source. For `pooled-text`
 * (`0_8b`) the GGUF is the text backbone; for `dedicated-region` it is the
 * `embedding/` GGUF. Either way the sidecar gets `--embeddings --pooling
 * last` (the route's `embeddingServerFlags`).
 */
export function embeddingServerForRoute(
  route: LocalEmbeddingRoute,
  opts: { gpuLayers?: number | "auto"; threads?: number } = {},
): EmbeddingServer {
  const modelPath =
    route.source.kind === "pooled-text"
      ? route.source.textModelPath
      : route.source.embeddingModelPath;
  return new EmbeddingServer({
    modelPath,
    serverFlags: route.serverFlags,
    gpuLayers: opts.gpuLayers,
    threads: opts.threads,
  });
}
