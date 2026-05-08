/**
 * Event-based action spy for real-time action tracking during E2E tests.
 *
 * Subscribes to `ACTION_STARTED` and `ACTION_COMPLETED` events on an
 * elizaOS `AgentRuntime` and captures every action invocation for later
 * assertion. Faster and more reliable than post-hoc database queries.
 *
 * @example
 * ```ts
 * const spy = new ActionSpy();
 * spy.attach(runtime);
 *
 * // ... trigger some agent interaction ...
 *
 * const action = await spy.waitForAction("SEND_MESSAGE", 5000);
 * expect(action?.actionStatus).not.toBe("failed");
 *
 * spy.detach(runtime);
 * ```
 */
import type { ActionEventPayload, IAgentRuntime, UUID } from "@elizaos/core";
import { EventType } from "@elizaos/core";

/**
 * One captured action lifecycle event.
 *
 * Two phases are recorded: `started` (the runtime selected and began executing
 * the action) and `completed` (the action's handler returned, success or
 * failure).
 */
export interface ActionSpyCall {
  phase: "started" | "completed";
  actionName: string;
  actionStatus?: string;
  actionId?: string;
  runId?: string;
  /**
   * True when the action's terminal output is "user must confirm before
   * dispatch" or "user must provide one missing detail" (security-sensitive ops
   * like remote desktop, sending messages, outbound calls, and draft flows that
   * stop for a date/duration). The runtime emits ACTION_COMPLETED with
   * `actionStatus: "failed"` for these even though selection + execution were
   * both correct. The benchmark scorer treats these as completed.
   */
  actionConfirmationPending?: boolean;
  roomId: UUID;
  timestamp: number;
  payload: ActionEventPayload;
}

/**
 * Backwards-compatible alias for callers that used the older eliza-side
 * `SpiedAction` shape. Prefer `ActionSpyCall` in new code.
 */
export type SpiedAction = ActionSpyCall;

function extractActionName(payload: ActionEventPayload): string {
  const first = payload.content?.actions?.[0];
  return typeof first === "string" ? first : "";
}

const CONFIRMATION_ERROR_CODES = new Set([
  "CONFIRMATION_REQUIRED",
  "NOT_CONFIRMED",
  "REQUIRES_CONFIRMATION",
  "AWAITING_CONFIRMATION",
  "NEEDS_CONFIRMATION",
  "MISSING_ARGUMENTS",
  "MISSING_REQUIRED_FIELDS",
  "MISSING_DETAILS",
  "MISSING_INPUT",
  "NEEDS_INPUT",
  "REQUIRES_INPUT",
]);

function containsConfirmationPendingText(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /pending (?:owner )?approval|requires? confirmation|confirmation required|awaiting confirmation|needs confirmation|what time should|what time would you like|when should|when would you like|how long would you like|please confirm|could you confirm|could you tell me|tell me which|tell me what|once I have|need (?:the|a|to know)/i.test(
      value,
    )
  );
}

function hasMissingInputMarker(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.requiresInput === true ||
    record.needsInput === true ||
    record.requiresConfirmation === true
  ) {
    return true;
  }
  if (
    (Array.isArray(record.missing) && record.missing.length > 0) ||
    (typeof record.missing === "string" && record.missing.trim().length > 0)
  ) {
    return true;
  }
  for (const key of ["error", "reason", "code"]) {
    const raw = record[key];
    if (typeof raw === "string") {
      const normalized = raw.trim().toUpperCase();
      if (CONFIRMATION_ERROR_CODES.has(normalized)) return true;
      if (/MISSING|REQUIRES?_?INPUT|NEEDS?_?INPUT/i.test(raw)) return true;
    }
  }
  return false;
}

/**
 * Mirrors the detection in `services/message.ts` that breaks the multi-step
 * loop when an action returns "needs human confirmation". Reads the
 * `actionResult` attached to the ACTION_COMPLETED payload.
 */
function detectConfirmationPending(payload: ActionEventPayload): boolean {
  if (containsConfirmationPendingText(payload.content?.text)) return true;
  const actionResult = (
    payload.content as { actionResult?: unknown } | undefined
  )?.actionResult;
  if (!actionResult || typeof actionResult !== "object") return false;
  const r = actionResult as Record<string, unknown>;
  if (containsConfirmationPendingText(r.text)) return true;
  const v =
    r.values && typeof r.values === "object"
      ? (r.values as Record<string, unknown>)
      : null;
  const d =
    r.data && typeof r.data === "object"
      ? (r.data as Record<string, unknown>)
      : null;
  if (v?.requiresConfirmation === true) return true;
  if (d?.requiresConfirmation === true) return true;
  if (hasMissingInputMarker(v)) return true;
  if (hasMissingInputMarker(d)) return true;
  if (typeof v?.error === "string" && CONFIRMATION_ERROR_CODES.has(v.error))
    return true;
  if (typeof d?.error === "string" && CONFIRMATION_ERROR_CODES.has(d.error))
    return true;
  return false;
}

/** Case- and underscore-insensitive name normalization used for matching. */
function normalize(name: string): string {
  return name.trim().toUpperCase().replace(/_/g, "");
}

export class ActionSpy {
  private started: ActionSpyCall[] = [];
  private completed: ActionSpyCall[] = [];
  private roomIdFilter: UUID | null = null;
  private attachedRuntime: IAgentRuntime | null = null;
  private startedHandler:
    | ((payload: ActionEventPayload) => Promise<void>)
    | null = null;
  private completedHandler:
    | ((payload: ActionEventPayload) => Promise<void>)
    | null = null;

  /** Pending waiters: resolved when a matching completed action arrives. */
  private waiters: Array<{
    normalizedName: string;
    resolve: (action: ActionSpyCall) => void;
  }> = [];

  constructor(roomIdFilter?: UUID) {
    this.roomIdFilter = roomIdFilter ?? null;
  }

  /**
   * Restrict captured events to a specific room. Pass `null` to clear the
   * filter and capture every action across the runtime.
   */
  setRoomFilter(roomId: UUID | null): void {
    this.roomIdFilter = roomId;
  }

  /**
   * Subscribe to ACTION_STARTED and ACTION_COMPLETED events on the runtime.
   * If a runtime is already attached, it is detached first.
   */
  attach(runtime: IAgentRuntime): void {
    if (this.attachedRuntime) {
      this.detach();
    }

    this.attachedRuntime = runtime;

    this.startedHandler = async (payload: ActionEventPayload) => {
      if (this.roomIdFilter && payload.roomId !== this.roomIdFilter) {
        return;
      }
      this.started.push({
        phase: "started",
        actionName: extractActionName(payload),
        actionStatus: payload.content?.actionStatus as string | undefined,
        actionId: payload.content?.actionId as string | undefined,
        runId: payload.content?.runId as string | undefined,
        roomId: payload.roomId,
        timestamp: Date.now(),
        payload,
      });
    };
    this.completedHandler = async (payload: ActionEventPayload) => {
      if (this.roomIdFilter && payload.roomId !== this.roomIdFilter) {
        return;
      }
      const call: ActionSpyCall = {
        phase: "completed",
        actionName: extractActionName(payload),
        actionStatus: payload.content?.actionStatus as string | undefined,
        actionId: payload.content?.actionId as string | undefined,
        runId: payload.content?.runId as string | undefined,
        actionConfirmationPending: detectConfirmationPending(payload),
        roomId: payload.roomId,
        timestamp: Date.now(),
        payload,
      };
      this.completed.push(call);
      this.resolveWaiters(call);
    };
    runtime.registerEvent(EventType.ACTION_STARTED, this.startedHandler);
    runtime.registerEvent(EventType.ACTION_COMPLETED, this.completedHandler);
  }

  /**
   * Unsubscribe from the runtime's event bus. The `runtime` argument is
   * optional; if omitted, the runtime captured at `attach()` time is used.
   * Safe to call when not attached.
   */
  detach(runtime?: IAgentRuntime): void {
    const target = runtime ?? this.attachedRuntime;
    if (!target) return;
    if (this.startedHandler) {
      target.unregisterEvent(EventType.ACTION_STARTED, this.startedHandler);
      this.startedHandler = null;
    }
    if (this.completedHandler) {
      target.unregisterEvent(EventType.ACTION_COMPLETED, this.completedHandler);
      this.completedHandler = null;
    }
    this.attachedRuntime = null;
  }

  /** Clear all captured calls and pending waiters. */
  reset(): void {
    this.started = [];
    this.completed = [];
    this.waiters = [];
  }

  /** Alias for `reset()` retained for callers that used the eliza API. */
  clear(): void {
    this.reset();
  }

  /** All captured calls (started + completed) sorted by timestamp ascending. */
  getCalls(): ActionSpyCall[] {
    return [...this.started, ...this.completed].sort(
      (a, b) => a.timestamp - b.timestamp,
    );
  }

  /** Alias for `getCalls()` retained for callers that used the eliza API. */
  getActions(): ActionSpyCall[] {
    return this.getCalls();
  }

  getStartedCalls(): ActionSpyCall[] {
    return [...this.started];
  }

  getCompletedCalls(): ActionSpyCall[] {
    return [...this.completed];
  }

  /** Alias for `getCompletedCalls()` for eliza-API compatibility. */
  getCompletedActions(): ActionSpyCall[] {
    return this.getCompletedCalls();
  }

  /** True if any started or completed call matches the given action name. */
  wasActionCalled(name: string): boolean {
    const target = normalize(name);
    return (
      this.started.some((c) => normalize(c.actionName) === target) ||
      this.completed.some((c) => normalize(c.actionName) === target)
    );
  }

  /** All matching calls (started + completed) for a given action name. */
  getActionCalls(name: string): ActionSpyCall[] {
    const target = normalize(name);
    return this.getCalls().filter((c) => normalize(c.actionName) === target);
  }

  /**
   * Return a promise that resolves when a completed action with the given
   * name is captured, or rejects after `timeoutMs` milliseconds. If a
   * matching completed action already exists in the buffer, resolves
   * immediately.
   */
  waitForAction(name: string, timeoutMs = 10_000): Promise<ActionSpyCall> {
    const normalized = normalize(name);

    const existing = this.completed.find(
      (c) => normalize(c.actionName) === normalized,
    );
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise<ActionSpyCall>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const wrappedResolve = (action: ActionSpyCall) => {
        clearTimeout(timer);
        resolve(action);
      };

      timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === wrappedResolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(
          new Error(
            `ActionSpy: timed out waiting for action "${name}" after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this.waiters.push({
        normalizedName: normalized,
        resolve: wrappedResolve,
      });
    });
  }

  private resolveWaiters(action: ActionSpyCall): void {
    const normalized = normalize(action.actionName);
    if (this.waiters.length === 0) return;
    const remaining: typeof this.waiters = [];
    const matched: typeof this.waiters = [];
    for (const w of this.waiters) {
      if (w.normalizedName === normalized) matched.push(w);
      else remaining.push(w);
    }
    this.waiters = remaining;
    for (const w of matched) w.resolve(action);
  }
}

export function createActionSpy(roomIdFilter?: UUID): ActionSpy {
  return new ActionSpy(roomIdFilter);
}
