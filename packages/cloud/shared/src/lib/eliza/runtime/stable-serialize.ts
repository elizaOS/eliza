export function stableSerialize(value: unknown): string {
  return serializeStableValue(value, new WeakSet<object>());
}

function serializeStableValue(value: unknown, seen: WeakSet<object>): string {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError("stableSerialize does not support circular references");
    }
    seen.add(value);
    const serialized = `[${value.map((item) => serializeStableValue(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }

  if (value && typeof value === "object") {
    if (value instanceof Date) {
      return JSON.stringify(value.toISOString());
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        `stableSerialize does not support ${value.constructor?.name ?? "non-plain object"} values`,
      );
    }

    if (seen.has(value)) {
      throw new TypeError("stableSerialize does not support circular references");
    }
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    const serialized = `{${entries
      .map(
        ([key, entryValue]) => `${JSON.stringify(key)}:${serializeStableValue(entryValue, seen)}`,
      )
      .join(",")}}`;
    seen.delete(value);
    return serialized;
  }

  return JSON.stringify(value) ?? "null";
}
