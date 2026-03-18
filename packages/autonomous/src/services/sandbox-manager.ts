/** Sandbox container lifecycle: create, exec, health check, teardown. */

import { mkdirSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  createEngine,
  detectBestEngine,
  type ISandboxEngine,
  type SandboxEngineType,
} from "./sandbox-engine";

// ── Types ────────────────────────────────────────────────────────────────────

export type SandboxMode = "off" | "light" | "standard" | "max";

export type SandboxState =
  | "uninitialized"
  | "initializing"
  | "ready"
  | "degraded"
  | "stopping"
  | "stopped"
  | "recovering";

export interface SandboxManagerConfig {
  /** Sandbox mode. */
  mode: SandboxMode;
  /** Docker image for sandbox containers. */
  image?: string;
  /** Container name prefix. */
  containerPrefix?: string;
  /** Container workdir mount path. */
  workdir?: string;
  /** Run rootfs read-only. */
  readOnlyRoot?: boolean;
  /** Container network mode. */
  network?: string;
  /** Container user (uid:gid). */
  user?: string;
  /** Drop Linux capabilities. */
  capDrop?: string[];
  /** Environment variables for sandbox. */
  env?: Record<string, string>;
  /** Container memory limit. */
  memory?: string;
  /** Container CPU limit. */
  cpus?: number;
  /** PIDs limit. */
  pidsLimit?: number;
  /** Root directory for sandbox workspaces. */
  workspaceRoot?: string;
  /** Additional bind mounts. */
  binds?: string[];
  /** DNS servers. */
  dns?: string[];
  /** Container engine type: "docker", "apple-container", or "auto" (default). */
  engineType?: SandboxEngineType;
  /** Browser sandbox settings. */
  browser?: {
    enabled?: boolean;
    image?: string;
    cdpPort?: number;
    vncPort?: number;
    noVncPort?: number;
    headless?: boolean;
    enableNoVnc?: boolean;
    autoStart?: boolean;
    autoStartTimeoutMs?: number;
  };
}

export interface SandboxExecOptions {
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  executedInSandbox: boolean;
}

export interface SandboxEvent {
  timestamp: number;
  type:
    | "state_change"
    | "exec"
    | "exec_denied"
    | "container_start"
    | "container_stop"
    | "health_check"
    | "error";
  detail: string;
  metadata?: Record<string, string | number | boolean>;
}

// ── Implementation ───────────────────────────────────────────────────────────

export class SandboxManager {
  private state: SandboxState = "uninitialized";
  private config: SandboxManagerConfig;
  private engine: ISandboxEngine;
  private containerId: string | null = null;
  private browserContainerId: string | null = null;
  private eventLog: SandboxEvent[] = [];

  constructor(config: SandboxManagerConfig) {
    this.config = {
      image: "milady-sandbox:bookworm-slim",
      containerPrefix: "milady-sandbox",
      workdir: "/workspace",
      network: "none",
      user: "1000:1000",
      capDrop: ["ALL"],
      memory: "512m",
      cpus: 1,
      pidsLimit: 256,
      ...config,
    };
    this.engine = config.engineType
      ? createEngine(config.engineType)
      : detectBestEngine();
  }

  getState(): SandboxState {
    return this.state;
  }

  getMode(): SandboxMode {
    return this.config.mode;
  }

  isReady(): boolean {
    return this.state === "ready";
  }

  private getMainContainerConfig(): {
    image: string;
    containerPrefix: string;
    workdir: string;
    network: string;
    user: string;
    wsRoot: string;
  } {
    const image = this.config.image ?? "milady-sandbox:bookworm-slim";
    const containerPrefix = this.config.containerPrefix ?? "milady-sandbox";
    const workdir = this.config.workdir ?? "/workspace";
    const network = this.config.network ?? "none";
    const user = this.config.user ?? "1000:1000";
    const wsRoot =
      this.config.workspaceRoot ??
      join(
        process.env.HOME ?? process.env.USERPROFILE ?? os.tmpdir(),
        ".milady",
        "sandbox-workspace",
      );
    mkdirSync(wsRoot, { recursive: true });
    return { image, containerPrefix, workdir, network, user, wsRoot };
  }

  private async createMainContainer(): Promise<string> {
    const config = this.getMainContainerConfig();
    return this.engine.runContainer({
      image: config.image,
      name: `${config.containerPrefix}-${Date.now()}`,
      detach: true,
      mounts: [
        { host: config.wsRoot, container: config.workdir, readonly: false },
      ],
      env: this.config.env ?? {},
      network: config.network,
      user: config.user,
      capDrop: this.config.capDrop ?? [],
      memory: this.config.memory,
      cpus: this.config.cpus,
      pidsLimit: this.config.pidsLimit,
      readOnlyRoot: this.config.readOnlyRoot,
      dns: this.config.dns,
    });
  }

  private async cleanupContainer(containerId: string | null): Promise<void> {
    if (!containerId) return;
    await this.engine.stopContainer(containerId);
    await this.engine.removeContainer(containerId);
  }

  private setState(newState: SandboxState): void {
    const oldState = this.state;
    this.state = newState;
    this.emitEvent({
      timestamp: Date.now(),
      type: "state_change",
      detail: `${oldState} → ${newState}`,
    });
  }

  async start(): Promise<void> {
    if (this.config.mode === "off") {
      this.setState("stopped");
      return;
    }

    if (this.config.mode === "light") {
      // Light mode: no container, just tokenization + fetch proxy
      this.setState("ready");
      return;
    }

    // Standard / Max: create container
    this.setState("initializing");

    try {
      const config = this.getMainContainerConfig();

      if (!this.engine.isAvailable()) {
        throw new Error(
          `Container engine "${this.engine.engineType}" is not available. Install Docker or Apple Container.`,
        );
      }

      if (!this.engine.imageExists(config.image)) {
        try {
          await this.engine.pullImage(config.image);
        } catch {
          throw new Error(
            `Sandbox image "${config.image}" not found. Build with: scripts/sandbox-setup.sh`,
          );
        }
      }

      // Cleanup orphans from previous runs
      const orphans = this.engine.listContainers(config.containerPrefix);
      for (const id of orphans) {
        await this.engine.stopContainer(id);
        await this.engine.removeContainer(id);
      }

      this.containerId = await this.createMainContainer();

      this.emitEvent({
        timestamp: Date.now(),
        type: "container_start",
        detail: `Container started: ${this.containerId}`,
      });

      // Start browser container if configured
      if (this.config.browser?.enabled && this.config.browser?.autoStart) {
        try {
          this.browserContainerId = await this.createBrowserContainer();
        } catch (err) {
          this.emitEvent({
            timestamp: Date.now(),
            type: "error",
            detail: `Browser container start failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          // Non-fatal: sandbox can work without browser
        }
      }

      // Health check
      const healthy = await this.healthCheck();
      if (healthy) {
        this.setState("ready");
      } else {
        this.setState("degraded");
      }
    } catch (err) {
      this.emitEvent({
        timestamp: Date.now(),
        type: "error",
        detail: `Sandbox start failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.setState("degraded");
      throw err;
    }
  }

  async recover(): Promise<void> {
    if (this.state !== "degraded") {
      return; // Only recover from degraded
    }

    this.setState("recovering");
    this.emitEvent({
      timestamp: Date.now(),
      type: "state_change",
      detail: "Attempting recovery from degraded state",
    });

    try {
      const config = this.getMainContainerConfig();
      await this.cleanupContainer(this.containerId);
      await this.cleanupContainer(this.browserContainerId);
      this.containerId = null;
      this.browserContainerId = null;

      const orphans = this.engine.listContainers(config.containerPrefix);
      for (const id of orphans) {
        await this.engine.stopContainer(id);
        await this.engine.removeContainer(id);
      }

      this.containerId = await this.createMainContainer();

      const healthy = await this.healthCheck();
      if (healthy) {
        this.setState("ready");
      } else {
        this.setState("degraded");
      }
    } catch (err) {
      this.emitEvent({
        timestamp: Date.now(),
        type: "error",
        detail: `Recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.setState("degraded");
    }
  }

  async stop(): Promise<void> {
    this.setState("stopping");

    try {
      await this.cleanupContainer(this.browserContainerId);
      await this.cleanupContainer(this.containerId);
      this.browserContainerId = null;
      this.containerId = null;
    } catch (err) {
      this.emitEvent({
        timestamp: Date.now(),
        type: "error",
        detail: `Sandbox stop error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    this.setState("stopped");
  }

  async exec(options: SandboxExecOptions): Promise<SandboxExecResult> {
    const start = Date.now();

    if (this.config.mode === "off" || this.config.mode === "light") {
      // In off/light mode, refuse sandbox exec — caller must use local
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Sandbox exec not available in current mode",
        durationMs: Date.now() - start,
        executedInSandbox: false,
      };
    }

    if (!this.containerId || this.state !== "ready") {
      this.emitEvent({
        timestamp: Date.now(),
        type: "exec_denied",
        detail: `Sandbox not ready (state=${this.state})`,
      });
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Sandbox not ready (state=${this.state})`,
        durationMs: Date.now() - start,
        executedInSandbox: false,
      };
    }

    this.emitEvent({
      timestamp: Date.now(),
      type: "exec",
      detail: options.command.substring(0, 200),
      metadata: {
        workdir: options.workdir ?? this.config.workdir ?? "/workspace",
      },
    });

    try {
      const result = await this.engine.execInContainer({
        containerId: this.containerId,
        command: options.command,
        workdir: options.workdir,
        env: options.env,
        timeoutMs: options.timeoutMs,
        stdin: options.stdin,
      });
      return {
        ...result,
        executedInSandbox: true,
      };
    } catch (err) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Exec error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
        executedInSandbox: false,
      };
    }
  }

  getBrowserCdpEndpoint(): string | null {
    if (!this.browserContainerId) return null;
    const port = this.config.browser?.cdpPort ?? 9222;
    return `http://localhost:${port}`;
  }

  getBrowserWsEndpoint(): string | null {
    if (!this.browserContainerId) return null;
    const port = this.config.browser?.cdpPort ?? 9222;
    return `ws://localhost:${port}`;
  }

  getBrowserNoVncEndpoint(): string | null {
    if (!this.browserContainerId) return null;

    const noVncEnabled = this.config.browser?.enableNoVnc ?? false;
    const headless = this.config.browser?.headless ?? false;
    if (!noVncEnabled || headless) return null;

    const port = this.config.browser?.noVncPort ?? 6080;
    return `http://localhost:${port}/vnc.html?autoconnect=true&resize=scale&view_only=true`;
  }

  private async createBrowserContainer(): Promise<string> {
    const name = `${this.config.containerPrefix}-browser-${Date.now()}`;
    const cdpPort = this.config.browser?.cdpPort ?? 9222;
    const vncPort = this.config.browser?.vncPort ?? 5900;
    const noVncPort = this.config.browser?.noVncPort ?? 6080;
    const enableNoVnc = this.config.browser?.enableNoVnc ?? false;
    const headless = this.config.browser?.headless ?? false;
    const image =
      this.config.browser?.image ?? "milady-sandbox-browser:bookworm-slim";

    return this.engine.runContainer({
      image,
      name,
      detach: true,
      mounts: [],
      env: {
        MILADY_BROWSER_CDP_PORT: String(cdpPort),
        MILADY_BROWSER_VNC_PORT: String(vncPort),
        MILADY_BROWSER_NOVNC_PORT: String(noVncPort),
        MILADY_BROWSER_ENABLE_NOVNC: enableNoVnc ? "1" : "0",
        MILADY_BROWSER_HEADLESS: headless ? "1" : "0",
      },
      network: "bridge",
      user: "1000:1000",
      capDrop: [],
      ports: [
        { host: cdpPort, container: cdpPort },
        { host: vncPort, container: vncPort },
        ...(enableNoVnc && !headless
          ? [{ host: noVncPort, container: noVncPort }]
          : []),
      ],
    });
  }

  private async healthCheck(): Promise<boolean> {
    if (!this.containerId) return false;
    const healthy = await this.engine.healthCheck(this.containerId);
    this.emitEvent({
      timestamp: Date.now(),
      type: "health_check",
      detail: healthy ? "healthy" : "unhealthy",
    });
    return healthy;
  }

  private emitEvent(event: SandboxEvent): void {
    this.eventLog.push(event);
    // Keep bounded
    if (this.eventLog.length > 1000) {
      this.eventLog = this.eventLog.slice(-500);
    }
  }

  getEventLog(): SandboxEvent[] {
    return [...this.eventLog];
  }

  getStatus(): {
    state: SandboxState;
    mode: SandboxMode;
    containerId: string | null;
    browserContainerId: string | null;
  } {
    return {
      state: this.state,
      mode: this.config.mode,
      containerId: this.containerId,
      browserContainerId: this.browserContainerId,
    };
  }
}
