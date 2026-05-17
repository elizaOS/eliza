import type {
  ActionEventPayload,
  EventHandler,
  IAgentRuntime,
} from "@elizaos/core";
import { EventType } from "@elizaos/core";

/**
 * Captured action invocation from the runtime event bus.
 */
export interface SpiedAction {
  /** Action name (e.g. "MESSAGE") */
  name: string;
  /** Whether this event represents a start or completion */
  status: "started" | "completed";
  /** Whether the action succeeded (only present on completed events) */
  success?: boolean;
  /** Unix timestamp (ms) when the event was captured */
  timestamp: number;
  /** Run ID from the action context, if available */
  runId?: string;
  /** Raw payload data from the event */
  data?: unknown;
}

type ActionHandler = EventHandler<typeof EventType.ACTION_STARTED>;

/**
 * Normalize an action name for comparison: lowercase and strip underscores/hyphens.
 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "");
}

/**
 * Extract the action name from an ActionEventPayload.
 * The runtime emits content.actions as a string array; take the first entry.
 */
function extractActionName(payload: ActionEventPayload): string {
  return payload.content?.actions?.[0] ?? "UNKNOWN";
}

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
 * const action = await spy.waitForAction("MESSAGE", 5000);
 * expect(action.success).toBe(true);
 *
 * spy.detach();
 * ```
 */
export class ActionSpy {
  private actions: SpiedAction[] = [];
  private runtime: IAgentRuntime | null = null;
  private onStarted: ActionHandler | null = null;
  private onCompleted: ActionHandler | null = null;

  /** Pending waiters: resolved when a matching completed action arrives. */
  private waiters: Array<{
    normalizedName: string;
    resolve: (action: SpiedAction) => void;
  }> = [];

  /**
   * Subscribe to ACTION_STARTED and ACTION_COMPLETED events on the runtime.
   * Only one runtime can be attached at a time; call `detach()` first to switch.
   */
  attach(runtime: IAgentRuntime): void {
    if (this.runtime) {
      this.detach();
    }

    this.runtime = runtime;

    this.onStarted = async (payload: ActionEventPayload) => {
      const name = extractActionName(payload);
      this.actions.push({
        name,
        status: "started",
        timestamp: Date.now(),
        runId: (payload.content as Record<string, unknown>)?.runId as
          | string
          | undefined,
        data: payload.content,
      });
    };

    this.onCompleted = async (payload: ActionEventPayload) => {
      const name = extractActionName(payload);
      const actionStatus = (payload.content as Record<string, unknown>)
        ?.actionStatus as string | undefined;
      const success = actionStatus !== "failed";

      const spied: SpiedAction = {
        name,
        status: "completed",
        success,
        timestamp: Date.now(),
        runId: (payload.content as Record<string, unknown>)?.runId as
          | string
          | undefined,
        data: payload.content,
      };

      this.actions.push(spied);
      this.resolveWaiters(spied);
    };

    runtime.registerEvent(EventType.ACTION_STARTED, this.onStarted);
    runtime.registerEvent(EventType.ACTION_COMPLETED, this.onCompleted);
  }

  /**
   * Unsubscribe from the runtime's event bus.
   * Safe to call even if not currently attached.
   */
  detach(): void {
    if (!this.runtime) {
      return;
    }

    // The runtime has no removeEvent API, so we splice our handlers out
    // of the internal event arrays directly.
    if (this.onStarted) {
      this.removeHandler(EventType.ACTION_STARTED, this.onStarted);
    }
    if (this.onCompleted) {
      this.removeHandler(EventType.ACTION_COMPLETED, this.onCompleted);
    }

    this.onStarted = null;
    this.onCompleted = null;
    this.runtime = null;
  }

  /**
   * Clear all captured actions and pending waiters.
   */
  clear(): void {
    this.actions = [];
    this.waiters = [];
  }

  /**
   * Return all captured actions (started and completed).
   */
  getActions(): SpiedAction[] {
    return [...this.actions];
  }

  /**
   * Return only completed actions.
   */
  getCompletedActions(): SpiedAction[] {
    return this.actions.filter((a) => a.status === "completed");
  }

  /**
   * Check whether an action with the given name was invoked (started or completed).
   * Comparison is case-insensitive and ignores underscores/hyphens.
   */
  wasActionCalled(name: string): boolean {
    const normalized = normalizeName(name);
    return this.actions.some((a) => normalizeName(a.name) === normalized);
  }

  /**
   * Return a promise that resolves when a completed action with the given name
   * is captured, or rejects after `timeoutMs` milliseconds.
   *
   * If a matching completed action already exists in the buffer, resolves
   * immediately.
   *
   * @param name - Action name (case-insensitive, underscore/hyphen-normalized)
   * @param timeoutMs - Maximum time to wait (default 10 000 ms)
   */
  waitForAction(name: string, timeoutMs = 10_000): Promise<SpiedAction> {
    const normalized = normalizeName(name);

    // Check if already captured
    const existing = this.actions.find(
      (a) => a.status === "completed" && normalizeName(a.name) === normalized,
    );
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise<SpiedAction>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const wrappedResolve = (action: SpiedAction) => {
        clearTimeout(timer);
        resolve(action);
      };

      timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === wrappedResolve);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
        }
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

  // ---- internal helpers ----

  private resolveWaiters(action: SpiedAction): void {
    const normalized = normalizeName(action.name);
    const matched: number[] = [];

    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].normalizedName === normalized) {
        matched.push(i);
      }
    }

    // Resolve in reverse index order so splicing doesn't shift later indices
    for (let i = matched.length - 1; i >= 0; i--) {
      const waiter = this.waiters[matched[i]];
      this.waiters.splice(matched[i], 1);
      waiter.resolve(action);
    }
  }

  /**
   * Remove a specific handler from the runtime's internal event array.
   * The runtime exposes `events` (a record of handler arrays) but no
   * removal API, so we splice the handler out directly.
   */
  private removeHandler(event: string, handler: ActionHandler): void {
    const handlers = this.runtime?.events?.[event];
    if (!Array.isArray(handlers)) {
      return;
    }
    const idx = handlers.indexOf(handler as never);
    if (idx !== -1) {
      handlers.splice(idx, 1);
    }
  }
}
