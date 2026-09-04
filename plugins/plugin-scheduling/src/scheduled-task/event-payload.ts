/**
 * Clones complete plain JSON event data for dispatch persistence and host
 * prompts. Dates, custom objects, accessors, sparse arrays, and values JSON
 * would omit are rejected before delivery; repeated references are permitted.
 */
import { ElizaError, type JsonValue } from "@elizaos/core/edge";

function cloneDataProperty(
  object: object,
  key: string | symbol,
  ancestors: Set<object>,
): JsonValue {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (
    typeof key !== "string" ||
    !descriptor?.enumerable ||
    !Object.hasOwn(descriptor, "value")
  ) {
    throw new TypeError(
      "Event payload requires enumerable string-keyed data properties",
    );
  }
  return cloneJsonValue(descriptor.value, ancestors);
}

function cloneJsonValue(value: unknown, ancestors: Set<object>): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") {
    throw new TypeError("Event payload contains a value JSON cannot preserve");
  }
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      "Event payload objects must be plain JSON records or arrays",
    );
  }
  if (ancestors.has(value))
    throw new TypeError("Event payload contains a cycle");

  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (isArray) {
      // JSON ignores extra array properties and fills holes with null.
      if (keys.length !== value.length + 1) {
        throw new TypeError(
          "Event payload arrays must be dense and have no extra properties",
        );
      }
      return Array.from({ length: value.length }, (_item, index) =>
        cloneDataProperty(value, String(index), ancestors),
      );
    }
    return Object.fromEntries(
      keys.map((key) => [key, cloneDataProperty(value, key, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

/** Clone plain JSON data without a content limit or implicit value conversion. */
export function normalizeScheduledEventPayload(
  value: unknown,
  taskId: string,
): JsonValue {
  try {
    return cloneJsonValue(value, new Set());
  } catch (cause) {
    // error-policy:J2 context-adding rethrow — no partial event may reach delivery.
    throw new ElizaError(
      "Scheduled event payload must contain plain JSON data; explicitly convert dates and custom objects, and remove cycles, missing array entries, symbols, accessors, and unsupported values before firing the task.",
      {
        code: "SCHEDULED_EVENT_PAYLOAD_NOT_SERIALIZABLE",
        context: { taskId },
        cause,
      },
    );
  }
}
