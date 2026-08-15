/** Finds due Shared reminders, atomically claims them, and dispatches through the connector gateway. */

import {
  listDueScheduledTaskRefs,
  type ScheduledTaskDispatcher,
  type ScheduledTaskDispatchRecord,
} from "@elizaos/plugin-scheduling/edge";
import type { Bindings } from "../../../types/cloud-worker-env";
import { createSharedScheduledTaskRunner, executeSharedSchedulingSql } from "./shared-scheduling";

interface ReminderDelivery {
  platform: "telegram";
  project: string;
  chatId: string;
}

function reminderDelivery(record: ScheduledTaskDispatchRecord): ReminderDelivery {
  const value = record.metadata?.delivery;
  if (!value || typeof value !== "object") {
    throw new Error("Shared reminder has no trusted delivery metadata");
  }
  const delivery = value as Record<string, unknown>;
  if (
    delivery.platform !== "telegram" ||
    typeof delivery.project !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(delivery.project) ||
    typeof delivery.chatId !== "string" ||
    !/^-?\d{1,20}$/.test(delivery.chatId)
  ) {
    throw new Error("Shared reminder delivery metadata is invalid");
  }
  return {
    platform: "telegram",
    project: delivery.project,
    chatId: delivery.chatId,
  };
}

function gatewayBaseUrl(env: Bindings): string {
  const value =
    env.ELIZA_APP_WEBHOOK_GATEWAY_URL ?? env.WEBHOOK_GATEWAY_URL ?? env.GATEWAY_WEBHOOK_URL;
  if (!value) throw new Error("Shared reminder gateway URL is not configured");
  return value.replace(/\/+$/, "");
}

function sharedReminderDispatcher(env: Bindings): ScheduledTaskDispatcher {
  const secret = env.GATEWAY_INTERNAL_SECRET;
  if (!secret) {
    throw new Error("GATEWAY_INTERNAL_SECRET is not configured");
  }
  const baseUrl = gatewayBaseUrl(env);
  return {
    async dispatch(record) {
      const delivery = reminderDelivery(record);
      const idempotencyKey = `${record.taskId}:${record.firedAtIso}`;
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/internal/deliver`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Secret": secret,
          },
          body: JSON.stringify({
            ...delivery,
            text: record.output?.fallback?.body ?? record.promptInstructions,
            idempotencyKey,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        // error-policy:J1 connector dispatch returns an explicit unknown-acceptance failure.
        return {
          ok: false,
          reason: "transport_error",
          userActionable: false,
          acceptance: "unknown",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (response.status === 409 || response.status === 429) {
        return {
          ok: false,
          reason: "rate_limited",
          retryAfterMinutes: 1,
          userActionable: false,
          acceptance: "not_accepted",
        };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          reason: "auth_expired",
          userActionable: false,
          acceptance: "not_accepted",
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          reason: "transport_error",
          userActionable: false,
          acceptance: response.status >= 500 ? "unknown" : "not_accepted",
        };
      }
      const result = (await response.json()) as {
        acceptedAt?: unknown;
        idempotencyKey?: unknown;
      };
      const acceptedAt =
        typeof result.acceptedAt === "string" ? result.acceptedAt : new Date().toISOString();
      return {
        ok: true,
        channelKey: "current_dm",
        target: delivery.chatId,
        metadata: { idempotencyKey, acceptedAt },
      };
    },
  };
}

export async function processDueSharedReminders(
  env: Bindings,
  options: { now?: Date; limit?: number } = {},
) {
  const now = options.now ?? new Date();
  const due = await listDueScheduledTaskRefs(executeSharedSchedulingSql, {
    dueAtIso: now.toISOString(),
    limit: options.limit,
  });
  const dispatcher = sharedReminderDispatcher(env);
  let fired = 0;
  let raced = 0;
  let deferred = 0;
  let failed = 0;
  for (let offset = 0; offset < due.length; offset += 10) {
    const batch = due.slice(offset, offset + 10);
    const outcomes = await Promise.all(
      batch.map(({ agentId, taskId }) =>
        createSharedScheduledTaskRunner(agentId, dispatcher).fireWithResult(taskId),
      ),
    );
    for (const outcome of outcomes) {
      if (outcome.kind === "fired") fired += 1;
      else if (outcome.kind === "raced") raced += 1;
      else if (outcome.kind === "dispatch_deferred") deferred += 1;
      else failed += 1;
    }
  }
  return { scanned: due.length, fired, raced, deferred, failed };
}
