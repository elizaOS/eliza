export type AgentType =
  | "claude"
  | "codex"
  | "gemini"
  | "aider"
  | "pi"
  | "shell"
  | string;

export type ApprovalPreset =
  | "readonly"
  | "standard"
  | "permissive"
  | "autonomous";

export type SessionStatus =
  | "running"
  | "ready"
  | "busy"
  | "blocked"
  | "authenticating"
  | "completed"
  | "stopped"
  | "errored"
  | "error"
  | "tool_running"
  | string;

export type SessionEventName =
  | "ready"
  | "blocked"
  | "login_required"
  | "task_complete"
  | "tool_running"
  | "stopped"
  | "error"
  | "message"
  | "reconnected"
  | string;

export type SessionEventCallback = (
  sessionId: string,
  event: SessionEventName,
  data: unknown,
) => void;

export type AcpEventCallback = (
  event: AcpJsonRpcMessage,
  sessionId?: string,
) => void;

export interface SpawnOptions {
  name?: string;
  agentType?: AgentType;
  workdir?: string;
  initialTask?: string;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
  credentials?: unknown;
  memoryContent?: string;
  approvalPreset?: ApprovalPreset;
  customCredentials?: Record<string, string>;
  skipAdapterAutoResponse?: boolean;
  timeoutMs?: number;
  model?: string;
}

export interface SpawnResult {
  sessionId: string;
  id: string;
  name: string;
  agentType: AgentType;
  workdir: string;
  status: SessionStatus;
  acpxRecordId?: string;
  acpxSessionId?: string;
  agentSessionId?: string;
  pid?: number;
  authReady?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SendOptions {
  timeoutMs?: number;
  silent?: boolean;
  env?: Record<string, string>;
  model?: string;
}

export interface PromptResult {
  sessionId: string;
  response: string;
  finalText: string;
  stopReason: string;
  durationMs: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}

export interface AvailableAgentInfo {
  adapter: AgentType;
  agentType: AgentType;
  installed: boolean;
  installCommand?: string;
  docsUrl?: string;
  auth?: {
    status?: "authenticated" | "unauthenticated" | "unknown" | string;
    detail?: string;
  };
}

export interface SessionInfo {
  id: string;
  name?: string;
  agentType: AgentType;
  workdir: string;
  status: SessionStatus;
  acpxRecordId?: string;
  acpxSessionId?: string;
  agentSessionId?: string;
  pid?: number;
  approvalPreset: ApprovalPreset;
  createdAt: Date;
  lastActivityAt: Date;
  lastError?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionFilter {
  status?: SessionStatus;
  statuses?: SessionStatus[];
  workdir?: string;
  agentType?: string;
  name?: string;
  acpxRecordId?: string;
}

export interface SessionStore {
  create(session: SessionInfo): Promise<void>;
  get(id: string): Promise<SessionInfo | null>;
  getByAcpxRecordId(recordId: string): Promise<SessionInfo | null>;
  findByScope(opts: {
    workdir: string;
    agentType: string;
    name?: string;
  }): Promise<SessionInfo | null>;
  list(filter?: SessionFilter): Promise<SessionInfo[]>;
  update(id: string, patch: Partial<SessionInfo>): Promise<void>;
  updateStatus(
    id: string,
    status: SessionStatus,
    error?: string,
  ): Promise<void>;
  delete(id: string): Promise<void>;
  sweepStale(maxAgeMs: number): Promise<string[]>;
}

export interface SessionStoreRuntime {
  databaseAdapter?: unknown;
  logger?: {
    warn?: (message: string, ...args: unknown[]) => void;
    error?: (message: string, ...args: unknown[]) => void;
    info?: (message: string, ...args: unknown[]) => void;
    debug?: (message: string, ...args: unknown[]) => void;
  };
  getSetting?: (key: string) => string | undefined;
}

export interface AcpJsonRpcBase {
  jsonrpc?: "2.0" | string;
}

export interface AcpJsonRpcRequest extends AcpJsonRpcBase {
  id: string | number;
  method: string;
  params?: unknown;
}

export interface AcpJsonRpcNotification extends AcpJsonRpcBase {
  method: string;
  params?: unknown;
}

export interface AcpJsonRpcResponse extends AcpJsonRpcBase {
  id: string | number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface AcpJsonRpcAnyMessage extends AcpJsonRpcBase {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  [k: string]: unknown;
}

export type AcpJsonRpcMessage = AcpJsonRpcAnyMessage;

export interface AcpToolCall {
  id?: string;
  title?: string;
  status?:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | string;
  output?: string;
}
