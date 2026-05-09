/**
 * W2-B — Discord connector contribution.
 *
 * Wraps the LifeOps Discord mixin (`service-mixin-discord.ts`).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { LifeOpsService } from "../service.js";
import {
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
    async disconnect() {
      await service.disconnectDiscord("owner");
    },
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
          message: error instanceof Error ? error.message : String(error),
          observedAt: new Date().toISOString(),
        };
      }
    },
    async send(payload: unknown): Promise<DispatchResult> {
      if (!isConnectorSendPayload(payload)) return rejectInvalidPayload();
      try {
        const result = await service.sendDiscordMessage({
          side: "owner",
          channelId: payload.target,
          text: payload.message,
        });
        return { ok: true, messageId: result.channelId };
      } catch (error) {
        return errorToDispatchResult(error);
      }
    },
  };
}
