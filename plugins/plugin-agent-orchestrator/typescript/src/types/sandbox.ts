import type { UUID } from "@elizaos/core";

/**
 * Docker container configuration for sandboxed execution.
 */
export interface SandboxDockerConfig {
  /** Docker image to use */
  image: string;
  /** Container name prefix */
  containerPrefix: string;
  /** Working directory inside the container */
  workdir: string;
  /** Whether to remove container after execution */
  autoRemove: boolean;
  /** Memory limit (e.g., "2g") */
  memoryLimit?: string;
  /** CPU limit (e.g., "2") */
  cpuLimit?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Additional volume mounts */
  mounts?: Array<{ host: string; container: string; mode: "ro" | "rw" }>;
  /** Network mode */
  network?: "none" | "bridge" | "host";
  /** Additional docker run arguments */
  extraArgs?: string[];
}

/**
 * Tool execution policy for sandboxed environments.
 */
export interface SandboxToolPolicy {
  /** Tools explicitly allowed (overrides deny) */
  allow?: string[];
  /** Tools explicitly denied */
  deny?: string[];
}

/**
 * Browser configuration for sandboxed environments.
 */
export interface SandboxBrowserConfig {
  /** Whether sandboxed browser is enabled */
  enabled: boolean;
  /** Docker image for browser container */
  image: string;
  /** Container name prefix */
  containerPrefix: string;
  /** Chrome DevTools Protocol port */
  cdpPort: number;
  /** VNC port for remote viewing */
  vncPort: number;
  /** noVNC web port */
  noVncPort: number;
  /** Run browser headless */
  headless: boolean;
  /** Enable noVNC web interface */
  enableNoVnc: boolean;
  /** Allow host browser control */
  allowHostControl: boolean;
  /** Auto-start browser on sandbox creation */
  autoStart: boolean;
  /** Timeout for auto-start in milliseconds */
  autoStartTimeoutMs: number;
}

/**
 * Workspace access level for sandboxed sessions.
 */
export type SandboxWorkspaceAccess = "none" | "ro" | "rw";

/**
 * Sandbox scope - determines isolation level.
 */
export type SandboxScope = "session" | "agent" | "shared";

/**
 * Sandbox mode - determines when sandboxing applies.
 */
export type SandboxMode = "off" | "non-main" | "all";

/**
 * Pruning configuration for sandbox cleanup.
 */
export interface SandboxPruneConfig {
  /** Hours of inactivity before marking as idle */
  idleHours: number;
  /** Maximum age in days before forced cleanup */
  maxAgeDays: number;
}

/**
 * Complete sandbox configuration.
 * Stored in Character.settings.sandbox or world metadata.
 */
export interface SandboxConfig {
  /** Sandbox mode */
  mode: SandboxMode;
  /** Isolation scope */
  scope: SandboxScope;
  /** Workspace access level */
  workspaceAccess: SandboxWorkspaceAccess;
  /** Root directory for sandbox workspaces */
  workspaceRoot: string;
  /** Docker configuration */
  docker: SandboxDockerConfig;
  /** Browser configuration */
  browser: SandboxBrowserConfig;
  /** Tool execution policy */
  tools: SandboxToolPolicy;
  /** Pruning configuration */
  prune: SandboxPruneConfig;
}

/**
 * Browser context for a sandbox.
 */
export interface SandboxBrowserContext {
  /** URL to connect to the browser bridge */
  bridgeUrl: string;
  /** URL for noVNC web interface */
  noVncUrl?: string;
  /** Container name running the browser */
  containerName: string;
}

/**
 * Resolved sandbox context for a session.
 */
export interface SandboxContext {
  /** Whether sandboxing is enabled for this session */
  enabled: boolean;
  /** The session key this sandbox is for */
  sessionKey: string;
  /** Eliza room ID associated with this sandbox */
  roomId?: UUID;
  /** Directory where sandbox files are stored */
  workspaceDir: string;
  /** Agent's workspace directory */
  agentWorkspaceDir: string;
  /** Access level for the workspace */
  workspaceAccess: SandboxWorkspaceAccess;
  /** Name of the Docker container */
  containerName: string;
  /** Working directory inside the container */
  containerWorkdir: string;
  /** Docker configuration */
  docker: SandboxDockerConfig;
  /** Tool execution policy */
  tools: SandboxToolPolicy;
  /** Whether host browser control is allowed */
  browserAllowHostControl: boolean;
  /** Browser context if available */
  browser?: SandboxBrowserContext;
  /** When this context was created */
  createdAt: number;
  /** When this context was last accessed */
  lastAccessedAt: number;
}

/**
 * Minimal workspace info for sandbox operations.
 */
export interface SandboxWorkspaceInfo {
  workspaceDir: string;
  containerWorkdir: string;
}

/**
 * Result of a sandboxed command execution.
 */
export interface SandboxExecutionResult {
  /** Whether the command succeeded */
  success: boolean;
  /** Exit code of the command */
  exitCode: number;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Whether the command timed out */
  timedOut: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Parameters for executing a command in a sandbox.
 */
export interface SandboxExecuteParams {
  /** Command to execute */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Working directory (relative to container workdir) */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Standard input to pass to the command */
  stdin?: string;
}

/**
 * Events emitted by the sandbox service.
 */
export const SandboxEventType = {
  /** Sandbox created */
  CREATED: "SANDBOX_CREATED",
  /** Sandbox destroyed */
  DESTROYED: "SANDBOX_DESTROYED",
  /** Command started */
  COMMAND_STARTED: "SANDBOX_COMMAND_STARTED",
  /** Command completed */
  COMMAND_COMPLETED: "SANDBOX_COMMAND_COMPLETED",
  /** Command failed */
  COMMAND_FAILED: "SANDBOX_COMMAND_FAILED",
  /** Browser started */
  BROWSER_STARTED: "SANDBOX_BROWSER_STARTED",
  /** Browser stopped */
  BROWSER_STOPPED: "SANDBOX_BROWSER_STOPPED",
} as const;

export type SandboxEventType = (typeof SandboxEventType)[keyof typeof SandboxEventType];

/**
 * Payload for sandbox events.
 */
export interface SandboxEventPayload {
  sessionKey: string;
  roomId?: UUID;
  containerName?: string;
  command?: string;
  result?: SandboxExecutionResult;
  error?: string;
}
