/**
 * Provider contributor — reports the active model provider.
 */

import type { AwarenessContributor } from "@elizaos/agent";
import type { IAgentRuntime } from "@elizaos/core";

export const providerContributor: AwarenessContributor = {
  id: "provider",
  position: 40,
  cacheTtl: 300_000,
  invalidateOn: ["provider-changed"],
  trusted: true,

  async summary(runtime: IAgentRuntime): Promise<string> {
    const provider =
      (runtime.getSetting?.("MODEL_PROVIDER") as string) ??
      ((runtime.character?.settings as Record<string, unknown>)
        ?.modelProvider as string) ??
      "unknown";

    return `Provider: ${String(provider)}`;
  },
};
