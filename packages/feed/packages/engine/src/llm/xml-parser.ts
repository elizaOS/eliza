/**
 * XML Parser for LLM Responses
 *
 * Robust XML parsing that handles:
 * - Malformed/truncated XML
 * - Mixed content (text + XML)
 * - Continuation responses
 * - Nested structures
 *
 * XML is more forgiving than JSON and easier for LLMs to generate correctly.
 */

import { logger } from '@babylon/shared';
import type { JsonValue } from '../types/common';
import { formatError } from '../utils/error-utils';

export interface XMLParseResult {
  success: boolean;
  data: JsonValue | null;
  error?: string;
  /** Extracted content from <think>/<thinking> blocks, can be used as fallback reasoning */
  thinkingContent?: string;
}

/**
 * Extract XML from text that may contain prose/reasoning
 * Handles cases where LLM outputs reasoning text before/after XML
 */
export function extractXMLFromText(content: string): string {
  const cleaned = content.trim();

  // Try to find the main XML document (starts with < and ends with >)
  // Look for patterns like <decisions>...</decisions> or <response>...</response>
  const xmlPattern =
    /<(decisions|response|result|data|output)[\s>][\s\S]*?<\/\1>/i;
  const xmlMatch = cleaned.match(xmlPattern);
  if (xmlMatch) {
    return xmlMatch[0];
  }

  // Fallback: Try to find ANY XML block (more permissive, non-greedy)
  const anyXmlMatch = cleaned.match(/<([\w-]+)[\s>][\s\S]*?<\/\1>/);
  if (anyXmlMatch) {
    return anyXmlMatch[0];
  }

  // If starts with XML but no closing tag found, try to extract up to last >
  if (cleaned.startsWith('<')) {
    const endIndex = cleaned.lastIndexOf('>');
    if (endIndex !== -1) {
      return cleaned.substring(0, endIndex + 1);
    }
    return cleaned;
  }

  // Last resort: Extract everything between first < and matching >
  const startIndex = cleaned.indexOf('<');
  if (startIndex !== -1) {
    // Find the root tag name
    const tagMatch = cleaned.substring(startIndex).match(/<([\w-]+)[\s>]/);
    if (tagMatch && tagMatch[1]) {
      const tagName = tagMatch[1];
      const closingTag = `</${tagName}>`;
      const endIndex = cleaned.indexOf(closingTag, startIndex);
      if (endIndex !== -1) {
        return cleaned.substring(startIndex, endIndex + closingTag.length);
      }
    }
  }

  return cleaned;
}

/**
 * Extract thinking content from LLM response before stripping.
 * Returns the concatenated content of all <think> and <thinking> blocks.
 * This can be used as fallback reasoning for training data.
 */
export function extractThinkingContent(content: string): string {
  const thinkMatches = content.match(/<think>([\s\S]*?)<\/think>/gi) || [];
  const thinkingMatches =
    content.match(/<thinking>([\s\S]*?)<\/thinking>/gi) || [];

  const allMatches = [...thinkMatches, ...thinkingMatches];

  if (allMatches.length === 0) {
    return '';
  }

  // Extract inner content from each match
  return allMatches
    .map((match) => {
      const innerMatch = match.match(
        /<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/i
      );
      return innerMatch?.[1]?.trim() || '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Remove LLM thinking blocks (e.g., <think>...</think> from DeepSeek, Qwen)
 * These blocks contain internal reasoning that shouldn't be parsed as content.
 *
 * NOTE: We do NOT strip <reasoning> tags - those are valid fields inside <decision> elements
 * that we need to preserve for training data.
 */
export function stripThinkingBlocks(content: string): string {
  const originalLength = content.length;

  // Remove <think>...</think> blocks (DeepSeek, Qwen reasoning)
  // Use non-greedy matching to handle multiple blocks
  let cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // Also handle <thinking>...</thinking> variant
  cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');

  // NOTE: We intentionally do NOT strip <reasoning> tags!
  // <reasoning> is a valid field inside <decision> elements that we need to preserve.
  // The previous code was incorrectly stripping reasoning from decisions.

  const strippedLength = originalLength - cleaned.length;
  if (strippedLength > 0) {
    logger.debug(
      'Stripped LLM thinking blocks',
      {
        originalLength,
        strippedChars: strippedLength,
        remainingLength: cleaned.length,
      },
      'XMLParser'
    );
  }

  return cleaned.trim();
}

/**
 * Clean markdown code blocks from content
 */
export function cleanXMLMarkdown(content: string): string {
  let cleaned = content.trim();

  // First, strip any thinking/reasoning blocks
  cleaned = stripThinkingBlocks(cleaned);

  // Remove markdown code fences
  cleaned = cleaned.replace(/```xml\n?/g, '');
  cleaned = cleaned.replace(/```\n?/g, '');

  // Remove any leading/trailing whitespace
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Attempt to repair truncated XML by closing unclosed tags
 */
export function repairTruncatedXML(xml: string): string {
  let repaired = xml.trim();

  // Track open tags
  const openTags: string[] = [];
  const tagRegex = /<(\/?)([\w-]+)[^>]*>/g;
  let match;

  while ((match = tagRegex.exec(xml)) !== null) {
    const isClosing = match[1] === '/';
    const tagName = match[2];

    if (!tagName) continue; // Skip if no tag name captured

    if (!isClosing) {
      // Check if it's a self-closing tag
      const fullMatch = match[0];
      if (
        fullMatch &&
        !fullMatch.endsWith('/>') &&
        !['br', 'hr', 'img', 'input'].includes(tagName)
      ) {
        openTags.push(tagName);
      }
    } else {
      // Closing tag - remove from stack
      const lastIndex = openTags.lastIndexOf(tagName);
      if (lastIndex !== -1) {
        openTags.splice(lastIndex, 1);
      }
    }
  }

  // Close any unclosed tags in reverse order
  while (openTags.length > 0) {
    const tag = openTags.pop();
    repaired += `</${tag}>`;
  }

  return repaired;
}

/**
 * Simple regex-based XML parser
 * Works in both Node.js and browser environments
 */
export function parseXMLToObject(xml: string): JsonValue {
  const cleaned = repairTruncatedXML(xml);

  // Find root element
  const rootMatch = cleaned.match(/<([\w-]+)[^>]*>([\s\S]*)<\/\1>/);
  if (!rootMatch || !rootMatch[1] || !rootMatch[2]) {
    throw new Error('No root element found in XML');
  }

  const content = rootMatch[2];

  // Parse the content
  return parseXMLContent(content);
}

/**
 * Parse XML content recursively
 */
function parseXMLContent(content: string): JsonValue {
  const trimmed = content.trim();

  // Check if it's just text content (no child tags)
  if (!trimmed.includes('<')) {
    // Try to parse as primitive
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null') return null;
    const num = Number(trimmed);
    // Check for finite numbers only (excludes NaN, Infinity, -Infinity)
    if (Number.isFinite(num) && trimmed === String(num)) return num;
    return trimmed;
  }

  // Parse child elements
  const children: Record<string, JsonValue | JsonValue[]> = {};
  const tagRegex = /<([\w-]+)[^>]*>([\s\S]*?)<\/\1>/g;
  let match;

  while ((match = tagRegex.exec(content)) !== null) {
    const tagName = match[1];
    const tagContent = match[2];

    if (!tagName || tagContent === undefined) continue; // Skip invalid matches

    // Recursively parse child content
    const value = parseXMLContent(tagContent);

    // Handle multiple elements with same tag name (arrays)
    const existing = children[tagName];
    if (existing === undefined) {
      children[tagName] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      children[tagName] = [existing, value];
    }
  }

  // If no children found, return text content
  if (Object.keys(children).length === 0) {
    const textContent = trimmed.replace(/<[^>]+>/g, '').trim();
    if (textContent) {
      return textContent;
    }
  }

  return children;
}

/**
 * Parse XML string to JSON - handles all edge cases
 * Includes fallback to JSON if LLM ignores XML request
 */
export function parseXML(content: string): XMLParseResult {
  try {
    // Extract thinking content BEFORE stripping (for fallback reasoning)
    const thinkingContent = extractThinkingContent(content);

    // Clean markdown (this will strip thinking blocks)
    let cleaned = cleanXMLMarkdown(content);

    // Extract XML from text
    cleaned = extractXMLFromText(cleaned);

    // FALLBACK: If LLM returned JSON instead of XML, try to parse it
    if (cleaned.trim().startsWith('{') || cleaned.trim().startsWith('[')) {
      logger.warn(
        'LLM returned JSON instead of XML, attempting JSON parse as fallback',
        {
          contentPreview: cleaned.substring(0, 100),
        },
        'XMLParser'
      );

      try {
        const jsonData = JSON.parse(cleaned);
        return {
          success: true,
          data: jsonData,
          thinkingContent: thinkingContent || undefined,
        };
      } catch (jsonError) {
        logger.error(
          'Failed to parse as both XML and JSON',
          {
            xmlError: 'No root element',
            jsonError:
              jsonError instanceof Error
                ? jsonError.message
                : String(jsonError),
          },
          'XMLParser'
        );

        return {
          success: false,
          data: null,
          error: 'Failed to parse as both XML and JSON',
        };
      }
    }

    // Handle continuation responses with multiple root elements
    if (cleaned.includes('Continue from where you left off')) {
      return parseContinuationXML(cleaned);
    }

    // Parse single XML document
    const data = parseXMLToObject(cleaned);

    return {
      success: true,
      data,
      thinkingContent: thinkingContent || undefined,
    };
  } catch (error) {
    logger.error(
      'Failed to parse XML',
      {
        error: formatError(error),
        contentPreview: content.substring(0, 200),
      },
      'XMLParser'
    );

    return {
      success: false,
      data: null,
      error: formatError(error),
    };
  }
}

/**
 * Parse continuation XML with multiple fragments
 */
function parseContinuationXML(content: string): XMLParseResult {
  try {
    // Extract all complete XML documents from continuation
    const xmlDocs: string[] = [];
    const lines = content.split('\n');
    let currentDoc = '';
    let inDoc = false;

    for (const line of lines) {
      if (line.trim().match(/^<[\w-]+[^/]*>/)) {
        // Start of new root element
        inDoc = true;
        currentDoc = line + '\n';
      } else if (inDoc) {
        currentDoc += line + '\n';
        // Check if this closes the root
        if (line.trim().match(/^<\/[\w-]+>$/)) {
          xmlDocs.push(currentDoc.trim());
          currentDoc = '';
          inDoc = false;
        }
      }
    }

    // Parse each document and merge
    if (xmlDocs.length > 0) {
      const allItems: JsonValue[] = [];

      for (const doc of xmlDocs) {
        try {
          const parsed = parseXMLToObject(doc);

          // If it's an array wrapper, extract items
          if (parsed && typeof parsed === 'object') {
            const obj = parsed as Record<string, JsonValue>;
            if ('decision' in obj) {
              const decisions = obj.decision;
              if (Array.isArray(decisions)) {
                allItems.push(...decisions);
              } else {
                allItems.push(decisions);
              }
            } else if ('item' in obj) {
              const items = obj.item;
              if (Array.isArray(items)) {
                allItems.push(...items);
              } else {
                allItems.push(items);
              }
            } else {
              allItems.push(parsed);
            }
          } else {
            allItems.push(parsed);
          }
        } catch (error) {
          logger.warn(
            'Failed to parse XML fragment',
            {
              error: formatError(error),
              fragment: doc.substring(0, 100),
            },
            'XMLParser'
          );
        }
      }

      if (allItems.length > 0) {
        logger.info(
          'Merged continuation XML documents',
          {
            totalItems: allItems.length,
            fragments: xmlDocs.length,
          },
          'XMLParser'
        );

        return {
          success: true,
          data: allItems,
        };
      }
    }

    // Fallback to single document parse
    const cleaned = cleanXMLMarkdown(content);
    const data = parseXMLToObject(cleaned);

    return {
      success: true,
      data,
    };
  } catch (error) {
    return {
      success: false,
      data: null,
      error: formatError(error),
    };
  }
}
