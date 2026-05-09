/**
 * W2-B — X (Twitter) connector contribution.
 *
 * Wraps the LifeOps X mixin (`service-mixin-x.ts`).
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

export function createXConnectorContribution(
  runtime: IAgentRuntime,
): ConnectorContribution {
  const service = new LifeOpsService(runtime);
  return {
    kind: "x",
    capabilities: ["x.read", "x.write", "x.dm.read", "x.dm.write"],
    modes: ["local", "cloud"],
    describe: { label: "X (Twitter)" },
    async start() {},
    async disconnect() {
      await service.disconnectXConnector({ side: "owner" });
    },
    async verify(): Promise<boolean> {
      const status = await service.getXConnectorStatus(undefined, "owner");
      return Boolean(status.connected);
    },
    async status(): Promise<ConnectorStatus> {
      try {
        const status = await service.getXConnectorStatus(undefined, "owner");
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
        const result = await service.sendXDirectMessage({
          participantId: payload.target,
          text: payload.message,
          confirmSend: true,
          side: "owner",
        });
        if (result.ok) {
          return { ok: true };
        }
        return {
          ok: false,
          reason: "transport_error",
          userActionable: false,
          message: result.error ?? "X DM send returned a non-ok response.",
        };
      } catch (error) {
        return errorToDispatchResult(error);
      }
    },
  };
}
