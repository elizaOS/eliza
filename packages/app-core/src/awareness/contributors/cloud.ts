/**
 * Cloud contributor — reports Eliza Cloud connection status.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { AwarenessContributor } from "@elizaos/shared/contracts";

export const cloudContributor: AwarenessContributor = {
  id: "cloud",
  position: 70,
  cacheTtl: 60_000,
  invalidateOn: ["config-changed"],
  trusted: true,

  async summary(runtime: IAgentRuntime): Promise<string> {
    const elizaToken = runtime.getSetting?.("ELIZA_CLOUD_AUTH_TOKEN");
    const connected = !!elizaToken;

    return connected ? "Cloud: connected" : "Cloud: disconnected";
  },
};
