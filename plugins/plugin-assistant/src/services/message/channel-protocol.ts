/** Separates context discovery eligibility from channel engagement and delivery policy. */
import { ChannelType } from "@elizaos/core";
import { TEXT_GROUP_CHANNEL_TYPES } from "./stage1-prompt-tier.ts";

/** Voice retains complete dialogue and provider bodies. */
export function isProgressiveContextChannel(channelType: unknown): boolean {
  return (
    typeof channelType === "string" &&
    (channelType === ChannelType.DM ||
      channelType === ChannelType.API ||
      channelType === ChannelType.SELF ||
      TEXT_GROUP_CHANNEL_TYPES.has(channelType))
  );
}

/** Complete authorized tool descriptions remain retrievable on every indexed turn. */
export function isActionDiscoveryChannel(channelType: unknown): boolean {
  return (
    isProgressiveContextChannel(channelType) ||
    channelType === ChannelType.VOICE_DM
  );
}
