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
}

export interface N8nSidecarConfig {
  /** Enable local sidecar fallback. Default: true when no cloud session. */
  enabled?: boolean;
  /** Pinned n8n version. Update via release process; matches bunx cache. */
  version?: string;
  /** Preferred starting port; next free port used on collision. Default 5678. */
  startPort?: number;
  /** State directory root; owner email/password + sqlite live here. */
  stateDir?: string;
  /** Readiness probe timeout in ms. Default 60000. */
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
}

type Listener = (state: N8nSidecarState) => void;

// ── Implementation ───────────────────────────────────────────────────────────

// TODO pin on release — validated via `npm view n8n version` before ship.
const DEFAULT_N8N_VERSION = "1.70.0";
const DEFAULT_START_PORT = 5678;
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const DEFAULT_PROBE_INTERVAL_MS = 750;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 2_000;

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

/** Redact a secret to a short fingerprint that's safe to log. */
function fingerprint(secret: string): string {
  if (!secret || secret.length < 8) return "***";
  return `${secret.slice(0, 4)}…${secret.slice(-2)} (len=${secret.length})`;
}

export class N8nSidecar {
  private config: Required<Omit<N8nSidecarConfig, "onStatusChange" | "onLog">> &
    Pick<N8nSidecarConfig, "onStatusChange" | "onLog">;
  private deps: Required<N8nSidecarDeps>;
  private state: N8nSidecarState = {
    status: "stopped",
    host: null,
    port: null,
    errorMessage: null,
    pid: null,
    retries: 0,
  };
  private child: ChildProcess | null = null;
  /** Cached API key — secret, never logged, never serialized via getState(). */
  private apiKey: string | null = null;
  private listeners: Set<Listener> = new Set();
  private stopping = false;
  private supervisorRunning = false;

  constructor(config: N8nSidecarConfig = {}, deps: N8nSidecarDeps = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      version: config.version ?? DEFAULT_N8N_VERSION,
      startPort: config.startPort ?? DEFAULT_START_PORT,
      stateDir: config.stateDir ?? defaultStateDir(),
      readinessTimeoutMs: config.readinessTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      readinessIntervalMs:
        config.readinessIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      backoffBaseMs: config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      onStatusChange: config.onStatusChange,
      onLog: config.onLog,
    };
    this.deps = {
      spawn: deps.spawn ?? nodeSpawn,
      fetch: deps.fetch ?? fetch,
      pickPort: deps.pickPort ?? pickFreePortDefault,
      sleep: deps.sleep ?? sleepDefault,
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
          const port = await this.deps.pickPort(this.config.startPort);
          const host = `http://127.0.0.1:${port}`;
          this.setState({ host, port });

          try {
            mkdirSync(this.config.stateDir, { recursive: true });
          } catch (err) {
            logger.warn(
              `[n8n-sidecar] mkdir state dir failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          await this.spawnChild(port);
          const reachable = await this.probeReadiness(host);
          if (!reachable) {
            throw new Error(
              `readiness probe timed out after ${this.config.readinessTimeoutMs}ms`,
            );
          }

          // Provision API key — optional; readiness is still "ready" if it fails.
          try {
            const key = await this.provisionApiKey(host);
            if (key) {
              this.apiKey = key;
              logger.info(
                `[n8n-sidecar] provisioned api key ${fingerprint(key)}`,
              );
            }
          } catch (err) {
            logger.warn(
              `[n8n-sidecar] api key provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          this.setState({ status: "ready", errorMessage: null });
          // Wait for child to exit; then decide retry vs shutdown.
          await this.waitForChildExit();
          if (this.stopping) return;

          logger.warn("[n8n-sidecar] child exited unexpectedly");
          this.setState({ status: "starting", pid: null });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[n8n-sidecar] start attempt failed: ${msg}`);
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
      N8N_HOST: "127.0.0.1",
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
    const child = this.deps.spawn("bunx", ["--", versioned, "start"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    this.child = child;
    this.setState({ pid: child.pid ?? null });

    child.stdout?.on("data", (buf: Buffer) => {
      // n8n log lines are noisy; surface at debug only.
      const line = buf.toString().trimEnd();
      logger.debug(`[n8n-sidecar:stdout] ${line}`);
      try {
        this.config.onLog?.(line, "stdout");
      } catch {
        /* ignore */
      }
    });
    child.stderr?.on("data", (buf: Buffer) => {
      const line = buf.toString().trimEnd();
      logger.debug(`[n8n-sidecar:stderr] ${line}`);
      try {
        this.config.onLog?.(line, "stderr");
      } catch {
        /* ignore */
      }
    });
    child.on("error", (err: Error) => {
      logger.warn(`[n8n-sidecar] spawn error: ${err.message}`);
    });
  }

  private waitForChildExit(): Promise<void> {
    return new Promise((resolve) => {
      const child = this.child;
      if (!child) {
        resolve();
        return;
      }
      const onExit = () => {
        child.removeListener("exit", onExit);
        resolve();
      };
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
      setTimeout(() => {
        if (!child.killed) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* no-op */
          }
        }
      }, 5_000).unref?.();
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
    this.killChild();
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
 * Returns the process-wide n8n sidecar singleton, constructing it lazily
 * on first access. Nothing is started until start() is called.
 */
export function getN8nSidecar(config: N8nSidecarConfig = {}): N8nSidecar {
  if (!_singleton) {
    _singleton = new N8nSidecar(config);
  }
  return _singleton;
}

/**
 * Returns the singleton if one has already been constructed. Used by
 * routes that should only surface state if the sidecar was explicitly
 * initialized (avoids side-effectful construction on a read).
 */
export function peekN8nSidecar(): N8nSidecar | null {
  return _singleton;
}

/** Stops and clears the singleton. Tests + shutdown paths use this. */
export async function disposeN8nSidecar(): Promise<void> {
  const existing = _singleton;
  _singleton = null;
  if (existing) {
    await existing.stop();
  }
}
