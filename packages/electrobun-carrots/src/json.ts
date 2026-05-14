import type { JsonObject, JsonValue } from "./types.js";

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
