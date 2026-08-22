/**
 * Steward Sidecar - manages Steward API as a child process for embedded wallet functionality.
 *
 * Responsibilities:
 *   - Start Steward API as a child process on a local port (default 3200)
 *   - Health check polling until Steward is ready
 *   - Auto-restart on crash (exponential backoff)
 *   - Clean shutdown on app exit
 *   - First-launch wallet creation (tenant + agent + wallet)
 *   - Subsequent launches: verify existing wallet loads
 *
 * The sidecar runs Steward in embedded mode with a local Postgres-compatible
 * database (PGLite when available, or standard Postgres via DATABASE_URL).
 *
 * Usage:
 *   const sidecar = new StewardSidecar({ dataDir: '~/.local/state/eliza/steward/' });
 *   await sidecar.start();  // starts process + first-launch setup
 *   const client = sidecar.getClient();
 *   await sidecar.stop();
 */

// Node builtins are imported statically: this file only runs in the bun
// process (StewardSidecar manages a child Steward API process), never in
// the renderer. Other steward modules (api/wallet, services/steward-*)
// already use static node:* imports - keeping this file dynamic just
// triggered the Vite "dynamically imported but also statically imported"
// warning without preventing browser-bundling.
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import { readAliasedEnv } from "@elizaos/shared";
import { waitForHealthy } from "./steward-sidecar/health-check";
import {
  allocateFirstFreeLoopbackPort,
  generateMasterPassword,
  resolveDataDir,
} from "./steward-sidecar/helpers";
import {
  findStewardEntryPoint,
  pipeOutput,
} from "./steward-sidecar/process-management";
import {
  CREDENTIALS_FILE,
  DEFAULT_MAX_RESTARTS,
  DEFAULT_PORT,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  type StewardCredentials,
  type StewardSidecarConfig,
  type StewardSidecarStatus,
} from "./steward-sidecar/types";
import { ensureWalletSetup } from "./steward-sidecar/wallet-setup";

// Re-export helpers for external Steward integrations.
export {
  allocateFirstFreeLoopbackPort,
  fingerprintRandomToken,
  generateApiKey,
  generateMasterPassword,
  resolveDataDir,
} from "./steward-sidecar/helpers";
// Re-export types for external consumers
export type {
  StewardCredentials,
  StewardSidecarConfig,
  StewardSidecarStatus,
  StewardWalletInfo,
} from "./steward-sidecar/types";

interface BunSubprocessLike {
  kill: (signal?: string) => void;
  pid?: number | null;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
}

interface BunRuntimeLike {
  spawn: (
    cmd: string[],
    options: {
      env: Record<string, string>;
      cwd: string;
      stdout: "pipe";
      stderr: "pipe";
    },
  ) => BunSubprocessLike;
}

function getBunRuntime(): BunRuntimeLike | null {
  return (globalThis as { Bun?: BunRuntimeLike }).Bun ?? null;
}

/**
 * Each signal gets its own grace period: SIGTERM may take 5s, then SIGKILL may
 * take another 5s. Stop/reset stay blocked for at most 10s while the sidecar
 * proves the child released its port and wallet database.
 */
const PROCESS_TERMINATION_GRACE_MS = 5_000;

/** The spawned steward child, normalized across the Bun and Node spawn paths. */
type StewardProcessHandle = {
  kill: (signal?: string) => unknown;
  pid?: number | null;
  exitCode?: number | null;
  exited: Promise<number>;
};

type ProcessExitWaitResult =
  | { exited: true }
  | { exited: false; error?: unknown };

// ---------------------------------------------------------------------------
// StewardSidecar
// ---------------------------------------------------------------------------

export class StewardSidecar {
  private config: Required<
    Pick<StewardSidecarConfig, "dataDir" | "port" | "maxRestarts">
  > &
    StewardSidecarConfig;
  private status: StewardSidecarStatus;
  private process: StewardProcessHandle | null = null;
  /**
   * Handles this class killed on purpose because their lifecycle failed after
   * the spawn. Their exit is expected, so it must not be read as a crash and
   * must not start the restart backoff.
   */
  private discardedProcesses = new WeakSet<StewardProcessHandle>();
  /** One termination sequence owns a handle even when stop races failed start. */
  private terminationPromises = new WeakMap<
    StewardProcessHandle,
    Promise<void>
  >();
  private stopping = false;
  private lifecycleGeneration = 0;
  private startPromise: Promise<StewardSidecarStatus> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private credentials: StewardCredentials | null = null;
  private healthCheckAbort: AbortController | null = null;

  constructor(config: StewardSidecarConfig) {
    this.config = {
      port: DEFAULT_PORT,
      maxRestarts: DEFAULT_MAX_RESTARTS,
      ...config,
      dataDir: resolveDataDir(config.dataDir),
    };

    this.status = {
      state: "stopped",
      port: null,
      pid: null,
      error: null,
      restartCount: 0,
      walletAddress: null,
      agentId: null,
      tenantId: null,
      startedAt: null,
    };
  }

  // Public API.

  /**
   * Start the Steward sidecar process and wait until it's healthy.
   * On first launch, creates tenant + agent + wallet.
   * On subsequent launches, verifies existing wallet.
   */
  async start(): Promise<StewardSidecarStatus> {
    if (this.status.state === "running") {
      return this.status;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.process) {
      const error = new ElizaError(
        "Cannot start Steward while the previous child has not confirmed exit",
        {
          code: "STEWARD_CHILD_EXIT_UNCONFIRMED",
          context: { pid: this.process.pid ?? null },
          severity: "fatal",
        },
      );
      this.updateStatus({ state: "error", error: error.message });
      throw error;
    }

    const generation = ++this.lifecycleGeneration;
    const startPromise = this.startLifecycle(generation);
    this.startPromise = startPromise;

    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = null;
      }
    }
  }

  private async startLifecycle(
    generation: number,
  ): Promise<StewardSidecarStatus> {
    this.stopping = false;
    this.updateStatus({ state: "starting", error: null });

    let spawned: StewardProcessHandle | null = null;

    try {
      await this.ensureDataDir();
      await this.loadOrCreateCredentials();
      if (!(await this.spawnProcess(generation))) {
        return this.status;
      }
      spawned = this.process;

      const abort = new AbortController();
      this.healthCheckAbort = abort;
      await waitForHealthy(this.getApiBase(), abort);
      if (this.healthCheckAbort === abort) {
        this.healthCheckAbort = null;
      }
      if (!this.isLifecycleActive(generation)) {
        return this.status;
      }

      const credentials = await ensureWalletSetup(
        this.credentials,
        this.getApiBase(),
        this.config.masterPassword,
        this.config.dataDir,
        (p) => {
          if (this.isLifecycleActive(generation)) {
            this.updateStatus(p);
          }
        },
      );
      if (!this.isLifecycleActive(generation)) {
        return this.status;
      }
      this.credentials = credentials;

      this.updateStatus({
        state: "running",
        port: this.config.port,
        startedAt: Date.now(),
      });

      return this.status;
    } catch (err) {
      let cleanupError: unknown = null;
      try {
        await this.discardSpawnedProcess(spawned, "failed start");
      } catch (error) {
        // error-policy:J2 the startup boundary below preserves both the
        // lifecycle failure and the child-cleanup failure in one typed cause.
        cleanupError = error;
      }
      if (!this.isLifecycleActive(generation)) {
        if (cleanupError) {
          // error-policy:J6 stop/supersession owns the visible lifecycle state,
          // but a concurrent cleanup failure must still be observable.
          logger.warn(
            { error: cleanupError, generation },
            "[StewardSidecar] Spawned-child cleanup failed after the start lifecycle was superseded",
          );
        }
        return this.status;
      }
      if (cleanupError) {
        const error = new ElizaError(
          "Steward startup failed and spawned-child cleanup did not complete",
          {
            code: "STEWARD_START_CLEANUP_FAILED",
            cause: new AggregateError([err, cleanupError]),
            context: { generation, pid: spawned?.pid ?? null },
            severity: "fatal",
          },
        );
        this.updateStatus({ state: "error", error: error.message });
        throw error;
      }
      const error = err instanceof Error ? err.message : String(err);
      this.updateStatus({ state: "error", error, pid: null });
      throw err;
    }
  }

  /** Stop the Steward sidecar process gracefully. */
  async stop(): Promise<void> {
    this.stopping = true;
    const generation = ++this.lifecycleGeneration;
    this.startPromise = null;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.healthCheckAbort) {
      this.healthCheckAbort.abort();
      this.healthCheckAbort = null;
    }

    const processToStop = this.process;
    if (processToStop) {
      try {
        await this.terminateProcess(processToStop, "explicit stop");
      } catch (error) {
        // error-policy:J1 the public lifecycle boundary reports an explicit
        // failed stop and retains the unconfirmed child for a later retry.
        const message = error instanceof Error ? error.message : String(error);
        this.updateStatus({ state: "error", error: message });
        throw error;
      }
      if (this.process === processToStop) {
        this.process = null;
      }
    }

    if (this.lifecycleGeneration === generation) {
      this.updateStatus({
        state: "stopped",
        port: null,
        pid: null,
        startedAt: null,
      });
    }
  }

  /** Restart the sidecar (stop + start). */
  async restart(): Promise<StewardSidecarStatus> {
    await this.stop();
    this.status.restartCount = 0;
    return this.start();
  }

  /** Get current sidecar status. */
  getStatus(): StewardSidecarStatus {
    return { ...this.status };
  }

  /** Get the API base URL for Steward. */
  getApiBase(): string {
    return `http://127.0.0.1:${this.config.port}`;
  }

  /** Get stored wallet credentials (null if not initialized). */
  getCredentials(): StewardCredentials | null {
    return this.credentials ? { ...this.credentials } : null;
  }

  /** Get tenant API key for making authenticated requests. */
  getTenantApiKey(): string | null {
    return this.credentials?.tenantApiKey ?? null;
  }

  /** Get agent token for making agent-scoped requests. */
  getAgentToken(): string | null {
    return this.credentials?.agentToken ?? null;
  }

  // Internal.

  private async ensureDataDir(): Promise<void> {
    const dir = this.config.dataDir;
    const home = process.env.HOME || process.env.USERPROFILE || "";

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    for (const sub of ["data", "logs"]) {
      const subDir = path.join(dir, sub);
      if (!fs.existsSync(subDir)) {
        fs.mkdirSync(subDir, { recursive: true });
      }
    }

    // Steward's embedded runtime historically defaulted to ~/.steward/data.
    // Migrate that legacy PGLite directory into Eliza's state dir when the
    // new target is still empty so upgrades keep the same wallet/agent data.
    const legacyDataDir = path.join(home, ".steward", "data");
    const targetDataDir = path.join(dir, "data");
    const targetHasData =
      fs.existsSync(path.join(targetDataDir, "PG_VERSION")) ||
      (fs.existsSync(targetDataDir) &&
        fs.readdirSync(targetDataDir).length > 0);

    if (
      legacyDataDir !== targetDataDir &&
      fs.existsSync(legacyDataDir) &&
      !targetHasData
    ) {
      logger.info(
        `[StewardSidecar] Migrating legacy steward data from ${legacyDataDir} to ${targetDataDir}`,
      );
      fs.cpSync(legacyDataDir, targetDataDir, {
        recursive: true,
        force: false,
      });
    }
  }

  private async loadOrCreateCredentials(): Promise<void> {
    const credPath = path.join(this.config.dataDir, CREDENTIALS_FILE);

    if (fs.existsSync(credPath)) {
      try {
        const raw = fs.readFileSync(credPath, "utf-8");
        this.credentials = JSON.parse(raw) as StewardCredentials;

        if (!this.credentials.masterPassword && this.config.masterPassword) {
          this.credentials.masterPassword = this.config.masterPassword;
        }

        this.updateStatus({
          walletAddress: this.credentials.walletAddress,
          agentId: this.credentials.agentId,
          tenantId: this.credentials.tenantId,
        });
        return;
      } catch {
        logger.warn(
          "[StewardSidecar] Failed to parse credentials, will recreate",
        );
      }
    }

    if (!this.config.masterPassword) {
      this.config.masterPassword = generateMasterPassword();
    }
  }

  private async spawnProcess(generation: number): Promise<boolean> {
    const entryPoint =
      this.config.stewardEntryPoint || (await findStewardEntryPoint());

    if (!entryPoint) {
      throw new Error(
        "Steward API entry point not found. Set STEWARD_ENTRY_POINT or install a package that exposes @stwd/api.",
      );
    }

    const preferredPort = this.config.port;
    const allocatedPort = await allocateFirstFreeLoopbackPort(preferredPort);
    if (!this.isLifecycleActive(generation)) {
      return false;
    }
    if (allocatedPort !== preferredPort) {
      logger.warn(
        `[StewardSidecar] Port ${preferredPort} is busy; using ${allocatedPort} instead`,
      );
      this.config.port = allocatedPort;
    }

    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      PORT: String(this.config.port),
      STEWARD_LOCAL: "true",
      STEWARD_BIND_HOST: "127.0.0.1",
      NODE_ENV: "production",
    };

    const masterPw =
      this.credentials?.masterPassword || this.config.masterPassword;
    if (masterPw) {
      env.STEWARD_MASTER_PASSWORD = masterPw;
    }

    if (this.config.databaseUrl) {
      env.DATABASE_URL = this.config.databaseUrl;
    }

    env.STEWARD_DATA_DIR = path.join(this.config.dataDir, "data");
    env.STEWARD_PGLITE_PATH = env.STEWARD_DATA_DIR;
    env.STEWARD_REDIS_DISABLED = "true";

    logger.info(
      `[StewardSidecar] Spawning steward on port ${this.config.port} (entryPoint=${entryPoint}, dataDir=${this.config.dataDir})`,
    );

    const bun = getBunRuntime();
    if (bun) {
      const proc = bun.spawn(["bun", "run", entryPoint], {
        env,
        cwd: path.dirname(entryPoint),
        stdout: "pipe",
        stderr: "pipe",
      });

      this.process = proc;
      this.updateStatus({ pid: proc.pid ?? null });

      pipeOutput(proc.stdout, "stdout", this.config.onLog);
      pipeOutput(proc.stderr, "stderr", this.config.onLog);

      proc.exited.then((code: number) => this.observeProcessExit(proc, code));
    } else {
      const child = childProcess.spawn("node", [entryPoint], {
        env,
        cwd: path.dirname(entryPoint),
        stdio: ["ignore", "pipe", "pipe"],
      });

      const exitPromise = new Promise<number>((resolve) => {
        child.on("exit", (code) => resolve(code ?? 1));
      });

      const handle: StewardProcessHandle = {
        kill: (signal?: string) =>
          child.kill((signal as NodeJS.Signals) ?? "SIGTERM"),
        pid: child.pid ?? null,
        exited: exitPromise,
      };
      this.process = handle;

      this.updateStatus({ pid: child.pid ?? null });

      if (child.stdout) {
        child.stdout.on("data", (chunk: Buffer) => {
          const line = chunk.toString().trimEnd();
          if (line) {
            logger.info(`[Steward] ${line}`);
            this.config.onLog?.(line, "stdout");
          }
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          const line = chunk.toString().trimEnd();
          if (line) {
            logger.warn(`[Steward:err] ${line}`);
            this.config.onLog?.(line, "stderr");
          }
        });
      }

      exitPromise.then((code) => this.observeProcessExit(handle, code));
    }

    return true;
  }

  private async handleCrash(exitCode: number | null): Promise<void> {
    if (this.stopping) return;

    const generation = this.lifecycleGeneration;

    this.status.restartCount += 1;

    if (this.status.restartCount > this.config.maxRestarts) {
      this.updateStatus({
        state: "error",
        error: `Steward crashed ${this.status.restartCount} times (exit code: ${exitCode}). Giving up.`,
        pid: null,
      });
      return;
    }

    const backoff = Math.min(
      INITIAL_BACKOFF_MS * 2 ** (this.status.restartCount - 1),
      MAX_BACKOFF_MS,
    );

    logger.info(
      `[StewardSidecar] Restarting in ${backoff}ms (attempt ${this.status.restartCount}/${this.config.maxRestarts})`,
    );

    this.updateStatus({ state: "restarting", pid: null });

    this.restartTimer = setTimeout(async () => {
      if (!this.isLifecycleActive(generation)) return;

      let spawned: StewardProcessHandle | null = null;

      try {
        if (!(await this.spawnProcess(generation))) {
          return;
        }
        spawned = this.process;

        const abort = new AbortController();
        this.healthCheckAbort = abort;
        await waitForHealthy(this.getApiBase(), abort);
        if (this.healthCheckAbort === abort) {
          this.healthCheckAbort = null;
        }
        if (!this.isLifecycleActive(generation)) {
          return;
        }

        // ensureWalletSetup is intentionally skipped on crash restart:
        // credentials (tenant, agent, wallet) are created on first launch
        // and persisted to disk. They survive process restarts - the wallet
        // and agent identity don't change when steward crashes and recovers.

        this.updateStatus({
          state: "running",
          port: this.config.port,
          error: null,
        });
      } catch (err) {
        let cleanupError: unknown = null;
        try {
          await this.discardSpawnedProcess(spawned, "failed crash restart");
        } catch (error) {
          // error-policy:J1 this background restart boundary publishes both
          // failures as one visible terminal status and structured log.
          cleanupError = error;
        }
        if (!this.isLifecycleActive(generation)) {
          if (cleanupError) {
            // error-policy:J6 stop/supersession owns the visible lifecycle
            // state, but its concurrent cleanup failure remains observable.
            logger.warn(
              { error: cleanupError, generation },
              "[StewardSidecar] Spawned-child cleanup failed after the restart lifecycle was superseded",
            );
          }
          return;
        }
        if (cleanupError) {
          const error = new ElizaError(
            "Steward restart failed and spawned-child cleanup did not complete",
            {
              code: "STEWARD_RESTART_CLEANUP_FAILED",
              cause: new AggregateError([err, cleanupError]),
              context: { generation, pid: spawned?.pid ?? null },
              severity: "fatal",
            },
          );
          logger.error(
            { error },
            "[StewardSidecar] Crash restart cleanup failed",
          );
          this.updateStatus({ state: "error", error: error.message });
          return;
        }
        const error = err instanceof Error ? err.message : String(err);
        this.updateStatus({ state: "error", error, pid: null });
      }
    }, backoff);
  }

  /**
   * Kill a child this lifecycle spawned but never managed to bring up.
   *
   * `spawnProcess` publishes `this.process` as soon as the child exists, which
   * is before `waitForHealthy` and `ensureWalletSetup` run. If either of those
   * fails, the child is still alive — bound to the steward port with the wallet
   * database open — and `stop()` is the only other code path that kills it. The
   * failing lifecycle never calls `stop()`, and `startSteward()` only skips a
   * restart when the state is `"running"`, so a retry after a failed start
   * reaches `spawnProcess` again and overwrites `this.process`. At that point
   * nothing holds a reference to the first child and no code path can ever kill
   * it: it outlives the app, still holding the port and the wallet data.
   *
   * A catch cannot un-allocate a process, so the kill has to happen here. The
   * handle is identity-checked first because a newer generation may already own
   * `this.process`, and it is recorded as discarded so its exit is not read as
   * a crash and does not start the restart backoff.
   */
  private async discardSpawnedProcess(
    spawned: StewardProcessHandle | null,
    reason: string,
  ): Promise<void> {
    if (!spawned || this.process !== spawned) {
      return;
    }
    this.discardedProcesses.add(spawned);
    await this.terminateProcess(spawned, reason);
    if (this.process === spawned) {
      this.process = null;
    }
  }

  private observeProcessExit(
    processHandle: StewardProcessHandle,
    exitCode: number,
  ): void {
    if (this.process !== processHandle) {
      return;
    }
    this.process = null;
    if (!this.stopping && !this.discardedProcesses.has(processHandle)) {
      logger.warn(
        `[StewardSidecar] Process exited unexpectedly (code ${exitCode})`,
      );
      void this.handleCrash(exitCode);
    }
  }

  private async terminateProcess(
    processHandle: StewardProcessHandle,
    reason: string,
  ): Promise<void> {
    const existing = this.terminationPromises.get(processHandle);
    if (existing) {
      return existing;
    }

    const termination = this.terminateProcessOnce(processHandle, reason);
    this.terminationPromises.set(processHandle, termination);
    try {
      await termination;
    } finally {
      if (this.terminationPromises.get(processHandle) === termination) {
        this.terminationPromises.delete(processHandle);
      }
    }
  }

  private async terminateProcessOnce(
    processHandle: StewardProcessHandle,
    reason: string,
  ): Promise<void> {
    const errors: unknown[] = [];
    this.requestTerminationSignal(processHandle, "SIGTERM", reason, errors);

    let exit = await this.waitForProcessExit(processHandle);
    if (exit.exited) {
      return;
    }
    if (exit.error) {
      errors.push(exit.error);
    }
    errors.push(
      new Error(
        `Steward child did not exit within ${PROCESS_TERMINATION_GRACE_MS}ms of SIGTERM`,
      ),
    );

    this.requestTerminationSignal(processHandle, "SIGKILL", reason, errors);
    exit = await this.waitForProcessExit(processHandle);
    if (exit.exited) {
      return;
    }
    if (exit.error) {
      errors.push(exit.error);
    }
    errors.push(
      new Error(
        `Steward child did not exit within ${PROCESS_TERMINATION_GRACE_MS}ms of SIGKILL`,
      ),
    );

    throw new ElizaError(
      "Steward child failed to confirm exit after SIGTERM and SIGKILL",
      {
        code: "STEWARD_CHILD_TERMINATION_FAILED",
        cause: new AggregateError(errors),
        context: { pid: processHandle.pid ?? null, reason },
        severity: "fatal",
      },
    );
  }

  private requestTerminationSignal(
    processHandle: StewardProcessHandle,
    signal: "SIGTERM" | "SIGKILL",
    reason: string,
    errors: unknown[],
  ): void {
    try {
      const delivered = processHandle.kill(signal);
      if (delivered === false) {
        const error = new Error(`Steward child rejected ${signal}`);
        errors.push(error);
        logger.warn(
          { error, pid: processHandle.pid ?? null, reason, signal },
          "[StewardSidecar] Child termination signal was not delivered",
        );
      }
    } catch (error) {
      // error-policy:J6 a failed signal request is recorded and the bounded
      // termination ladder continues; an unconfirmed exit throws below.
      errors.push(error);
      logger.warn(
        { error, pid: processHandle.pid ?? null, reason, signal },
        "[StewardSidecar] Child termination signal failed",
      );
    }
  }

  private async waitForProcessExit(
    processHandle: StewardProcessHandle,
  ): Promise<ProcessExitWaitResult> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        processHandle.exited.then(
          (): ProcessExitWaitResult => ({ exited: true }),
          (error: unknown): ProcessExitWaitResult => ({ exited: false, error }),
        ),
        new Promise<ProcessExitWaitResult>((resolve) => {
          timeout = setTimeout(
            () => resolve({ exited: false }),
            PROCESS_TERMINATION_GRACE_MS,
          );
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private isLifecycleActive(generation: number): boolean {
    return !this.stopping && this.lifecycleGeneration === generation;
  }

  private updateStatus(partial: Partial<StewardSidecarStatus>): void {
    Object.assign(this.status, partial);
    this.config.onStatusChange?.(this.getStatus());
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a StewardSidecar with standard defaults.
 *
 * Uses environment variables for overrides:
 *   - STEWARD_DATA_DIR: data directory (default: ~/.local/state/eliza/steward/)
 *   - STEWARD_PORT: API port (default: 3200)
 *   - STEWARD_MASTER_PASSWORD: vault encryption password
 *   - STEWARD_ENTRY_POINT: path to steward API entry
 *   - DATABASE_URL: Postgres connection string
 */
export function createDesktopStewardSidecar(
  overrides?: Partial<StewardSidecarConfig>,
): StewardSidecar {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const namespace = readAliasedEnv("ELIZA_NAMESPACE") || "eliza";
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  const stateHome = xdgStateHome
    ? path.isAbsolute(xdgStateHome)
      ? xdgStateHome
      : path.join(home, xdgStateHome)
    : path.join(home, ".local", "state");

  return new StewardSidecar({
    dataDir:
      process.env.STEWARD_DATA_DIR ||
      overrides?.dataDir ||
      path.join(stateHome, namespace, "steward"),
    port:
      parseInt(process.env.STEWARD_PORT || "", 10) ||
      overrides?.port ||
      DEFAULT_PORT,
    masterPassword:
      process.env.STEWARD_MASTER_PASSWORD || overrides?.masterPassword,
    stewardEntryPoint:
      process.env.STEWARD_ENTRY_POINT || overrides?.stewardEntryPoint,
    databaseUrl: process.env.DATABASE_URL || overrides?.databaseUrl,
    ...overrides,
  });
}
