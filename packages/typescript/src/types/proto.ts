/**
 * Proto-generated Types Compatibility Layer
 * 
 * This module provides a compatibility layer between the proto-generated types
 * and the legacy TypeScript interfaces. It re-exports the generated types
 * and provides type aliases for backwards compatibility.
 * 
 * ## Migration Guide
 * 
 * The proto-generated types use a slightly different structure:
 * 
 * 1. **Enums**: Use `ENUM_NAME_VALUE` format instead of `EnumName.Value`
 *    - Old: `MemoryType.MESSAGE`
 *    - New: `MEMORY_TYPE_MESSAGE` (or use `MemoryType.MESSAGE` re-export)
 * 
 * 2. **Optional fields**: Explicitly typed as `T | undefined`
 * 
 * 3. **Dynamic properties**: Use `google.protobuf.Struct` (JsonObject)
 *    - Access via `.data` field on Content, State, etc.
 * 
 * @module @elizaos/core/types/proto
 */

// Re-export all generated types
export * from "./generated/index.js";

/**
 * Type alias for JSON-serializable object (used for dynamic properties)
 */
export type JsonObject = Record<string, unknown>;

/**
 * Helper to convert a proto message to a plain JSON object
 */
export function toJson<T extends object>(message: T): Record<string, unknown> {
  // The @bufbuild/protobuf types are already plain objects
  return message as unknown as Record<string, unknown>;
}

/**
 * Helper to create a proto message from a plain object
 */
export function fromJson<T extends object>(
  schema: { new(): T },
  json: Record<string, unknown>
): T {
  return Object.assign(new schema(), json) as T;
}

