/**
 * Message Text Extraction Utility
 *
 * Provides a standardized way to extract text content from elizaOS messages.
 * elizaOS stores content in various formats depending on message type and source.
 */

/**
 * Priority-ordered list of field names to check for text content.
 * More common/reliable fields are checked first.
 */
const TEXT_FIELD_PRIORITY = ["text", "thought", "response", "body", "content", "message"] as const;

/**
 * Fields to exclude when searching for any string content.
 * These fields contain metadata, not user-visible text.
 */
const EXCLUDED_FIELDS = new Set(["source", "action", "inReplyTo", "type", "id"]);

/**
 * Extract text content from a message content object.
 * Handles multiple storage formats used by elizaOS.
 *
 * @param content - The parsed message content object
 * @returns The extracted text content, or empty string if not found
 */
export function extractTextFromContent(content: unknown): string {
  if (!content || typeof content !== "object") {
    return "";
  }

  const c = content as Record<string, unknown>;

  // Check priority fields first
  for (const field of TEXT_FIELD_PRIORITY) {
    const value = c[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  // Check nested content.text structure
  if (
    typeof c.content === "object" &&
    c.content !== null &&
    typeof (c.content as Record<string, unknown>).text === "string" &&
    ((c.content as Record<string, unknown>).text as string).length > 0
  ) {
    return (c.content as Record<string, unknown>).text as string;
  }

  // Last resort: find any non-empty string field (prefer longer strings)
  const stringFields = Object.entries(c)
    .filter(
      ([key, v]) => typeof v === "string" && (v as string).length > 0 && !EXCLUDED_FIELDS.has(key),
    )
    .sort((a, b) => (b[1] as string).length - (a[1] as string).length);

  if (stringFields.length > 0) {
    return stringFields[0][1] as string;
  }

  return "";
}

/**
 * Extract text content from message metadata.
 * Some elizaOS messages store text in metadata instead of content.
 *
 * @param metadata - The message metadata object
 * @returns The extracted text content, or empty string if not found
 */
export function extractTextFromMetadata(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object") {
    return "";
  }

  const meta = metadata as Record<string, unknown>;

  // Check common metadata text fields
  for (const field of ["text", "response", "content"]) {
    const value = meta[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return "";
}

/**
 * Extract text content from a message, checking both content and metadata.
 *
 * @param content - The parsed message content object
 * @param metadata - The message metadata object (optional)
 * @returns The extracted text content, or empty string if not found
 */
export function extractMessageText(content: unknown, metadata?: unknown): string {
  // Try content first
  const textFromContent = extractTextFromContent(content);
  if (textFromContent) {
    return textFromContent;
  }

  // Fall back to metadata
  return extractTextFromMetadata(metadata);
}
