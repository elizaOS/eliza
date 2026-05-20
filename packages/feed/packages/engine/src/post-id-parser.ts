/**
 * Post ID Parser
 *
 * @description Type-safe parser for extracting metadata from various post ID formats.
 * Supports multiple formats used throughout the application, including game-generated
 * posts, user posts, and legacy formats. Automatically detects format and extracts
 * game ID, author ID, and timestamp.
 */

/**
 * Parsed post metadata from post ID
 *
 * @description Contains extracted metadata from a parsed post ID, including the game
 * context, author information, and timestamp.
 */
export interface ParsedPostMetadata {
  gameId: string;
  authorId: string;
  timestamp: Date;
}

/**
 * Parse result with success indicator
 *
 * @description Result of parsing a post ID, indicating whether parsing was successful
 * and containing the extracted metadata (or default values if parsing failed).
 */
export interface ParseResult {
  metadata: ParsedPostMetadata;
  success: boolean;
}

/**
 * Default post metadata
 */
const DEFAULT_POST_METADATA: ParsedPostMetadata = {
  gameId: 'babylon',
  authorId: 'system',
  timestamp: new Date(),
};

/**
 * Type-safe array access helper that ensures element exists
 */
function getArrayElement<T>(arr: readonly T[], index: number): T | undefined {
  return arr[index];
}

/**
 * Parse Format 1: gameId-gameTimestamp-authorId-isoTimestamp
 * Example: babylon-1761441310151-kash-patrol-2025-10-01T02:12:00Z
 */
function parseFormat1(postId: string): ParsedPostMetadata | null {
  const isoTimestampMatch = postId.match(
    /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/
  );
  if (!isoTimestampMatch?.[1]) return null;

  const timestampStr = isoTimestampMatch[1];
  const timestamp = new Date(timestampStr);
  if (isNaN(timestamp.getTime())) return null;

  const firstHyphenIndex = postId.indexOf('-');
  if (firstHyphenIndex === -1) return null;

  const gameId = postId.substring(0, firstHyphenIndex);
  const withoutGameId = postId.substring(firstHyphenIndex + 1);
  const secondHyphenIndex = withoutGameId.indexOf('-');

  let authorId = 'system';
  if (secondHyphenIndex !== -1) {
    const afterGameTimestamp = withoutGameId.substring(secondHyphenIndex + 1);
    authorId = afterGameTimestamp.substring(
      0,
      afterGameTimestamp.lastIndexOf('-' + timestampStr)
    );
  }

  return { gameId, authorId, timestamp };
}

/**
 * Parse Format 2/3: post-{timestamp}-{actorId?}-{random}
 * Format 2: post-1762099655817-0.7781412938928327
 * Format 3: post-1762099655817-kash-patrol-abc123
 */
function parsePostFormat(postId: string): ParsedPostMetadata | null {
  if (!postId.startsWith('post-')) return null;

  const parts = postId.split('-');
  if (parts.length < 3) return null;

  const timestampPart = getArrayElement(parts, 1);
  if (!timestampPart) return null;

  const timestampNum = Number.parseInt(timestampPart, 10);
  if (isNaN(timestampNum) || timestampNum <= 1000000000000) return null;

  const timestamp = new Date(timestampNum);
  if (isNaN(timestamp.getTime())) return null;

  let authorId = 'system';
  const thirdPart = getArrayElement(parts, 2);
  if (parts.length >= 4 && thirdPart && !thirdPart.includes('.')) {
    authorId = thirdPart;
  }

  return { gameId: 'babylon', authorId, timestamp };
}

/**
 * Parse Format 4: game-{gameId}-{timestamp} (legacy)
 */
function parseGameFormat(postId: string): ParsedPostMetadata | null {
  if (!postId.startsWith('game-')) return null;

  const parts = postId.split('-');
  if (parts.length < 3) return null;

  const gameId = getArrayElement(parts, 1);
  if (!gameId) return null;

  const timestampPart = parts.slice(2).join('-');
  if (!timestampPart) return null;

  // Try ISO date first
  let timestamp = new Date(timestampPart);
  if (isNaN(timestamp.getTime())) {
    // Try numeric timestamp
    const numericTimestamp = Number.parseInt(timestampPart, 10);
    if (isNaN(numericTimestamp)) return null;
    timestamp = new Date(numericTimestamp);
    if (isNaN(timestamp.getTime())) return null;
  }

  return { gameId, authorId: 'system', timestamp };
}

/**
 * Parse post ID and extract metadata
 *
 * @description Parses a post ID string and extracts metadata (gameId, authorId, timestamp).
 * Supports multiple post ID formats:
 * - Format 1: gameId-gameTimestamp-authorId-isoTimestamp
 * - Format 2/3: post-{timestamp}-{actorId?}-{random}
 * - Format 4: game-{gameId}-{timestamp} (legacy)
 *
 * Returns default metadata if parsing fails, allowing graceful degradation.
 *
 * @param {string} postId - The post ID to parse
 * @returns {ParseResult} Parse result with metadata and success indicator
 *
 * @example
 * ```typescript
 * const result = parsePostId('babylon-1761441310151-kash-patrol-2025-10-01T02:12:00Z');
 * if (result.success) {
 *   console.log(`Post by ${result.metadata.authorId} at ${result.metadata.timestamp}`);
 * }
 * ```
 */
export function parsePostId(postId: string): ParseResult {
  const format1 = parseFormat1(postId);
  if (format1) {
    return { metadata: format1, success: true };
  }

  const postFormat = parsePostFormat(postId);
  if (postFormat) {
    return { metadata: postFormat, success: true };
  }

  const gameFormat = parseGameFormat(postId);
  if (gameFormat) {
    return { metadata: gameFormat, success: true };
  }

  return { metadata: DEFAULT_POST_METADATA, success: false };
}
