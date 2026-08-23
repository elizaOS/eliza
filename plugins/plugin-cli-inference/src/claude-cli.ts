import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger, toWellFormedUnicode } from "@elizaos/core";
import { flattenPrompt } from "./prompt-flatten";
import { ProviderApiError, parseProviderApiErrorText } from "./provider-errors";
import { filterEnv, redactStderr, resolveSafeBinary, resolveSafeCwd } from "./sandbox";

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

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_TIMEOUT_MS = 120_000;
const CLAUDE_BINARY = "claude";

// The Claude Code harness injects `<system-reminder>` blocks into its
// prompts, and the model occasionally echoes one back verbatim in text
// output. They are transport metadata, never legitimate reply content — one
// leaked into a user-facing Stage-1 reply live (#16941: "On it.
// <system-reminder> Return exactly one JSON object … </system-reminder>").
// Strip them before the runtime ever sees the text.
const SYSTEM_REMINDER_BLOCK_RE = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;

export function stripSystemReminderBlocks(text: string): string {
  return text.replace(SYSTEM_REMINDER_BLOCK_RE, "");
}

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
  /** Absolute path streamed to the child as stdin. */
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
 * Default spawner: streams the configured input file to stdin, captures stdout/stderr,
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
      stdinFd = openSync(opts.stdinPath, "r");
    } catch (err) {
      // error-policy:J1 boundary — cannot open the required stdin fd; reject the
      // spawn (fail closed, do not launch the CLI blind).
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        stdio: [stdinFd, "pipe", "pipe"],
        // Lead a new process group so we can signal the whole tree (the CLI may
        // fork helpers) and so SIGKILL escalation reaches a child that traps
        // SIGTERM.
        detached: true,
      });
    } catch (err) {
      // error-policy:J2 context-adding rethrow — spawn() can throw synchronously
      // (e.g. invalid options) before any 'error'/'close' handler is attached,
      // so close the parent's stdin fd here or it leaks on the throw path.
      try {
        closeSync(stdinFd);
      } catch {
        // error-policy:J6 best-effort teardown — already-invalid fd is harmless.
      }
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

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
        // error-policy:J6 best-effort signal — an ESRCH means the group already
        // exited; there is nothing to signal, which is the intended terminal state.
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

    // Close the PARENT's copy of the stdin fd exactly once on any terminal
    // outcome. Node dup's the descriptor into the child at spawn() time, so the
    // child keeps its own inherited copy — but Node does NOT auto-close an
    // integer fd passed via `stdio`, so without this the parent leaks one fd per
    // spawn. The CLI inference route cold-spawns per model call (~4-8 per turn),
    // so an unclosed fd here marches the process toward EMFILE and breaks every
    // subsequent open/spawn/socket, not just inference (#24979).
    let stdinFdClosed = false;
    const closeStdinFd = (): void => {
      if (stdinFdClosed) return;
      stdinFdClosed = true;
      try {
        closeSync(stdinFd);
      } catch {
        // error-policy:J6 best-effort teardown — a double-close / already-invalid
        // fd is harmless; the only goal is to not leak the parent's copy.
      }
    };

    const clearTimers = (): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      closeStdinFd();
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
      const bodyPath = join(cwd, "prompt.txt");
      await writeFile(bodyPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      const argv = [binary, "-p"];
      // Only override the system prompt when the runtime actually supplied one.
      // Passing `--system-prompt ''` together with
      // `--exclude-dynamic-system-prompt-sections` would strip ALL steering
      // (both ours and Claude Code's), leaving the model ungoverned. When the
      // flattened system is empty we leave Claude Code's default sections in
      // place rather than blank everything out.
      if (system.trim().length > 0) {
        const systemPath = join(cwd, "system-prompt.txt");
        await writeFile(systemPath, system, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        argv.push(
          // FULL REPLACE of the system prompt: suppresses Claude Code's own
          // identity and lets the runtime grammar (`<response><thought><text>`
          // + do-not-invent rules) take over.
          "--system-prompt-file",
          systemPath,
          // Drop Claude Code's dynamic system-prompt sections (repo/tool
          // context) so only our system prompt governs the turn.
          "--exclude-dynamic-system-prompt-sections"
        );
      }
      // Disable EVERY built-in Claude Code tool: eliza uses the CLI strictly
      // as a text engine (planner routing JSON / reply synthesis), never as an
      // agent. With tools live, an agentic-looking transcript ("create an app
      // for me") can nondeterministically flip the model into Claude Code
      // behavior — really invoking Write/Bash, stalling on permission prompts
      // that non-interactive --print can never approve, and burning the whole
      // 120s budget generating the task instead of routing it (observed live
      // in the #16939 CHOICE runs: "waiting on your file-write approval" from
      // a planner call). No tools ⇒ the only reachable output is text.
      argv.push("--tools", "", "--output-format", "text", "--model", this.model);

      const result = await spawnImpl(argv, {
        cwd,
        // NEVER inject the subscription token: filterEnv allowlists PATH/HOME/…
        // and drops every `SENSITIVE_ENV_RE` key. The CLI reads its own creds
        // from ~/.claude/.credentials.json.
        env: filterEnv(this.env),
        timeoutMs: this.timeoutMs,
        stdinPath: bodyPath,
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
      const text = stripSystemReminderBlocks(result.stdout).trim();
      const apiError = parseProviderApiErrorText(text);
      if (apiError) {
        throw new ProviderApiError(`[cli-inference] claude upstream ${toWellFormedUnicode(text)}`, {
          statusCode: apiError.statusCode,
        });
      }
      if (text.length === 0) {
        throw new Error(
          `[cli-inference] claude returned empty stdout: ${redactStderr(result.stderr)}`
        );
      }
      return text;
    } finally {
      // error-policy:J6 best-effort teardown of the isolated cwd; logged at debug,
      // must not mask the returned result / error.
      await rm(rawCwd, { recursive: true, force: true }).catch((err) => {
        logger.debug(`[cli-inference] failed to clean isolated cwd ${rawCwd}: ${String(err)}`);
      });
    }
  }
}
