import type { AwarenessRegistry } from "@elizaos/agent/awareness/registry";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

export function createSelfStatusProvider(
  registry: AwarenessRegistry,
): Provider {
  return {
    name: "agentSelfStatus",
    description:
      "Agent self-awareness status summary (wallet, permissions, plugins, etc.)",
    dynamic: true,
    position: 12,
    async get(
      runtime: IAgentRuntime,
      _message: Memory,
      _state: State,
    ): Promise<ProviderResult> {
      const text = await registry.composeSummary(runtime);
      return { text };
    },
  };
}
