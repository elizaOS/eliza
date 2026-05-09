/**
 * n8n local sidecar: lifecycle + readiness + API-key provisioning.
 *
 * Fallback for the @elizaos/plugin-workflow plugin when the user has
 * no Eliza Cloud session. Spawns `bunx n8n@<pinned>` (no package.json
 * dependency on n8n — that tree is ~300MB), polls `/rest/login` until
 * the instance is reachable, then provisions a personal API key via
 * `/rest/me/api-keys` so the plugin has `WORKFLOW_HOST` + `WORKFLOW_API_KEY` to
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
   * so the UI / `/api/workflow/status` can show the real n8n boot output when
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
  /**
   * Binary used to run n8n. Default "npx".
   *
   * Why not "bunx"? bunx invokes n8n through Bun's runtime / shim, which
   * fails two different ways depending on the n8n version:
   *   1. n8n@1.70.x: bunx resolves `node` via $PATH before reading the
   *      package's `engines` field. On macOS with Homebrew that's v24,
   *      which 1.70 rejects ("Node.js version 24.5.0 is currently not
   *      supported").
   *   2. n8n@1.108.x: bunx runs n8n under Bun's runtime which does not
   *      fully implement the `reflect-metadata` + TSyringe decorator
   *      pattern n8n relies on for DI, failing at bootstrap with
   *      "[DI] ErrorReporter is not decorated with Service".
   * `npx --yes` uses npm's cache and execs n8n under the expected Node
   * runtime, which works across every n8n + Node combo we care about.
   */
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

// n8n version selection — this range is narrower than it looks.
//
//   1.70.x  declares `engines.node: ">=18.17 <= 22"` — rejects Node 23/24
//           (which is what Homebrew ships). Fails at boot with
//           "Node.js version 24.5.0 is currently not supported".
//   1.99.0  widens to ">=20.19 <= 24.x" and boots cleanly under Node 24 ✓
//   1.100.0 same engines range, boots cleanly ✓
//   1.108.0 has a DI-container bootstrap regression — throws
//           "[DI] GlobalConfig is not decorated with Service" under every
//           launcher (npx, npm install + node, bunx). Confirmed broken on
//           both Node 22 and Node 24. See upstream n8n issue.
//
// 1.100.0 is the last version I verified end-to-end against Node 24 +
// npx --yes on 2026-04-19. Bump only with a re-run of the smoke test in
// docs/apps/n8n-sidecar.md. Validate `engines.node` via
// `npm view n8n@<v> engines`.
const DEFAULT_N8N_VERSION = "1.100.0";
const DEFAULT_START_PORT = 5678;
const DEFAULT_HOST = "127.0.0.1";
// Spawn n8n via `npx --yes n8n@<pinned>`. See `binary?` docs for why bunx
// is broken (Node-version mismatch + Bun runtime breaks tsyringe decorators).
const DEFAULT_BINARY = "npx";
// First-run `npx n8n@<pinned>` downloads ~300MB of n8n + nodes into the
// npm cache before boot. On a typical home connection that's 60–120s of
// download plus 15–30s of n8n boot. Keep 180s so the first-run path
// reliably lands inside the probe window on every desktop platform.
// Warm starts hit the npm cache and finish well under this budget.
const DEFAULT_PROBE_TIMEOUT_MS = 180_000;
const DEFAULT_PROBE_INTERVAL_MS = 750;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 2_000;
/** Uptime after which a ready sidecar is considered healthy and retries reset. */
const RETRY_RESET_AFTER_MS = 5 * 60 * 1_000;
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
    const ipv4Free = await canBindTcpPortDefault(candidate, "127.0.0.1");
    const ipv6Free = await canBindTcpPortDefault(candidate, "::");
    if (ipv4Free && ipv6Free) return candidate;
  }
  throw new Error(`no free port available starting from ${start}`);
}

function canBindTcpPortDefault(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (free: boolean) => {
      if (settled) return;
      settled = true;
      resolve(free);
    };
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (
        host === "::" &&
        (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT")
      ) {
        finish(true);
        return;
      }
      finish(false);
    });
    server.once("listening", () => {
      server.close(() => finish(true));
    });
    server.listen({ port, host });
  });
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

/**
 * Match diagnostics that mean "n8n binary is not installed/resolvable" rather
 * than a real runtime fault. Users without n8n installed shouldn't see warn-
 * level spam every supervisor retry — those lines belong at debug.
 *
 * Patterns are intentionally narrow so generic "X not found" messages from a
 * running n8n instance keep their warn level.
 */
const BINARY_MISSING_PATTERNS = [
  /^sh:\s*\d+:\s*\S+:\s*not found$/i, // sh: 1: n8n: not found
  /:\s*command not found$/i, // bash/zsh "command not found"
  /\bnot found on PATH\b/i, // preflightBinary error string
  /\bexited with code 127\b/i, // npx/sh exit code for "command not found"
];
export function isBinaryMissingMessage(message: string): boolean {
  return BINARY_MISSING_PATTERNS.some((re) => re.test(message));
}

/**
 * Extract the n8n-auth cookie from a `Response` for re-use on subsequent
 * calls. Returns a ready-to-send `Cookie:` header value, or null if the
 * response didn't set one. Tolerates fetch implementations that expose
 * multiple Set-Cookie values through `getSetCookie()` (Node 20.18+) or
 * a single joined `set-cookie` header (older runtimes and the test fetch
 * mock we use in unit tests).
 */
function extractAuthCookie(res: Response): string | null {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const list =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") ?? "")
          .split(/,(?=\s*[\w-]+=)/)
          .filter((s) => s.length > 0);
  for (const raw of list) {
    const first = raw.split(";")[0]?.trim();
    if (first?.startsWith("n8n-auth=")) return first;
  }
  return null;
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
  // 40 was too small — n8n's migration output alone is ~60 stdout lines on a
  // cold boot, which evicts every preceding error/log from the buffer before
  // the UI can read it. Sized to comfortably hold migrations + the api-key
  // provisioning trace + a reasonable error tail.
  private static readonly RECENT_OUTPUT_CAP = 200;
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

    // Resolve when the supervisor first transitions to a terminal steady
    // state ("ready" or "error") — not when the supervisor loop itself
    // exits. The loop keeps running for the full lifetime of the child,
    // so awaiting it here would block callers forever on a healthy sidecar.
    // The supervisor continues to run in the background after this resolves;
    // stop() is the canonical way to terminate it.
    const supervisorPromise = this.runSupervisor();
    // Watch for an unexpected supervisor exit. The inner loop already
    // handles known crash paths and parks state in "error"; this handler
    // exists for the case where the supervisor itself throws or returns
    // without reaching a terminal status (which would otherwise leave
    // consumers like AutomationsView wedged on "starting" forever with no
    // signal). When that happens, log and pin status=error so the UI's
    // existing error branches (WorkflowRuntimeNotice, resolveProxyTarget)
    // can surface the failure.
    supervisorPromise.then(
      () => {
        if (
          !this.stopping &&
          this.state.status !== "ready" &&
          this.state.status !== "error"
        ) {
          logger.error(
            `[n8n-sidecar] supervisor exited without reaching a terminal status: state=${this.state.status}`,
          );
          this.setState({
            status: "error",
            errorMessage:
              this.state.errorMessage ?? "supervisor exited unexpectedly",
            pid: null,
          });
        }
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[n8n-sidecar] supervisor exited: ${message}`);
        if (!this.stopping) {
          this.setState({
            status: "error",
            errorMessage: message,
            pid: null,
          });
        }
      },
    );
    await new Promise<void>((resolve) => {
      if (this.state.status === "ready" || this.state.status === "error") {
        resolve();
        return;
      }
      const unsubscribe = this.subscribe((state) => {
        if (state.status === "ready" || state.status === "error") {
          unsubscribe();
          resolve();
        }
      });
    });
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
          try {
            mkdirSync(this.config.stateDir, { recursive: true });
          } catch (err) {
            logger.warn(
              `[n8n-sidecar] mkdir state dir failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          const port = await this.deps.pickPort(this.config.startPort);
          const preferredHost = `http://${this.config.host}:${this.config.startPort}`;
          if (
            port !== this.config.startPort &&
            (await this.attachExistingInstance(
              preferredHost,
              this.config.startPort,
            ))
          ) {
            return;
          }

          const host = `http://${this.config.host}:${port}`;
          this.setState({ host, port });

          await this.deps.preflightBinary(this.config.binary);

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
              logger.info(`[n8n-sidecar] using api key ${fingerprint(key)}`);
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
          await this.clearNpmCacheAfterJsonParseFailure();
          if (isBinaryMissingMessage(msg)) {
            logger.debug(`[n8n-sidecar] start attempt failed: ${msg}`);
          } else {
            logger.warn(`[n8n-sidecar] start attempt failed: ${msg}`);
          }
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
    // data is needed. Using `npx n8n@<pinned>` pulls from the shared npm
    // cache and runs under the native Node runtime, which n8n's DI stack
    // depends on (bunx breaks both the Node version check for 1.70 and the
    // tsyringe decorator handling for 1.100+ — see `binary?` docs above).
    const npmCacheDir = path.join(this.config.stateDir, ".npm-cache");
    mkdirSync(npmCacheDir, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Force NODE_ENV=production for the child.
      //
      // Reason: when the parent process has NODE_ENV=test (vitest sets this
      // by default, and CI pipelines set it for similar reasons), `npx`
      // spawned under Bun silently exits with code 1 before producing any
      // stdout/stderr. Setting NODE_ENV=test also causes `npm install` to
      // skip devDependencies, which can leave n8n's dep graph incomplete
      // when npx runs it through the npm cache. Overriding to `production`
      // gives the child the environment n8n was actually tested against
      // and unblocks the sidecar inside vitest's live-e2e suite. The parent
      // process's NODE_ENV is untouched — this only shapes the child env.
      NODE_ENV: "production",
      N8N_PORT: String(port),
      WORKFLOW_HOST: this.config.host,
      N8N_PROTOCOL: "http",
      N8N_USER_MANAGEMENT_DISABLED: "true",
      N8N_DIAGNOSTICS_ENABLED: "false",
      N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
      N8N_PERSONALIZATION_ENABLED: "false",
      N8N_HIRING_BANNER_ENABLED: "false",
      N8N_USER_FOLDER: this.config.stateDir,
      NPM_CONFIG_CACHE: npmCacheDir,
      npm_config_cache: npmCacheDir,
      DB_TYPE: "sqlite",
      DB_SQLITE_DATABASE: path.join(this.config.stateDir, "database.sqlite"),
      // Opt out of the Enterprise-Edition modules. n8n's module-registry
      // tries to `require()` an `.ee` variant of each enabled module at
      // boot; both `insights.ee` and `external-secrets.ee` only ship with
      // the EE build and are missing from the public npm/bunx install, so
      // the child crashes with "Failed to load module 'insights'" before
      // the HTTP server even binds. Disabling both here means the sidecar
      // boots cleanly on the OSS build.
      N8N_DISABLED_MODULES: "insights,external-secrets",
    };

    const versioned = `n8n@${this.config.version}`;
    // Arg style depends on the launcher:
    //   npx:  --yes <pkg> <args...>   (auto-confirm install prompt)
    //   bunx: -- <pkg> <args...>       (still supported for manual overrides)
    // Anything else is passed through as <pkg> <args...>.
    const binaryBase =
      this.config.binary.split("/").pop() ?? this.config.binary;
    const launcherArgs =
      binaryBase === "npx"
        ? ["--yes", versioned, "start"]
        : binaryBase === "bunx"
          ? ["--", versioned, "start"]
          : [versioned, "start"];
    this.recordOutput(
      `[spawn] ${this.config.binary} ${launcherArgs.join(" ")} (port ${port}, stateDir ${this.config.stateDir}, npmCache ${npmCacheDir}, NODE_ENV=${env.NODE_ENV ?? "(unset)"}, PATH len=${(env.PATH ?? "").length})`,
    );
    const child = this.deps.spawn(this.config.binary, launcherArgs, {
      cwd: this.config.stateDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

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
        // "binary not found" lines are user-config noise, not runtime faults,
        // so they go to debug.
        if (stream === "stderr") {
          if (isBinaryMissingMessage(trimmed)) {
            logger.debug(`[n8n-sidecar:stderr] ${trimmed}`);
          } else {
            logger.warn(`[n8n-sidecar:stderr] ${trimmed}`);
          }
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
    //
    // Use `close` instead of `exit` so the final chunks from stdout/stderr
    // are flushed into recentOutput before we log the exit summary. Node
    // emits `exit` as soon as the process terminates but `close` only fires
    // after all stdio streams have drained — which is the ordering we want
    // so the supervisor / UI see the *reason* for the exit, not just the
    // bare exit code line.
    child.on("close", (code, signal) => {
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

  private async clearNpmCacheAfterJsonParseFailure(): Promise<void> {
    const sawJsonParseFailure = this.recentOutput.some(
      (line) =>
        line.includes("EJSONPARSE") ||
        line.includes("Invalid package.json") ||
        line.includes("JSON.parse"),
    );
    if (!sawJsonParseFailure) return;

    const npmCacheDir = path.join(this.config.stateDir, ".npm-cache");
    try {
      await fs.rm(npmCacheDir, { recursive: true, force: true });
      logger.warn(
        `[n8n-sidecar] cleared npm cache after package.json parse failure: ${npmCacheDir}`,
      );
    } catch (err) {
      logger.warn(
        `[n8n-sidecar] failed to clear npm cache after package.json parse failure: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Block until the current child exits. Returns early if the child is null
   * or if `stop()` has flipped `stopping`. No timeout — n8n is a long-running
   * service, so timing out here would SIGKILL a healthy child and bounce the
   * supervisor into a "child exited unexpectedly" → retry loop that ends in
   * the `max retries exceeded` error state. Shutdown-side timeouts live in
   * `killChild()` (SIGTERM with a 5s SIGKILL fallback).
   */
  private waitForChildExitWithTimeout(): Promise<void> {
    return new Promise((resolve) => {
      const child = this.child;
      if (!child) {
        resolve();
        return;
      }
      if (this.stopping) {
        resolve();
        return;
      }
      const settle = () => {
        child.removeListener("exit", onExit);
        resolve();
      };
      const onExit = () => settle();
      child.once("exit", onExit);
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

  private async attachExistingInstance(
    host: string,
    port: number,
  ): Promise<boolean> {
    const reachable = await this.probeExistingInstance(host);
    if (!reachable) return false;

    this.child = null;
    this.recordOutput(`[attach] existing n8n detected at ${host}; reusing it`);
    logger.info(`[n8n-sidecar] reusing existing n8n at ${host}`);
    this.setState({ host, port, pid: null });

    try {
      const key = await this.ensureApiKey(host);
      if (key) {
        this.apiKey = key;
        logger.info(`[n8n-sidecar] using api key ${fingerprint(key)}`);
      }
    } catch (err) {
      logger.warn(
        `[n8n-sidecar] api key provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.setState({ status: "ready", errorMessage: null });
    this.armRetryResetTimer();
    return true;
  }

  private async probeExistingInstance(host: string): Promise<boolean> {
    try {
      const res = await this.deps.fetch(`${host}/rest/login`, {
        method: "GET",
        signal: AbortSignal.timeout(2_000),
      });
      return res.status === 200 || res.status === 401;
    } catch {
      return false;
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
      // If the child died mid-probe AND left no zombie descendants, keep
      // polling is pointless. We only fail fast on a NON-ZERO exit code —
      // npx itself cleanly handoffs to n8n and its own exit code is 0 in
      // some spawn topologies (bun's child_process.spawn in particular),
      // so a 0 here is not a real failure.
      const child = this.child;
      if (child && typeof child.exitCode === "number" && child.exitCode !== 0) {
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
   * Validate a cached API key by calling the public REST API that accepts
   * the X-N8N-API-KEY header. A 2xx means the key is still live; 401/403
   * means it was revoked.
   *
   * Important: /rest/api-keys is the internal endpoint that requires the
   * JWT cookie and will always 401 for an X-N8N-API-KEY regardless of
   * whether the key itself is valid. Using /api/v1/workflows instead —
   * the same endpoint the proxy hits, so "valid for probe" = "valid for
   * real traffic".
   */
  private async validateApiKey(host: string, key: string): Promise<boolean> {
    try {
      const res = await this.deps.fetch(`${host}/api/v1/workflows?limit=1`, {
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
   * Provision an API key by driving n8n's owner-setup → login → api-key flow.
   *
   * n8n ≥ 1.90-ish removed the anonymous `/rest/me/api-keys` endpoint. The
   * supported path now requires:
   *   1. POST /rest/owner/setup   { email, firstName, lastName, password }
   *      – returns `Set-Cookie: n8n-auth=<JWT>` when no owner exists yet.
   *   2. POST /rest/login         { emailOrLdapLoginId, password }
   *      – returns the same cookie on restarts, once the owner is set.
   *   3. GET  /rest/api-keys/scopes
   *      – enumerates the scopes the current role is allowed to grant.
   *   4. POST /rest/api-keys      { label, scopes, expiresAt: null }
   *      – returns `data.rawApiKey` which stays valid across restarts until
   *        explicitly revoked.
   *
   * Credentials are persisted to `{stateDir}/owner.json` (mode-600) so the
   * same login works on every subsequent boot; we never re-generate. Password
   * is random per install — there's no user-facing n8n UI flow in Eliza, so
   * storing it here is safe for a local single-user sidecar.
   */
  private async provisionApiKey(host: string): Promise<string | null> {
    const log = (msg: string) => {
      // Route through both the central logger and the sidecar's recentOutput
      // ring so operators can see the failure in /api/workflow/status even if the
      // dev-server log rotates or gets lost. The strings never contain the
      // raw API key (that's fingerprinted at the ensureApiKey callsite).
      logger.warn(`[n8n-sidecar] ${msg}`);
      this.recordOutput(`[provisionApiKey] ${msg}`);
    };
    try {
      const owner = await this.loadOrCreateOwnerCreds();
      const cookie = await this.acquireOwnerCookie(host, owner, log);
      if (!cookie) {
        log("acquireOwnerCookie returned null — cannot create api key");
        return null;
      }

      const scopes = await this.fetchApiKeyScopes(host, cookie);
      if (!scopes || scopes.length === 0) {
        log("/rest/api-keys/scopes returned no scopes");
        return null;
      }

      const label = "eliza-sidecar";
      const createKey = async (): Promise<Response> =>
        this.deps.fetch(`${host}/rest/api-keys`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ label, scopes, expiresAt: null }),
          signal: AbortSignal.timeout(5_000),
        });

      let res = await createKey();
      if (!res.ok) {
        // 500 "There is already an entry with this name" means a prior
        // provisioning run created the label but we lost the rawApiKey
        // (n8n only returns it at creation time). Drop the stale row and
        // re-create so the caller gets a usable key instead of null.
        const bodyText = await res.text().catch(() => "");
        if (
          res.status === 500 &&
          /already\s+an?\s+entry\s+with\s+this\s+name/i.test(bodyText)
        ) {
          log("api-key label already exists in n8n — deleting and re-creating");
          const deleted = await this.deleteApiKeysByLabel(host, cookie, label);
          if (deleted > 0) {
            res = await createKey();
          }
        }
        if (!res.ok) {
          const finalBody = bodyText || (await res.text().catch(() => ""));
          log(
            `api-key create failed: ${res.status} ${res.statusText}${finalBody ? ` — ${finalBody.slice(0, 200)}` : ""}`,
          );
          return null;
        }
      }
      const body = (await res.json()) as {
        data?: { rawApiKey?: string; apiKey?: string };
        rawApiKey?: string;
        apiKey?: string;
      };
      const key =
        body.data?.rawApiKey ??
        body.data?.apiKey ??
        body.rawApiKey ??
        body.apiKey ??
        null;
      if (!key) {
        log("api-key create returned no rawApiKey in body");
      }
      return key;
    } catch (err) {
      log(
        `provisionApiKey threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Load owner credentials from `{stateDir}/owner.json`, or generate a fresh
   * pair and persist them mode-600. The email is deterministic (matches the
   * label we show to the user); the password is a long random token.
   */
  private async loadOrCreateOwnerCreds(): Promise<{
    email: string;
    firstName: string;
    lastName: string;
    password: string;
  }> {
    const ownerPath = path.join(this.config.stateDir, "owner.json");
    try {
      const raw = await fs.readFile(ownerPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        email?: unknown;
        firstName?: unknown;
        lastName?: unknown;
        password?: unknown;
      };
      if (
        typeof parsed.email === "string" &&
        typeof parsed.password === "string" &&
        parsed.email.length > 0 &&
        parsed.password.length > 0
      ) {
        return {
          email: parsed.email,
          firstName:
            typeof parsed.firstName === "string" ? parsed.firstName : "Eliza",
          lastName:
            typeof parsed.lastName === "string" ? parsed.lastName : "Local",
          password: parsed.password,
        };
      }
    } catch {
      /* fall through to generate fresh */
    }

    const password = this.generateRandomPassword();
    const creds = {
      email: "eliza@eliza.local",
      firstName: "Eliza",
      lastName: "Local",
      password,
    };
    try {
      await fs.mkdir(this.config.stateDir, { recursive: true });
      await fs.writeFile(ownerPath, JSON.stringify(creds, null, 2), {
        mode: 0o600,
      });
      await fs.chmod(ownerPath, 0o600).catch(() => undefined);
    } catch (err) {
      logger.warn(
        `[n8n-sidecar] failed to persist owner creds: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return creds;
  }

  /**
   * Returns a `Cookie: n8n-auth=<jwt>` string by either creating the owner
   * (first boot) or logging in (subsequent boots). Returns null if both
   * fail so the caller can back off gracefully.
   */
  private async acquireOwnerCookie(
    host: string,
    owner: {
      email: string;
      firstName: string;
      lastName: string;
      password: string;
    },
    log: (msg: string) => void = () => undefined,
  ): Promise<string | null> {
    // First boot: owner does not exist yet, /rest/owner/setup returns 200.
    // Subsequent boots: returns 400 "instance owner already setup"; we fall
    // through to /rest/login.
    const setup = await this.deps
      .fetch(`${host}/rest/owner/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: owner.email,
          firstName: owner.firstName,
          lastName: owner.lastName,
          password: owner.password,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      .catch((err: unknown) => {
        log(
          `owner/setup fetch threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      });
    if (setup?.ok) {
      const cookie = extractAuthCookie(setup);
      if (cookie) return cookie;
      log("owner/setup 200 but no n8n-auth cookie in response");
    } else if (setup) {
      const text = await setup.text().catch(() => "");
      log(
        `owner/setup ${setup.status}${text ? ` — ${text.slice(0, 160)}` : ""}`,
      );
    }

    const login = await this.deps
      .fetch(`${host}/rest/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailOrLdapLoginId: owner.email,
          password: owner.password,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      .catch((err: unknown) => {
        log(
          `login fetch threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      });
    if (login?.ok) {
      const cookie = extractAuthCookie(login);
      if (cookie) return cookie;
      log("login 200 but no n8n-auth cookie in response");
    } else if (login) {
      const text = await login.text().catch(() => "");
      log(`login ${login.status}${text ? ` — ${text.slice(0, 160)}` : ""}`);
    }

    return null;
  }

  /** List scopes the current role may grant when creating an API key. */
  private async fetchApiKeyScopes(
    host: string,
    cookie: string,
  ): Promise<string[] | null> {
    try {
      const res = await this.deps.fetch(`${host}/rest/api-keys/scopes`, {
        method: "GET",
        headers: { cookie },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: string[] };
      return Array.isArray(body.data) ? body.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Delete every api-key row with a matching label. Used to recover from the
   * "already exists" case when a previous provisioning run created the label
   * but lost the `rawApiKey` (n8n only returns the raw key at creation time,
   * so a partially-persisted state wedges the next boot unless we can delete
   * and re-create). Returns the number of rows deleted.
   */
  private async deleteApiKeysByLabel(
    host: string,
    cookie: string,
    label: string,
  ): Promise<number> {
    try {
      const listRes = await this.deps.fetch(`${host}/rest/api-keys`, {
        method: "GET",
        headers: { cookie },
        signal: AbortSignal.timeout(5_000),
      });
      if (!listRes.ok) return 0;
      const body = (await listRes.json()) as {
        data?: Array<{ id?: unknown; label?: unknown }>;
      };
      const matches = (body.data ?? []).filter(
        (row): row is { id: string; label: string } =>
          typeof row.id === "string" &&
          typeof row.label === "string" &&
          row.label === label,
      );
      let deleted = 0;
      for (const row of matches) {
        const delRes = await this.deps.fetch(
          `${host}/rest/api-keys/${encodeURIComponent(row.id)}`,
          {
            method: "DELETE",
            headers: { cookie },
            signal: AbortSignal.timeout(5_000),
          },
        );
        if (delRes.ok) deleted += 1;
      }
      return deleted;
    } catch {
      return 0;
    }
  }

  /** 48 bytes of base64url entropy — ~64 chars, far above n8n's min length. */
  private generateRandomPassword(): string {
    // crypto is Node 20+ global; fallback to Math.random if unavailable is
    // intentionally not provided — insecure passwords are worse than a crash.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require("node:crypto") as typeof import("node:crypto");
    return nodeCrypto.randomBytes(48).toString("base64url");
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
    const raw = await fs
      .readFile(this.pidfilePath(), "utf-8")
      .catch(() => null);
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
    const deadline = this.deps.now() + ORPHAN_SIGTERM_GRACE_MS;
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
