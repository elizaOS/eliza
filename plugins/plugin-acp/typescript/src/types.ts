import type { SessionId } from "@agentclientprotocol/sdk";

/**
 * Version constant for the ACP service
 */
export const ACP_VERSION = "1.0.0";

/**
 * Represents an ACP session with all its state
 */
export type AcpSession = {
  sessionId: SessionId;
  sessionKey: string;
  cwd: string;
  createdAt: number;
  abortController: AbortController | null;
  activeRunId: string | null;
};

/**
 * Options for configuring the ACP server
 */
export type AcpServerOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  defaultSessionKey?: string;
  defaultSessionLabel?: string;
  requireExistingSession?: boolean;
  resetSession?: boolean;
  prefixCwd?: boolean;
  verbose?: boolean;
};

/**
 * Agent info metadata for the ACP protocol
 */
export const ACP_AGENT_INFO = {
  name: "elizaos-acp",
  title: "elizaOS ACP Gateway",
  version: ACP_VERSION,
};

/**
 * Options for the ACP client
 */
export type AcpClientOptions = {
  cwd?: string;
  serverCommand?: string;
  serverArgs?: string[];
  serverVerbose?: boolean;
  verbose?: boolean;
};

/**
 * Handle returned from creating an ACP client
 */
export type AcpClientHandle = {
  client: import("@agentclientprotocol/sdk").ClientSideConnection;
  agent: import("node:child_process").ChildProcess;
  sessionId: string;
};

/**
 * Gateway event frame structure
 */
export type EventFrame = {
  event: string;
  payload?: unknown;
  seq?: number;
};

/**
 * Result from listing gateway sessions
 */
export type SessionsListResult = {
  sessions: Array<{
    key: string;
    displayName?: string;
    label?: string;
    updatedAt?: string;
    kind?: string;
    channel?: string;
  }>;
};

/**
 * Session metadata from ACP _meta field
 */
export type AcpSessionMeta = {
  sessionKey?: string;
  sessionLabel?: string;
  resetSession?: boolean;
  requireExisting?: boolean;
  prefixCwd?: boolean;
};

/**
 * Gateway attachment for images
 */
export type GatewayAttachment = {
  type: string;
  mimeType: string;
  content: string;
};

/**
 * Stub interface for gateway client
 */
export type GatewayClientStub = {
  request: <T>(method: string, params?: unknown) => Promise<T>;
};

/**
 * Configuration options for the ACPService
 */
export type ACPServiceConfig = {
  /**
   * Gateway WebSocket URL
   */
  gatewayUrl?: string;

  /**
   * Gateway authentication token
   */
  gatewayToken?: string;

  /**
   * Gateway password for authentication
   */
  gatewayPassword?: string;

  /**
   * Default session key to use
   */
  defaultSessionKey?: string;

  /**
   * Default session label to resolve
   */
  defaultSessionLabel?: string;

  /**
   * Whether to require existing sessions
   */
  requireExistingSession?: boolean;

  /**
   * Whether to reset sessions on first use
   */
  resetSession?: boolean;

  /**
   * Whether to prefix prompts with working directory
   */
  prefixCwd?: boolean;

  /**
   * Enable verbose logging
   */
  verbose?: boolean;

  /**
   * Client name for gateway identification
   */
  clientName?: string;

  /**
   * Client display name for gateway
   */
  clientDisplayName?: string;

  /**
   * Client version string
   */
  clientVersion?: string;

  /**
   * Client mode for gateway
   */
  clientMode?: string;

  /**
   * Use persistent session store (syncs with Eliza core session store)
   * When true, sessions are persisted to disk and survive restarts
   */
  persistSessions?: boolean;

  /**
   * Path to the session store file (used when persistSessions is true)
   * Defaults to ~/.eliza/agents/{agentId}/sessions.json
   */
  sessionStorePath?: string;

  /**
   * Agent ID for scoping persistent sessions
   */
  agentId?: string;
};
