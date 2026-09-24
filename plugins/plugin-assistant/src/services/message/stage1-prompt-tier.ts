/**
 * Structural classification for unaddressed group-channel turns.
 *
 * The sibling TEXT_SMALL gate (`bot-noise-triage.ts`) removes positively
 * bot-authored noise before Stage-1 entirely; this tier is the residual for
 * unaddressed turns that still reach Stage-1.
 */

import type { Memory } from "@elizaos/core";
import {
  ChannelType,
  MESSAGE_SOURCE_CLIENT_CHAT,
  MESSAGE_SOURCE_SUB_AGENT,
  MESSAGE_SOURCE_TRIGGER_PROMPT,
} from "@elizaos/core";
/** Group audiences share admission regardless of text or speech transport.
 * The exported name is retained for callers; speech turn timing remains in the
 * voice adapter and cannot change completed-turn audience classification. */
export const TEXT_GROUP_CHANNEL_TYPES: ReadonlySet<string> = new Set([
  String(ChannelType.GROUP),
  String(ChannelType.VOICE_GROUP),
  String(ChannelType.THREAD),
  String(ChannelType.WORLD),
  String(ChannelType.FORUM),
  String(ChannelType.FEED),
]);

/** Sub-agent completion relays are routed by their own evaluator — never tier down. */
const SUB_AGENT_SOURCE = MESSAGE_SOURCE_SUB_AGENT;

/** Sources that bypass should-respond entirely — always respond-likely. */
const ALWAYS_RESPOND_SOURCES: readonly string[] = [
  MESSAGE_SOURCE_CLIENT_CHAT,
  MESSAGE_SOURCE_TRIGGER_PROMPT,
];

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Structural classifier: is this a group-channel turn that does NOT address
 * the agent? Only positively-identified unaddressed group traffic
 * qualifies; autonomous self-turns, sub-agent relays, client-chat sources,
 * and unknown/missing channel types all fail OPEN (return false) so callers
 * keep full-rule behavior for them.
 */
export function isUnaddressedTextGroupTurn(
  message: Memory,
  explicitlyAddressesAgent: boolean,
): boolean {
  if (explicitlyAddressesAgent) return false;

  const contentMetadata = metadataRecord(message.content?.metadata);
  const topLevelMetadata = metadataRecord(message.metadata);

  // Autonomous self-turns are the agent working, not inbound triage traffic.
  if (
    contentMetadata?.isAutonomous === true ||
    topLevelMetadata?.isAutonomous === true
  ) {
    return false;
  }

  // Sub-agent completion relays carry their own routing evaluator.
  const source =
    typeof message.content?.source === "string"
      ? message.content.source.trim().toLowerCase()
      : "";
  if (source === SUB_AGENT_SOURCE) return false;
  if (
    contentMetadata?.subAgent === true ||
    topLevelMetadata?.subAgent === true
  ) {
    return false;
  }
  if (ALWAYS_RESPOND_SOURCES.some((pattern) => source.includes(pattern))) {
    return false;
  }

  // Only known group channels; unknown/missing channel type fails open.
  const channelType =
    typeof message.content?.channelType === "string"
      ? message.content.channelType.trim().toUpperCase()
      : "";
  return TEXT_GROUP_CHANNEL_TYPES.has(channelType);
}
