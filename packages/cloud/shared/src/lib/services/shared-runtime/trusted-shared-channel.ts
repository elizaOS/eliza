/**
 * Defines and validates the server-owned transport provenance carried into a
 * Shared AgentRuntime turn. Request bodies and JSON-RPC params are never read
 * as channel authority.
 */

import { ChannelType, type ChannelType as ChannelTypeValue } from "@elizaos/core/edge";

const SHARED_CHANNEL_TYPES = new Set<ChannelTypeValue>([
  ChannelType.DM,
  ChannelType.GROUP,
  ChannelType.VOICE_DM,
  ChannelType.VOICE_GROUP,
]);

export interface TrustedSharedChannelEnvelope {
  source: string;
  channelType: ChannelTypeValue;
}

/**
 * Neutral provenance for history written before per-message channel metadata
 * existed. Never substitute the current request channel: doing so would turn a
 * Telegram or text turn into Discord or voice merely because it was replayed
 * there later.
 */
export const LEGACY_SHARED_HISTORY_CHANNEL: TrustedSharedChannelEnvelope = {
  source: "shared-runtime-history",
  channelType: ChannelType.DM,
};

export const SHARED_SYSTEM_CHANNEL: TrustedSharedChannelEnvelope = {
  source: "shared-runtime-system",
  channelType: ChannelType.DM,
};

/** Validate the envelope after it crosses the coordinator's JSON boundary. */
export function parseTrustedSharedChannelEnvelope(
  value: unknown,
): TrustedSharedChannelEnvelope | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = (value as { source?: unknown }).source;
  const channelType = (value as { channelType?: unknown }).channelType;
  if (
    typeof source !== "string" ||
    !source.trim() ||
    source.length > 80 ||
    typeof channelType !== "string" ||
    !SHARED_CHANNEL_TYPES.has(channelType as ChannelTypeValue)
  ) {
    return undefined;
  }
  return { source: source.trim(), channelType: channelType as ChannelTypeValue };
}
