/**
 * W2-B — WhatsApp connector contribution.
 *
 * Wraps the LifeOps WhatsApp mixin (`service-mixin-whatsapp.ts`).
 * The actual transport is owned by `@elizaos/plugin-whatsapp`.
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

export function createWhatsAppConnectorContribution(
  runtime: IAgentRuntime,
): ConnectorContribution {
  const service = new LifeOpsService(runtime);
  return {
    kind: "whatsapp",
    capabilities: ["whatsapp.read", "whatsapp.send"],
    modes: ["local"],
    describe: { label: "WhatsApp" },
    async start() {},
    async disconnect() {
      // WhatsApp account auth is owned by @elizaos/plugin-whatsapp; LifeOps
      // doesn't manage the credential lifecycle directly.
    },
    async verify(): Promise<boolean> {
      const status = await service.getWhatsAppConnectorStatus();
      return Boolean(status.connected);
    },
    async status(): Promise<ConnectorStatus> {
      try {
        const status = await service.getWhatsAppConnectorStatus();
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
        const result = await service.sendWhatsAppMessage({
          to: payload.target,
          text: payload.message,
        });
        return { ok: true, messageId: result.messageId };
      } catch (error) {
        return errorToDispatchResult(error);
      }
    },
    async read(query: unknown) {
      const params = (query ?? {}) as { limit?: number };
      return service.pullWhatsAppRecent(params.limit ?? 25);
    },
  };
}
