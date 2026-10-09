import { ChannelType } from "@elizaos/core";
import { TEXT_GROUP_CHANNEL_TYPES } from "./stage1-prompt-tier";

/** Context discovery is independent of direct/group reply and engagement rules. */
export function isProgressiveContextChannel(channelType: unknown): boolean {
  return (
    typeof channelType === "string" &&
    (channelType === ChannelType.DM ||
      channelType === ChannelType.API ||
      channelType === ChannelType.SELF ||
      channelType === ChannelType.VOICE_DM ||
      TEXT_GROUP_CHANNEL_TYPES.has(channelType))
  );
}
