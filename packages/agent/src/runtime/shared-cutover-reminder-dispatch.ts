/**
 * Registers the Dedicated-side channel for reminders migrated from Shared.
 * The container supplies only task identity and occurrence time; Cloud
 * re-authorizes the target and re-reads the committed delivery binding.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  registerScheduledTaskChannelDispatcher,
  SHARED_CUTOVER_GATEWAY_CHANNEL,
} from "@elizaos/plugin-scheduling";
import { resolveCloudApiBaseUrl } from "@elizaos/shared";

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
        acceptance:
          body?.acceptance === "not_accepted" ? "not_accepted" : "unknown",
      };
    },
  });
  return true;
}
