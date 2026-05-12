import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";

export type ChannelExecutionProfile =
  | "voice_fast"
  | "text_fast"
  | "group_compact"
  | "default_full";

function resolveChannelProfile(
  content: Record<string, unknown> | undefined,
): ChannelExecutionProfile {
  const channelType = content?.channelType;
  const conversationMode =
    typeof content?.conversationMode === "string"
      ? content.conversationMode.toLowerCase()
      : null;
  if (
    channelType === ChannelType.VOICE_DM ||
    channelType === ChannelType.VOICE_GROUP
  ) {
    return "voice_fast";
  }
  if (channelType === ChannelType.GROUP) {
    return "group_compact";
  }
  if (conversationMode === "simple") {
    return "text_fast";
  }
  return "default_full";
}

function compactContextForProfile(profile: ChannelExecutionProfile): boolean {
  return profile !== "default_full";
}

export function createChannelProfileProvider(): Provider {
  return {
    name: "elizaChannelProfile",
    description: "Reports channel-derived execution profile state.",
    position: -50,
    contexts: ["general"],
    contextGate: { anyOf: ["general"] },
    cacheStable: false,
    cacheScope: "turn",
    roleGate: { minRole: "USER" },

    async get(
      _runtime: IAgentRuntime,
      message: Memory,
      _state: State,
    ): Promise<ProviderResult> {
      const content = message.content as Record<string, unknown> | undefined;
      const profile = resolveChannelProfile(content);
      const compactContext = compactContextForProfile(profile);

      return {
        text: `channel_profile: profile=${profile} compact_context=${compactContext}`,
        values: {
          executionProfile: profile,
          compactContext,
        },
        data: {
          profile,
          compactContext,
        },
      };
    },
  };
}
