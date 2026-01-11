/**
 * JSON extraction and parsing utilities.
 *
 * These utilities handle extracting valid JSON from LLM responses that may
 * contain markdown, code blocks, or other non-JSON content.
 */

import { logger } from "@elizaos/core";
import { jsonrepair } from "jsonrepair";
import type {
  CodeBlockPlaceholder,
  ExtractedJSON,
  JsonObject,
  JsonValue,
  ReconstructedResponse,
  ReflectionResponse,
  UnstructuredResponse,
} from "../types";

/**
 * Ensure reflection response has all required properties.
 * Only processes if isReflection is true.
 */
export function ensureReflectionProperties(
  obj: ExtractedJSON,
  isReflection: boolean
): ExtractedJSON {
  if (!isReflection) {
    return obj;
  }

  if (obj !== null && typeof obj === "object" && !("type" in obj)) {
    // It's a JsonObject, add reflection properties
    const jsonObj = obj as JsonObject;
    return {
      ...jsonObj,
      thought:
        "thought" in jsonObj && typeof jsonObj["thought"] === "string" ? jsonObj["thought"] : "",
      facts: "facts" in jsonObj && Array.isArray(jsonObj["facts"]) ? jsonObj["facts"] : [],
      relationships:
        "relationships" in jsonObj && Array.isArray(jsonObj["relationships"])
          ? jsonObj["relationships"]
          : [],
    };
  }

  return obj;
}

/**
 * Recursively restore code blocks in a parsed object.
 */
function restoreCodeBlocks(
  obj: JsonValue,
  placeholders: readonly CodeBlockPlaceholder[]
): JsonValue {
  if (typeof obj === "string") {
    let result = obj;
    for (const { placeholder, content } of placeholders) {
      result = result.replace(placeholder, content);
    }
    return result;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => restoreCodeBlocks(item, placeholders));
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = restoreCodeBlocks(value as JsonValue, placeholders);
    }
    return result;
  }

  return obj;
}

/**
 * Try to parse JSON directly.
 */
function tryDirectParse(text: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Try to repair and parse JSON.
 */
function tryRepairParse(text: string): JsonObject | null {
  try {
    const repaired = jsonrepair(text);
    const parsed: unknown = JSON.parse(repaired);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract JSON from code blocks.
 */
function extractFromCodeBlocks(text: string): string | null {
  // First priority: explicit JSON code blocks
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch?.[1]) {
    return jsonBlockMatch[1].trim();
  }

  // Second priority: any code block with JSON-like content
  const anyBlockRegex = /```(?:\w*)\s*([\s\S]*?)\s*```/g;
  let match: RegExpExecArray | null = anyBlockRegex.exec(text);
  while (match !== null) {
    const blockContent = match[1]?.trim();
    if (blockContent?.startsWith("{") && blockContent.endsWith("}")) {
      return blockContent;
    }
    match = anyBlockRegex.exec(text);
  }

  return null;
}

/**
 * Extract JSON-like content from text.
 */
function extractJsonContent(text: string): string | null {
  // Try to find JSON-like content
  const jsonContentMatch = text.match(/(^|\n)\s*(\{[\s\S]*\})\s*($|\n)/);
  if (jsonContentMatch?.[2]) {
    return jsonContentMatch[2].trim();
  }

  // Find the largest JSON-like structure
  const jsonMatches = text.match(/\{[\s\S]*?\}/g);
  if (jsonMatches && jsonMatches.length > 0) {
    // Sort by length descending and return the largest
    const sorted = [...jsonMatches].sort((a, b) => b.length - a.length);
    return sorted[0] ?? null;
  }

  return null;
}

/**
 * Try to manually extract thought/message structure.
 */
function extractThoughtMessage(text: string): ReconstructedResponse | ReflectionResponse | null {
  const thoughtPattern = /"thought"\s*:\s*"([^"]*?)(?:"|$)/;
  const messagePattern = /"message"\s*:\s*"([^"]*?)(?:"|$)/;

  const thoughtMatch = text.match(thoughtPattern);
  const messageMatch = text.match(messagePattern);

  if (thoughtMatch || messageMatch) {
    const result: {
      type: "reconstructed_response";
      thought?: string;
      message?: string;
      codeBlocks?: Array<{ language: string; code: string }>;
    } = { type: "reconstructed_response" };

    if (thoughtMatch?.[1]) {
      result.thought = thoughtMatch[1].replace(/\\n/g, "\n");
    }

    if (messageMatch?.[1]) {
      result.message = messageMatch[1].replace(/\\n/g, "\n");
    } else if (thoughtMatch) {
      // Extract code blocks and remaining content
      let remainingContent = text.replace(thoughtPattern, "");
      const codeBlocks: Array<{ language: string; code: string }> = [];
      const codeBlockRegex = /```([\w]*)\n([\s\S]*?)```/g;
      let codeMatch: RegExpExecArray | null = codeBlockRegex.exec(remainingContent);

      while (codeMatch !== null) {
        codeBlocks.push({
          language: codeMatch[1] || "text",
          code: codeMatch[2]?.trim() ?? "",
        });
        codeMatch = codeBlockRegex.exec(remainingContent);
      }

      if (codeBlocks.length > 0) {
        result.codeBlocks = codeBlocks;
        remainingContent = remainingContent.replace(codeBlockRegex, "");
      }

      result.message = remainingContent.trim();
    }

    return result as ReconstructedResponse;
  }

  // Check for reflection schema pattern
  if (text.includes("thought") || text.includes("facts") || text.includes("relationships")) {
    logger.debug("Attempting to extract reflection schema components");

    const reflectionThoughtMatch = text.match(/thought["\s:]+([^"{}[\],]+)/i);

    const result: ReflectionResponse = {
      thought: reflectionThoughtMatch?.[1]?.trim() ?? "",
      facts: [],
      relationships: [],
      rawContent: text,
    };

    return result;
  }

  return null;
}

/**
 * Handle JSON with embedded code blocks.
 */
function handleJsonWithCodeBlocks(text: string): JsonObject | null {
  const isJsonWithCodeBlocks =
    text.trim().startsWith("{") && text.trim().endsWith("}") && text.includes("```");

  if (!isJsonWithCodeBlocks) {
    return null;
  }

  try {
    const placeholders: CodeBlockPlaceholder[] = [];
    let counter = 0;

    const textWithPlaceholders = text.replace(
      /```(\w*)\n([\s\S]*?)```/g,
      (_match, language: string, code: string) => {
        const placeholder = `__CODE_BLOCK_${counter++}__`;
        placeholders.push({
          placeholder,
          content: `\`\`\`${language}\n${code}\`\`\``,
        });
        return placeholder;
      }
    );

    let parsed = tryRepairParse(textWithPlaceholders);
    if (!parsed) {
      parsed = tryDirectParse(textWithPlaceholders);
    }

    if (parsed) {
      return restoreCodeBlocks(parsed, placeholders) as JsonObject;
    }
  } catch {
    logger.debug("Code block preservation failed");
  }

  return null;
}

/**
 * Extract and parse JSON from LLM responses.
 *
 * This function handles various response formats including:
 * - Direct JSON
 * - JSON in markdown code blocks
 * - JSON with embedded code blocks
 * - Mixed markdown and JSON
 *
 * @throws Never - always returns a valid ExtractedJSON type
 */
export function extractAndParseJSON(text: string): ExtractedJSON {
  // First attempt: Direct JSON parsing
  const directResult = tryDirectParse(text);
  if (directResult) {
    return directResult;
  }

  logger.debug("Initial JSON parse failed, attempting alternative extraction");

  // Try JSONRepair
  const repairedResult = tryRepairParse(text);
  if (repairedResult) {
    return repairedResult;
  }

  logger.debug("JSONRepair failed, proceeding with manual extraction");

  // Handle JSON with embedded code blocks
  const codeBlockResult = handleJsonWithCodeBlocks(text);
  if (codeBlockResult) {
    return codeBlockResult;
  }

  // Try extracting from code blocks
  const extractedBlock = extractFromCodeBlocks(text);
  if (extractedBlock) {
    const blockParsed = tryDirectParse(extractedBlock) ?? tryRepairParse(extractedBlock);
    if (blockParsed) {
      return blockParsed;
    }
  }

  // Try extracting JSON-like content
  const extractedJson = extractJsonContent(text);
  if (extractedJson) {
    const jsonParsed = tryDirectParse(extractedJson) ?? tryRepairParse(extractedJson);
    if (jsonParsed) {
      return jsonParsed;
    }
  }

  // Try manual structure extraction
  const manualResult = extractThoughtMessage(text);
  if (manualResult) {
    return manualResult;
  }

  // Last resort: Return unstructured response
  logger.debug("All JSON extraction methods failed, returning unstructured response");
  const unstructured: UnstructuredResponse = {
    type: "unstructured_response",
    content: text,
  };
  return unstructured;
}
