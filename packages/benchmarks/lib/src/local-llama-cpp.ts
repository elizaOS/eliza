/**
 * Thin OpenAI-compatible client adapter for the dflash llama-cpp fork.
 *
 * The dflash fork (built locally under
 * `~/.cache/eliza-dflash/eliza-llama-cpp`) exposes the standard
 * `llama-server` OpenAI-compatible HTTP endpoint at `/v1`. This module
 * provides:
 *
 * - `probeDflashFork()`           — locate the binary on disk, return its
 *                                   absolute path or `null`.
 * - `startLocalServer(...)`       — spawn `llama-server` against a GGUF
 *                                   bundle and wait for `/v1/models`.
 * - `resolveLocalBaseUrl(...)`    — choose between the dflash spawn URL and
 *                                   the Ollama fallback exposed via
 *                                   `PARALLAX_OPENCODE_BASE_URL`.
 *
 * Higher-level callers should treat the dflash fork as the primary local
 * provider for `MODEL_TIER=small|mid` and fall back to Ollama only when the
 * fork is not built.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DFLASH_FORK_ROOT = path.join(homedir(), ".cache", "eliza-dflash", "eliza-llama-cpp");
const DFLASH_BINARY_RELATIVE = path.join("build", "bin", "llama-server");

/** Absolute filesystem path to where the dflash fork is expected to live. */
export const DFLASH_FORK_PATH = DFLASH_FORK_ROOT;

/** Absolute filesystem path to the expected `llama-server` binary. */
export const DFLASH_BINARY_PATH = path.join(DFLASH_FORK_ROOT, DFLASH_BINARY_RELATIVE);

/**
 * Expand a leading `~` to the user's home directory. No-op for absolute
 * or relative paths without a leading `~`.
 */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * Return the absolute path to the dflash `llama-server` binary if it
 * exists on disk, otherwise `null`.
 */
export function probeDflashFork(): string | null {
  return existsSync(DFLASH_BINARY_PATH) ? DFLASH_BINARY_PATH : null;
}

export interface StartLocalServerOptions {
  /** GGUF bundle path. `~` is expanded. */
  bundlePath: string;
  /** Port to bind. Defaults to 18781 to avoid collisions with Ollama (11434). */
  port?: number;
  /** Override the binary location (test seam). */
  binaryPath?: string;
  /** Extra args appended after the canonical `--model`/`--port` block. */
  extraArgs?: string[];
  /** Max wait for `/v1/models` to respond, in ms. Default 30s. */
  readyTimeoutMs?: number;
}

export interface LocalServerHandle {
  /** Base URL with `/v1` suffix the OpenAI SDK / litellm expects. */
  baseUrl: string;
  /** Underlying child process. Kept on the handle so callers can read PID. */
  child: ChildProcess;
  /** Stop the spawned server. Resolves once the child exits. */
  kill: () => Promise<void>;
}

/**
 * Spawn a dflash `llama-server` instance against the requested bundle and
 * wait for the OpenAI-compatible endpoint to respond.
 *
 * Throws if the binary cannot be located, the bundle is missing, or the
 * server does not become ready within `readyTimeoutMs`.
 */
export async function startLocalServer(
  options: StartLocalServerOptions,
): Promise<LocalServerHandle> {
  const binary = options.binaryPath ?? probeDflashFork();
  if (!binary) {
    throw new Error(
      `dflash llama-server binary not found at ${DFLASH_BINARY_PATH}. ` +
        "Build the fork at ~/.cache/eliza-dflash/eliza-llama-cpp or set " +
        "PARALLAX_OPENCODE_BASE_URL to point at a local OpenAI-compatible endpoint.",
    );
  }

  const bundlePath = expandHome(options.bundlePath);
  if (!existsSync(bundlePath)) {
    throw new Error(
      `dflash bundle path does not exist: ${bundlePath}. Set MODEL_BUNDLE_OVERRIDE ` +
        "or place the GGUF bundle at the default location.",
    );
  }

  const port = options.port ?? 18781;
  const args = [
    "--model",
    bundlePath,
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
    ...(options.extraArgs ?? []),
  ];

  const child = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;

  try {
    await waitForReady(baseUrl, readyTimeoutMs);
  } catch (err) {
    child.kill("SIGTERM");
    throw err;
  }

  return {
    baseUrl,
    child,
    kill: () => killChild(child),
  };
}

async function waitForReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const target = `${baseUrl}/models`;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(target, { method: "GET" });
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${target} to respond. ` +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function killChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    // Hard kill if still alive after 5s.
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
    }, 5_000).unref();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ResolveLocalBaseUrlOptions {
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedLocalBaseUrl {
  /** OpenAI-compatible base URL, e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  /** Where the URL came from. */
  source: "dflash-running" | "ollama-env" | "ollama-default";
}

/**
 * Decide which OpenAI-compatible base URL to use for local-tier
 * inference. Preference order:
 *
 * 1. `PARALLAX_OPENCODE_BASE_URL` (explicit operator override; matches the
 *    same env Eliza's OpenCode fallback reads).
 * 2. Ollama default `http://localhost:11434/v1`.
 *
 * This function does **not** spawn the dflash fork — callers that want to
 * spawn it should call `startLocalServer` first and pass that handle
 * forward. `resolveLocalBaseUrl` is for the "already running" case (Ollama,
 * LM Studio, an externally-managed `llama-server`).
 */
export function resolveLocalBaseUrl(
  options: ResolveLocalBaseUrlOptions = {},
): ResolvedLocalBaseUrl {
  const env = options.env ?? process.env;
  const override = env.PARALLAX_OPENCODE_BASE_URL?.trim();
  if (override) {
    return { baseUrl: override, source: "ollama-env" };
  }
  return { baseUrl: "http://localhost:11434/v1", source: "ollama-default" };
}
