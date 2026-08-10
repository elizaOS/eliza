/**
 * Google connector contribution.
 *
 * Wraps {@link import("../service-mixin-google.js").LifeOpsGoogleService}
 * (Gmail + Calendar + Drive grants). Official Gmail MCP creates drafts but
 * cannot deliver them, so this contribution deliberately has no outbound
 * `send` verb. Draft creation remains available through the Gmail domain.
 *
 * Capabilities are namespaced — the entries here mirror
 * `LIFEOPS_GOOGLE_CAPABILITIES` from `@elizaos/shared`.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { formatError } from "@elizaos/core";
import { INTERNAL_URL } from "../access.js";
import { LifeOpsService } from "../service.js";
import { legacyStatusToConnectorStatus } from "./_helpers.js";
import type { ConnectorContribution, ConnectorStatus } from "./contract.js";

export function createGoogleConnectorContribution(
  runtime: IAgentRuntime,
): ConnectorContribution {
  const service = new LifeOpsService(runtime);
  return {
    kind: "google",
    capabilities: [
      "google.basic_identity",
      "google.calendar.read",
      "google.gmail.triage",
      "google.gmail.draft.create",
      "google.gmail.manage",
    ],
    modes: ["local"],
    describe: { label: "Google (Gmail + Calendar)" },
    async start() {
      // No-op: connect is initiated through the dashboard OAuth UI; the
      // ConnectorContribution.start hook is reserved for connectors that
      // need eager session restoration.
    },
    async disconnect() {
      await service.disconnectGoogleConnector(
        { side: "owner", mode: "local" },
        INTERNAL_URL,
      );
    },
    async verify(): Promise<boolean> {
      const status = await service.getGoogleConnectorStatus(INTERNAL_URL);
      return Boolean(status.connected);
    },
    async status(): Promise<ConnectorStatus> {
      try {
        const status = await service.getGoogleConnectorStatus(INTERNAL_URL);
        return legacyStatusToConnectorStatus(status);
      } catch (error) {
        return {
          state: "disconnected",
          message: formatError(error),
          observedAt: new Date().toISOString(),
        };
      }
    },
  };
}
