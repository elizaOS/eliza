/**
 * Connectors contributor — reports configured communication channels.
 */

import type { AwarenessContributor } from "@elizaos/agent";
import type { IAgentRuntime } from "@elizaos/core";

export const connectorsContributor: AwarenessContributor = {
  id: "connectors",
  position: 60,
  cacheTtl: 120_000,
  invalidateOn: ["config-changed"],
  trusted: true,

  async summary(runtime: IAgentRuntime): Promise<string> {
    const clients = ((runtime.character as Record<string, unknown>)?.clients ??
      []) as string[];

    if (!clients.length) {
      return "Channels: none configured";
    }

    const prefix = "Channels: ";
    const joined = clients.join(", ");

    if (prefix.length + joined.length <= 80) {
      return `${prefix}${joined}`;
    }

    // Truncate to fit within 80 chars
    const budget = 80 - prefix.length - 3; // 3 for "..."
    return `${prefix}${joined.slice(0, budget)}...`;
  },
};
