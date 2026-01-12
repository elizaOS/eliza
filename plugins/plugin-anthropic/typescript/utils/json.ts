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

export function ensureReflectionProperties(
  obj: ExtractedJSON,
  isReflection: boolean
): ExtractedJSON {
  if (!isReflection) {
    return obj;
  }

  if (obj !== null && typeof obj === "object" && !("type" in obj)) {
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

function extractFromCodeBlocks(text: string): string | null {
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch?.[1]) {
    return jsonBlockMatch[1].trim();
  }

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

function extractJsonContent(text: string): string | null {
  const jsonContentMatch = text.match(/(^|\n)\s*(\{[\s\S]*\})\s*($|\n)/);
  if (jsonContentMatch?.[2]) {
    return jsonContentMatch[2].trim();
  }

  const jsonMatches = text.match(/\{[\s\S]*?\}/g);
  if (jsonMatches && jsonMatches.length > 0) {
    const sorted = [...jsonMatches].sort((a, b) => b.length - a.length);
    return sorted[0] ?? null;
  }

  return null;
}

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

export function extractAndParseJSON(text: string): ExtractedJSON {
  const directResult = tryDirectParse(text);
  if (directResult) {
    return directResult;
  }

  logger.debug("Initial JSON parse failed, attempting alternative extraction");

  const repairedResult = tryRepairParse(text);
  if (repairedResult) {
    return repairedResult;
  }

  logger.debug("JSONRepair failed, proceeding with manual extraction");

  const codeBlockResult = handleJsonWithCodeBlocks(text);
  if (codeBlockResult) {
    return codeBlockResult;
  }

  const extractedBlock = extractFromCodeBlocks(text);
  if (extractedBlock) {
    const blockParsed = tryDirectParse(extractedBlock) ?? tryRepairParse(extractedBlock);
    if (blockParsed) {
      return blockParsed;
    }
  }

  const extractedJson = extractJsonContent(text);
  if (extractedJson) {
    const jsonParsed = tryDirectParse(extractedJson) ?? tryRepairParse(extractedJson);
    if (jsonParsed) {
      return jsonParsed;
    }
  }

  const manualResult = extractThoughtMessage(text);
  if (manualResult) {
    return manualResult;
  }

  logger.debug("All JSON extraction methods failed, returning unstructured response");
  const unstructured: UnstructuredResponse = {
    type: "unstructured_response",
    content: text,
  };
  return unstructured;
}
