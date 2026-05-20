/**
 * JSON Continuation Parser
 *
 * Handles parsing and merging of JSON responses that were split across
 * multiple LLM calls due to token limits.
 */

import { logger } from '@babylon/shared';
import type { JsonValue } from '../types/common';

export interface ParsedContent {
  content: string;
  isArray: boolean;
  items?: JsonValue[];
}

/**
 * Clean markdown code blocks from content
 */
export function cleanMarkdownCodeBlocks(content: string): string {
  let cleaned = content.trim();

  // Remove markdown code fences
  if (cleaned.startsWith('```')) {
    const lines = cleaned.split('\n');
    const jsonStartIndex = lines.findIndex(
      (line) => line.trim().startsWith('{') || line.trim().startsWith('[')
    );
    if (jsonStartIndex !== -1) {
      cleaned = lines.slice(jsonStartIndex).join('\n');
    }
    cleaned = cleaned.replace(/```\s*$/g, '').trim();
  }

  // Remove any remaining code fence markers
  cleaned = cleaned.replace(/```json\n?/g, '').replace(/```\n?/g, '');

  return cleaned.trim();
}

/**
 * Extract JSON from text that may contain prose
 */
export function extractJsonFromText(content: string): string {
  // If it already starts with JSON, return as-is
  if (content.startsWith('{') || content.startsWith('[')) {
    return content;
  }

  // Try to find JSON object or array in the text
  const jsonMatch = content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch?.[1]) {
    return jsonMatch[1];
  }

  return content;
}

/**
 * Extract all complete JSON arrays from content that may have multiple fragments
 */
export function extractJsonArrays(content: string): string[] {
  const arrays: string[] = [];

  // Find all potential array boundaries
  let depth = 0;
  let startIndex = -1;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (char === '[') {
      if (depth === 0) {
        startIndex = i;
      }
      depth++;
    } else if (char === ']') {
      depth--;
      if (depth === 0 && startIndex !== -1) {
        // Found a complete array
        arrays.push(content.substring(startIndex, i + 1));
        startIndex = -1;
      }
    }
  }

  return arrays;
}

/**
 * Try to fix truncated JSON by completing brackets
 */
export function attemptJsonRepair(jsonStr: string): string | null {
  let repaired = jsonStr.trim();

  // Count brackets
  let arrayDepth = 0;
  let objectDepth = 0;
  let inString = false;
  let escapeNext = false;

  for (const char of repaired) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '[') arrayDepth++;
    if (char === ']') arrayDepth--;
    if (char === '{') objectDepth++;
    if (char === '}') objectDepth--;
  }

  // If we're in a string, close it
  if (inString) {
    repaired += '"';
  }

  // Remove any trailing commas before closing
  repaired = repaired.replace(/,\s*$/, '');

  // Close any open objects
  while (objectDepth > 0) {
    repaired += '}';
    objectDepth--;
  }

  // Close any open arrays
  while (arrayDepth > 0) {
    repaired += ']';
    arrayDepth--;
  }

  // Try to parse it
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}

/**
 * Merge multiple JSON arrays into a single array
 */
export function mergeJsonArrays(
  arrayStrings: string[],
  options: { repairTruncated?: boolean } = {}
): JsonValue[] {
  const allItems: JsonValue[] = [];
  const { repairTruncated = false } = options;

  for (const arrayStr of arrayStrings) {
    let jsonStr = arrayStr.trim();

    // Try to repair truncated JSON if enabled
    if (repairTruncated) {
      const repaired = attemptJsonRepair(jsonStr);
      if (repaired) {
        jsonStr = repaired;
      }
    }

    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        allItems.push(...parsed);
      } else {
        // Single object, wrap in array
        allItems.push(parsed);
      }
    } catch (error) {
      logger.warn(
        'Failed to parse JSON fragment',
        {
          error,
          fragment: jsonStr.substring(0, 100),
        },
        'JsonContinuationParser'
      );
      // Skip invalid fragments
    }
  }

  return allItems;
}

/**
 * Main function to parse continuation content
 * Handles multiple strategies for extracting and merging JSON
 */
export function parseContinuationContent(content: string): JsonValue | null {
  // Clean markdown
  let cleaned = cleanMarkdownCodeBlocks(content);

  // Extract JSON from text
  cleaned = extractJsonFromText(cleaned);

  // Try simple parse first
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall through to advanced parsing
  }

  // Try to extract and merge multiple arrays
  const arrays = extractJsonArrays(content);

  if (arrays.length > 0) {
    logger.info(
      'Found multiple JSON arrays in continuation',
      {
        count: arrays.length,
      },
      'JsonContinuationParser'
    );

    // Try without repair first
    const merged = mergeJsonArrays(arrays, { repairTruncated: false });
    if (merged.length > 0) {
      return merged;
    }

    // Try with repair for last array (likely truncated)
    const mergedWithRepair = mergeJsonArrays(arrays, { repairTruncated: true });
    if (mergedWithRepair.length > 0) {
      logger.info(
        'Successfully repaired truncated JSON',
        {
          items: mergedWithRepair.length,
        },
        'JsonContinuationParser'
      );
      return mergedWithRepair;
    }
  }

  // Try to repair the whole thing as last resort
  const repaired = attemptJsonRepair(cleaned);
  if (repaired) {
    try {
      return JSON.parse(repaired);
    } catch {
      // Give up
    }
  }

  return null;
}
