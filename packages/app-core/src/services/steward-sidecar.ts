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
 *   const sidecar = new StewardSidecar({ dataDir: '~/.eliza/steward/' });
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

// Re-export types for external consumers
export type {
  StewardCredentials,
  StewardSidecarConfig,
  StewardSidecarStatus,
  StewardWalletInfo,
} from "./steward-sidecar/types";

// Re-export helpers for external consumers (used by @elizaos/app-steward).
export {
  allocateFirstFreeLoopbackPort,
  fingerprintRandomToken,
  generateApiKey,
  generateMasterPassword,
  resolveDataDir,
} from "./steward-sidecar/helpers";

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

// ---------------------------------------------------------------------------
// StewardSidecar
// ---------------------------------------------------------------------------

export class StewardSidecar {
  private config: Required<
    Pick<StewardSidecarConfig, "dataDir" | "port" | "maxRestarts">
  > &
    StewardSidecarConfig;
  private status: StewardSidecarStatus;
  private process: {
    kill: (signal?: string) => void;
    pid?: number | null;
    exitCode?: number | null;
    exited?: Promise<number>;
  } | null = null;
  private stopping = false;
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

    this.stopping = false;
    this.updateStatus({ state: "starting", error: null });

    try {
      await this.ensureDataDir();
      await this.loadOrCreateCredentials();
      await this.spawnProcess();

      const abort = new AbortController();
      this.healthCheckAbort = abort;
      await waitForHealthy(this.getApiBase(), abort);
      this.healthCheckAbort = null;

      this.credentials = await ensureWalletSetup(
        this.credentials,
        this.getApiBase(),
        this.config.masterPassword,
        this.config.dataDir,
        (p) => this.updateStatus(p),
      );

      this.updateStatus({
        state: "running",
        port: this.config.port,
        startedAt: Date.now(),
      });

      return this.status;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.updateStatus({ state: "error", error });
      throw err;
    }
  }

  /** Stop the Steward sidecar process gracefully. */
  async stop(): Promise<void> {
    this.stopping = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.healthCheckAbort) {
      this.healthCheckAbort.abort();
      this.healthCheckAbort = null;
    }

    if (this.process) {
      try {
        this.process.kill("SIGTERM");
        const timeout = setTimeout(() => {
          try {
            this.process?.kill("SIGKILL");
          } catch {
            // already dead
          }
        }, 5_000);

        if (this.process.exited) {
          await this.process.exited;
        }
        clearTimeout(timeout);
      } catch {
        // process already dead
      }
      this.process = null;
    }

    this.updateStatus({
      state: "stopped",
      port: null,
      pid: null,
      startedAt: null,
    });
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
      console.log(
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
        console.warn(
          "[StewardSidecar] Failed to parse credentials, will recreate",
        );
      }
    }

    if (!this.config.masterPassword) {
      this.config.masterPassword = generateMasterPassword();
    }
  }

  private async spawnProcess(): Promise<void> {
    const entryPoint =
      this.config.stewardEntryPoint || (await findStewardEntryPoint());

    if (!entryPoint) {
      throw new Error(
        "Steward API entry point not found. Set STEWARD_ENTRY_POINT or install a package that exposes @stwd/api.",
      );
    }

    const preferredPort = this.config.port;
    const allocatedPort = await allocateFirstFreeLoopbackPort(preferredPort);
    if (allocatedPort !== preferredPort) {
      console.warn(
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

    console.log(
      `[StewardSidecar] Spawning steward on port ${this.config.port}`,
      { entryPoint, dataDir: this.config.dataDir },
    );

    const bun = getBunRuntime();
    if (bun) {
      const proc = bun.spawn(["bun", "run", entryPoint], {
        env,
        cwd: path.dirname(entryPoint),
        stdout: "pipe",
        stderr: "pipe",
      });

      this.process = proc as unknown as typeof this.process;
      this.updateStatus({ pid: proc.pid ?? null });

      pipeOutput(proc.stdout, "stdout", this.config.onLog);
      pipeOutput(proc.stderr, "stderr", this.config.onLog);

      proc.exited.then((code: number) => {
        if (!this.stopping) {
          console.warn(
            `[StewardSidecar] Process exited unexpectedly (code ${code})`,
          );
          void this.handleCrash(code);
        }
      });
    } else {
      const child = childProcess.spawn("node", [entryPoint], {
        env,
        cwd: path.dirname(entryPoint),
        stdio: ["ignore", "pipe", "pipe"],
      });

      const exitPromise = new Promise<number>((resolve) => {
        child.on("exit", (code) => resolve(code ?? 1));
      });

      this.process = {
        kill: (signal?: string) =>
          child.kill((signal as NodeJS.Signals) ?? "SIGTERM"),
        pid: child.pid ?? null,
        exited: exitPromise,
      };

      this.updateStatus({ pid: child.pid ?? null });

      if (child.stdout) {
        child.stdout.on("data", (chunk: Buffer) => {
          const line = chunk.toString().trimEnd();
          if (line) {
            console.log(`[Steward] ${line}`);
            this.config.onLog?.(line, "stdout");
          }
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          const line = chunk.toString().trimEnd();
          if (line) {
            console.error(`[Steward:err] ${line}`);
            this.config.onLog?.(line, "stderr");
          }
        });
      }

      exitPromise.then((code) => {
        if (!this.stopping) {
          console.warn(
            `[StewardSidecar] Process exited unexpectedly (code ${code})`,
          );
          void this.handleCrash(code);
        }
      });
    }
  }

  private async handleCrash(exitCode: number | null): Promise<void> {
    if (this.stopping) return;

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

    console.log(
      `[StewardSidecar] Restarting in ${backoff}ms (attempt ${this.status.restartCount}/${this.config.maxRestarts})`,
    );

    this.updateStatus({ state: "restarting", pid: null });

    this.restartTimer = setTimeout(async () => {
      if (this.stopping) return;

      try {
        await this.spawnProcess();

        const abort = new AbortController();
        this.healthCheckAbort = abort;
        await waitForHealthy(this.getApiBase(), abort);
        this.healthCheckAbort = null;

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
        const error = err instanceof Error ? err.message : String(err);
        this.updateStatus({ state: "error", error });
      }
    }, backoff);
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
 *   - STEWARD_DATA_DIR: data directory (default: ~/.eliza/steward/)
 *   - STEWARD_PORT: API port (default: 3200)
 *   - STEWARD_MASTER_PASSWORD: vault encryption password
 *   - STEWARD_ENTRY_POINT: path to steward API entry
 *   - DATABASE_URL: Postgres connection string
 */
export function createDesktopStewardSidecar(
  overrides?: Partial<StewardSidecarConfig>,
): StewardSidecar {
  const home = process.env.HOME || process.env.USERPROFILE || "";

  return new StewardSidecar({
    dataDir:
      process.env.STEWARD_DATA_DIR ||
      overrides?.dataDir ||
      `${home}/.eliza/steward`,
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
