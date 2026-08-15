/**
 * Registers the Dedicated-side channel for reminders migrated from Shared.
 * The container supplies only task identity and occurrence time; Cloud
 * re-authorizes the target and re-reads the committed delivery binding.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  type DispatchFailureReason,
  registerScheduledTaskChannelDispatcher,
  SHARED_CUTOVER_GATEWAY_CHANNEL,
} from "@elizaos/plugin-scheduling";
import { resolveCloudApiBaseUrl } from "@elizaos/shared";

const DISPATCH_FAILURE_REASONS = new Set<DispatchFailureReason>([
  "disconnected",
  "rate_limited",
  "auth_expired",
  "unknown_recipient",
  "transport_error",
]);

function dispatchFailureReason(
  value: unknown,
): DispatchFailureReason | undefined {
  return typeof value === "string" &&
    DISPATCH_FAILURE_REASONS.has(value as DispatchFailureReason)
    ? (value as DispatchFailureReason)
    : undefined;
}

export function registerSharedCutoverReminderDispatcher(
  runtime: IAgentRuntime,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const apiKey = env.ELIZAOS_CLOUD_API_KEY?.trim();
  const targetAgentId = env.ELIZA_CLOUD_AGENT_ID?.trim();
  if (!apiKey || !targetAgentId) return false;
  const baseUrl = resolveCloudApiBaseUrl(env.ELIZAOS_CLOUD_BASE_URL);

  registerScheduledTaskChannelDispatcher(runtime, {
    channelKey: SHARED_CUTOVER_GATEWAY_CHANNEL,
    async dispatch(record) {
      let response: Response;
      try {
        response = await fetch(
          `${baseUrl}/eliza/agents/${encodeURIComponent(targetAgentId)}/shared-reminders/${encodeURIComponent(record.taskId)}/deliver`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": apiKey,
            },
            body: JSON.stringify({ firedAtIso: record.firedAtIso }),
            signal: AbortSignal.timeout(10_000),
          },
        );
      } catch (error) {
        // error-policy:J1 the scheduling dispatcher preserves unknown provider acceptance.
        return {
          ok: false,
          reason: "transport_error",
          userActionable: true,
          acceptance: "unknown",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (response.ok && body?.success === true) {
        return {
          ok: true,
          channelKey: SHARED_CUTOVER_GATEWAY_CHANNEL,
          metadata:
            body.metadata && typeof body.metadata === "object"
              ? (body.metadata as Record<string, unknown>)
              : {},
        };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          reason: "auth_expired",
          userActionable: true,
          acceptance: "not_accepted",
        };
      }
      const reportedReason = dispatchFailureReason(body?.reason);
      const reportedAcceptance =
        body?.acceptance === "not_accepted" ? "not_accepted" : "unknown";
      if (body?.success === false && reportedReason) {
        const retryAfterMinutes =
          typeof body.retryAfterMinutes === "number" &&
          Number.isFinite(body.retryAfterMinutes) &&
          body.retryAfterMinutes > 0
            ? body.retryAfterMinutes
            : reportedReason === "rate_limited"
              ? 1
              : undefined;
        return {
          ok: false,
          reason: reportedReason,
          ...(retryAfterMinutes ? { retryAfterMinutes } : {}),
          userActionable:
            reportedReason === "auth_expired" ||
            reportedReason === "unknown_recipient" ||
            reportedReason === "disconnected",
          acceptance: reportedAcceptance,
        };
      }
      if (response.status === 409 || response.status === 429) {
        return {
          ok: false,
          reason: "rate_limited",
          retryAfterMinutes:
            typeof body?.retryAfterMinutes === "number"
              ? body.retryAfterMinutes
              : 1,
          userActionable: false,
          acceptance: "not_accepted",
        };
      }
      return {
        ok: false,
        reason: "transport_error",
        userActionable: true,
        acceptance: reportedAcceptance,
      };
    },
  });
  return true;
}
