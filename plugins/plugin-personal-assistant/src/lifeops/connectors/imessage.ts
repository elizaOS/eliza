/**
 * iMessage connector contribution.
 *
 * Wraps the LifeOps iMessage mixin (`service-mixin-imessage.ts`). Local-only;
 * the iMessage runtime service is provided by `@elizaos/plugin-imessage` /
 * `plugin-bluebubbles` on macOS.
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

export function createIMessageConnectorContribution(
  runtime: IAgentRuntime,
): ConnectorContribution {
  const service = new LifeOpsService(runtime);
  return {
    kind: "imessage",
    capabilities: ["imessage.read", "imessage.send"],
    modes: ["local"],
    describe: { label: "iMessage" },
    async start() {},
    async disconnect() {
      // iMessage account is bound to the macOS Messages.app login; LifeOps
      // can't disconnect at the mixin level.
    },
    async verify(): Promise<boolean> {
      const status = await service.getIMessageConnectorStatus();
      return Boolean(status.connected);
    },
    async status(): Promise<ConnectorStatus> {
      try {
        const status = await service.getIMessageConnectorStatus();
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
        const result = await service.sendIMessage({
          to: payload.target,
          text: payload.message,
        });
        return {
          ok: true,
          messageId: result.messageId ?? undefined,
        };
      } catch (error) {
        return errorToDispatchResult(error);
      }
    },
  };
}
