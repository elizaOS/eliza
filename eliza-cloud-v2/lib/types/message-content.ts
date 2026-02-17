/**
 * Shared type definitions for message content structures
 */

import { MemoryType } from "@elizaos/core";
import type { Content, Media, BaseMetadata } from "@elizaos/core";

/**
 * Message content with text, attachments, and source metadata
 */
export interface MessageContent {
  text?: string;
  attachments?: Media[];
  source?: "user" | "agent" | "api";
  thought?: string;
  inReplyTo?: string;
  action?: string;
  type?: string; // e.g., "action_result" for internal system messages
}

/**
 * Type guard to check if content has attachments
 */
export function hasAttachments(
  content: unknown,
): content is MessageContent & { attachments: Media[] } {
  return (
    typeof content === "object" &&
    content !== null &&
    "attachments" in content &&
    Array.isArray((content as MessageContent).attachments) &&
    (content as MessageContent).attachments!.length > 0
  );
}

/**
 * Type guard to check if content has text
 */
export function hasText(
  content: unknown,
): content is MessageContent & { text: string } {
  return (
    typeof content === "object" &&
    content !== null &&
    "text" in content &&
    typeof (content as MessageContent).text === "string"
  );
}

/**
 * Safely parse message content from unknown
 * Handles various formats: string, JSON string, double-encoded JSON, or object
 */
export function parseMessageContent(content: unknown): MessageContent {
  // Handle string content (may be JSON or plain text)
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      // Check if result is still a string (double-encoded)
      if (typeof parsed === "string") {
        try {
          return JSON.parse(parsed) as MessageContent;
        } catch {
          return { text: parsed };
        }
      }
      return parsed as MessageContent;
    } catch {
      return { text: content };
    }
  }

  // Handle object content
  if (typeof content === "object" && content !== null) {
    // Check if the object has a stringified content field
    const obj = content as Record<string, unknown>;
    if (typeof obj.content === "string") {
      try {
        const innerParsed = JSON.parse(obj.content);
        if (typeof innerParsed === "object" && innerParsed !== null) {
          return { ...obj, ...innerParsed } as MessageContent;
        }
      } catch {
        // content field is plain text, not JSON
      }
    }
    return content as MessageContent;
  }

  return {};
}

/**
 * Room metadata structure
 */
export interface RoomMetadata {
  creatorUserId?: string;
  [key: string]: unknown;
}

/**
 * Attachment structure for API responses
 */
export interface MessageAttachment {
  id: string;
  url: string;
  title?: string;
  contentType?: string;
}

/**
 * Voice structure from ElevenLabs
 */
export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category?: "premade" | "professional" | "cloned" | "generated";
  [key: string]: unknown;
}

/**
 * Extended metadata for dialogue messages in ElizaCloud.
 * Extends elizaOS standard metadata with UI and categorization fields.
 *
 * BACKWARDS COMPATIBLE: Works alongside legacy metadata formats.
 */
export interface DialogueMetadata extends BaseMetadata {
  /** Official elizaOS type - always MESSAGE for dialogue */
  type: MemoryType.MESSAGE;

  /** Semantic role: who created this message */
  role: "user" | "agent" | "system";

  /** Dialogue categorization: message vs action result */
  dialogueType?: "message" | "action_result" | "system_event";

  /** UI visibility flag */
  visibility?: "visible" | "hidden";

  /** Optional: Agent mode that generated this */
  agentMode?: "chat" | "build" | "assistant";

  /** Optional: Action that generated this (for action results) */
  action?: string;
}

/**
 * Legacy metadata format (for backwards compatibility)
 * @deprecated Use DialogueMetadata instead
 */
export interface LegacyDialogueMetadata {
  type: "user_message" | "agent_response_message" | "action_result";
  [key: string]: unknown;
}

/**
 * Type guard to check if metadata is new DialogueMetadata format
 */
export function isDialogueMetadata(
  metadata: unknown,
): metadata is DialogueMetadata {
  if (!metadata || typeof metadata !== "object") return false;
  const meta = metadata as Record<string, unknown>;
  return (
    meta.type === MemoryType.MESSAGE &&
    typeof meta.role === "string" &&
    ["user", "agent", "system"].includes(meta.role as string)
  );
}

/**
 * Type guard to check if metadata is legacy format
 */
export function isLegacyDialogueMetadata(
  metadata: unknown,
): metadata is LegacyDialogueMetadata {
  if (!metadata || typeof metadata !== "object") return false;
  const meta = metadata as Record<string, unknown>;
  return (
    typeof meta.type === "string" &&
    ["user_message", "agent_response_message", "action_result"].includes(
      meta.type as string,
    )
  );
}

/**
 * Helper to check if a message should be visible in conversation logs
 * Supports both new and legacy formats for backwards compatibility
 */
export function isVisibleDialogueMessage(
  metadata: unknown,
  content?: unknown,
): boolean {
  // Check content.type for action_result (all formats)
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (c.type === "action_result") {
      return false;
    }
  }

  // Check metadata.type for action_result (legacy format)
  if (metadata && typeof metadata === "object") {
    const m = metadata as Record<string, unknown>;
    if (m.type === "action_result") {
      return false;
    }
  }

  // New format
  if (isDialogueMetadata(metadata)) {
    return (
      metadata.visibility !== "hidden" &&
      metadata.dialogueType !== "action_result"
    );
  }

  // Legacy format
  if (isLegacyDialogueMetadata(metadata)) {
    return (
      metadata.type === "user_message" ||
      metadata.type === "agent_response_message"
    );
  }

  // Fallback: check content.source
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    return c.source === "user" || c.source === "agent";
  }

  return false;
}
