/** Records action lifecycle events so tests can assert which actions ran. */
import type { ActionEventPayload, IAgentRuntime, UUID } from "@elizaos/core";
import { EventType } from "@elizaos/core";

export interface ActionSpyCall {
  phase: "started" | "completed";
  actionName: string;
  actionStatus?: string;
  actionId?: string;
  runId?: string;
  /**
   * True when the action's terminal output is "user must confirm before
   * dispatch" (security-sensitive ops like remote desktop, sending messages,
   * outbound calls). The runtime emits ACTION_COMPLETED with
   * `actionStatus: "failed"` for these even though selection + execution were
   * both correct. The benchmark scorer treats these as completed.
   */
  actionConfirmationPending?: boolean;
  roomId: UUID;
  timestamp: number;
  payload: ActionEventPayload;
}

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
]);

/**
 * Mirrors the detection in `services/message.ts` that breaks the multi-step
 * loop when an action returns "needs human confirmation". Reads the
 * `actionResult` attached to the ACTION_COMPLETED payload.
 */
function detectConfirmationPending(payload: ActionEventPayload): boolean {
  const actionResult = (
    payload.content as { actionResult?: unknown } | undefined
  )?.actionResult;
  if (!actionResult || typeof actionResult !== "object") return false;
  const r = actionResult as Record<string, unknown>;
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
  if (typeof v?.error === "string" && CONFIRMATION_ERROR_CODES.has(v.error))
    return true;
  if (typeof d?.error === "string" && CONFIRMATION_ERROR_CODES.has(d.error))
    return true;
  return false;
}

function normalize(name: string): string {
  return name.trim().toUpperCase().replace(/_/g, "");
}

export class ActionSpy {
  private started: ActionSpyCall[] = [];
  private completed: ActionSpyCall[] = [];
  private roomIdFilter: UUID | null = null;
  private startedHandler:
    | ((payload: ActionEventPayload) => Promise<void>)
    | null = null;
  private completedHandler:
    | ((payload: ActionEventPayload) => Promise<void>)
    | null = null;

  constructor(roomIdFilter?: UUID) {
    this.roomIdFilter = roomIdFilter ?? null;
  }

  setRoomFilter(roomId: UUID | null): void {
    this.roomIdFilter = roomId;
  }

  attach(runtime: IAgentRuntime): void {
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
      this.completed.push({
        phase: "completed",
        actionName: extractActionName(payload),
        actionStatus: payload.content?.actionStatus as string | undefined,
        actionId: payload.content?.actionId as string | undefined,
        runId: payload.content?.runId as string | undefined,
        actionConfirmationPending: detectConfirmationPending(payload),
        roomId: payload.roomId,
        timestamp: Date.now(),
        payload,
      });
    };
    runtime.registerEvent(EventType.ACTION_STARTED, this.startedHandler);
    runtime.registerEvent(EventType.ACTION_COMPLETED, this.completedHandler);
  }

  detach(runtime: IAgentRuntime): void {
    if (this.startedHandler) {
      runtime.unregisterEvent(EventType.ACTION_STARTED, this.startedHandler);
      this.startedHandler = null;
    }
    if (this.completedHandler) {
      runtime.unregisterEvent(
        EventType.ACTION_COMPLETED,
        this.completedHandler,
      );
      this.completedHandler = null;
    }
  }

  reset(): void {
    this.started = [];
    this.completed = [];
  }

  getCalls(): ActionSpyCall[] {
    return [...this.started, ...this.completed].sort(
      (a, b) => a.timestamp - b.timestamp,
    );
  }

  getStartedCalls(): ActionSpyCall[] {
    return [...this.started];
  }

  getCompletedCalls(): ActionSpyCall[] {
    return [...this.completed];
  }

  wasActionCalled(name: string): boolean {
    const target = normalize(name);
    return this.completed.some((c) => normalize(c.actionName) === target);
  }

  getActionCalls(name: string): ActionSpyCall[] {
    const target = normalize(name);
    return this.getCalls().filter((c) => normalize(c.actionName) === target);
  }
}

export function createActionSpy(): ActionSpy {
  return new ActionSpy();
}
