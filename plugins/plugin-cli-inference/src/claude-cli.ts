import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@elizaos/core";
import { flattenPrompt } from "./prompt-flatten";
import { filterEnv, redactSensitive, resolveSafeBinary, resolveSafeCwd } from "./sandbox";

/**
 * Claude Code CLI inference variant (TOS-clean SAFE/CLOUD route).
 *
 * Spawns the sanctioned `claude --print` binary, which reads its OWN OAuth
 * credentials from `~/.claude/.credentials.json`. eliza never sees, forwards,
 * or logs the subscription token: the child env is run through `filterEnv`
 * (allowlist + `SENSITIVE_ENV_RE` blocklist), and stderr is redacted before
 * logging. Distinct from the in-process stealth fetch-interceptor at
 * `packages/agent/src/auth/credentials.ts`, which replays the token in-process
 * and stays on a never-commit branch.
 */

const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_TIMEOUT_MS = 120_000;
const CLAUDE_BINARY = "claude";

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type SpawnFn = (argv: string[], opts: SpawnOptions) => Promise<SpawnResult>;

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Absolute path used as stdin (always `/dev/null` in production). */
  stdinPath: string;
}

export interface ClaudeCliConfig {
  model?: string;
  timeoutMs?: number;
  /** Override the env source (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /**
   * Pin the resolved binary path, skipping `resolveSafeBinary`. Used by unit
   * tests (so they never touch the real filesystem) and by container deploys
   * that pin the CLI outside the default allowlist. When unset, the binary is
   * resolved from PATH against the SOC2 whitelist.
   */
  binaryPath?: string;
}

export interface ClaudeGenerateParams {
  system?: string;
  prompt?: string;
  messages?: Parameters<typeof flattenPrompt>[0]["messages"];
}

/** Grace window after SIGTERM before escalating to SIGKILL on the group. */
const SIGKILL_GRACE_MS = 2_000;

/**
 * Default spawner: runs argv with `/dev/null` stdin, captures stdout/stderr,
 * and enforces a hard timeout. On expiry it SIGTERMs the whole process group
 * (the child is spawned `detached` so it leads its own group), then escalates
 * to SIGKILL after a short grace window so a child that ignores SIGTERM cannot
 * hang generate() past `timeoutMs + SIGKILL_GRACE_MS`. Pure I/O — overridable
 * in tests via `__setSpawnForTests`.
 */
export const defaultSpawn: SpawnFn = (argv, opts) =>
  new Promise<SpawnResult>((resolve, reject) => {
    let stdinFd: number;
    try {
      // `/dev/null` stdin is REQUIRED: without it the CLI waits ~3s for stdin
      // before falling through to the `-p` arg.
      stdinFd = openSync(opts.stdinPath, "r");
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: [stdinFd, "pipe", "pipe"],
      // Lead a new process group so we can signal the whole tree (the CLI may
      // fork helpers) and so SIGKILL escalation reaches a child that traps
      // SIGTERM.
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    // Signal the process group (negative pid) when we have one; fall back to
    // the child directly if the pid is unavailable.
    const signalTree = (sig: NodeJS.Signals): void => {
      const pid = child.pid;
      try {
        if (typeof pid === "number") {
          process.kill(-pid, sig);
        } else {
          child.kill(sig);
        }
      } catch {
        // Group already gone — nothing to signal.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      signalTree("SIGTERM");
      // Hard escalation: if the child ignores SIGTERM, SIGKILL the group so
      // generate() cannot hang past timeoutMs + grace.
      killTimer = setTimeout(() => signalTree("SIGKILL"), SIGKILL_GRACE_MS);
      killTimer.unref?.();
    }, opts.timeoutMs);

    const clearTimers = (): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimers();
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimers();
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });

let spawnImpl: SpawnFn = defaultSpawn;

/** Test seam: swap the child-process spawner. Returns a restore fn. */
export function __setSpawnForTests(fn: SpawnFn): () => void {
  const prev = spawnImpl;
  spawnImpl = fn;
  return () => {
    spawnImpl = prev;
  };
}

/** Redact anything resembling a secret out of stderr before logging. */
function redactStderr(stderr: string): string {
  return redactSensitive(stderr).slice(0, 2000);
}

export class ClaudeCli {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly binaryPath?: string;

  constructor(config: ClaudeCliConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.env = config.env ?? process.env;
    this.binaryPath = config.binaryPath;
  }

  async generate(params: ClaudeGenerateParams): Promise<string> {
    const { system, body } = flattenPrompt(params);
    const binary = this.binaryPath ?? resolveSafeBinary(CLAUDE_BINARY, this.env);

    // Isolated empty tmpdir cwd: keeps the CLI out of any real project so it
    // never picks up repo context (which would inject Claude Code's own
    // identity / file-aware behavior), and `resolveSafeCwd` rejects symlink
    // escapes. Created + removed per call.
    const rawCwd = await mkdtemp(join(tmpdir(), "eliza-cli-inference-"));
    const cwd = resolveSafeCwd(rawCwd, [tmpdir()]);

    try {
      const argv = [binary, "-p", body];
      // Only override the system prompt when the runtime actually supplied one.
      // Passing `--system-prompt ''` together with
      // `--exclude-dynamic-system-prompt-sections` would strip ALL steering
      // (both ours and Claude Code's), leaving the model ungoverned. When the
      // flattened system is empty we leave Claude Code's default sections in
      // place rather than blank everything out.
      if (system.trim().length > 0) {
        argv.push(
          // FULL REPLACE of the system prompt: suppresses Claude Code's own
          // identity and lets the runtime grammar (`<response><thought><text>`
          // + do-not-invent rules) take over.
          "--system-prompt",
          system,
          // Drop Claude Code's dynamic system-prompt sections (repo/tool
          // context) so only our system prompt governs the turn.
          "--exclude-dynamic-system-prompt-sections"
        );
      }
      argv.push("--output-format", "text", "--model", this.model);

      const result = await spawnImpl(argv, {
        cwd,
        // NEVER inject the subscription token: filterEnv allowlists PATH/HOME/…
        // and drops every `SENSITIVE_ENV_RE` key. The CLI reads its own creds
        // from ~/.claude/.credentials.json.
        env: filterEnv(this.env),
        timeoutMs: this.timeoutMs,
        stdinPath: "/dev/null",
      });

      if (result.timedOut) {
        throw new Error(
          `[cli-inference] claude timed out after ${this.timeoutMs}ms (SIGTERM): ${redactStderr(result.stderr)}`
        );
      }
      if (result.code !== 0) {
        throw new Error(
          `[cli-inference] claude exited ${result.code} signal=${result.signal}: ${redactStderr(result.stderr)}`
        );
      }
      const text = result.stdout.trim();
      if (text.length === 0) {
        throw new Error(
          `[cli-inference] claude returned empty stdout: ${redactStderr(result.stderr)}`
        );
      }
      return text;
    } finally {
      await rm(rawCwd, { recursive: true, force: true }).catch((err) => {
        logger.debug(`[cli-inference] failed to clean isolated cwd ${rawCwd}: ${String(err)}`);
      });
    }
  }
}
