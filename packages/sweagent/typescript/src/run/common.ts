/**
 * Common utilities for run module
 * Converted from sweagent/run/common.py
 */

import fs from "node:fs";
import path from "node:path";
import type { JsonObject, JsonValue } from "../json";
import type { AgentInfo, AgentRunResult } from "../types";

/**
 * Shorten a string to a maximum length
 */
export function shortenString(
  s: string,
  maxLength: number,
  shortenLeft: boolean = false,
): string {
  if (s.length <= maxLength) {
    return s;
  }

  if (shortenLeft) {
    return `...${s.slice(s.length - maxLength + 3)}`;
  } else {
    return `${s.slice(0, maxLength - 3)}...`;
  }
}

/**
 * Shorten strings in a nested object/array
 */
export function shortenStrings(
  data: JsonValue,
  maxLength: number = 30,
): JsonValue {
  if (typeof data === "string") {
    return shortenString(data, maxLength);
  }

  if (Array.isArray(data)) {
    return data.map((item) => shortenStrings(item, maxLength));
  }

  if (data && typeof data === "object") {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = shortenStrings(value as JsonValue, maxLength);
    }
    return result;
  }

  return data;
}

/**
 * Save predictions from agent run result
 */
export function savePredictions(
  trajDir: string | path.ParsedPath,
  instanceId: string,
  result: AgentRunResult,
): void {
  const dirPath = typeof trajDir === "string" ? trajDir : path.format(trajDir);
  const predPath = path.join(dirPath, "predictions.json");

  // Load existing predictions or create new
  let predictions: Record<string, Record<string, string | number>> = {};
  if (fs.existsSync(predPath)) {
    const content = fs.readFileSync(predPath, "utf-8");
    predictions = JSON.parse(content);
  }

  // Add/update prediction for this instance
  predictions[instanceId] = {
    model_patch: result.info.submission || "",
    model_name_or_path: result.info.modelStats?.model || "unknown",
    cost: result.info.modelStats?.instanceCost || 0,
    api_calls: result.info.modelStats?.apiCalls || 0,
    instance_id: instanceId,
  };

  // Save predictions
  fs.writeFileSync(predPath, JSON.stringify(predictions, null, 2));
}

/**
 * Check if a patch is promising (not empty/trivial)
 */
export function isPromisingPatch(info: AgentInfo): boolean {
  const submission = info.submission;

  if (!submission || typeof submission !== "string") {
    return false;
  }

  // Check if patch is empty or only whitespace
  if (submission.trim() === "") {
    return false;
  }

  // Check if patch only contains diff headers but no actual changes
  const lines = submission.split("\n");
  let hasChanges = false;

  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      hasChanges = true;
      break;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      hasChanges = true;
      break;
    }
  }

  return hasChanges;
}

/**
 * Create a nested dictionary structure
 */
export function createNestedDict(): JsonObject {
  return new Proxy(
    {},
    {
      get: (target: JsonObject, prop: string): JsonValue | undefined => {
        const existing = target[prop];
        if (existing === undefined) {
          const next = createNestedDict();
          target[prop] = next;
          return next;
        }
        return existing;
      },
    },
  );
}

/**
 * Parse command-line arguments into nested dictionary
 */
export function parseArgsToNestedDict(args: string[]): JsonObject {
  const result = createNestedDict();

  for (const arg of args) {
    if (arg.includes("=")) {
      const [keyPath, value] = arg.split("=", 2);
      const keys = keyPath.split(".");

      let current: JsonObject = result;
      for (let i = 0; i < keys.length - 1; i++) {
        const existing = current[keys[i]];
        if (
          existing === undefined ||
          typeof existing !== "object" ||
          existing === null ||
          Array.isArray(existing)
        ) {
          current[keys[i]] = {};
        }
        current = current[keys[i]] as JsonObject;
      }

      // Try to parse value as JSON, number, or boolean
      let parsedValue: JsonValue = value;
      try {
        parsedValue = JSON.parse(value) as JsonValue;
      } catch {
        if (value === "true") {
          parsedValue = true;
        } else if (value === "false") {
          parsedValue = false;
        } else if (!Number.isNaN(Number(value))) {
          parsedValue = Number(value);
        }
      }

      current[keys[keys.length - 1]] = parsedValue;
    }
  }

  return result;
}
