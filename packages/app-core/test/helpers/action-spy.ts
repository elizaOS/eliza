/**
 * ActionSpy — test helper that records ACTION_STARTED and ACTION_COMPLETED
 * events so tests can assert on which actions the agent invoked.
 *
 * Usage:
 *   const spy = createActionSpy();
 *   spy.attach(runtime);
 *   // ... send messages ...
 *   expect(spy.wasActionCalled("BLOCK_WEBSITES")).toBe(true);
 *   spy.detach(runtime);
 */
import type {
  ActionEventPayload,
  IAgentRuntime,
  UUID,
} from "@elizaos/core";
import { EventType } from "@elizaos/core";

export interface ActionSpyCall {
  phase: "started" | "completed";
  actionName: string;
  actionStatus?: string;
  actionId?: string;
  runId?: string;
  roomId: UUID;
  timestamp: number;
  payload: ActionEventPayload;
}

function extractActionName(payload: ActionEventPayload): string {
  const first = payload.content?.actions?.[0];
  return typeof first === "string" ? first : "";
}

function normalize(name: string): string {
  return name.trim().toUpperCase().replace(/_/g, "");
}

export class ActionSpy {
  private started: ActionSpyCall[] = [];
  private completed: ActionSpyCall[] = [];
  private startedHandler:
    | ((payload: ActionEventPayload) => Promise<void>)
    | null = null;
  private completedHandler:
    | ((payload: ActionEventPayload) => Promise<void>)
    | null = null;

  attach(runtime: IAgentRuntime): void {
    this.startedHandler = async (payload: ActionEventPayload) => {
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
      this.completed.push({
        phase: "completed",
        actionName: extractActionName(payload),
        actionStatus: payload.content?.actionStatus as string | undefined,
        actionId: payload.content?.actionId as string | undefined,
        runId: payload.content?.runId as string | undefined,
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
    return this.completed.some(
      (c) => normalize(c.actionName) === target,
    );
  }

  getActionCalls(name: string): ActionSpyCall[] {
    const target = normalize(name);
    return this.getCalls().filter(
      (c) => normalize(c.actionName) === target,
    );
  }
}

export function createActionSpy(): ActionSpy {
  return new ActionSpy();
}
