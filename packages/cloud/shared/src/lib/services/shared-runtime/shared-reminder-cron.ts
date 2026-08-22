/**
 * Finds due Shared reminders, atomically claims them, and dispatches through
 * the connector gateway. The Dedicated cutover deliver route reuses the same
 * dispatcher, so every group delivery re-verifies its binding here regardless
 * of which runtime requested the fire.
 */

import {
  isSharedGroupReminderDelivery,
  listDueScheduledTaskRefs,
  listRecoverableScheduledTaskRefs,
  parseSharedReminderDelivery,
  type ScheduledTaskDispatcher,
  type ScheduledTaskDispatchRecord,
  SHARED_REMINDER_MAX_TEXT_LENGTH,
  type SharedGroupReminderDelivery,
  type SharedReminderDelivery,
  sharedGroupReminderMessageText,
} from "@elizaos/plugin-scheduling/edge";
import { personalSharedGroupsRepository } from "../../../db/repositories/personal-shared-groups";
import type { PersonalSharedGroupBinding } from "../../../db/schemas/personal-shared-groups";
import type { Bindings } from "../../../types/cloud-worker-env";
import { logger } from "../../utils/logger";
import { coordinateSharedPushDispatch } from "./conversation-coordinator";
import { isPersonalSharedAgentId } from "./personal-shared-agent";
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

export interface SharedTelegramReminderDispatchInput {
  project: string;
  chatId: string;
  text: string;
  idempotencyKey: string;
}

export type SharedTelegramReminderDispatchResult =
  | {
      ok: true;
      acceptedAt: string;
      providerMessageIds: string[];
    }
  | {
      ok: false;
      acceptance: "not_accepted" | "unknown";
      message: string;
      retryAfterMinutes?: number;
    };

export type SharedTelegramReminderDispatch = (
  input: SharedTelegramReminderDispatchInput,
) => Promise<SharedTelegramReminderDispatchResult>;

interface SharedReminderDispatcherOptions {
  telegramDispatch?: SharedTelegramReminderDispatch;
}

/**
 * A group reminder is only deliverable while its binding is still the active
 * authority for the same provider chat. Suspension (Eliza removed), owner
 * revocation (`/eliza_leave`), and a re-bound chat id all fail the send closed
 * before any connector egress.
 */
async function resolveActiveGroupBinding(
  delivery: SharedGroupReminderDelivery,
): Promise<PersonalSharedGroupBinding | undefined> {
  const binding = await personalSharedGroupsRepository.findBindingById(delivery.groupBindingId);
  if (
    !binding ||
    binding.state !== "active" ||
    binding.platform !== delivery.platform ||
    binding.project !== delivery.project ||
    binding.provider_chat_id !== delivery.chatId
  ) {
    return undefined;
  }
  return binding;
}

/** The connector gateway only accepts the provider-addressable delivery fields. */
function gatewayWireDelivery(delivery: SharedReminderDelivery) {
  return isSharedGroupReminderDelivery(delivery)
    ? {
        platform: delivery.platform,
        project: delivery.project,
        chatId: delivery.chatId,
      }
    : delivery;
}

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

export function sharedReminderDispatcher(
  env: Bindings,
  agentId?: string,
  options: SharedReminderDispatcherOptions = {},
): ScheduledTaskDispatcher {
  return {
    async dispatch(record) {
      const delivery = reminderDelivery(record);
      const idempotencyKey = record.metadata?.dispatchIdempotencyKey;
      if (typeof idempotencyKey !== "string" || !idempotencyKey) {
        throw new Error("Shared reminder dispatch idempotency key is missing");
      }
      const groupDelivery = isSharedGroupReminderDelivery(delivery) ? delivery : undefined;
      const groupBinding = groupDelivery
        ? await resolveActiveGroupBinding(groupDelivery)
        : undefined;
      if (groupDelivery && !groupBinding) {
        return {
          ok: false,
          reason: "unknown_recipient",
          userActionable: true,
          acceptance: "not_accepted",
          message:
            "This group is no longer linked to Eliza, so the group reminder was not delivered.",
        };
      }
      const body = record.output?.fallback?.body ?? record.promptInstructions;
      // Creation reserved this prefix inside the connector limit, so the
      // guard below only trips for rows written before that budget existed.
      const text = groupDelivery ? sharedGroupReminderMessageText(groupDelivery, body) : body;
      if (text.length > SHARED_REMINDER_MAX_TEXT_LENGTH) {
        return {
          ok: false,
          reason: "transport_error",
          userActionable: true,
          acceptance: "not_accepted",
          message: `Reminder text exceeds the ${SHARED_REMINDER_MAX_TEXT_LENGTH}-character connector limit.`,
        };
      }
      let acceptedAt: string | undefined;
      let providerMessageIds: string[] = [];
      if (delivery.platform === "telegram" && options.telegramDispatch) {
        const result = await options.telegramDispatch({
          project: delivery.project,
          chatId: delivery.chatId,
          text,
          idempotencyKey,
        });
        if (!result.ok) {
          return {
            ok: false,
            reason: result.retryAfterMinutes ? "rate_limited" : "transport_error",
            ...(result.retryAfterMinutes ? { retryAfterMinutes: result.retryAfterMinutes } : {}),
            userActionable: false,
            acceptance: result.acceptance,
            message: result.message,
          };
        }
        acceptedAt = result.acceptedAt;
        providerMessageIds = result.providerMessageIds;
      } else {
        const secret = env.GATEWAY_INTERNAL_SECRET;
        if (!secret) {
          throw new Error("GATEWAY_INTERNAL_SECRET is not configured");
        }
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
              ...gatewayWireDelivery(delivery),
              text,
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
        acceptedAt =
          typeof result?.acceptedAt === "string" && Number.isFinite(Date.parse(result.acceptedAt))
            ? result.acceptedAt
            : undefined;
        providerMessageIds = Array.isArray(result?.providerMessageIds)
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
      }
      if (
        !acceptedAt ||
        !Number.isFinite(Date.parse(acceptedAt)) ||
        providerMessageIds.length === 0 ||
        providerMessageIds.some((id) => typeof id !== "string" || !id)
      ) {
        return {
          ok: false,
          reason: "transport_error",
          userActionable: true,
          acceptance: "unknown",
          message: "Reminder delivery returned no verifiable provider receipt.",
        };
      }
      if (groupBinding) {
        try {
          await personalSharedGroupsRepository.recordDeliveryReceipts({
            platform: groupBinding.platform,
            project: groupBinding.project,
            connectorAccountId: groupBinding.connector_account_id,
            providerChatId: groupBinding.provider_chat_id,
            sourceMessageId: idempotencyKey,
            providerMessageIds,
          });
        } catch (error) {
          // error-policy:J7 receipt rows only power reply verification for
          // later inbound turns; the connector's verified acceptance stands.
          logger.warn("[SharedReminders] group delivery receipt recording failed", {
            taskId: record.taskId,
            bindingId: groupBinding.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // A group reminder already landed in the group thread; a DM-styled push
      // notification to the owner's phone would misattribute the destination.
      if (!groupDelivery && agentId && isPersonalSharedAgentId(agentId)) {
        const namespace = env.SHARED_RUNTIME_CONVERSATIONS;
        if (!namespace) {
          logger.warn("[SharedReminders] mobile push coordinator is unavailable", {
            agentId,
            taskId: record.taskId,
          });
        } else {
          try {
            await coordinateSharedPushDispatch(
              agentId,
              {
                title: "Reminder",
                body: text,
                collapseKey: idempotencyKey,
                data: {
                  notificationId: idempotencyKey,
                  category: "reminder",
                  deepLink: "/chat",
                  taskId: record.taskId,
                  firedAtIso: record.firedAtIso,
                },
              },
              { namespace },
            );
          } catch (error) {
            // error-policy:J7 remote push is diagnostic fan-out after the
            // connector's verified acceptance and cannot refire that delivery.
            logger.warn("[SharedReminders] mobile push dispatch failed", {
              agentId,
              taskId: record.taskId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      return {
        ok: true,
        channelKey: "current_dm",
        target: isSharedGroupReminderDelivery(delivery)
          ? delivery.chatId
          : delivery.platform === "telegram"
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
  options: {
    now?: Date;
    limit?: number;
    telegramDispatch?: SharedTelegramReminderDispatch;
  } = {},
) {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  const recoveryCutoff = new Date(now.getTime() - 2 * 60 * 1000);
  const recoverable = await listRecoverableScheduledTaskRefs(executeSharedSchedulingSql, {
    updatedBeforeIso: recoveryCutoff.toISOString(),
    limit,
  });
  const due = await listDueScheduledTaskRefs(executeSharedSchedulingSql, {
    dueAtIso: now.toISOString(),
    limit,
  });
  let fired = 0;
  let raced = 0;
  let deferred = 0;
  let failed = 0;
  const work = [
    ...recoverable.map((ref) => ({ ...ref, recovery: true as const })),
    ...due
      .filter(
        (ref) =>
          !recoverable.some(
            (candidate) => candidate.taskId === ref.taskId && candidate.agentId === ref.agentId,
          ),
      )
      .map((ref) => ({ ...ref, recovery: false as const })),
  ].slice(0, limit);
  for (let offset = 0; offset < work.length; offset += 10) {
    const batch = work.slice(offset, offset + 10);
    const outcomes = await Promise.all(
      batch.map((item) =>
        createSharedScheduledTaskRunner(
          item.agentId,
          sharedReminderDispatcher(env, item.agentId, {
            telegramDispatch: options.telegramDispatch,
          }),
        ).fireWithResult(
          item.taskId,
          item.recovery ? { recoverFiredAtIso: item.firedAtIso } : { allowTerminalRefire: true },
        ),
      ),
    );
    for (const outcome of outcomes) {
      if (outcome.kind === "fired") fired += 1;
      else if (outcome.kind === "raced") raced += 1;
      else if (outcome.kind === "dispatch_deferred") deferred += 1;
      else failed += 1;
    }
  }
  return { scanned: work.length, fired, raced, deferred, failed };
}
