import type {
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type {
  AcpJsonRpcMessage,
  ApprovalPreset,
  AvailableAgentInfo,
  PromptResult,
  SessionEventName,
  SessionInfo,
  SpawnOptions,
  SpawnResult,
} from "../services/types.js";

export interface AcpActionService {
  defaultApprovalPreset?: ApprovalPreset;
  agentSelectionStrategy?: string;
  spawnSession(opts: SpawnOptions): Promise<SpawnResult>;
  sendPrompt?(
    sessionId: string,
    text: string,
    opts?: { timeoutMs?: number; model?: string },
  ): Promise<PromptResult>;
  sendToSession(sessionId: string, input: string): Promise<PromptResult>;
  sendKeysToSession(sessionId: string, keys?: string): Promise<void>;
  stopSession(sessionId: string, force?: boolean): Promise<void>;
  cancelSession?(sessionId: string): Promise<void>;
  listSessions(): SessionInfo[] | Promise<SessionInfo[]>;
  getSession(
    sessionId: string,
  ): SessionInfo | undefined | Promise<SessionInfo | null | undefined>;
  resolveAgentType?(
    selection?: Record<string, unknown>,
  ): Promise<string> | string;
  checkAvailableAgents?(types?: string[]): Promise<AvailableAgentInfo[]>;
  getAvailableAgents?(): Promise<AvailableAgentInfo[]>;
  onSessionEvent?(
    handler: (
      sessionId: string,
      event: SessionEventName,
      data: unknown,
    ) => void,
  ): () => void;
  onAcpEvent?(
    handler: (event: AcpJsonRpcMessage, sessionId?: string) => void,
  ): () => void;
  emitSessionEvent?(
    sessionId: string,
    event: SessionEventName,
    data: unknown,
  ): void;
}

export type HandlerOptionsLike =
  | { parameters?: Record<string, unknown> }
  | Record<string, unknown>;

/**
 * Resolve the live coding-agent spawn service. Despite the historical
 * `getAcpService` name, the PTYService (the orchestrator path that spawns
 * via `coding-agent-adapters` — claude/codex/gemini/aider, plus opencode)
 * is preferred — that's the working path live deployments actually use.
 * ACP-prefixed services remain as fallbacks for environments where someone
 * has wired `acpx` (Agent Communication Protocol) as the primary route.
 *
 * Before this preference change, ACP_SUBPROCESS_SERVICE was tried first
 * and (when present + registered) silently shadowed the working PTY path,
 * so the same `TASKS_SPAWN_AGENT` / `TASKS:create` action surface produced
 * different spawn pipelines depending on whether `acpx` happened to
 * register cleanly. Prefer-PTY makes the planner-visible spawn path
 * deterministic: it's always the orchestrator, regardless of ACP state.
 */
export function getAcpService(
  runtime: IAgentRuntime,
): AcpActionService | undefined {
  return (runtime.getService?.("PTY_SERVICE") ??
    runtime.getService?.("ACP_SERVICE") ??
    runtime.getService?.("ACP_SUBPROCESS_SERVICE") ??
    undefined) as AcpActionService | undefined;
}

export function logger(runtime: IAgentRuntime) {
  return runtime.logger ?? {};
}

export function contentRecord(message: Memory): Record<string, unknown> {
  return message.content && typeof message.content === "object"
    ? (message.content as Record<string, unknown>)
    : {};
}

export function paramsRecord(
  options?: HandlerOptionsLike,
): Record<string, unknown> {
  const maybeParams =
    options && "parameters" in options ? options.parameters : undefined;
  return maybeParams && typeof maybeParams === "object"
    ? (maybeParams as Record<string, unknown>)
    : {};
}

export function pickString(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = params[name] ?? content[name];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function pickBoolean(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const value = params[name] ?? content[name];
  return typeof value === "boolean" ? value : undefined;
}

export function pickNumber(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = params[name] ?? content[name];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function messageText(message: Memory): string {
  if (typeof message.content === "string") return message.content;
  const content = contentRecord(message);
  return typeof content.text === "string" ? content.text : "";
}

export function hasExplicitPayload(message: Memory, fields: string[]): boolean {
  const content = contentRecord(message);
  return fields.some((field) => typeof content[field] === "string");
}

export function looksLikeTaskAgentRequest(text: string): boolean {
  if (!text.trim()) return true;
  return /\b(code|debug|fix|implement|investigate|research|summari[sz]e|write|plan|delegate|subagent|agent|repo|test|build|refactor|analy[sz]e|document|automate|script|issue|pr|pull request)\b/i.test(
    text,
  );
}

export function shortId(id: string): string {
  return id.slice(0, 8).toLowerCase();
}

export function labelFor(
  session: Pick<SessionInfo, "id" | "name" | "metadata">,
): string {
  return typeof session.metadata?.label === "string"
    ? session.metadata.label
    : (session.name ?? shortId(session.id));
}

export function newestSession(
  sessions: SessionInfo[],
): SessionInfo | undefined {
  return sessions
    .slice()
    .sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime() -
        new Date(a.lastActivityAt).getTime(),
    )[0];
}

export async function listSessionsWithin(
  service: AcpActionService,
  timeoutMs = 2000,
): Promise<SessionInfo[]> {
  return Promise.race([
    Promise.resolve(service.listSessions()),
    new Promise<SessionInfo[]>((resolve) =>
      setTimeout(() => resolve([]), timeoutMs),
    ),
  ]);
}

export async function validateHasSessions(
  runtime: IAgentRuntime,
): Promise<boolean> {
  const service = getAcpService(runtime);
  if (!service) return false;
  try {
    const sessions = await listSessionsWithin(service, 2000);
    return sessions.length > 0;
  } catch {
    return false;
  }
}

export async function callbackText(
  callback: HandlerCallback | undefined,
  text: string,
): Promise<void> {
  if (callback) await callback({ text });
}

export function errorResult(error: string, text?: string): ActionResult {
  return { success: false, error, ...(text ? { text } : {}) };
}

export async function resolveSession(
  service: AcpActionService,
  sessionId: string | undefined,
  state?: State,
): Promise<{
  session?: SessionInfo;
  missingId?: string;
  sessions: SessionInfo[];
}> {
  const stateSession = (
    state as { codingSession?: { id?: string } } | undefined
  )?.codingSession?.id;
  const targetId = sessionId ?? stateSession;
  if (targetId) {
    const found = await Promise.resolve(service.getSession(targetId));
    return {
      session: found ?? undefined,
      missingId: found ? undefined : targetId,
      sessions: [],
    };
  }
  const sessions = await Promise.resolve(service.listSessions());
  return { session: newestSession(sessions), sessions };
}

export function setCurrentSession(
  state: State | undefined,
  session: SpawnResult | SessionInfo,
): void {
  if (state) (state as { codingSession?: unknown }).codingSession = session;
}

export function setCurrentSessions(
  state: State | undefined,
  sessions: SpawnResult[],
): void {
  if (state) (state as { codingSessions?: unknown }).codingSessions = sessions;
}

export function emitSessionEvent(
  service: AcpActionService,
  sessionId: string,
  event: SessionEventName,
  data: unknown,
): void {
  service.emitSessionEvent?.(sessionId, event, data);
}

export function parseApproval(
  value: string | undefined,
): ApprovalPreset | undefined {
  if (
    value === "readonly" ||
    value === "standard" ||
    value === "permissive" ||
    value === "autonomous"
  )
    return value;
  return undefined;
}

export function isAuthError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /auth|login|credential|unauthorized|forbidden|permission/i.test(text);
}

export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getTimeoutMs(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
): number | undefined {
  return (
    pickNumber(params, content, "timeout_ms") ??
    pickNumber(params, content, "timeoutMs")
  );
}
