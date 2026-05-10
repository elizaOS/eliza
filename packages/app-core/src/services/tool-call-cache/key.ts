/**
 * Stable cache-key derivation.
 *
 * Args are JSON-stringified with sorted object keys so semantically-equal
 * argument shapes (e.g. `{a:1,b:2}` and `{b:2,a:1}`) collide on the same
 * key. The final key is `sha256(toolName + ':' + canonicalJson)`.
 */

import { createHash } from "node:crypto";

import type { ToolArgs } from "./types.ts";

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalizeJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`${JSON.stringify(key)}:${canonicalizeJson(obj[key])}`);
  }
  return `{${parts.join(",")}}`;
}

export function buildCacheKey(toolName: string, args: ToolArgs): string {
  const canonical = canonicalizeJson(args);
  const hash = createHash("sha256");
  hash.update(toolName);
  hash.update(":");
  hash.update(canonical);
  return hash.digest("hex");
}
