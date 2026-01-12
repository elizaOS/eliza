/**
 * Proto-generated Types
 *
 * This module provides the proto-generated types for elizaOS.
 * Types are generated from /packages/@schemas/eliza/v1/*.proto using @bufbuild/protoc-gen-es
 *
 * ## Type Structure
 *
 * 1. **Enums**: Use `ENUM_NAME_VALUE` format
 *    - Example: `MEMORY_TYPE_MESSAGE`
 *
 * 2. **Optional fields**: Explicitly typed as `T | undefined`
 *
 * 3. **Dynamic properties**: Use `google.protobuf.Struct` (JsonObject)
 *    - Access via `.data` field on Content, State, etc.
 *
 * @module @elizaos/core/types/proto
 */

// TODO: Generate types from /packages/@schemas/eliza/v1/*.proto using @bufbuild/protoc-gen-es
// import from "./generated/index.js" directly when available

/**
 * Type alias for JSON-serializable object (used for dynamic properties)
 */
export type JsonObject = Record<string, unknown>;

/**
 * Helper to convert a proto message to a plain JSON object.
 * Uses a properly constrained type to avoid unsafe casts.
 */
export function toJson<T extends Record<string, unknown>>(
  message: T,
): Record<string, unknown> {
  // The @bufbuild/protobuf types are already plain objects
  return message;
}

/**
 * Helper to create a proto message from a plain object
 */
export function fromJson<T extends object>(
  schema: { new (): T },
  json: Record<string, unknown>,
): T {
  return Object.assign(new schema(), json) as T;
}
