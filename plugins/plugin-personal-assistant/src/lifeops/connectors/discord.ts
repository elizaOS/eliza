/**
 * Discord connector contribution. Wraps the LifeOps Discord mixin
 * (`service-mixin-discord.ts`).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { formatError } from "@elizaos/core";
import { LifeOpsService } from "../service.js";
import {
  dispatchReceipt,
  errorToDispatchResult,
  isConnectorSendPayload,
  legacyStatusToConnectorStatus,
  rejectInvalidPayload,
} from "./_helpers.js";
import type {
  ConnectorContribution,
  ConnectorStatus,
  DispatchResult,
} from "./contract.js";

export function createDiscordConnectorContribution(
  runtime: IAgentRuntime,
): ConnectorContribution {
  const service = new LifeOpsService(runtime);
  return {
    kind: "discord",
    capabilities: ["discord.read", "discord.send"],
    modes: ["local"],
    describe: { label: "Discord" },
    async start() {},
    async disconnect() {},
    async verify(): Promise<boolean> {
      const status = await service.getDiscordConnectorStatus("owner");
      return Boolean(status.connected);
    },
    async status(): Promise<ConnectorStatus> {
      try {
        const status = await service.getDiscordConnectorStatus("owner");
        return legacyStatusToConnectorStatus(status);
      } catch (error) {
        return {
          state: "disconnected",
          message: formatError(error),
          observedAt: new Date().toISOString(),
        };
      }
    },
    async send(payload: unknown): Promise<DispatchResult> {
      if (!isConnectorSendPayload(payload)) return rejectInvalidPayload();
      try {
        // Discord user ids and channel ids live in disjoint id spaces: a
        // user-typed target must go through the user→DM resolution path
        // (`users.fetch` → `createDM`) — fetching it as a channel fails with
        // 10003 Unknown Channel.
        const result = await service.sendDiscordMessage(
          payload.targetKind === "user"
            ? { side: "owner", userId: payload.target, text: payload.message }
            : {
                side: "owner",
                channelId: payload.target,
                text: payload.message,
              },
        );
        if (result.deliveryStatus === "failed") {
          // Discord marked the message failed: it was not delivered, so a
          // check-in may try the next channel.
          return {
            ok: false,
            reason: "transport_error",
            acceptance: "not_accepted",
            userActionable: false,
            message: "Discord reported the message as failed.",
          };
        }
        const receipt = dispatchReceipt({
          provider: "discord",
          providerMessageId: result.providerMessageId,
          payload,
        });
        // Without a provider message id the delivery stays unconfirmed: the
        // scheduling ledger records it as ambiguous, never as a durable send.
        return receipt
          ? { ok: true, messageId: receipt.providerMessageId, receipt }
          : { ok: true };
      } catch (error) {
        return errorToDispatchResult(error);
      }
    },
  };
}
