import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { AwarenessRegistry } from "@elizaos/shared";

export function createSelfStatusProvider(
  registry: AwarenessRegistry,
): Provider {
  return {
    name: "agentSelfStatus",
    description:
      "Agent self-awareness status summary (wallet, permissions, plugins, etc.)",
    descriptionCompressed:
      "agent self-awareness status summary (wallet, permission, plugin, etc)",
    dynamic: true,
    position: 12,
    contexts: ["general"],
    contextGate: { anyOf: ["general"] },
    cacheStable: false,
    cacheScope: "turn",
    roleGate: { minRole: "USER" },

    async get(
      runtime: IAgentRuntime,
      _message: Memory,
      _state: State,
    ): Promise<ProviderResult> {
      const text = await registry.composeSummary(runtime);
      return {
        text,
        values: { hasSelfStatus: text.trim().length > 0 },
        data: { summaryLength: text.length },
      };
    },
  };
}
