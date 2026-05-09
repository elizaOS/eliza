/**
 * W2-B — Signal connector contribution.
 *
 * Wraps the LifeOps Signal mixin (`service-mixin-signal.ts`).
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

export function createSignalConnectorContribution(
  runtime: IAgentRuntime,
): ConnectorContribution {
  const service = new LifeOpsService(runtime);
  return {
    kind: "signal",
    capabilities: ["signal.read", "signal.send"],
    modes: ["local"],
    describe: { label: "Signal" },
    async start() {},
    async disconnect() {
      await service.disconnectSignal("owner");
    },
    async verify(): Promise<boolean> {
      const status = await service.getSignalConnectorStatus("owner");
      return Boolean(status.connected);
    },
    async status(): Promise<ConnectorStatus> {
      try {
        const status = await service.getSignalConnectorStatus("owner");
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
        const result = await service.sendSignalMessage({
          side: "owner",
          recipient: payload.target,
          text: payload.message,
        });
        return {
          ok: true,
          messageId:
            (result as { messageId?: string | null }).messageId ?? undefined,
        };
      } catch (error) {
        return errorToDispatchResult(error);
      }
    },
    async read(query: unknown) {
      const params = (query ?? {}) as { limit?: number };
      return service.readSignalInbound(params.limit ?? 25, "owner");
    },
  };
}
