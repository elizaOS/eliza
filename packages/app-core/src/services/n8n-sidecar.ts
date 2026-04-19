/**
 * n8n local sidecar: lifecycle + readiness + API-key provisioning.
 *
 * Fallback for the @elizaos/plugin-n8n-workflow plugin when the user has
 * no Eliza Cloud session. Spawns `bunx n8n@<pinned>` (no package.json
 * dependency on n8n — that tree is ~300MB), polls `/rest/login` until
 * the instance is reachable, then provisions a personal API key via
 * `/rest/me/api-keys` so the plugin has `N8N_HOST` + `N8N_API_KEY` to
 * talk to.
 *
 * ── Lifecycle state diagram ─────────────────────────────────────────
 *
 *   stopped ──start()──▶ starting ──ready_probe_ok──▶ ready
 *      ▲                    │
 *      │                    └──start_error / probe_timeout──▶ error
 *      │                                                         │
 *      │                                                  retry_backoff
 *      │                                                         │
 *      ├────stop()──── ready                                      │
 *      │                    │                                     │
 *      │                   crash                                  │
 *      │                    ▼                                     │
 *      │                 error ◀──max_retries_exceeded────────────┘
 *      │                    │
 *      └────stop()──────────┘
 *
 * Transitions are emitted via an observable so the UI can live-render
 * "Cloud n8n connected" vs "Local n8n starting…". Secrets never cross
 * the logger at INFO — the provisioned API key is logged as a redacted
 * fingerprint only.
 *
 * Matches the develop sidecar conventions used by StewardSidecar:
 *   - Prefers `Bun.spawn` when available, falls back to node:child_process
 *   - `onStatusChange` + `onLog` callbacks in config (parallels steward)
 *   - Bounded restart with exponential backoff
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";

// ── Types ────────────────────────────────────────────────────────────────────

// TODO(agent-a): replace this local type with the exported `N8nSidecarStatus`
// from `../config/…` once `N8nConfig` lands in the develop config module.
export type N8nSidecarStatus = "stopped" | "starting" | "ready" | "error";

export interface N8nSidecarState {
  status: N8nSidecarStatus;
  host: string | null;
  port: number | null;
  errorMessage: string | null;
  pid: number | null;
  retries: number;
  /**
   * Last ~40 lines of the child's stdout+stderr, most recent last. Surfaced
   * so the UI / `/api/n8n/status` can show the real n8n boot output when
   * the supervisor is stuck in "starting" or has landed in "error". Without
   * this, the sidecar was a black box: we'd see "not ready" forever with
   * no way to tell whether bunx was downloading, n8n was migrating, or the
   * process had crashed on a missing binary.
   */
  recentOutput: string[];
}

export interface N8nSidecarConfig {
  /** Enable local sidecar fallback. Default: true when no cloud session. */
  enabled?: boolean;
  /** Pinned n8n version. Update via release process; matches bunx cache. */
  version?: string;
  /** Preferred starting port; next free port used on collision. Default 5678. */
  startPort?: number;
  /** Bind host for the child. Default 127.0.0.1. */
  host?: string;
  /** Binary used to run n8n. Default "bunx". */
  binary?: string;
  /** State directory root; owner email/password + sqlite live here. */
  stateDir?: string;
  /**
   * Readiness probe timeout in ms. Default 180000 (3 minutes).
   *
   * First-run `bunx n8n@<pinned>` has to download the full n8n tree
   * (~300MB) before it can boot. On a typical home connection that's
   * 30–90s of download plus 15–30s of n8n boot. 60s was not enough —
   * bump to 3 minutes so cold starts land inside the probe window on
   * every desktop platform. Subsequent boots hit the bunx cache and
   * finish in <10s, well inside this budget.
   */
  readinessTimeoutMs?: number;
  /** Interval between readiness probes. Default 750ms. */
  readinessIntervalMs?: number;
  /** Max restart attempts before going to `error`. Default 3. */
  maxRetries?: number;
  /** Base backoff in ms (exponential). Default 2000. */
  backoffBaseMs?: number;
  /** Optional status-change listener (parallels StewardSidecar.onStatusChange). */
  onStatusChange?: (state: N8nSidecarState) => void;
  /** Optional log forwarder (parallels StewardSidecar.onLog). */
  onLog?: (line: string, stream: "stdout" | "stderr") => void;
}

export interface N8nSidecarDeps {
  /** Factory so tests can mock `spawn` without touching `node:child_process`. */
  spawn?: typeof nodeSpawn;
  /** HTTP fetch override for tests (readiness probe + API-key provisioning). */
  fetch?: typeof fetch;
  /** Port picker override so tests don't need real sockets. */
  pickPort?: (start: number) => Promise<number>;
  /** Sleep override for deterministic backoff tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Returns true if a process with the given pid is alive. Overridable so
   * tests can simulate orphaned pids without needing real OS processes.
   */
  isProcessAlive?: (pid: number) => boolean;
  /**
   * Returns the command-line of a process (or null). Used for orphan
   * detection to avoid killing an unrelated pid that may have been reused.
   */
  readProcessCommand?: (pid: number) => Promise<string | null>;
  /**
   * Sends a signal to a pid. Used when reaping an orphan from a pidfile.
   * Separate from the child-process kill because we may not own the
   * orphan's ChildProcess handle.
   */
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * Preflight check for the spawn binary. Default implementation runs
   * `<binary> --version` with a short timeout. Throws on failure.
   */
  preflightBinary?: (binary: string) => Promise<void>;
  /** Current wall-clock time. Injected for deterministic retry-reset tests. */
  now?: () => number;
  /** setTimeout override so tests can control the 5-minute retry-reset timer. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** clearTimeout override paired with `setTimer`. */
  clearTimer?: (handle: unknown) => void;
}

type Listener = (state: N8nSidecarState) => void;

// ── Implementation ───────────────────────────────────────────────────────────

// n8n@1.70.0 declared `engines.node: ">=18.17 <= 22"` — incompatible with
// Node 24.x which ships with current Homebrew and with the Electrobun runtime.
// 1.99.0+ widened to ">=20.19 <= 24.x". Pinning the last 1.x release so the
// DB schema stays on a supported migration path and Node 24 hosts can boot.
// Validated via `npm view n8n@<v> engines.node`. Bumping below 1.99 will break
// every desktop whose system Node is 23+.
const DEFAULT_N8N_VERSION = "1.108.0";
const DEFAULT_START_PORT = 5678;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_BINARY = "bunx";
// First-run `bunx n8n@<pinned>` downloads ~300MB before n8n can boot. A 60s
// timeout was too aggressive — cold starts on typical home connections take
// 60–120s just for the download. Bump to 180s so the first-run path reliably
// lands inside the probe window on every desktop platform. Warm starts hit
// the bunx cache and finish well under this budget.
const DEFAULT_PROBE_TIMEOUT_MS = 180_000;
const DEFAULT_PROBE_INTERVAL_MS = 750;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 2_000;
/** Uptime after which a ready sidecar is considered healthy and retries reset. */
const RETRY_RESET_AFTER_MS = 5 * 60 * 1_000;
/** Hard cap on how long we wait for a child to exit during supervision. */
const CHILD_EXIT_WAIT_TIMEOUT_MS = 2 * 60 * 1_000;
/** Grace period between SIGTERM and SIGKILL when reaping an orphan. */
const ORPHAN_SIGTERM_GRACE_MS = 5_000;

/** Terminal statuses that mean "not running right now". */
const TERMINAL_STATUSES: ReadonlySet<N8nSidecarStatus> = new Set([
  "stopped",
  "error",
]);

function defaultStateDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.tmpdir();
  // Matches develop namespace — see runtime/eliza.ts state-dir resolution.
  return path.join(home, ".eliza", "n8n");
}

/** Async port picker: asks the OS for a free port starting at `start`. */
async function pickFreePortDefault(start: number): Promise<number> {
  const maxAttempts = 50;
  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidate = start + offset;
    if (candidate > 65535) break;
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(candidate, "127.0.0.1");
    });
    if (free) return candidate;
  }
  throw new Error(`no free port available starting from ${start}`);
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAliveDefault(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 is the POSIX "does the pid exist and am I allowed to signal
    // it?" probe — doesn't actually deliver a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    // EPERM means the process exists but we can't signal it — still alive.
    if (code === "EPERM") return true;
    return false;
  }
}

async function readProcessCommandDefault(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // Linux-first; macOS exposes /proc only via `ps`. We fall back to `ps` on
  // any read failure so this works across both platforms in dev.
  try {
    const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, "utf-8");
    // /proc cmdline is NUL-separated; normalize.
    return cmdline.replace(/\0/g, " ").trim();
  } catch {
    // Fall through to `ps` fallback.
  }
  try {
    const { spawn } = await import("node:child_process");
    return await new Promise<string | null>((resolve) => {
      const proc = spawn("ps", ["-p", String(pid), "-o", "command="], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      proc.stdout?.on("data", (buf: Buffer) => {
        out += buf.toString();
      });
      proc.once("error", () => resolve(null));
      proc.once("exit", (code) => {
        if (code === 0) {
          const trimmed = out.trim();
          resolve(trimmed.length ? trimmed : null);
        } else {
          resolve(null);
        }
      });
    });
  } catch {
    return null;
  }
}

function killPidDefault(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, signal);
  } catch {
    /* pid gone or not ours — nothing to do */
  }
}

async function preflightBinaryDefault(binary: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = nodeSpawn(binary, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* no-op */
      }
      reject(
        new Error(
          `${binary} --version timed out; bun runtime not found on PATH — required for local n8n. Install from https://bun.sh.`,
        ),
      );
    }, 5_000);
    timer.unref?.();
    proc.once("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `${binary} runtime not found on PATH — required for local n8n. Install from https://bun.sh. (${err.message})`,
        ),
      );
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${binary} --version exited with code ${code ?? "null"} — required for local n8n. Install from https://bun.sh.`,
          ),
        );
      }
    });
  });
}

/** Redact a secret to a short fingerprint that's safe to log. */
function fingerprint(secret: string): string {
  if (!secret || secret.length < 8) return "***";
  return `${secret.slice(0, 4)}…${secret.slice(-2)} (len=${secret.length})`;
}

type ResolvedConfig = Required<
  Omit<N8nSidecarConfig, "onStatusChange" | "onLog">
> &
  Pick<N8nSidecarConfig, "onStatusChange" | "onLog">;

function resolveConfig(config: N8nSidecarConfig): ResolvedConfig {
  return {
    enabled: config.enabled ?? true,
    version: config.version ?? DEFAULT_N8N_VERSION,
    startPort: config.startPort ?? DEFAULT_START_PORT,
    host: config.host ?? DEFAULT_HOST,
    binary: config.binary ?? DEFAULT_BINARY,
    stateDir: config.stateDir ?? defaultStateDir(),
    readinessTimeoutMs: config.readinessTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    readinessIntervalMs:
      config.readinessIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    backoffBaseMs: config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
    onStatusChange: config.onStatusChange,
    onLog: config.onLog,
  };
}

export class N8nSidecar {
  private config: ResolvedConfig;
  private deps: Required<N8nSidecarDeps>;
  private state: N8nSidecarState = {
    status: "stopped",
    host: null,
    port: null,
    errorMessage: null,
    pid: null,
    retries: 0,
    recentOutput: [],
  };
  private static readonly RECENT_OUTPUT_CAP = 40;
  /** Ring buffer of the child's recent stdout/stderr lines (see state.recentOutput). */
  private recentOutput: string[] = [];
  private child: ChildProcess | null = null;
  /** Cached API key — secret, never logged, never serialized via getState(). */
  private apiKey: string | null = null;
  private listeners: Set<Listener> = new Set();
  private stopping = false;
  private supervisorRunning = false;
  /**
   * Handle for the retry-reset timer. A sidecar that stays ready for
   * RETRY_RESET_AFTER_MS is declared healthy and its retry count is zeroed
   * so a future crash doesn't count as part of the original burst.
   */
  private retryResetTimer: unknown = null;

  constructor(config: N8nSidecarConfig = {}, deps: N8nSidecarDeps = {}) {
    this.config = resolveConfig(config);
    this.deps = {
      spawn: deps.spawn ?? nodeSpawn,
      fetch: deps.fetch ?? fetch,
      pickPort: deps.pickPort ?? pickFreePortDefault,
      sleep: deps.sleep ?? sleepDefault,
      isProcessAlive: deps.isProcessAlive ?? isProcessAliveDefault,
      readProcessCommand: deps.readProcessCommand ?? readProcessCommandDefault,
      killPid: deps.killPid ?? killPidDefault,
      preflightBinary: deps.preflightBinary ?? preflightBinaryDefault,
      now: deps.now ?? (() => Date.now()),
      setTimer:
        deps.setTimer ??
        ((fn, ms) => {
          const handle = setTimeout(fn, ms);
          handle.unref?.();
          return handle;
        }),
      clearTimer:
        deps.clearTimer ??
        ((handle) => {
          if (handle) clearTimeout(handle as ReturnType<typeof setTimeout>);
        }),
    };
  }

  getState(): N8nSidecarState {
    return { ...this.state };
  }

  /**
   * Returns the provisioned API key. Separate from `getState()` so state
   * snapshots can be broadcast to UI/WS clients without leaking the secret.
   */
  getApiKey(): string | null {
    return this.apiKey;
  }

  /**
   * Merge new config into the existing sidecar. Safe to call at any time.
   *
   * - If the sidecar has not been spawned yet (no child), the next call to
   *   start() will pick up the new values.
   * - If the sidecar is currently running AND a field that requires a
   *   respawn (binary, host, startPort, stateDir, version) changed, we log
   *   a warning and keep the old values live. Callers must stop() + start()
   *   explicitly to apply those changes.
   */
  updateConfig(next: N8nSidecarConfig): void {
    const merged = resolveConfig({ ...this.snapshotConfig(), ...next });
    if (!this.child) {
      this.config = merged;
      return;
    }
    const respawnFields: ReadonlyArray<keyof ResolvedConfig> = [
      "binary",
      "host",
      "startPort",
      "stateDir",
      "version",
    ];
    const changed = respawnFields.filter(
      (field) => merged[field] !== this.config[field],
    );
    if (changed.length > 0) {
      logger.warn(
        `[n8n-sidecar] updateConfig: ${changed.join(", ")} changed while sidecar is running; restart required to apply`,
      );
    }
    // Non-respawn fields (retries, timeouts, callbacks) take effect immediately.
    this.config = {
      ...merged,
      // Preserve respawn-critical fields tied to the live child process.
      binary: this.config.binary,
      host: this.config.host,
      startPort: this.config.startPort,
      stateDir: this.config.stateDir,
      version: this.config.version,
    };
  }

  /**
   * Return the current ResolvedConfig as an N8nSidecarConfig input (used by
   * updateConfig for the merge). Excludes internal timer state.
   */
  private snapshotConfig(): N8nSidecarConfig {
    return {
      enabled: this.config.enabled,
      version: this.config.version,
      startPort: this.config.startPort,
      host: this.config.host,
      binary: this.config.binary,
      stateDir: this.config.stateDir,
      readinessTimeoutMs: this.config.readinessTimeoutMs,
      readinessIntervalMs: this.config.readinessIntervalMs,
      maxRetries: this.config.maxRetries,
      backoffBaseMs: this.config.backoffBaseMs,
      onStatusChange: this.config.onStatusChange,
      onLog: this.config.onLog,
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    // Fire once so subscribers get the current snapshot.
    try {
      fn(this.getState());
    } catch {
      /* ignore listener errors */
    }
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch {
        /* ignore listener errors */
      }
    }
    try {
      this.config.onStatusChange?.(snapshot);
    } catch {
      /* ignore listener errors */
    }
  }

  private setState(patch: Partial<N8nSidecarState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  /**
   * Start the sidecar. Safe to call multiple times — no-ops if already
   * starting/ready. Never throws; failures mark status=error and resolve.
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.setState({
        status: "stopped",
        errorMessage: "disabled",
      });
      return;
    }
    if (this.state.status === "starting" || this.state.status === "ready") {
      return;
    }

    this.stopping = false;
    this.setState({
      status: "starting",
      errorMessage: null,
      retries: 0,
    });

    await this.runSupervisor();
  }

  /**
   * Supervisor loop: spawn → probe readiness → (on crash) exponential
   * backoff. Bounded by `maxRetries`; beyond that we land in `error`.
   */
  private async runSupervisor(): Promise<void> {
    if (this.supervisorRunning) return;
    this.supervisorRunning = true;

    try {
      while (!this.stopping) {
        try {
          await this.deps.preflightBinary(this.config.binary);

          const port = await this.deps.pickPort(this.config.startPort);
          const host = `http://${this.config.host}:${port}`;
          this.setState({ host, port });

          try {
            mkdirSync(this.config.stateDir, { recursive: true });
          } catch (err) {
            logger.warn(
              `[n8n-sidecar] mkdir state dir failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          await this.reapOrphan();

          await this.spawnChild(port);
          await this.writePidfile(this.child?.pid ?? null);

          const reachable = await this.probeReadiness(host);
          if (!reachable) {
            throw new Error(
              `readiness probe timed out after ${this.config.readinessTimeoutMs}ms`,
            );
          }

          // Try the cached API key first; provision if missing or rejected.
          try {
            const key = await this.ensureApiKey(host);
            if (key) {
              this.apiKey = key;
              logger.info(
                `[n8n-sidecar] using api key ${fingerprint(key)}`,
              );
            }
          } catch (err) {
            logger.warn(
              `[n8n-sidecar] api key provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          this.setState({ status: "ready", errorMessage: null });
          this.armRetryResetTimer();

          // Wait for child to exit; then decide retry vs shutdown.
          await this.waitForChildExitWithTimeout();
          this.cancelRetryResetTimer();
          if (this.stopping) return;

          logger.warn("[n8n-sidecar] child exited unexpectedly");
          this.setState({ status: "starting", pid: null });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[n8n-sidecar] start attempt failed: ${msg}`);
          this.cancelRetryResetTimer();
          this.setState({
            status: "starting",
            errorMessage: msg,
            pid: null,
          });
          this.killChild();
        }

        if (this.stopping) return;

        const nextRetries = this.state.retries + 1;
        if (nextRetries > this.config.maxRetries) {
          this.setState({
            status: "error",
            errorMessage: this.state.errorMessage ?? "max retries exceeded",
            retries: nextRetries,
          });
          return;
        }

        const backoff = this.config.backoffBaseMs * 2 ** (nextRetries - 1);
        this.setState({ retries: nextRetries });
        await this.deps.sleep(backoff);
      }
    } finally {
      this.supervisorRunning = false;
    }
  }

  private async spawnChild(port: number): Promise<void> {
    // n8n reads N8N_USER_MANAGEMENT_DISABLED to skip the owner-setup flow
    // on first boot; we pair it with a random owner email so no real user
    // data is needed. Using `bunx n8n@<pinned>` avoids adding n8n as a
    // package.json dep — bun caches the install globally.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      N8N_PORT: String(port),
      N8N_HOST: this.config.host,
      N8N_PROTOCOL: "http",
      N8N_USER_MANAGEMENT_DISABLED: "true",
      N8N_DIAGNOSTICS_ENABLED: "false",
      N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
      N8N_PERSONALIZATION_ENABLED: "false",
      N8N_HIRING_BANNER_ENABLED: "false",
      N8N_USER_FOLDER: this.config.stateDir,
      DB_TYPE: "sqlite",
      DB_SQLITE_DATABASE: path.join(this.config.stateDir, "database.sqlite"),
    };

    const versioned = `n8n@${this.config.version}`;
    const child = this.deps.spawn(
      this.config.binary,
      ["--", versioned, "start"],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      },
    );

    this.child = child;
    this.setState({ pid: child.pid ?? null });

    const captureOutput = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        const trimmed = line.trimEnd();
        if (!trimmed) continue;
        this.recordOutput(`[${stream}] ${trimmed}`);
        // Surface n8n errors at warn so they land in the dev-server log even
        // when debug is off — the sidecar was silent before when n8n died.
        if (stream === "stderr") {
          logger.warn(`[n8n-sidecar:stderr] ${trimmed}`);
        } else {
          logger.debug(`[n8n-sidecar:stdout] ${trimmed}`);
        }
        try {
          this.config.onLog?.(trimmed, stream);
        } catch {
          /* ignore */
        }
      }
    };
    child.stdout?.on("data", (buf: Buffer) => captureOutput(buf, "stdout"));
    child.stderr?.on("data", (buf: Buffer) => captureOutput(buf, "stderr"));
    // Pre-emptively reap the zombie: without an exit listener attached from
    // the moment we spawn, a child that dies while we're in probeReadiness
    // can linger as <defunct> because Node only waitpid()'s when something
    // is listening. This handler is unconditional — waitForChildExit attaches
    // its own once('exit') for supervisor-level signalling.
    child.on("exit", (code, signal) => {
      const summary =
        code !== null
          ? `exit code ${code}`
          : signal !== null
            ? `signal ${signal}`
            : "exit (no code/signal)";
      this.recordOutput(`[exit] n8n child ${summary}`);
    });
    child.on("error", (err: Error) => {
      this.recordOutput(`[error] spawn error: ${err.message}`);
      logger.warn(`[n8n-sidecar] spawn error: ${err.message}`);
    });
  }

  /** Push a line into the bounded recent-output buffer and publish. */
  private recordOutput(line: string): void {
    this.recentOutput.push(line);
    if (this.recentOutput.length > N8nSidecar.RECENT_OUTPUT_CAP) {
      this.recentOutput.splice(
        0,
        this.recentOutput.length - N8nSidecar.RECENT_OUTPUT_CAP,
      );
    }
    this.state = { ...this.state, recentOutput: [...this.recentOutput] };
    // Don't re-emit on every line — that would spam listeners. The buffer
    // is snapshotted on every setState() call and served by getState().
  }

  /**
   * Wait for the current child to exit. Returns early if the child is null.
   * Capped at CHILD_EXIT_WAIT_TIMEOUT_MS — beyond that we assume the child
   * is hung, send SIGKILL, and treat it as exited so the supervisor can
   * make forward progress instead of blocking forever.
   */
  private waitForChildExitWithTimeout(): Promise<void> {
    return new Promise((resolve) => {
      const child = this.child;
      if (!child) {
        resolve();
        return;
      }
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        child.removeListener("exit", onExit);
        this.deps.clearTimer(timer);
        resolve();
      };
      const onExit = () => settle();
      child.once("exit", onExit);
      const timer = this.deps.setTimer(() => {
        if (settled) return;
        logger.warn(
          `[n8n-sidecar] child did not exit within ${CHILD_EXIT_WAIT_TIMEOUT_MS}ms; forcing kill`,
        );
        try {
          child.kill("SIGKILL");
        } catch {
          /* no-op */
        }
        settle();
      }, CHILD_EXIT_WAIT_TIMEOUT_MS);
    });
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.kill("SIGTERM");
      // Hard kill after 5s if it's still alive.
      const timer = setTimeout(() => {
        if (!child.killed) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* no-op */
          }
        }
      }, 5_000);
      timer.unref?.();
    } catch (err) {
      logger.warn(
        `[n8n-sidecar] kill error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Polls GET {host}/rest/login until 200 or 401 (both mean "up"). 503
   * means "still booting". Times out per `readinessTimeoutMs`.
   *
   * Returns true on success, false on timeout.
   */
  private async probeReadiness(host: string): Promise<boolean> {
    const deadline = Date.now() + this.config.readinessTimeoutMs;
    const url = `${host}/rest/login`;

    while (Date.now() < deadline) {
      if (this.stopping) return false;
      // If the child died mid-probe, keep polling is pointless — the port
      // will never open. Fail fast so the supervisor surfaces the error and
      // kicks off the next retry (with captured stderr in recentOutput).
      // Uses `typeof === "number"` rather than `!== null` so this tolerates
      // test fakes whose exitCode is undefined while still running.
      const child = this.child;
      if (child && typeof child.exitCode === "number") {
        throw new Error(
          `n8n child exited with code ${child.exitCode} before readiness probe succeeded`,
        );
      }
      try {
        const res = await this.deps.fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(2_000),
        });
        if (res.status === 200 || res.status === 401) {
          return true;
        }
        // 503 / 502 / 500 → retry
      } catch {
        /* connection refused, retry */
      }
      await this.deps.sleep(this.config.readinessIntervalMs);
    }
    return false;
  }

  /**
   * Resolve an API key for this sidecar.
   *
   * Strategy:
   *   1. If a key is cached on the filesystem at {stateDir}/api-key, try
   *      it first. If /rest/api-keys accepts it, reuse it — this preserves
   *      webhook configs across restarts.
   *   2. Otherwise provision a new key via /rest/me/api-keys and persist
   *      it mode-600 for the next boot.
   *   3. If everything fails, return null. The caller logs a warning but
   *      does not fail readiness.
   */
  private async ensureApiKey(host: string): Promise<string | null> {
    const cached = await this.loadPersistedApiKey();
    if (cached) {
      const valid = await this.validateApiKey(host, cached);
      if (valid) return cached;
      logger.warn("[n8n-sidecar] cached api key rejected; re-provisioning");
    }
    const fresh = await this.provisionApiKey(host);
    if (fresh) {
      await this.persistApiKey(fresh);
    }
    return fresh;
  }

  private apiKeyPath(): string {
    return path.join(this.config.stateDir, "api-key");
  }

  private async loadPersistedApiKey(): Promise<string | null> {
    const raw = await fs.readFile(this.apiKeyPath(), "utf-8").catch(() => null);
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed.length ? trimmed : null;
  }

  private async persistApiKey(key: string): Promise<void> {
    try {
      await fs.mkdir(this.config.stateDir, { recursive: true });
      await fs.writeFile(this.apiKeyPath(), key, { mode: 0o600 });
      // Re-chmod defensively — writeFile's `mode` is ignored on some
      // platforms when the file already exists.
      await fs.chmod(this.apiKeyPath(), 0o600).catch(() => undefined);
    } catch (err) {
      logger.warn(
        `[n8n-sidecar] failed to persist api key: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Validate a cached API key by listing keys through n8n's public API.
   * A 2xx means the key is still live; 401/403 means it was revoked.
   */
  private async validateApiKey(host: string, key: string): Promise<boolean> {
    try {
      const res = await this.deps.fetch(`${host}/rest/api-keys`, {
        method: "GET",
        headers: { "X-N8N-API-KEY": key },
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Provision a personal API key via n8n's internal REST endpoint. With
   * user management disabled, n8n accepts unauthenticated calls to
   * `/rest/me/api-keys`. If the pinned version rejects this flow (newer
   * n8n versions moved to an auth-required flow), we return null and
   * the caller must fall back to the JWT path documented in-file.
   */
  private async provisionApiKey(host: string): Promise<string | null> {
    try {
      const res = await this.deps.fetch(`${host}/rest/me/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "milady-sidecar" }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        // 401/403/404 → endpoint disabled or moved; caller falls back.
        return null;
      }
      const body = (await res.json()) as {
        data?: { rawApiKey?: string; apiKey?: string };
        rawApiKey?: string;
        apiKey?: string;
      };
      return (
        body.data?.rawApiKey ??
        body.data?.apiKey ??
        body.rawApiKey ??
        body.apiKey ??
        null
      );
    } catch {
      return null;
    }
  }

  /** Stop the sidecar. Idempotent. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.cancelRetryResetTimer();
    this.killChild();
    await this.removePidfile();
    this.setState({
      status: "stopped",
      host: null,
      port: null,
      pid: null,
      errorMessage: null,
      retries: 0,
    });
    this.apiKey = null;
  }

  /** Public helper so callers can gate feature activation on running state. */
  isRunning(): boolean {
    return !TERMINAL_STATUSES.has(this.state.status);
  }

  // ── Orphan detection ─────────────────────────────────────────────────────

  private pidfilePath(): string {
    return path.join(this.config.stateDir, "pid");
  }

  private async readPidfile(): Promise<number | null> {
    const raw = await fs.readFile(this.pidfilePath(), "utf-8").catch(() => null);
    if (!raw) return null;
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  private async writePidfile(pid: number | null): Promise<void> {
    if (pid === null) return;
    try {
      await fs.mkdir(this.config.stateDir, { recursive: true });
      await fs.writeFile(this.pidfilePath(), String(pid), { mode: 0o600 });
    } catch (err) {
      logger.warn(
        `[n8n-sidecar] failed to write pidfile: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async removePidfile(): Promise<void> {
    await fs.unlink(this.pidfilePath()).catch(() => undefined);
  }

  /**
   * If the pidfile points at a live n8n process, kill it before spawning.
   * Guards against orphans created by SIGKILL'ing the parent — without this,
   * each cold boot leaks a port and eventually a zombie per start.
   *
   * We do two levels of verification to avoid nuking an unrelated pid that
   * may have been reused by the OS:
   *   1. The pid must be alive.
   *   2. The pid's cmdline must mention "n8n".
   */
  private async reapOrphan(): Promise<void> {
    const pid = await this.readPidfile();
    if (pid === null) return;
    if (!this.deps.isProcessAlive(pid)) {
      await this.removePidfile();
      return;
    }
    const cmd = await this.deps.readProcessCommand(pid);
    if (!cmd || !/n8n/i.test(cmd)) {
      // Pid reused by a different process. Drop the stale pidfile and move on.
      await this.removePidfile();
      return;
    }
    logger.warn(
      `[n8n-sidecar] reaping orphan n8n pid=${pid} before spawn (cmd=${cmd.slice(0, 120)})`,
    );
    this.deps.killPid(pid, "SIGTERM");
    const deadline =
      this.deps.now() + ORPHAN_SIGTERM_GRACE_MS;
    while (this.deps.now() < deadline) {
      if (!this.deps.isProcessAlive(pid)) {
        await this.removePidfile();
        return;
      }
      await this.deps.sleep(250);
    }
    if (this.deps.isProcessAlive(pid)) {
      logger.warn(`[n8n-sidecar] orphan pid=${pid} survived SIGTERM; SIGKILL`);
      this.deps.killPid(pid, "SIGKILL");
    }
    await this.removePidfile();
  }

  // ── Retry-reset timer ────────────────────────────────────────────────────

  private armRetryResetTimer(): void {
    this.cancelRetryResetTimer();
    this.retryResetTimer = this.deps.setTimer(() => {
      this.retryResetTimer = null;
      if (this.state.status === "ready" && this.state.retries !== 0) {
        logger.info(
          "[n8n-sidecar] retry count reset after sustained healthy uptime",
        );
        this.setState({ retries: 0 });
      }
    }, RETRY_RESET_AFTER_MS);
  }

  private cancelRetryResetTimer(): void {
    if (this.retryResetTimer !== null) {
      this.deps.clearTimer(this.retryResetTimer);
      this.retryResetTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton accessor
// ---------------------------------------------------------------------------
//
// develop uses lazy module-level singletons for sidecars (see
// platforms/electrobun/src/native/steward.ts:getStewardSidecar). We mirror
// that pattern here so API routes can read the sidecar without having to
// thread it through CompatRuntimeState.

let _singleton: N8nSidecar | null = null;
/**
 * Tracks an in-flight disposal so concurrent getN8nSidecarAsync() callers
 * don't race and construct a second sidecar while the old one is still
 * tearing down. Cleared once dispose resolves.
 */
let _disposing: Promise<void> | null = null;

/**
 * Returns the process-wide n8n sidecar singleton, constructing it lazily
 * on first access.
 *
 * If the singleton already exists, the provided config is merged via
 * `updateConfig()` — changes that require a respawn (binary/host/port/
 * stateDir/version) log a warning and do NOT take effect until an explicit
 * stop()+start() cycle. Non-respawn fields (timeouts, callbacks, retries)
 * apply immediately.
 *
 * NOTE: This accessor is synchronous for backwards compatibility with
 * existing callers. If a disposal is currently in flight, you may get a
 * sidecar that races with the old one. Prefer `getN8nSidecarAsync()` in
 * new code.
 */
export function getN8nSidecar(config: N8nSidecarConfig = {}): N8nSidecar {
  if (_disposing !== null) {
    logger.warn(
      "[n8n-sidecar] getN8nSidecar() called during disposal; prefer getN8nSidecarAsync()",
    );
  }
  if (!_singleton) {
    _singleton = new N8nSidecar(config);
    return _singleton;
  }
  _singleton.updateConfig(config);
  return _singleton;
}

/**
 * Async-safe variant of getN8nSidecar(). Awaits any in-flight disposal
 * before constructing or returning the singleton. Use this from code that
 * can be async (most callers already are).
 */
export async function getN8nSidecarAsync(
  config: N8nSidecarConfig = {},
): Promise<N8nSidecar> {
  if (_disposing !== null) {
    await _disposing;
  }
  return getN8nSidecar(config);
}

/**
 * Returns the singleton if one has already been constructed. Used by
 * routes that should only surface state if the sidecar was explicitly
 * initialized (avoids side-effectful construction on a read).
 */
export function peekN8nSidecar(): N8nSidecar | null {
  return _singleton;
}

/**
 * Stops and clears the singleton. Tests + shutdown paths use this.
 *
 * Concurrency contract: concurrent callers all await the same in-flight
 * stop() before `_singleton` is cleared. Once disposal resolves, the
 * singleton slot is free and a new sidecar can be constructed.
 */
export async function disposeN8nSidecar(): Promise<void> {
  if (_disposing !== null) {
    await _disposing;
    return;
  }
  const existing = _singleton;
  if (!existing) return;
  _disposing = (async () => {
    try {
      await existing.stop();
    } finally {
      _singleton = null;
      _disposing = null;
    }
  })();
  await _disposing;
}
