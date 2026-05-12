/**
 * Telegram connector contribution.
 *
 * Wraps the LifeOps Telegram mixin (`service-mixin-telegram.ts`). The actual
 * transport is owned by `@elizaos/plugin-telegram`; this contribution only
 * surfaces lifecycle hooks for the registry. `disconnect` resolves to a
 * no-op because account credentials are owned by the Telegram plugin.
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

export function createTelegramConnectorContribution(
  runtime: IAgentRuntime,
): ConnectorContribution {
  const service = new LifeOpsService(runtime);
  return {
    kind: "telegram",
    capabilities: ["telegram.read", "telegram.send"],
    modes: ["local"],
    describe: { label: "Telegram" },
    async start() {},
    async disconnect() {
      await service.disconnectTelegram("owner");
    },
    async verify(): Promise<boolean> {
      const status = await service.getTelegramConnectorStatus("owner");
      return Boolean(status.connected);
    },
    async status(): Promise<ConnectorStatus> {
      try {
        const status = await service.getTelegramConnectorStatus("owner");
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
        const result = await service.sendTelegramMessage({
          side: "owner",
          target: payload.target,
          message: payload.message,
        });
        return {
          ok: true,
          messageId: result.messageId ?? undefined,
        };
      } catch (error) {
        return errorToDispatchResult(error);
      }
    },
    async read(query: unknown) {
      const params = (query ?? {}) as {
        scope?: string;
        query?: string;
        limit?: number;
      };
      return service.searchTelegramMessages({
        side: "owner",
        query: params.query ?? "",
        scope: params.scope,
        limit: params.limit,
      });
    },
  };
}
