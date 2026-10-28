/**
 * Browser-safe JSON, schema and view-capability types. A leaf entry with no
 * runtime code, for renderers and plugin clients that must not load the root
 * `@elizaos/core` barrel.
 */
export type { JsonObject, JsonPrimitive, JsonValue } from "./types/json.ts";
export type { ActionParameterSchema, JSONSchema } from "./types/schema.ts";
export type {
	ViewCapability,
	ViewCapabilityParameter,
} from "./types/view-capability.ts";
