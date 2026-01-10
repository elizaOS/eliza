/**
 * RSS Plugin Utility Functions
 */

import type { IAgentRuntime, Memory, Content, ChannelType } from '@elizaos/core';
import { createUniqueUuid } from '@elizaos/core';

/**
 * Create a message reply content object
 */
export function createMessageReply(
  runtime: IAgentRuntime, 
  message: Memory, 
  reply: string
): Content {
  return {
    text: reply,
    attachments: [],
    source: (message as Record<string, unknown>).source as string || 'unknown',
    channelType: (message as Record<string, unknown>).channelType as ChannelType | undefined,
    inReplyTo: createUniqueUuid(runtime, message.id || '')
  };
}

/**
 * Extract all URLs from a block of text.
 * - Supports http(s)://, ftp://, and schemeless "www." links
 * - Strips trailing punctuation like .,?!:;)]}'"… if it slipped into the match
 * - Normalizes and deduplicates results (returns absolute URLs with scheme)
 *
 * @param text - The text to extract URLs from
 * @returns Array of normalized URL strings
 */
export function extractUrls(text: string): string[] {
  const URL_MATCH = /(?:(?:https?|ftp):\/\/|www\.)[^\s<>"'`]+/gi;
  const candidates = text.match(URL_MATCH) || [];

  const results: string[] = [];
  const seen = new Set<string>();

  for (const raw of candidates) {
    // Trim leading wrappers like ( [ { < ' "
    let candidate = raw.replace(/^[(\[{<'"]+/, "");

    // Add scheme if missing
    let withScheme = candidate.startsWith("www.") ? `http://${candidate}` : candidate;

    // Iteratively trim common trailing punctuation until it parses (or give up)
    const TRAIL = /[)\]\}>,.;!?:'"\u2026]$/; // includes … (ellipsis)
    while (withScheme && TRAIL.test(withScheme.slice(-1)) && !isValidUrl(withScheme)) {
      withScheme = withScheme.slice(0, -1);
    }

    if (!isValidUrl(withScheme)) continue;

    const normalized = new URL(withScheme).toString();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      results.push(normalized);
    }
  }

  return results;
}

/**
 * Check if a string is a valid URL
 */
function isValidUrl(u: string): boolean {
  try { 
    new URL(u); 
    return true; 
  } catch { 
    return false; 
  }
}

/**
 * Format a relative time string (e.g., "5 minutes ago")
 */
export function formatRelativeTime(timestamp: number): string {
  const timeSince = Date.now() - timestamp;
  const minutesSince = Math.floor(timeSince / 60000);
  const hoursSince = Math.floor(minutesSince / 60);
  const daysSince = Math.floor(hoursSince / 24);

  if (daysSince > 0) {
    return `${daysSince} day${daysSince > 1 ? 's' : ''} ago`;
  } else if (hoursSince > 0) {
    return `${hoursSince} hour${hoursSince > 1 ? 's' : ''} ago`;
  } else if (minutesSince > 0) {
    return `${minutesSince} minute${minutesSince > 1 ? 's' : ''} ago`;
  } else {
    return 'just now';
  }
}

