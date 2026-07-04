/**
 * Shared type vocabulary for the ACP session layer: agent/backend kinds,
 * approval presets, session status and lifecycle events, spawn options, and the
 * `SessionStore` contract the persistence tiers implement.
 */
export type AgentType =
  | "elizaos"
  | "pi-agent"
  | "opencode"
  | "claude"
  | "codex"
  | string;

export type ApprovalPreset =
  | "readonly"
  | "standard"
  | "permissive"
  | "autonomous"
  // Read + search + EXECUTE allowed, edit/write/delete DENIED. The profile the
  // independent read-only verifier (#8898) runs under: it must re-run tests
  // (`execute`) and inspect files (`read`/`search`) but can never mutate the
  // worktree it is verifying. `readonly` (`--deny-all`) cannot run the tests.
  | "verifier";

export type SessionStatus =
  | "running"
  | "ready"
  | "busy"
  | "blocked"
  | "authenticating"
  | "completed"
  | "stopped"
  | "errored"
  | "cancelled"
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
  | "reasoning"
  | "plan"
  | "reconnected"
  | "account_switched"
  | string;

/**
 * Set of session statuses that mean "this session is finished and will
 * not emit further activity". Exported here so providers, the progress
 * hook, and the orchestrator service share a single source of truth.
 * Adding a new terminal status only requires updating this set.
 */
export const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "stopped",
  "completed",
  "error",
  "errored",
  "cancelled",
]);

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
  /**
   * When true, spawnSession places this session in a per-session subdir of
   * `workdir` (a SHARED scratch root) so concurrent tasks can't collide.
   * Set by the orchestrator only when the workdir resolved to a configured
   * workspace root — never for cwd self-checkout or a route/explicit dir.
   */
  isolateWorkdir?: boolean;
  initialTask?: string;
  /**
   * The planner judged this an app the user wants to MONETIZE (charge for use).
   * Threaded into the deploy-guidance injection so the sub-agent gets the
   * monetized Eliza Cloud contract rather than a free static page. Model intent,
   * not a keyword match — see app-deploy-guidance.augmentTaskWithDeployGuidance.
   */
  monetized?: boolean;
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
  /** Modern eliza runtime exposes the DB adapter as `runtime.adapter`. */
  adapter?: unknown;
  /** Legacy alias kept for pre-2026 runtimes and custom container harnesses. */
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
  /**
   * ACP `kind` (when present) — typically `read`, `edit`, `execute`,
   * `search`, `fetch`, etc. Lets downstream consumers format the
   * Claude-Code-style display (e.g. `Bash(git status)` for kind=execute).
   */
  kind?: string;
  /**
   * ACP `rawInput` — the actual tool arguments object as the agent
   * emitted it. For Read/Edit/Write the most useful field is usually
   * `file_path`. For Bash/Terminal it's `command`. For Grep it's
   * `pattern` / `path`. Forwarded as-is so consumers can pick what they
   * surface.
   */
  rawInput?: Record<string, unknown>;
  /**
   * ACP `locations` array — file path + line hints attached to the call.
   * For Read/Edit this typically holds the target file.
   */
  locations?: Array<{ path?: string; line?: number }>;
}
