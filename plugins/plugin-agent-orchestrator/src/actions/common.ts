import type {
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
  StateValue,
  UUID,
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
import { TERMINAL_SESSION_STATUSES } from "../services/types.js";

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
  getSessionOutput?(sessionId: string, lines?: number): Promise<string>;
  listSessions(): SessionInfo[] | Promise<SessionInfo[]>;
  getSession(
    sessionId: string,
  ): SessionInfo | undefined | Promise<SessionInfo | null | undefined>;
  findResumableSessionByLabel?(
    label: string,
    workdir: string,
  ): Promise<SessionInfo | undefined>;
  resumeOrphanedBusySessions?(): Promise<{
    resumed: number;
    skipped: number;
  }>;
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

export function getAcpService(
  runtime: IAgentRuntime,
): AcpActionService | undefined {
  // Single-step cast: getService returns Service|null; AcpActionService is a
  // plain interface (no Service base) so we can't use the generic parameter,
  // but the structural types are non-conflicting so one cast suffices.
  return (runtime.getService?.("ACP_SERVICE") ??
    runtime.getService?.("ACP_SUBPROCESS_SERVICE") ??
    undefined) as AcpActionService | undefined;
}

export function logger(runtime: IAgentRuntime): IAgentRuntime["logger"] {
  return runtime.logger;
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

function pickNumber(
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

/**
 * Read the genuine user request text off a message.
 *
 * Connectors stamp the raw human message into `content.currentMessageText`
 * (the discord connector does this via `extraContent.currentMessageText`)
 * while `content.text` may be an envelope-wrapped header, a planner
 * rephrasing, or empty. The canonical core reader (`getUserMessageText`)
 * prefers `currentMessageText`; we inline the same precedence here to avoid a
 * cross-package barrel/build dependency. The orchestrator's narrow
 * `messageText()` only reads `content.text`, which is exactly why the terse
 * claude path dropped the route keyword.
 */
function userRequestFromMessage(message: Memory): string {
  const content = contentRecord(message);
  const raw =
    typeof content.currentMessageText === "string" &&
    content.currentMessageText.trim().length > 0
      ? content.currentMessageText
      : typeof content.text === "string"
        ? content.text
        : "";
  return raw.trim();
}

/**
 * The actual conversation `Memory[]` the runtime composed into state before
 * this action ran. `recentMessagesProvider` writes it to
 * `state.data.providers.RECENT_MESSAGES.data.recentMessages`; this is the
 * vetted access pattern (see core plugin-manager `relevance.ts`). Unlike a
 * fresh `getMemories` read, this is already populated synchronously at action
 * time, so it does not hit the "current message not yet persisted" race.
 */
function recentMessagesFromState(state: State | undefined): Memory[] {
  const messages = (
    state?.data as
      | {
          providers?: {
            RECENT_MESSAGES?: { data?: { recentMessages?: unknown } };
          };
        }
      | undefined
  )?.providers?.RECENT_MESSAGES?.data?.recentMessages;
  return Array.isArray(messages) ? (messages as Memory[]) : [];
}

/**
 * Resolve the genuine originating user request for workdir-route matching.
 *
 * Workdir routes (`TASK_AGENT_WORKDIR_ROUTES`) match keyword phrases like
 * "web page" against `${userRequest}\n${task}`. Feeding only the planner's
 * `task` argument is unreliable: with a verbose planner (gpt-oss /
 * TASKS_CREATE) the user's wording survives, but with a terser planner
 * (claude / TASKS_SPAWN_AGENT) the action arrives with the planner's
 * rephrasing — and the orchestrator's `messageText()` only reads
 * `content.text`, which may be envelope-wrapped or empty — dropping the route
 * keyword and silently falling the spawn back to the default ACP workspace.
 * Builds then land in the wrong directory and never get hosted.
 *
 * The fix is planner-independent and reads only sources that are guaranteed
 * populated synchronously at action time (no DB round-trip, no persistence
 * race — the failure mode of the earlier `getMemories`-first attempt):
 *   1. the message's own `content.currentMessageText` (the raw human request
 *      the connector stamped), via `userRequestFromMessage`;
 *   2. the newest non-agent message in the state-composed conversation window
 *      (`state.data.providers.RECENT_MESSAGES.data.recentMessages`) — covers
 *      the case where the action message is a synthetic re-plan trigger but
 *      the user's original request is still in the dialogue;
 *   3. a bounded `getMemories` read, kept ONLY as a last resort.
 *
 * Fail-open: every source is optional and the result is unioned with the
 * action's own text, so routing never regresses below today's behavior.
 */
export async function resolveOriginatingRequestText(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  opts: { timeoutMs?: number; scanLimit?: number } = {},
): Promise<string> {
  // Primary: the raw request carried on the current message itself.
  const direct = userRequestFromMessage(message);

  // Secondary: the newest genuine (non-agent) request already in the
  // state-composed conversation window. Synchronous; no persistence race.
  const fromState = recentMessagesFromState(state)
    .filter((m) => m.entityId && m.entityId !== runtime.agentId)
    .map(userRequestFromMessage)
    .filter((text) => text.length > 0 && text !== direct)
    .at(-1);
  if (fromState) {
    return direct ? `${fromState}\n${direct}` : fromState;
  }

  // Last resort: a bounded room read. Demoted below the synchronous sources
  // because at spawn time the CURRENT user message is mid-processing and not
  // yet persisted, so this can only return older/stale messages.
  const roomId = message.roomId;
  if (typeof runtime.getMemories !== "function" || !roomId) {
    return direct;
  }
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const scanLimit = opts.scanLimit ?? 8;
  let recent: Memory[] = [];
  try {
    recent = await Promise.race([
      runtime.getMemories({
        roomId: roomId as UUID,
        tableName: "messages",
        count: scanLimit,
        unique: false,
        includeEmbedding: false,
      }),
      new Promise<Memory[]>((resolve) =>
        setTimeout(() => resolve([]), timeoutMs),
      ),
    ]);
  } catch {
    return direct;
  }
  const latestUserText = recent
    .filter((m) => m.entityId && m.entityId !== runtime.agentId)
    .map(userRequestFromMessage)
    .find((text) => text.length > 0);
  if (!latestUserText || latestUserText === direct) {
    return direct;
  }
  return direct ? `${latestUserText}\n${direct}` : latestUserText;
}

export function hasExplicitPayload(message: Memory, fields: string[]): boolean {
  const content = contentRecord(message);
  return fields.some((field) => typeof content[field] === "string");
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

/**
 * Block until the number of in-flight sub-agent sessions drops below the
 * configured ceiling, so concurrent spawns don't stampede the model
 * provider.
 *
 * Why this exists: coding sub-agents (opencode + gpt-oss-class models on
 * Cerebras / other OpenAI-compatible providers) degrade hard under
 * concurrent load — the provider rate-limits, and the model responds by
 * silently skipping its Write/tool calls and "completing" with a text-only
 * answer. One build at a time succeeds; four at once produces one good
 * build and three empty workdirs. Serialising spawns past a small ceiling
 * trades a little latency for builds that actually land.
 *
 * Bounded and self-correcting: it polls real session state (no permits to
 * leak), and gives up waiting after `maxWaitMs` so a wedged session can
 * never deadlock the queue — the spawn just proceeds.
 *
 * Tunable via `ELIZA_MAX_CONCURRENT_SPAWNS` (default 2). Set to 0 or a
 * negative value to disable the gate entirely.
 */
export async function waitForSpawnSlot(
  runtime: IAgentRuntime,
  service: AcpActionService,
  opts: { maxWaitMs?: number; pollMs?: number } = {},
): Promise<void> {
  const limitRaw =
    (typeof runtime.getSetting === "function"
      ? (runtime.getSetting("ELIZA_MAX_CONCURRENT_SPAWNS") as
          | string
          | undefined)
      : undefined) ?? process.env.ELIZA_MAX_CONCURRENT_SPAWNS;
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 2;
  if (!Number.isFinite(limit) || limit <= 0) return;
  const maxWaitMs = opts.maxWaitMs ?? 8 * 60_000;
  const pollMs = opts.pollMs ?? 3_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    let active = 0;
    try {
      const sessions = await listSessionsWithin(service, 2000);
      active = sessions.filter(
        (s) => !TERMINAL_SESSION_STATUSES.has(String(s.status)),
      ).length;
    } catch {
      // If we can't read session state, don't block the spawn.
      return;
    }
    if (active < limit) return;
    logger(runtime).debug(
      `[spawn-gate] ${active} sub-agent session(s) active (limit=${limit}); waiting for a slot`,
    );
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  logger(runtime).warn(
    `[spawn-gate] still over the concurrency limit after ${Math.round(maxWaitMs / 1000)}s; proceeding anyway`,
  );
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

/** Read the session id stored in state by setCurrentSession / setCurrentSessions. */
function stateSessionId(state: State | undefined): string | undefined {
  const session = state?.codingSession;
  if (session !== null && typeof session === "object" && "id" in session) {
    const { id } = session as { id?: string };
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
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
  const stateSession = stateSessionId(state);
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
  if (state) state.codingSession = session as StateValue;
}

export function setCurrentSessions(
  state: State | undefined,
  sessions: SpawnResult[],
): void {
  if (state) state.codingSessions = sessions as StateValue;
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
