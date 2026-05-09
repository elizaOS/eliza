/**
 * AOSP DFlash adapter.
 *
 * Spawns the bundled `llama-server` binary (cross-compiled per ABI by
 * `eliza/packages/app-core/scripts/aosp/compile-libllama.mjs` and staged
 * by `stage-android-agent.mjs` into `assets/agent/<abi>/llama-server`) and
 * routes inference over loopback HTTP using the same OpenAI-shaped request
 * shape that the host-side `dflash-server.ts` already speaks.
 *
 * Why a separate file:
 *   The in-process FFI adapter (`AospLlamaAdapter` in `aosp-llama-adapter.ts`)
 *   talks to a single libllama.so context and does not have a draft-model
 *   API surface. DFlash speculative decoding wants `--model <target.gguf>
 *   --model-draft <drafter.gguf>` on the same llama.cpp process, which the
 *   server binary already wires up via the upstream `common_speculative_*`
 *   helpers. Rather than re-bind the speculative C API through the shim
 *   (path b in the porting plan), we cross-compile llama-server itself and
 *   have bun spawn it as a child process (path a — "cheaper to validate;
 *   path b is the production answer"). The tok/s number we capture here
 *   informs whether path b is worth the shim work.
 *
 * Activation:
 *   - `AospLlamaLoadOptions.draftModelPath` is set, OR
 *   - `ELIZA_DFLASH=1` env var is set AND the catalog entry for the
 *     loaded target advertises `runtime.dflash.drafterModelId`.
 *
 * Lifecycle:
 *   - `loadModel({ modelPath, draftModelPath, ... })` allocates a free
 *     loopback port, spawns `<abiAssetDir>/llama-server` with `--model`,
 *     `--model-draft`, `--spec-type dflash`, `--port`, `--host 127.0.0.1`,
 *     and waits for `GET /health` to return 200.
 *   - `generate({ prompt, ... })` POSTs to `/v1/chat/completions` and
 *     returns the assistant content.
 *   - `unloadModel()` SIGTERMs the child, waits up to 5s for graceful exit,
 *     then SIGKILLs.
 *   - `embed()` is NOT supported on this backend — embeddings go through
 *     the in-process FFI adapter or plugin-local-embedding. The dispatcher
 *     in `registerAospLlamaLoader` keeps the FFI adapter active for embed
 *     calls and only routes generate() to DFlash when a drafter is paired.
 *
 * What this is NOT:
 *   This adapter does not duplicate the catalog/cache logic from
 *   `dflash-server.ts`. The host-side service handles desktop/CUDA/Metal
 *   DFlash and pulls catalog entries from registry. On AOSP we have a
 *   single target+drafter pair per chat session, no slot-save-path (the
 *   APK private dir is the only writable disk anyway), and no model-hash
 *   caching across restarts (cold start re-spawns llama-server). Keeping
 *   this file standalone means no transitive imports from app-core into
 *   the agent bundle.
 */

import {
  type ChildProcess,
  spawn as spawnChild,
} from "node:child_process";
import { existsSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { logger } from "@elizaos/core";

const DFLASH_HOST = "127.0.0.1";
const DEFAULT_START_TIMEOUT_MS = 60_000;

export interface DflashLoadOptions {
  modelPath: string;
  draftModelPath: string;
  contextSize?: number;
  draftContextSize?: number;
  draftMin?: number;
  draftMax?: number;
  cacheTypeK?: string;
  cacheTypeV?: string;
  disableThinking?: boolean;
}

export interface DflashGenerateOptions {
  prompt: string;
  stopSequences?: string[];
  maxTokens?: number;
  temperature?: number;
}

export interface DflashAdapter {
  loadModel(args: DflashLoadOptions): Promise<void>;
  unloadModel(): Promise<void>;
  currentModelPath(): string | null;
  generate(args: DflashGenerateOptions): Promise<string>;
}

/**
 * Resolve `<abiAssetDir>/llama-server` for the current ABI. Mirrors
 * `resolveAbiDir` in aosp-llama-adapter.ts but kept local so this file has
 * no cross-module coupling beyond the @elizaos/core logger.
 */
export function resolveLlamaServerPath(
  arch: NodeJS.Architecture = process.arch,
  cwd: string = process.cwd(),
): string {
  const abiDir =
    arch === "arm64" ? "arm64-v8a" : arch === "x64" ? "x86_64" : null;
  if (abiDir === null) {
    throw new Error(
      `[aosp-dflash] Unsupported process.arch for AOSP build: ${arch}`,
    );
  }
  return path.join(cwd, abiDir, "llama-server");
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, DFLASH_HOST, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(
            new Error(
              "[aosp-dflash] Could not allocate a loopback port for llama-server",
            ),
          );
        }
      });
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(
  baseUrl: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, {
        method: "GET",
      });
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(500);
  }
  const detail =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `[aosp-dflash] llama-server did not become healthy within ${timeoutMs}ms (${detail})`,
  );
}

class AospDflashAdapter implements DflashAdapter {
  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private loadedTarget: string | null = null;
  private loadedDrafter: string | null = null;
  private readonly llamaServerPath: string;
  private readonly libDir: string;
  private stderrTail: string[] = [];

  constructor(llamaServerPath: string) {
    this.llamaServerPath = llamaServerPath;
    this.libDir = path.dirname(llamaServerPath);
  }

  currentModelPath(): string | null {
    return this.loadedTarget;
  }

  async loadModel(args: DflashLoadOptions): Promise<void> {
    if (
      this.child &&
      this.loadedTarget === args.modelPath &&
      this.loadedDrafter === args.draftModelPath
    ) {
      return;
    }
    await this.unloadModel();

    if (!existsSync(args.modelPath)) {
      throw new Error(
        `[aosp-dflash] Target model not found: ${args.modelPath}`,
      );
    }
    if (!existsSync(args.draftModelPath)) {
      throw new Error(
        `[aosp-dflash] Drafter model not found: ${args.draftModelPath}`,
      );
    }
    if (!existsSync(this.llamaServerPath)) {
      throw new Error(
        `[aosp-dflash] llama-server binary not found at ${this.llamaServerPath}. ` +
          `Rebuild with \`node packages/app-core/scripts/aosp/compile-libllama.mjs\`.`,
      );
    }

    const port = await findFreePort();
    const baseUrl = `http://${DFLASH_HOST}:${port}`;

    const argv = [
      "--model",
      args.modelPath,
      "--model-draft",
      args.draftModelPath,
      "--spec-type",
      "dflash",
      "--host",
      DFLASH_HOST,
      "--port",
      String(port),
      "--ctx-size",
      String(args.contextSize ?? 4096),
      "--ctx-size-draft",
      String(args.draftContextSize ?? args.contextSize ?? 4096),
      "--draft-min",
      String(args.draftMin ?? 4),
      "--draft-max",
      String(args.draftMax ?? 16),
      "--n-gpu-layers",
      "0",
      "--n-gpu-layers-draft",
      "0",
      "--metrics",
      "--jinja",
    ];
    if (args.disableThinking) {
      argv.push("--reasoning", "off");
    }
    if (args.cacheTypeK) argv.push("--cache-type-k", args.cacheTypeK);
    if (args.cacheTypeV) argv.push("--cache-type-v", args.cacheTypeV);

    logger.info(
      `[aosp-dflash] Spawning llama-server: ${this.llamaServerPath} ${argv.join(" ")}`,
    );

    // LD_LIBRARY_PATH must include the per-ABI asset dir so llama-server
    // resolves its NEEDED libllama.so + libggml*.so siblings the same way
    // the in-process FFI loader does.
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: this.libDir,
    };

    const child = spawnChild(this.llamaServerPath, argv, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    child.stderr?.setEncoding("utf8");
    child.stdout?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const lines = chunk.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 200) this.stderrTail.shift();
        logger.debug(`[aosp-dflash] llama-server stderr: ${line}`);
      }
    });
    child.stdout?.on("data", (chunk: string) => {
      const lines = chunk.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        logger.debug(`[aosp-dflash] llama-server stdout: ${line}`);
      }
    });

    let exitedEarly: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    child.on("exit", (code, signal) => {
      exitedEarly = { code, signal };
      this.child = null;
      this.baseUrl = null;
    });

    try {
      await waitForHealth(baseUrl, DEFAULT_START_TIMEOUT_MS);
    } catch (err) {
      const tail = this.stderrTail.slice(-10).join("\n");
      const exitDetail = exitedEarly
        ? ` (process exited with code=${exitedEarly.code} signal=${exitedEarly.signal})`
        : "";
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}${exitDetail}\n` +
          `--- llama-server stderr tail ---\n${tail}`,
      );
    }

    this.baseUrl = baseUrl;
    this.loadedTarget = args.modelPath;
    this.loadedDrafter = args.draftModelPath;
    logger.info(
      `[aosp-dflash] llama-server ready at ${baseUrl} (target=${path.basename(args.modelPath)}, drafter=${path.basename(args.draftModelPath)})`,
    );
  }

  async unloadModel(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.baseUrl = null;
    this.loadedTarget = null;
    this.loadedDrafter = null;
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        sleep(5000).then(() => false as const),
      ]);
      if (exited === false) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore — process may have just exited
        }
      }
    }
  }

  async generate(args: DflashGenerateOptions): Promise<string> {
    if (!this.child || !this.baseUrl) {
      throw new Error("[aosp-dflash] generate called before loadModel");
    }
    const url = `${this.baseUrl}/v1/chat/completions`;
    const body = {
      messages: [{ role: "user", content: args.prompt }],
      temperature: args.temperature ?? 0.7,
      max_tokens: args.maxTokens ?? 512,
      stop: args.stopSequences ?? [],
      stream: false,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `[aosp-dflash] llama-server returned HTTP ${res.status}: ${errBody}`,
      );
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(
        `[aosp-dflash] llama-server returned no content: ${JSON.stringify(json).slice(0, 300)}`,
      );
    }
    return content;
  }
}

/**
 * Build a DFlash adapter pinned to the per-ABI llama-server binary in the
 * agent's cwd. Returns null when the binary isn't present (graceful
 * degradation — the caller falls back to the FFI single-model path).
 */
export function buildDflashAdapter(
  arch: NodeJS.Architecture = process.arch,
  cwd: string = process.cwd(),
): DflashAdapter | null {
  let llamaServerPath: string;
  try {
    llamaServerPath = resolveLlamaServerPath(arch, cwd);
  } catch {
    return null;
  }
  if (!existsSync(llamaServerPath)) {
    return null;
  }
  // Sanity check the binary is executable. statSync doesn't have an isExec
  // helper in node fs, so we mask the mode bits ourselves.
  try {
    const mode = statSync(llamaServerPath).mode;
    if ((mode & 0o111) === 0) {
      logger.warn(
        `[aosp-dflash] ${llamaServerPath} is not executable (mode=${mode.toString(8)}); refusing to spawn.`,
      );
      return null;
    }
  } catch {
    return null;
  }
  return new AospDflashAdapter(llamaServerPath);
}

/**
 * Decide whether a `loadModel` call should route through the DFlash
 * adapter. True when:
 *   - The caller passed `draftModelPath` explicitly, OR
 *   - `ELIZA_DFLASH=1` is set in env (catalog has paired the model already
 *     at the dispatch layer).
 *
 * Exported so the dispatcher in registerAospLlamaLoader can apply the same
 * rule without re-implementing it.
 */
export function shouldRouteViaDflash(args: {
  draftModelPath?: string;
}): boolean {
  if (args.draftModelPath) return true;
  const env = process.env.ELIZA_DFLASH?.trim().toLowerCase();
  return env === "1" || env === "true" || env === "yes";
}
