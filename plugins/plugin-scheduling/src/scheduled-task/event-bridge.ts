/**
 * Runtime-event → ScheduledTask fire bridge.
 *
 * `trigger.kind = "event"` tasks are push-fired: `isScheduledTaskDue`
 * deliberately reports them not-due (the tick never wall-clock fires them),
 * so something must map bus events onto `runner.fireWithResult`. This module
 * is that mapping: a consumer (e.g. `@elizaos/plugin-personal-assistant`)
 * installs a `runtime.registerEvent` handler per registered event kind, and
 * every `runtime.emitEvent(eventKind, payload)` fires the scheduled tasks
 * whose trigger matches `{ kind: "event", eventKind }` and whose optional
 * `filter` subset-matches the emitted payload.
 *
 * Race safety: firing goes through `fireWithResult`, whose store-level
 * atomic claim (`scheduled` → `fired`) guarantees one dispatch per task even
 * when the same event is emitted concurrently — the loser observes `raced`.
 */

import { type EventPayload, type IAgentRuntime, logger } from "@elizaos/core";
import type {
  ScheduledTaskFireResult,
  ScheduledTaskRunnerHandle,
} from "./runner.js";

const LOG_SRC = "ScheduledTaskEventBridge";

/**
 * The narrow runner surface the bridge needs. `list` finds candidate tasks;
 * `fireWithResult` performs the race-safe fire.
 */
export type EventBridgeRunner = Pick<
  ScheduledTaskRunnerHandle,
  "list" | "fireWithResult"
>;

/**
 * Subset-match an event trigger's `filter` against the emitted payload.
 *
 * Contract:
 *  - `undefined` / `null` filter matches every payload.
 *  - A plain-object filter matches when EVERY key it declares deep-equals the
 *    corresponding payload field (payloads may carry extra fields).
 *  - Arrays and primitives require exact deep equality.
 */
export function eventFilterMatches(filter: unknown, payload: unknown): boolean {
  if (filter === undefined || filter === null) return true;
  return subsetDeepEquals(filter, payload);
}

function subsetDeepEquals(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return false;
    }
    return expected.every((item, index) =>
      subsetDeepEquals(item, actual[index]),
    );
  }
  if (
    typeof expected === "object" &&
    expected !== null &&
    typeof actual === "object" &&
    actual !== null &&
    !Array.isArray(actual)
  ) {
    return Object.entries(expected as Record<string, unknown>).every(
      ([key, value]) =>
        subsetDeepEquals(value, (actual as Record<string, unknown>)[key]),
    );
  }
  return false;
}

export interface FireEventTriggeredTasksArgs {
  runner: EventBridgeRunner;
  eventKind: string;
  payload?: unknown;
}

export interface EventTriggeredFireOutcome {
  /** One entry per matched task, in `list` order. */
  results: Array<{ taskId: string; result: ScheduledTaskFireResult }>;
  /** Store/runner errors per task — surfaced, never swallowed silently. */
  errors: Array<{ taskId: string; message: string }>;
}

/**
 * Fire every `scheduled` task whose trigger matches the emitted event.
 * Per-task errors are collected (and logged by the installer's handler) so
 * one broken row cannot starve the other listeners of the same event.
 */
export async function fireEventTriggeredTasks(
  args: FireEventTriggeredTasksArgs,
): Promise<EventTriggeredFireOutcome> {
  const scheduled = await args.runner.list({ status: "scheduled" });
  const outcome: EventTriggeredFireOutcome = { results: [], errors: [] };
  for (const task of scheduled) {
    if (task.trigger.kind !== "event") continue;
    if (task.trigger.eventKind !== args.eventKind) continue;
    if (!eventFilterMatches(task.trigger.filter, args.payload)) continue;
    try {
      const result = await args.runner.fireWithResult(task.taskId, {
        eventPayload: args.payload,
      });
      outcome.results.push({ taskId: task.taskId, result });
    } catch (error) {
      outcome.errors.push({
        taskId: task.taskId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcome;
}

export interface InstallScheduledTaskEventBridgeArgs {
  runtime: IAgentRuntime;
  /**
   * The event kinds to subscribe. Consumers enumerate their
   * `EventKindRegistry` (events registered AFTER install are not picked up —
   * re-install or install after registry population).
   */
  eventKinds: readonly string[];
  /**
   * Resolved per event so the bridge always fires through the current cached
   * runner (never a stale handle with a frozen clock).
   */
  getRunner: () => EventBridgeRunner;
}

/**
 * Subscribe `runtime.emitEvent(eventKind, …)` to event-triggered task fires.
 * Returns an uninstall function that unregisters every handler.
 *
 * The handler strips the non-data envelope fields (`runtime`, `onComplete`)
 * from the payload before filter matching and before the payload is handed to
 * `fireWithResult` as the persisted `eventPayload`. `source` is kept: it is a
 * plain producer string and a legitimate filter target.
 */
export function installScheduledTaskEventBridge(
  args: InstallScheduledTaskEventBridgeArgs,
): () => void {
  const { runtime, getRunner } = args;
  const registrations: Array<{
    eventKind: string;
    handler: (params: EventPayload) => Promise<void>;
  }> = [];
  for (const eventKind of args.eventKinds) {
    const handler = async (params: EventPayload): Promise<void> => {
      const { runtime: _runtime, onComplete: _onComplete, ...payload } = params;
      const outcome = await fireEventTriggeredTasks({
        runner: getRunner(),
        eventKind,
        payload,
      });
      for (const failure of outcome.errors) {
        logger.error(
          {
            src: LOG_SRC,
            agentId: runtime.agentId,
            eventKind,
            taskId: failure.taskId,
          },
          `[${LOG_SRC}] event-triggered fire failed: ${failure.message}`,
        );
      }
    };
    runtime.registerEvent(eventKind, handler);
    registrations.push({ eventKind, handler });
  }
  return () => {
    for (const { eventKind, handler } of registrations) {
      runtime.unregisterEvent(eventKind, handler);
    }
  };
}
