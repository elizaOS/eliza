import { logger } from '@elizaos/core';
import { jsonrepair } from 'jsonrepair';

/**
 * Type definition for a code block placeholder
 */
interface CodeBlockPlaceholder {
  placeholder: string;
  content: string;
}

/**
 * Type for reconstructed response
 */
export interface ReconstructedResponse {
  type: 'reconstructed_response';
  thought?: string;
  message?: string;
  codeBlocks?: Array<{
    language: string;
    code: string;
  }>;
}

/**
 * Type for reflection schema response
 */
export interface ReflectionResponse {
  thought: string;
  facts: unknown[];
  relationships: unknown[];
  rawContent: string;
}

/**
 * Type for unstructured response
 */
export interface UnstructuredResponse {
  type: 'unstructured_response';
  content: string;
}

/**
 * Type for JSON extraction result
 */
export type ExtractedJSON =
  | Record<string, unknown>
  | ReconstructedResponse
  | ReflectionResponse
  | UnstructuredResponse;

/**
 * Helper function to ensure reflection response has all required properties
 */
export const ensureReflectionProperties = (
  obj: ExtractedJSON,
  isReflection: boolean
): ExtractedJSON => {
  // Only process if it's a reflection schema request
  if (!isReflection) return obj;

  // Check if it's an object with potentially missing reflection properties
  if (obj !== null && typeof obj === 'object') {
    // Create a new object with required properties
    return {
      ...obj,
      thought: 'thought' in obj ? obj.thought || '' : '',
      facts: 'facts' in obj ? obj.facts || [] : [],
      relationships: 'relationships' in obj ? obj.relationships || [] : [],
    };
  }

  return obj;
};

/**
 * Enhanced function to extract and parse JSON from LLM responses
 * Handles various response formats including mixed markdown and JSON with code blocks
 */
export const extractAndParseJSON = (text: string): ExtractedJSON => {
  try {
    // First attempt: Try direct JSON parsing
    return JSON.parse(text);
  } catch (initialError) {
    logger.debug('Initial JSON parse failed, attempting alternative extraction methods');

    // Try JSONRepair first
    try {
      const repaired = jsonrepair(text);
      return JSON.parse(repaired);
    } catch (repairError) {
      logger.debug('JSONRepair failed, proceeding with manual extraction methods');
    }

    // Check if we have a valid JSON structure with embedded code blocks
    // This specifically addresses the case where Anthropic returns a valid JSON object
    // that contains markdown code blocks inside string values
    const isJsonWithCodeBlocks =
      text.trim().startsWith('{') && text.trim().endsWith('}') && text.includes('```');

    if (isJsonWithCodeBlocks) {
      // Replace code blocks with escaped versions to preserve them in the JSON
      try {
        // First, try to preserve the code blocks by temporarily replacing them
        const codeBlockPlaceholders: CodeBlockPlaceholder[] = [];
        let placeholderCounter = 0;
        const textWithPlaceholders = text.replace(
          /```(\w*)\n([\s\S]*?)```/g,
          (match, language, code) => {
            const placeholder = `__CODE_BLOCK_${placeholderCounter++}__`;
            codeBlockPlaceholders.push({
              placeholder,
              content: `\`\`\`${language}\n${code}\`\`\``,
            });
            return placeholder;
          }
        );

        // Try parsing with placeholders
        let parsed: Record<string, unknown>;
        try {
          // Try JSONRepair first
          const repaired = jsonrepair(textWithPlaceholders);
          parsed = JSON.parse(repaired);
        } catch (e) {
          // If JSONRepair fails, try direct parsing
          parsed = JSON.parse(textWithPlaceholders);
        }

        // Restore code blocks in the parsed object
        const restoreCodeBlocks = (obj: unknown): unknown => {
          if (typeof obj === 'string') {
            let result = obj;
            for (const { placeholder, content } of codeBlockPlaceholders) {
              result = result.replace(placeholder, content);
            }
            return result;
          } else if (Array.isArray(obj)) {
            return obj.map((item) => restoreCodeBlocks(item));
          } else if (obj !== null && typeof obj === 'object') {
            const result: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
              result[key] = restoreCodeBlocks(value);
            }
            return result;
          }
          return obj;
        };

        return restoreCodeBlocks(parsed) as ExtractedJSON;
      } catch (codeBlockError) {
        logger.debug('Code block preservation failed, continuing with other methods');
      }
    }

    // Try to extract JSON from code blocks
    const extractFromCodeBlocks = (text: string): string | null => {
      // First priority: explicit JSON code blocks
      const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/;
      const jsonMatch = text.match(jsonBlockRegex);
      if (jsonMatch && jsonMatch[1]) {
        return jsonMatch[1].trim();
      }

      // Second priority: any code block that contains JSON-like content
      const anyBlockRegex = /```(?:\w*)\s*([\s\S]*?)\s*```/g;
      let match;
      while ((match = anyBlockRegex.exec(text)) !== null) {
        const blockContent = match[1].trim();
        if (blockContent.startsWith('{') && blockContent.endsWith('}')) {
          return blockContent;
        }
      }

      return null;
    };

    const extractedFromCodeBlock = extractFromCodeBlocks(text);
    if (extractedFromCodeBlock) {
      try {
        // Try parsing the extracted content
        return JSON.parse(extractedFromCodeBlock);
      } catch (blockParseError) {
        try {
          // Try with JSONRepair
          const repaired = jsonrepair(extractedFromCodeBlock);
          return JSON.parse(repaired);
        } catch (blockRepairError) {
          logger.debug('Failed to parse JSON from code block after repair');
        }
      }
    }

    // Look for JSON structure outside of code blocks
    const extractJSON = (text: string): string | null => {
      // Try to find JSON-like content in the text
      // This regex looks for content that starts with { and ends with }
      const jsonContentRegex = /(^|\n)\s*(\{[\s\S]*\})\s*($|\n)/;
      const contentMatch = text.match(jsonContentRegex);

      if (contentMatch && contentMatch[2]) {
        return contentMatch[2].trim();
      }

      // If no direct match, try to find the largest JSON-like structure
      const jsonPattern = /\{[\s\S]*?\}/g;
      const jsonMatches = text.match(jsonPattern);

      if (jsonMatches && jsonMatches.length > 0) {
        // Sort matches by length (descending) to try the largest JSON-like structure first
        return [...jsonMatches].sort((a, b) => b.length - a.length)[0];
      }

      return null;
    };

    const extractedJSON = extractJSON(text);
    if (extractedJSON) {
      try {
        // Try parsing the extracted JSON
        return JSON.parse(extractedJSON);
      } catch (extractParseError) {
        try {
          // Try with JSONRepair
          const repaired = jsonrepair(extractedJSON);
          return JSON.parse(repaired);
        } catch (extractRepairError) {
          logger.debug('Failed to parse JSON after extraction and repair');
        }
      }
    }

    // Try to manually extract a "thought"/"message" structure which is common
    const manuallyExtractStructure = (
      text: string
    ): ReconstructedResponse | ReflectionResponse | null => {
      // Extract thought/message pattern if present
      const thoughtPattern = /"thought"\s*:\s*"([^"]*?)(?:"|$)/;
      const messagePattern = /"message"\s*:\s*"([^"]*?)(?:"|$)/;

      const thoughtMatch = text.match(thoughtPattern);
      const messageMatch = text.match(messagePattern);

      if (thoughtMatch || messageMatch) {
        const extractedContent: ReconstructedResponse = {
          type: 'reconstructed_response',
        };

        if (thoughtMatch) {
          extractedContent.thought = thoughtMatch[1].replace(/\\n/g, '\n');
        }

        if (messageMatch) {
          extractedContent.message = messageMatch[1].replace(/\\n/g, '\n');
        } else {
          // If no message was found but we have a thought, try to use the rest of the content as message
          let remainingContent = text;
          if (thoughtMatch) {
            // Remove the thought part from the content
            remainingContent = remainingContent.replace(thoughtPattern, '');
          }

          // Look for code blocks in the remaining content
          const codeBlocks: Array<{ language: string; code: string }> = [];
          const codeBlockRegex = /```([\w]*)\n([\s\S]*?)```/g;
          let match;

          while ((match = codeBlockRegex.exec(remainingContent)) !== null) {
            codeBlocks.push({
              language: match[1] || 'text',
              code: match[2].trim(),
            });
          }

          if (codeBlocks.length > 0) {
            extractedContent.codeBlocks = codeBlocks;
            // Remove code blocks from the remaining content
            remainingContent = remainingContent.replace(codeBlockRegex, '');
          }

          // Use the cleaned remaining content as message
          extractedContent.message = remainingContent.trim();
        }

        return extractedContent;
      }

      // For reflection schema-like structure
      if (text.includes('thought') || text.includes('facts') || text.includes('relationships')) {
        logger.debug('Attempting to extract reflection schema components');

        const result: ReflectionResponse = {
          thought: '',
          facts: [],
          relationships: [],
          rawContent: text,
        };

        // Try to extract thought
        const thoughtMatch = text.match(/thought["\s:]+([^"{}[\],]+)/i);
        if (thoughtMatch) {
          result.thought = thoughtMatch[1].trim();
        }

        // Attempt to extract facts and relationships would go here
        // This would require more complex parsing logic for arrays

        return result;
      }

      return null;
    };

    const manuallyExtracted = manuallyExtractStructure(text);
    if (manuallyExtracted) {
      return manuallyExtracted;
    }

    // Last resort: Return a structured object with the raw text
    logger.debug(
      'All JSON extraction methods failed, returning structured object with raw content'
    );
    return {
      type: 'unstructured_response',
      content: text,
    };
  }
};

// Future config schema for generateObject
/**
 * Configuration schema for Anthropic plugin.
 * This will be used when we switch to generateObject instead of generateText.
 */
export const configSchemaComment = `
// Define a configuration schema for the Anthropics plugin.
// const configSchema = z.object({
// 	ANTHROPIC_API_KEY: z.string().min(1, "Anthropic API key is required"),
// 	ANTHROPIC_SMALL_MODEL: z.string().optional(),
// 	ANTHROPIC_LARGE_MODEL: z.string().optional(),
// });
`;
