import type { Memory } from "@elizaos/core";
import {
  extractUserText,
  incomingMessagePersistenceSnapshot,
} from "@elizaos/core";

/**
 * The text the owner sent for this in-flight message. The chat host may hand
 * the planner a prompt-only copy (document excerpts or a language instruction
 * around the owner's words) that inherits the host-bound persisted message;
 * that copy's authored text is the persisted words. Any other change, or a
 * copy whose unwrapped request differs from them, has no authored text.
 */
export function hostAuthoredText(original: Memory): string | undefined {
  let persisted: Memory | undefined;
  try {
    persisted = incomingMessagePersistenceSnapshot(original);
  } catch {
    return undefined;
  }
  const routed = original.content.text;
  if (typeof routed !== "string") return undefined;
  if (!persisted) return routed;
  const authored = persisted.content.text;
  if (typeof authored !== "string") return undefined;
  if (routed === authored) return authored;
  return extractUserText(routed) === extractUserText(authored)
    ? authored
    : undefined;
}
