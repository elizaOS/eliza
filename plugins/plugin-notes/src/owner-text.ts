/** The owner's own words for a Notes turn. */
import {
  extractUserText,
  incomingMessagePersistenceSnapshot,
  type Memory,
  unwrapUserMessageText,
} from "@elizaos/core";

/**
 * Owner-text checks (delete name fence, named-note routing and evidence, ID
 * re-resolution) must read what the owner typed, never the prompt text built
 * around it. The chat route can replace `content.text` with the
 * contextual-documents envelope, whose FAQ fragments would otherwise "name"
 * unrelated notes, and inbound hardening can wrap it in the external-content
 * envelope. Both are removed here; armor debris yields "", which names nothing.
 */
export function ownerRequestText(message: Memory): string {
  const original = incomingMessagePersistenceSnapshot(message);
  return original
    ? unwrapUserMessageText(original)
    : extractUserText(unwrapUserMessageText(message));
}
