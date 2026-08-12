/**
 * Connector-transport dispatch for the DEFAULT (no-consumer-host) scheduled
 * task dispatcher.
 *
 * On a standalone runtime — `@elizaos/plugin-scheduling` loaded without
 * `@elizaos/plugin-personal-assistant` — the default dispatcher previously
 * routed EVERY fire through the local NOTIFICATION emit, even when the task's
 * `output` explicitly targeted a live message connector
 * (`{ destination: "channel", target: "discord:user:<id>" }`) and that
 * connector was registered and connected on the runtime. The scheduled
 * message reached the in-app inbox but never the owner's actual channel, so a
 * standalone boot (e.g. a sol-dev / cloud container without PA) had no way to
 * deliver proactive scheduled behaviors to Discord/Telegram/etc.
 *
 * This module bridges that gap through the runtime's own connector transport:
 * when a dispatch record's channel key matches a registered message connector
 * (`runtime.getMessageConnectors()`), the rendered owner-facing body is sent
 * via `runtime.sendMessageToTarget` — the same chokepoint PA's production
 * dispatcher uses for bound chat delivery, so the humanness voice gate,
 * outbound sanitizer, and connector-level durable dedupe all apply. The
 * provider outcome is translated into the runner's typed `DispatchResult`
 * contract (mirroring PA's disposition mapping) so retry/escalation policy
 * keeps working. When the path does not apply (non-channel destination, no
 * target, no matching connector, no transport) the caller falls through to
 * the existing notification behavior unchanged.
 *
 * Target grammar (the `channelKey:` prefix is optional and stripped):
 *   - `<channelKey>:user:<providerUserId>`    → DM the user (TargetInfo.entityId)
 *   - `<channelKey>:channel:<providerChanId>` → post to the channel
 *   - `<channelKey>:<providerChanId>`         → bare id, treated as a channel
 */

import {
  type Content,
  type IAgentRuntime,
  inspectSendHandlerResult,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import type { DispatchResult } from "../dispatch-types.js";
import type { ScheduledTaskDispatchRecord } from "./runner.js";

/**
 * Channel keys that are in-process delivery surfaces, never message-connector
 * sources. Skipping them keeps the notification path authoritative for
 * in-app/push dispatches even if a connector ever registers such a source.
 */
const IN_PROCESS_CHANNEL_KEYS: ReadonlySet<string> = new Set([
  "in_app",
  "push",
  "browser",
]);

/** Backoff for an in-flight duplicate: retry the same step, do not escalate. */
const IN_FLIGHT_RETRY_MINUTES = 5;

function dispatchIdempotencyKey(record: ScheduledTaskDispatchRecord): string {
  const persisted = record.metadata?.dispatchIdempotencyKey;
  return typeof persisted === "string" && persisted.trim().length > 0
    ? persisted.trim()
    : `${record.taskId}:${record.firedAtIso}`;
}

function notDeliveredResult(
  code: string,
  message: string,
): Extract<DispatchResult, { ok: false }> {
  const normalized = code.toLowerCase();
  const reason = /rate|throttl/.test(normalized)
    ? "rate_limited"
    : /auth|credential|token/.test(normalized)
      ? "auth_expired"
      : /recipient|target|user_not_found|channel_not_found/.test(normalized)
        ? "unknown_recipient"
        : /disconnect|not_ready|unavailable/.test(normalized)
          ? "disconnected"
          : "transport_error";
  return {
    ok: false,
    reason,
    acceptance: "not_accepted",
    userActionable:
      reason === "auth_expired" ||
      reason === "unknown_recipient" ||
      reason === "disconnected",
    message,
  };
}

export interface ConnectorDispatchTarget {
  /** Message-connector source, i.e. the dispatch channel key ("discord"). */
  source: string;
  /** Transport target for `runtime.sendMessageToTarget`. */
  targetInfo: TargetInfo;
  /** The original `output.target` string, for result reporting. */
  rawTarget: string;
}

/** Whether the record explicitly requests an out-of-process connector send. */
export function isConnectorDispatchIntent(
  record: Pick<ScheduledTaskDispatchRecord, "channelKey" | "output">,
): boolean {
  if (record.output?.destination !== "channel") return false;
  const source =
    typeof record.channelKey === "string" ? record.channelKey.trim() : "";
  return Boolean(source) && !IN_PROCESS_CHANNEL_KEYS.has(source);
}

/**
 * Resolve a dispatch record into a connector transport target, or `null`
 * when the record does not describe a channel-destination connector send.
 */
export function resolveConnectorDispatchTarget(
  record: Pick<ScheduledTaskDispatchRecord, "channelKey" | "output">,
): ConnectorDispatchTarget | null {
  if (!isConnectorDispatchIntent(record)) return null;
  const output = record.output;
  if (!output) return null;
  const source =
    typeof record.channelKey === "string" ? record.channelKey.trim() : "";
  if (!source || IN_PROCESS_CHANNEL_KEYS.has(source)) return null;
  const rawTarget =
    typeof output.target === "string" ? output.target.trim() : "";
  if (!rawTarget) return null;
  const structuredPrefix = /^([^:]+):(user|channel):/.exec(rawTarget)?.[1];
  if (structuredPrefix && structuredPrefix !== source) return null;
  const rest = rawTarget.startsWith(`${source}:`)
    ? rawTarget.slice(source.length + 1)
    : rawTarget;
  if (!rest) return null;
  let targetInfo: TargetInfo;
  if (rest.startsWith("user:")) {
    const userId = rest.slice("user:".length);
    if (!userId) return null;
    // Provider user ids ride in `entityId`: connectors (e.g. Discord's
    // handleSendMessage) route entityId targets through their user→DM
    // resolution path, which accepts raw provider ids alongside runtime
    // entity UUIDs.
    targetInfo = { source, entityId: userId as UUID };
  } else {
    const channelId = rest.startsWith("channel:")
      ? rest.slice("channel:".length)
      : rest;
    if (!channelId) return null;
    targetInfo = { source, channelId };
  }
  return { source, targetInfo, rawTarget };
}

/** Whether this runtime can route the source through a message connector. */
export function runtimeHasMessageConnector(
  runtime: IAgentRuntime,
  source: string,
): boolean {
  if (typeof runtime.sendMessageToTarget !== "function") return false;
  if (typeof runtime.getMessageConnectors !== "function") return false;
  try {
    return runtime
      .getMessageConnectors()
      .some((connector) => connector.source === source);
  } catch {
    return false;
  }
}

/**
 * Attempt connector-transport delivery for one dispatch. Returns `null` when
 * the path does not apply (caller falls through to the notification surface);
 * otherwise returns the typed `DispatchResult` for the runner's policy.
 *
 * `body` is the already-rendered owner-facing message — never the raw
 * `promptInstructions` — and is flagged `agentVoiced` so the transport voice
 * gate preserves it instead of re-rephrasing model output.
 */
export async function dispatchViaMessageConnector(
  runtime: IAgentRuntime,
  record: ScheduledTaskDispatchRecord,
  body: string,
): Promise<DispatchResult | null> {
  const resolved = resolveConnectorDispatchTarget(record);
  if (!resolved) return null;
  if (!runtimeHasMessageConnector(runtime, resolved.source)) return null;

  const content: Content = {
    text: body,
    agentVoiced: true,
    source: resolved.source,
    metadata: {
      taskId: record.taskId,
      firedAtIso: record.firedAtIso,
      channelKey: record.channelKey,
      scheduledDispatchKey: dispatchIdempotencyKey(record),
    },
  };

  try {
    const disposition = inspectSendHandlerResult(
      await runtime.sendMessageToTarget(resolved.targetInfo, content),
    );
    switch (disposition.kind) {
      case "delivered": {
        // Provider acceptance is authoritative; degraded local persistence
        // must not trigger a retry that duplicates the visible message.
        const providerMessageId = disposition.providerMessageId;
        const idempotencyKey = dispatchIdempotencyKey(record);
        if (
          disposition.receipt?.persistence.status === "partial" ||
          disposition.receipt?.persistence.status === "failed"
        ) {
          runtime.reportError(
            "scheduling:scheduled-task:delivery-evidence",
            new Error(
              `Provider accepted scheduled dispatch but local persistence is ${disposition.receipt.persistence.status}`,
            ),
            { taskId: record.taskId, providerMessageId },
          );
        }
        return {
          ok: true,
          ...(providerMessageId ? { messageId: providerMessageId } : {}),
          channelKey: record.channelKey,
          target: resolved.rawTarget,
          ...(providerMessageId && disposition.receipt
            ? {
                receipt: {
                  provider: resolved.source,
                  providerMessageId,
                  idempotencyKey,
                  acceptedAt: new Date(
                    disposition.receipt.acceptedAt,
                  ).toISOString(),
                  metadata: {
                    replayed: disposition.replayed,
                    persistence: disposition.receipt.persistence.status,
                  },
                },
              }
            : {}),
        };
      }
      case "partially_delivered":
        runtime.reportError(
          "scheduling:scheduled-task:partial-delivery",
          new Error(disposition.message),
          {
            taskId: record.taskId,
            providerMessageId: disposition.providerMessageId,
            code: disposition.code,
          },
        );
        return {
          ok: false,
          reason: "transport_error",
          acceptance: "unknown",
          userActionable: false,
          message: disposition.message,
        };
      case "in_flight":
        return {
          ok: false,
          reason: "transport_error",
          acceptance: "unknown",
          retryAfterMinutes: IN_FLIGHT_RETRY_MINUTES,
          userActionable: false,
          message: disposition.message,
        };
      case "not_delivered":
        return notDeliveredResult(disposition.code, disposition.message);
      default:
        // "unknown": no delivery evidence either way. `acceptance: "unknown"`
        // tells the dispatch policy this send must not be blindly retried on
        // a non-idempotent transport.
        return {
          ok: false,
          reason: "transport_error",
          acceptance: "unknown",
          userActionable: false,
          message: disposition.message,
        };
    }
  } catch (error) {
    // error-policy:J1 boundary translation — transport throws become the
    // runner's typed contract; the failure also reaches RECENT_ERRORS via
    // reportError.
    runtime.reportError("scheduling:scheduled-task:connector-dispatch", error, {
      taskId: record.taskId,
      channelKey: record.channelKey,
      source: resolved.source,
    });
    return {
      ok: false,
      reason: "transport_error",
      acceptance: "unknown",
      userActionable: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
