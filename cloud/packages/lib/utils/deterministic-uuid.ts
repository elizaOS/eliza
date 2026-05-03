/**
 * Deterministic UUID Generation
 *
 * Generates consistent UUIDs from input strings using SHA-256 hashing.
 * Used for creating stable room and entity IDs from identifiers.
 */

import { createHash } from "crypto";

/**
 * Generate a deterministic UUID from an input string using SHA-256.
 * Format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 */
export function generateDeterministicUUID(input: string): string {
  const hash = createHash("sha256").update(input).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Generate room ID for Eliza App conversations
 */
export function generateElizaAppRoomId(
  channel: "telegram" | "imessage" | "discord" | "whatsapp",
  agentId: string,
  identifier: string,
): string {
  return generateDeterministicUUID(`eliza-app:${channel}:room:${agentId}:${identifier}`);
}

/**
 * Generate entity ID for Eliza App users
 */
export function generateElizaAppEntityId(
  channel: "telegram" | "imessage" | "discord" | "whatsapp",
  identifier: string,
): string {
  return generateDeterministicUUID(`eliza-app:${channel}:user:${identifier}`);
}
