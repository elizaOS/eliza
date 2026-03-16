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

import type {
  JsonObject as BufJsonObject,
  JsonValue as BufJsonValue,
} from "@bufbuild/protobuf";

export * from "./generated/eliza/v1/agent_pb.js";
export * from "./generated/eliza/v1/components_pb.js";
export * from "./generated/eliza/v1/database_pb.js";
export * from "./generated/eliza/v1/environment_pb.js";
export * from "./generated/eliza/v1/events_pb.js";
export * from "./generated/eliza/v1/ipc_pb.js";
export * from "./generated/eliza/v1/knowledge_pb.js";
export * from "./generated/eliza/v1/memory_pb.js";
export * from "./generated/eliza/v1/message_service_pb.js";
export * from "./generated/eliza/v1/messaging_pb.js";
export * from "./generated/eliza/v1/model_pb.js";
export * from "./generated/eliza/v1/plugin_pb.js";
export * from "./generated/eliza/v1/primitives_pb.js";
export * from "./generated/eliza/v1/prompts_pb.js";
export * from "./generated/eliza/v1/service_interfaces_pb.js";
export * from "./generated/eliza/v1/service_pb.js";
export * from "./generated/eliza/v1/settings_pb.js";
export * from "./generated/eliza/v1/state_pb.js";
export * from "./generated/eliza/v1/task_pb.js";
export * from "./generated/eliza/v1/tee_pb.js";
export * from "./generated/eliza/v1/testing_pb.js";

/**
 * Type alias for JSON-serializable object (used for dynamic properties)
 */
export type JsonObject = BufJsonObject;

/**
 * Type alias for JSON-serializable values
 */
export type JsonValue = BufJsonValue;

/**
 * Helper to convert a proto message to a plain JSON object.
 * Uses a properly constrained type to avoid unsafe casts.
 */
export function toJson<T extends JsonObject>(message: T): JsonObject {
  // The @bufbuild/protobuf types are already plain objects
  return message;
}

/**
 * Helper to create a proto message from a plain object
 */
export function fromJson<T extends object>(
  schema: { new (): T },
  json: JsonObject,
): T {
  return Object.assign(new schema(), json);
}
