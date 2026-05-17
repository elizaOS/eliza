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
import { executeTriggerTask } from "@elizaos/agent";
import { type AgentRuntime, EventType, type IAgentRuntime, type Task } from "@elizaos/core";
/**
 * Core `EventType`s the bridge subscribes to. Triggers created with an
 * `eventKind` outside this list can still be fired through the manual
 * HTTP route `POST /api/triggers/events/:eventKind` — they just won't
 * fire from real runtime events until added here.
 */
export declare const EXPOSED_EVENTS: readonly EventType[];
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
export declare function startTriggerEventBridge(runtime: AgentRuntime, options?: TriggerEventBridgeOptions): TriggerEventBridgeHandle;
//# sourceMappingURL=trigger-event-bridge.d.ts.map