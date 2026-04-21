/**
 * Plugin health contributor — reports loaded plugin count.
 */

import type { AwarenessContributor } from "@elizaos/agent/contracts";
import type { IAgentRuntime } from "@elizaos/core";

export const pluginHealthContributor: AwarenessContributor = {
  id: "pluginHealth",
  position: 50,
  cacheTtl: 120_000,
  invalidateOn: ["plugin-changed"],
  trusted: true,

  async summary(runtime: IAgentRuntime): Promise<string> {
    const plugins = runtime.plugins ?? [];
    const count = plugins.filter(
      (p) => p && typeof p === "object" && p.name,
    ).length;

    return count > 0 ? `Plugins: ${count} loaded` : "Plugins: none loaded";
  },
};
