import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type IAgentRuntime, Service, type UUID } from "@elizaos/core";
import type {
  SandboxBrowserConfig,
  SandboxBrowserContext,
  SandboxConfig,
  SandboxContext,
  SandboxDockerConfig,
  SandboxEventPayload,
  SandboxEventType,
  SandboxExecuteParams,
  SandboxExecutionResult,
  SandboxMode,
  SandboxPruneConfig,
  SandboxScope,
  SandboxToolPolicy,
  SandboxWorkspaceAccess,
} from "../types/sandbox.js";
import {
  extractAgentIdFromSessionKey,
  hashToUUID,
  isSubagentSessionKey,
  parseSessionKey,
  sessionKeyToRoomId,
} from "../utils/session.js";

type InternalEventType = "sandbox" | SandboxEventType;

/**
 * Default Docker configuration for sandboxes.
 */
const DEFAULT_DOCKER_CONFIG: SandboxDockerConfig = {
  image: "ubuntu:22.04",
  containerPrefix: "eliza-sandbox",
  workdir: "/workspace",
  autoRemove: true,
  memoryLimit: "2g",
  cpuLimit: "2",
  network: "none",
  env: {},
  mounts: [],
  extraArgs: [],
};

/**
 * Default browser configuration.
 */
const DEFAULT_BROWSER_CONFIG: SandboxBrowserConfig = {
  enabled: false,
  image: "browserless/chrome:latest",
  containerPrefix: "eliza-browser",
  cdpPort: 9222,
  vncPort: 5900,
  noVncPort: 6080,
  headless: true,
  enableNoVnc: false,
  allowHostControl: false,
  autoStart: false,
  autoStartTimeoutMs: 30000,
};

/**
 * Default pruning configuration.
 */
const DEFAULT_PRUNE_CONFIG: SandboxPruneConfig = {
  idleHours: 1,
  maxAgeDays: 7,
};

/**
 * SandboxService manages isolated execution environments for agent tools.
 *
 * This replaces Otto's sandbox system with a native Eliza service
 * that uses Docker containers for isolation.
 */
export class SandboxService extends Service {
  static serviceType = "SANDBOX";
  capabilityDescription = "Manages sandboxed execution environments for secure tool execution";

  private readonly emitter = new EventEmitter();
  private readonly contexts = new Map<string, SandboxContext>();
  private readonly activeContainers = new Set<string>();
  private readonly containerLocks = new Map<string, Promise<void>>();
  private sweeper: NodeJS.Timeout | null = null;
  private initialized = false;

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new SandboxService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    // Start the pruning sweeper
    this.startSweeper();
  }

  // ============================================================================
  // Configuration
  // ============================================================================

  /**
   * Gets the sandbox configuration from character settings.
   */
  getConfig(): SandboxConfig {
    const settings = this.runtime.character?.settings as Record<string, unknown> | undefined;
    const sandbox = (settings?.sandbox ?? {}) as Partial<SandboxConfig>;

    return {
      mode: (sandbox.mode ?? "off") as SandboxMode,
      scope: (sandbox.scope ?? "session") as SandboxScope,
      workspaceAccess: (sandbox.workspaceAccess ?? "rw") as SandboxWorkspaceAccess,
      workspaceRoot: sandbox.workspaceRoot ?? path.join(os.homedir(), ".eliza", "sandboxes"),
      docker: { ...DEFAULT_DOCKER_CONFIG, ...sandbox.docker },
      browser: { ...DEFAULT_BROWSER_CONFIG, ...sandbox.browser },
      tools: sandbox.tools ?? { allow: [], deny: [] },
      prune: { ...DEFAULT_PRUNE_CONFIG, ...sandbox.prune },
    };
  }

  /**
   * Checks if sandboxing should be enabled for a session.
   */
  shouldSandbox(sessionKey: string): boolean {
    const config = this.getConfig();

    if (config.mode === "off") {
      return false;
    }

    if (config.mode === "all") {
      return true;
    }

    // mode === "non-main"
    // Only sandbox non-main sessions (subagents, etc.)
    const parsed = parseSessionKey(sessionKey);
    if (parsed.keyType === "subagent") {
      return true;
    }

    // Check if this is the main session
    const identifier = parsed.identifier.toLowerCase();
    if (identifier === "main" || identifier === "global") {
      return false;
    }

    return true;
  }

  /**
   * Checks if a tool is allowed in the sandbox.
   */
  isToolAllowed(toolName: string, policy?: SandboxToolPolicy): boolean {
    const config = this.getConfig();
    const p = policy ?? config.tools;

    // Explicit allow takes priority
    if (p.allow && p.allow.length > 0) {
      const allowed = p.allow.some(
        (pattern) =>
          pattern === "*" ||
          pattern.toLowerCase() === toolName.toLowerCase() ||
          (pattern.endsWith("*") &&
            toolName.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase())),
      );
      if (allowed) {
        return true;
      }
    }

    // Check deny list
    if (p.deny && p.deny.length > 0) {
      const denied = p.deny.some(
        (pattern) =>
          pattern === "*" ||
          pattern.toLowerCase() === toolName.toLowerCase() ||
          (pattern.endsWith("*") &&
            toolName.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase())),
      );
      if (denied) {
        return false;
      }
    }

    // Default: allow if no deny list, deny if allow list exists
    return !p.allow || p.allow.length === 0;
  }

  // ============================================================================
  // Context Management
  // ============================================================================

  /**
   * Gets or creates a sandbox context for a session.
   */
  async getSandboxContext(
    sessionKey: string,
    options?: { workspaceDir?: string; roomId?: UUID },
  ): Promise<SandboxContext | null> {
    const trimmedKey = sessionKey.trim();
    if (!trimmedKey) {
      return null;
    }

    if (!this.shouldSandbox(trimmedKey)) {
      return null;
    }

    // Check cache
    const cached = this.contexts.get(trimmedKey);
    if (cached) {
      cached.lastAccessedAt = Date.now();
      return cached;
    }

    // Create new context
    const config = this.getConfig();
    const agentId = extractAgentIdFromSessionKey(trimmedKey);

    // Resolve workspace directories
    const agentWorkspaceDir =
      options?.workspaceDir ?? path.join(os.homedir(), ".eliza", "workspace");
    const scopeKey = this.resolveScopeKey(config.scope, trimmedKey);
    const sandboxWorkspaceDir =
      config.scope === "shared" ? config.workspaceRoot : path.join(config.workspaceRoot, scopeKey);

    const workspaceDir = config.workspaceAccess === "rw" ? agentWorkspaceDir : sandboxWorkspaceDir;

    // Ensure workspace exists
    await fs.mkdir(workspaceDir, { recursive: true });

    // Generate container name
    const containerName = `${config.docker.containerPrefix}-${scopeKey.slice(0, 12)}`;

    const context: SandboxContext = {
      enabled: true,
      sessionKey: trimmedKey,
      roomId: options?.roomId ?? sessionKeyToRoomId(trimmedKey, agentId),
      workspaceDir,
      agentWorkspaceDir,
      workspaceAccess: config.workspaceAccess,
      containerName,
      containerWorkdir: config.docker.workdir,
      docker: config.docker,
      tools: config.tools,
      browserAllowHostControl: config.browser.allowHostControl,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    };

    this.contexts.set(trimmedKey, context);

    this.emitSandboxEvent("SANDBOX_CREATED", {
      sessionKey: trimmedKey,
      roomId: context.roomId,
      containerName,
    });

    return context;
  }

  /**
   * Resolves the scope key for a session.
   */
  private resolveScopeKey(scope: SandboxScope, sessionKey: string): string {
    const parsed = parseSessionKey(sessionKey);

    switch (scope) {
      case "session":
        return hashToUUID(sessionKey).slice(0, 16);
      case "agent":
        return hashToUUID(parsed.agentId).slice(0, 16);
      case "shared":
        return "shared";
      default:
        return hashToUUID(sessionKey).slice(0, 16);
    }
  }

  /**
   * Destroys a sandbox context and its resources.
   */
  async destroySandbox(sessionKey: string): Promise<void> {
    const context = this.contexts.get(sessionKey);
    if (!context) {
      return;
    }

    // Stop container if running
    if (this.activeContainers.has(context.containerName)) {
      await this.stopContainer(context.containerName);
    }

    // Stop browser if running
    if (context.browser) {
      await this.stopContainer(context.browser.containerName);
    }

    this.contexts.delete(sessionKey);

    this.emitSandboxEvent("SANDBOX_DESTROYED", {
      sessionKey,
      roomId: context.roomId,
      containerName: context.containerName,
    });
  }

  // ============================================================================
  // Command Execution
  // ============================================================================

  /**
   * Executes a command in a sandbox container.
   */
  async execute(sessionKey: string, params: SandboxExecuteParams): Promise<SandboxExecutionResult> {
    const context = await this.getSandboxContext(sessionKey);

    if (!context) {
      // No sandbox - execute directly
      return this.executeLocal(params);
    }

    const startTime = Date.now();

    this.emitSandboxEvent("SANDBOX_COMMAND_STARTED", {
      sessionKey,
      roomId: context.roomId,
      containerName: context.containerName,
      command: params.command,
    });

    try {
      const result = await this.executeInContainer(context, params);

      this.emitSandboxEvent("SANDBOX_COMMAND_COMPLETED", {
        sessionKey,
        roomId: context.roomId,
        containerName: context.containerName,
        command: params.command,
        result,
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const result: SandboxExecutionResult = {
        success: false,
        exitCode: 1,
        stdout: "",
        stderr: errorMessage,
        durationMs: Date.now() - startTime,
        timedOut: false,
        error: errorMessage,
      };

      this.emitSandboxEvent("SANDBOX_COMMAND_FAILED", {
        sessionKey,
        roomId: context.roomId,
        containerName: context.containerName,
        command: params.command,
        result,
        error: errorMessage,
      });

      return result;
    }
  }

  /**
   * Executes a command locally (no sandbox).
   *
   * IMPORTANT: This method uses shell: true for user-provided commands
   * but should use executeDockerCommand for Docker operations to avoid injection.
   */
  private executeLocal(params: SandboxExecuteParams): Promise<SandboxExecutionResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const timeout = params.timeoutMs ?? 60000;

      const child = spawn(params.command, params.args ?? [], {
        cwd: params.cwd,
        env: { ...process.env, ...params.env },
        shell: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout);

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      if (params.stdin) {
        child.stdin?.write(params.stdin);
        child.stdin?.end();
      }

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        resolve({
          success: code === 0 && !timedOut,
          exitCode: code ?? 1,
          stdout: stdout.slice(0, 100000), // Limit output size
          stderr: stderr.slice(0, 100000),
          durationMs: Date.now() - startTime,
          timedOut,
          error: timedOut ? "Command timed out" : undefined,
        });
      });

      child.on("error", (error) => {
        clearTimeout(timeoutId);
        resolve({
          success: false,
          exitCode: 1,
          stdout,
          stderr: error.message,
          durationMs: Date.now() - startTime,
          timedOut: false,
          error: error.message,
        });
      });
    });
  }

  /**
   * Executes a Docker command safely without shell interpolation.
   * Uses spawn directly with args array to prevent command injection.
   */
  private executeDockerCommand(
    args: string[],
    options?: { timeoutMs?: number },
  ): Promise<SandboxExecutionResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const timeout = options?.timeoutMs ?? 60000;

      const child = spawn("docker", args, {
        env: process.env,
        // NO shell: true - args are passed directly to docker binary
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout);

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        resolve({
          success: code === 0 && !timedOut,
          exitCode: code ?? 1,
          stdout: stdout.slice(0, 100000),
          stderr: stderr.slice(0, 100000),
          durationMs: Date.now() - startTime,
          timedOut,
          error: timedOut ? "Command timed out" : undefined,
        });
      });

      child.on("error", (error) => {
        clearTimeout(timeoutId);
        resolve({
          success: false,
          exitCode: 1,
          stdout,
          stderr: error.message,
          durationMs: Date.now() - startTime,
          timedOut: false,
          error: error.message,
        });
      });
    });
  }

  /**
   * Executes a command inside a Docker container.
   *
   * Note: The command is intentionally passed through `sh -c` inside the container
   * because sandbox execution is designed to run arbitrary user/agent commands.
   * The security boundary is the container itself, not command sanitization.
   */
  private async executeInContainer(
    context: SandboxContext,
    params: SandboxExecuteParams,
  ): Promise<SandboxExecutionResult> {
    const startTime = Date.now();
    const timeout = params.timeoutMs ?? 60000;

    // Ensure container exists
    await this.ensureContainer(context);

    // Build docker exec args array (no shell interpolation on host)
    const dockerArgs: string[] = ["exec"];

    // Add working directory
    const workdir = params.cwd
      ? path.join(context.containerWorkdir, params.cwd)
      : context.containerWorkdir;
    dockerArgs.push("-w", workdir);

    // Add environment variables
    for (const [key, value] of Object.entries(params.env ?? {})) {
      dockerArgs.push("-e", `${key}=${value}`);
    }

    // Add container name
    dockerArgs.push(context.containerName);

    // The command runs inside the container via sh -c
    // This is intentional - the sandbox is meant to execute arbitrary commands
    // Security is provided by container isolation, not command sanitization
    dockerArgs.push("sh", "-c", params.command);

    return new Promise((resolve) => {
      // Spawn docker directly without shell interpolation on host
      const child = spawn("docker", dockerArgs, {
        env: process.env,
        // No shell: true - args are passed directly to docker binary
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout);

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      if (params.stdin) {
        child.stdin?.write(params.stdin);
        child.stdin?.end();
      }

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        resolve({
          success: code === 0 && !timedOut,
          exitCode: code ?? 1,
          stdout: stdout.slice(0, 100000),
          stderr: stderr.slice(0, 100000),
          durationMs: Date.now() - startTime,
          timedOut,
          error: timedOut ? "Command timed out" : undefined,
        });
      });

      child.on("error", (error) => {
        clearTimeout(timeoutId);
        resolve({
          success: false,
          exitCode: 1,
          stdout,
          stderr: error.message,
          durationMs: Date.now() - startTime,
          timedOut: false,
          error: error.message,
        });
      });
    });
  }

  /**
   * Ensures a container exists for the sandbox.
   * Uses executeDockerCommand to prevent shell injection.
   * Uses locking to prevent race conditions when multiple calls try to create the same container.
   */
  private async ensureContainer(context: SandboxContext): Promise<void> {
    if (this.activeContainers.has(context.containerName)) {
      return;
    }

    // Check if there's already a pending operation for this container
    const existingLock = this.containerLocks.get(context.containerName);
    if (existingLock) {
      await existingLock;
      return;
    }

    // Create a new lock for this container operation
    const lockPromise = this.ensureContainerInternal(context);
    this.containerLocks.set(context.containerName, lockPromise);

    try {
      await lockPromise;
    } finally {
      this.containerLocks.delete(context.containerName);
    }
  }

  /**
   * Internal implementation of ensureContainer, called under lock.
   */
  private async ensureContainerInternal(context: SandboxContext): Promise<void> {
    // Double-check after acquiring lock
    if (this.activeContainers.has(context.containerName)) {
      return;
    }

    // Check if container already exists using safe args
    const checkResult = await this.executeDockerCommand([
      "ps",
      "-a",
      "-q",
      "-f",
      `name=^${context.containerName}$`,
    ]);

    if (checkResult.stdout.trim()) {
      // Container exists, start it if not running
      const startResult = await this.executeDockerCommand(["start", context.containerName]);
      if (startResult.success) {
        this.activeContainers.add(context.containerName);
        return;
      }
    }

    // Create new container - build args array safely
    const dockerArgs = ["run", "-d", "--name", context.containerName];

    // Add resource limits
    if (context.docker.memoryLimit) {
      dockerArgs.push("-m", context.docker.memoryLimit);
    }
    if (context.docker.cpuLimit) {
      dockerArgs.push("--cpus", context.docker.cpuLimit);
    }

    // Add network mode
    if (context.docker.network) {
      dockerArgs.push("--network", context.docker.network);
    }

    // Add workspace mount
    const mountMode = context.workspaceAccess === "ro" ? "ro" : "rw";
    dockerArgs.push("-v", `${context.workspaceDir}:${context.containerWorkdir}:${mountMode}`);

    // Add additional mounts
    for (const mount of context.docker.mounts ?? []) {
      dockerArgs.push("-v", `${mount.host}:${mount.container}:${mount.mode}`);
    }

    // Add environment variables
    for (const [key, value] of Object.entries(context.docker.env ?? {})) {
      dockerArgs.push("-e", `${key}=${value}`);
    }

    // Add extra args - these come from config, not user input
    if (context.docker.extraArgs) {
      dockerArgs.push(...context.docker.extraArgs);
    }

    // Add image and keep alive command
    dockerArgs.push(context.docker.image, "tail", "-f", "/dev/null");

    // Execute with safe args array (no shell interpolation)
    const result = await this.executeDockerCommand(dockerArgs);

    if (result.success) {
      this.activeContainers.add(context.containerName);
    } else {
      throw new Error(`Failed to create container: ${result.stderr}`);
    }
  }

  /**
   * Stops a container.
   * Uses executeDockerCommand to prevent shell injection.
   */
  private async stopContainer(containerName: string): Promise<void> {
    await this.executeDockerCommand(["stop", containerName], { timeoutMs: 10000 });
    await this.executeDockerCommand(["rm", "-f", containerName], { timeoutMs: 10000 });
    this.activeContainers.delete(containerName);
  }

  // ============================================================================
  // Browser Management
  // ============================================================================

  /**
   * Starts a sandboxed browser for a session.
   */
  async startBrowser(sessionKey: string): Promise<SandboxBrowserContext | null> {
    const context = await this.getSandboxContext(sessionKey);
    if (!context) {
      return null;
    }

    const config = this.getConfig();
    if (!config.browser.enabled) {
      return null;
    }

    if (context.browser) {
      return context.browser;
    }

    const browserContainerName = `${config.browser.containerPrefix}-${context.containerName.slice(-12)}`;

    // Start browser container - build args array safely
    const browserArgs = [
      "run",
      "-d",
      "--name",
      browserContainerName,
      "-p",
      `${config.browser.cdpPort}:9222`,
    ];

    if (config.browser.enableNoVnc) {
      browserArgs.push("-p", `${config.browser.noVncPort}:6080`);
    }

    browserArgs.push(config.browser.image);

    // Execute with safe args array (no shell interpolation)
    const result = await this.executeDockerCommand(browserArgs);

    if (!result.success) {
      this.runtime.logger.error(
        { sessionKey, error: result.stderr },
        "Failed to start browser container",
      );
      return null;
    }

    const browserContext: SandboxBrowserContext = {
      bridgeUrl: `http://localhost:${config.browser.cdpPort}`,
      noVncUrl: config.browser.enableNoVnc
        ? `http://localhost:${config.browser.noVncPort}`
        : undefined,
      containerName: browserContainerName,
    };

    context.browser = browserContext;

    this.emitSandboxEvent("SANDBOX_BROWSER_STARTED", {
      sessionKey,
      roomId: context.roomId,
      containerName: browserContainerName,
    });

    return browserContext;
  }

  /**
   * Stops a sandboxed browser.
   */
  async stopBrowser(sessionKey: string): Promise<void> {
    const context = this.contexts.get(sessionKey);
    if (!context?.browser) {
      return;
    }

    await this.stopContainer(context.browser.containerName);

    this.emitSandboxEvent("SANDBOX_BROWSER_STOPPED", {
      sessionKey,
      roomId: context.roomId,
      containerName: context.browser.containerName,
    });

    context.browser = undefined;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  private startSweeper(): void {
    if (this.sweeper) {
      return;
    }

    const config = this.getConfig();
    const intervalMs = Math.max((config.prune.idleHours * 60 * 60 * 1000) / 4, 60000);

    this.sweeper = setInterval(() => {
      this.sweepIdleSandboxes();
    }, intervalMs);

    this.sweeper.unref?.();
  }

  private sweepIdleSandboxes(): void {
    const config = this.getConfig();
    const idleMs = config.prune.idleHours * 60 * 60 * 1000;
    const maxAgeMs = config.prune.maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const [sessionKey, context] of this.contexts.entries()) {
      const idle = now - context.lastAccessedAt > idleMs;
      const tooOld = now - context.createdAt > maxAgeMs;

      if (idle || tooOld) {
        this.destroySandbox(sessionKey).catch((err) => {
          this.runtime.logger.error({ sessionKey, error: err }, "Failed to destroy idle sandbox");
        });
      }
    }
  }

  // ============================================================================
  // Events
  // ============================================================================

  on(event: InternalEventType, handler: (payload: SandboxEventPayload) => void): void {
    this.emitter.on(event, handler);
  }

  off(event: InternalEventType, handler: (payload: SandboxEventPayload) => void): void {
    this.emitter.off(event, handler);
  }

  private emitSandboxEvent(type: SandboxEventType, payload: SandboxEventPayload): void {
    this.emitter.emit(type, payload);
    this.emitter.emit("sandbox", { type, ...payload });
  }

  async stop(): Promise<void> {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }

    // Stop all containers
    for (const sessionKey of this.contexts.keys()) {
      await this.destroySandbox(sessionKey);
    }

    this.emitter.removeAllListeners();
  }
}
