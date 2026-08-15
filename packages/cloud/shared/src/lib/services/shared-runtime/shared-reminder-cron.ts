/** Finds due Shared reminders, atomically claims them, and dispatches through the connector gateway. */

import {
  listDueScheduledTaskRefs,
  parseSharedReminderDelivery,
  type ScheduledTaskDispatcher,
  type ScheduledTaskDispatchRecord,
  type SharedReminderDelivery,
} from "@elizaos/plugin-scheduling/edge";
import type { Bindings } from "../../../types/cloud-worker-env";
import { createSharedScheduledTaskRunner, executeSharedSchedulingSql } from "./shared-scheduling";

function reminderDelivery(record: ScheduledTaskDispatchRecord): SharedReminderDelivery {
  const delivery = parseSharedReminderDelivery(record.metadata?.delivery);
  if (!delivery) {
    throw new Error("Shared reminder delivery metadata is invalid");
  }
  return delivery;
}

function gatewayBaseUrl(env: Bindings): string {
  const value =
    env.ELIZA_APP_WEBHOOK_GATEWAY_URL ?? env.WEBHOOK_GATEWAY_URL ?? env.GATEWAY_WEBHOOK_URL;
  if (!value) throw new Error("Shared reminder gateway URL is not configured");
  return value.replace(/\/+$/, "");
}

function discordGatewayBaseUrl(env: Bindings): string {
  const value = env.ELIZA_APP_DISCORD_WEBHOOK_HANDLER_URL ?? env.DISCORD_WEBHOOK_HANDLER_URL;
  if (!value) {
    throw new Error("Shared Discord reminder gateway URL is not configured");
  }
  return value.replace(/\/+$/, "");
}

type GatewayDeliveryResponse = {
  success?: unknown;
  acceptedAt?: unknown;
  acceptance?: unknown;
  acceptanceUnknown?: unknown;
  idempotencyKey?: unknown;
  providerMessageIds?: unknown;
  retryable?: unknown;
};

async function readGatewayDeliveryResponse(
  response: Response,
): Promise<GatewayDeliveryResponse | undefined> {
  try {
    const value = await response.json();
    return value && typeof value === "object" ? (value as GatewayDeliveryResponse) : undefined;
  } catch {
    // error-policy:J3 an unreadable connector response is never accepted.
    return undefined;
  }
}

export function sharedReminderDispatcher(env: Bindings): ScheduledTaskDispatcher {
  const secret = env.GATEWAY_INTERNAL_SECRET;
  if (!secret) {
    throw new Error("GATEWAY_INTERNAL_SECRET is not configured");
  }
  return {
    async dispatch(record) {
      const delivery = reminderDelivery(record);
      const idempotencyKey = `${record.taskId}:${record.firedAtIso}`;
      const baseUrl =
        delivery.platform === "discord" ? discordGatewayBaseUrl(env) : gatewayBaseUrl(env);
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
      const result = await readGatewayDeliveryResponse(response);
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
        if (result?.acceptance === "not_accepted" && result.retryable === true) {
          const retryAfterSeconds = Number(response.headers.get("Retry-After") ?? "60");
          return {
            ok: false,
            reason: "rate_limited",
            retryAfterMinutes:
              Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
                ? Math.max(1, Math.ceil(retryAfterSeconds / 60))
                : 1,
            userActionable: false,
            acceptance: "not_accepted",
          };
        }
        return {
          ok: false,
          reason: "transport_error",
          userActionable: false,
          acceptance: result?.acceptance === "not_accepted" ? "not_accepted" : "unknown",
        };
      }
      if (
        response.status === 202 ||
        result?.acceptanceUnknown === true ||
        result?.acceptance === "unknown"
      ) {
        return {
          ok: false,
          reason: "transport_error",
          userActionable: true,
          acceptance: "unknown",
          message: "Reminder delivery could not be confirmed; it was not recorded as fired.",
        };
      }
      const acceptedAt =
        typeof result?.acceptedAt === "string" && Number.isFinite(Date.parse(result.acceptedAt))
          ? result.acceptedAt
          : undefined;
      const providerMessageIds = Array.isArray(result?.providerMessageIds)
        ? result.providerMessageIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        : [];
      if (
        result?.success !== true ||
        result.idempotencyKey !== idempotencyKey ||
        !acceptedAt ||
        providerMessageIds.length === 0
      ) {
        return {
          ok: false,
          reason: "transport_error",
          userActionable: true,
          acceptance: "unknown",
          message: "Reminder delivery returned no verifiable provider receipt.",
        };
      }
      return {
        ok: true,
        channelKey: "current_dm",
        target:
          delivery.platform === "telegram"
            ? delivery.chatId
            : delivery.platform === "blooio"
              ? delivery.phoneNumber
              : delivery.discordUserId,
        metadata: {
          idempotencyKey,
          acceptedAt,
          acceptanceUnknown: false,
          providerMessageIds,
        },
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
