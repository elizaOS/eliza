/**
 * Trigger event bridge — routes runtime event-bus emissions to enabled
 * event-kind triggers via the existing `executeTriggerTask` pipeline.
 *
 * `executeTriggerTask` already handles `source: "event"` (see
 * `eliza/packages/agent/src/triggers/runtime.ts`), but nothing in the
 * runtime subscribes to `MESSAGE_RECEIVED` etc. and routes the payload
 * through it. Without this bridge, event-kind triggers can be created
 * and stored but will never fire from a real Discord / Telegram / WeChat
 * message.
 *
 * On `start()` the bridge calls `runtime.registerEvent(eventType, handler)`
 * for every `EventType` in `EXPOSED_EVENTS`. Each handler:
 *   1. Honours the `ELIZA_TRIGGERS_ENABLED` kill switch.
 *   2. Lists enabled trigger tasks via `listTriggerTasks(runtime)`.
 *   3. Filters to `triggerType === "event" && eventKind === <the event>`.
 *   4. Rate-limits per-trigger so a chatty channel cannot DoS the
 *      autonomy loop (default 1000 ms floor per trigger).
 *   5. Calls `executeTriggerTask(runtime, task, { source: "event", event })`
 *      for each permitted trigger, isolating each dispatch so one bad
 *      trigger does not break sibling dispatches.
 *
 * `stop()` unregisters every handler (using the original function
 * reference) and clears the rate-limit map.
 */

import {
  executeTriggerTask,
  listTriggerTasks,
  readTriggerConfig,
  triggersFeatureEnabled,
} from "@elizaos/agent/triggers/runtime";
import {
  type AgentRuntime,
  type EventPayload,
  type EventPayloadMap,
  EventType,
  type IAgentRuntime,
  type Task,
  type UUID,
} from "@elizaos/core";

const DEFAULT_MIN_INTERVAL_MS = 1_000;

/**
 * Core `EventType`s the bridge subscribes to. Triggers created with an
 * `eventKind` outside this list can still be fired through the manual
 * HTTP route `POST /api/triggers/events/:eventKind` — they just won't
 * fire from real runtime events until added here.
 */
export const EXPOSED_EVENTS: readonly EventType[] = [
  EventType.MESSAGE_RECEIVED,
  EventType.MESSAGE_SENT,
  EventType.REACTION_RECEIVED,
  EventType.ENTITY_JOINED,
];

export interface TriggerEventBridgeOptions {
  /** Rate-limit floor per trigger in milliseconds. Default 1000. */
  minIntervalMs?: number;
  /** Override the event list (tests only). Defaults to `EXPOSED_EVENTS`. */
  events?: readonly EventType[];
  /** Injection seam for the trigger lookup (tests only). */
  listTriggers?: (runtime: IAgentRuntime) => Promise<Task[]>;
  /** Injection seam for the dispatcher (tests only). */
  dispatch?: typeof executeTriggerTask;
  /** Injection seam for the current time (tests only). Defaults to `Date.now`. */
  now?: () => number;
}

export interface TriggerEventBridgeHandle {
  /** Unregister every event handler and clear rate-limit state. Idempotent. */
  stop: () => void;
}

/**
 * Extract the forwardable payload from an event. `runtime.emitEvent`
 * injects `runtime` and `source` into every handler's argument; those
 * are not part of the trigger's event payload and must not leak into
 * persisted run records (they would serialize circularly and bloat the
 * metadata blob).
 */
function stripRuntimeFields(
  payload: EventPayload | EventPayloadMap[keyof EventPayloadMap],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const source = payload as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (key === "runtime" || key === "source") continue;
    out[key] = value;
  }
  return out;
}

export function startTriggerEventBridge(
  runtime: AgentRuntime,
  options: TriggerEventBridgeOptions = {},
): TriggerEventBridgeHandle {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const events = options.events ?? EXPOSED_EVENTS;
  const listTriggers = options.listTriggers ?? listTriggerTasks;
  const dispatch = options.dispatch ?? executeTriggerTask;
  const now = options.now ?? Date.now;

  type BridgeHandler = (payload: EventPayload) => Promise<void>;
  const lastDispatchMs = new Map<UUID, number>();
  const registered = new Map<EventType, BridgeHandler>();

  const buildHandler = (eventType: EventType): BridgeHandler => {
    return async (payload: EventPayload) => {
      if (!triggersFeatureEnabled(runtime)) return;

      const tasks = await listTriggers(runtime);
      const forwardedPayload = stripRuntimeFields(payload);

      for (const task of tasks) {
        const trigger = readTriggerConfig(task);
        if (!trigger) continue;
        if (!trigger.enabled) continue;
        if (trigger.triggerType !== "event") continue;
        if (trigger.eventKind !== eventType) continue;

        const triggerId = trigger.triggerId;
        const last = lastDispatchMs.get(triggerId);
        const current = now();
        if (last !== undefined && current - last < minIntervalMs) {
          runtime.logger.debug?.(
            {
              src: "trigger-event-bridge",
              triggerId,
              eventKind: eventType,
              sinceLastMs: current - last,
              minIntervalMs,
            },
            "trigger rate-limited, skipping event dispatch",
          );
          continue;
        }
        lastDispatchMs.set(triggerId, current);

        try {
          await dispatch(runtime, task, {
            source: "event",
            event: { kind: eventType, payload: forwardedPayload },
          });
        } catch (err) {
          runtime.logger.error(
            {
              src: "trigger-event-bridge",
              triggerId,
              eventKind: eventType,
              error: err instanceof Error ? err.message : String(err),
            },
            "trigger-event-bridge dispatch threw — continuing with remaining triggers",
          );
        }
      }
    };
  };

  for (const eventType of events) {
    const handler = buildHandler(eventType);
    registered.set(eventType, handler);
    runtime.registerEvent(eventType, handler);
  }

  return {
    stop: () => {
      for (const [eventType, handler] of registered.entries()) {
        runtime.unregisterEvent(eventType, handler);
      }
      registered.clear();
      lastDispatchMs.clear();
    },
  };
}
