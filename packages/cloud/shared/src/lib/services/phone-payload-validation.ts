/** Validates phone metadata and media payloads before they cross the JSONB boundary. */

import { ElizaError } from "@elizaos/core/edge";
import { isPhoneLosslessJsonNumber } from "./phone-lossless-json";

export const PHONE_MESSAGE_METADATA_INVALID = "PHONE_MESSAGE_METADATA_INVALID";
export const PHONE_MESSAGE_MEDIA_URLS_INVALID = "PHONE_MESSAGE_MEDIA_URLS_INVALID";
export const PHONE_GATEWAY_METADATA_INVALID = "PHONE_GATEWAY_METADATA_INVALID";
export const PHONE_STORED_JSON_INVALID = "PHONE_STORED_JSON_INVALID";

const MAX_JSON_DEPTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (isPhoneLosslessJsonNumber(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDenseArray(value: unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function isJsonValue(value: unknown, ancestors: Set<object>, depth: number): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (isPhoneLosslessJsonNumber(value)) return true;
  if (depth >= MAX_JSON_DEPTH || typeof value !== "object") return false;

  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return (
        isDenseArray(value) && value.every((entry) => isJsonValue(entry, ancestors, depth + 1))
      );
    }
    if (!isPlainObject(value)) return false;
    return Object.values(value).every((entry) => isJsonValue(entry, ancestors, depth + 1));
  } finally {
    ancestors.delete(value);
  }
}

function invalidJsonObject(code: string, field: string, rule: string, message: string): never {
  throw new ElizaError(message, {
    code,
    context: { field, rule },
  });
}

/** Require a plain, losslessly serializable JSON object without logging its contents. */
export function requirePhoneJsonObject(
  value: unknown,
  options: { field: string; code?: string } = { field: "metadata" },
): Record<string, unknown> {
  const code = options.code ?? PHONE_STORED_JSON_INVALID;
  if (!isPlainObject(value)) {
    invalidJsonObject(code, options.field, "plain_object", "Phone metadata must be a JSON object");
  }
  if (!isJsonValue(value, new Set<object>(), 0)) {
    invalidJsonObject(
      code,
      options.field,
      "json_serializable",
      "Phone metadata contains a value that cannot be represented as JSON",
    );
  }
  return value;
}

/** Validate the intentionally shallow metadata accepted from phone webhooks. */
export function validatePhoneMessageMetadata(value: unknown): Record<string, unknown> {
  const metadata = requirePhoneJsonObject(value === undefined ? {} : value, {
    field: "metadata",
    code: PHONE_MESSAGE_METADATA_INVALID,
  });

  for (const entry of Object.values(metadata)) {
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry)) ||
      isPhoneLosslessJsonNumber(entry)
    ) {
      continue;
    }
    if (
      Array.isArray(entry) &&
      isDenseArray(entry) &&
      entry.every(
        (item) =>
          typeof item === "string" ||
          typeof item === "boolean" ||
          (typeof item === "number" && Number.isFinite(item)) ||
          isPhoneLosslessJsonNumber(item),
      )
    ) {
      continue;
    }
    invalidJsonObject(
      PHONE_MESSAGE_METADATA_INVALID,
      "metadata",
      "shallow_scalar_values",
      "Phone message metadata values must be scalars or scalar arrays",
    );
  }

  return metadata;
}

/** Require the JSONB media payload to be an array containing only strings. */
export function validatePhoneMediaUrls(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (
    !Array.isArray(value) ||
    !isDenseArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new ElizaError("Phone message media URLs must be a JSON array of strings", {
      code: PHONE_MESSAGE_MEDIA_URLS_INVALID,
      context: { field: "media_urls", rule: "string_array" },
    });
  }
  return value;
}
