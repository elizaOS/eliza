/**
 * Minimal JSON types used across the sweagent TypeScript port.
 *
 * This avoids `unknown`/`any` while still representing arbitrary structured data
 * that can be safely serialized.
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | {
      [key: string]: JsonValue | undefined;
    };

export type JsonObject = {
  [key: string]: JsonValue | undefined;
};
