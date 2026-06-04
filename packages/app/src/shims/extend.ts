type AnyRecord = Record<PropertyKey, unknown>;

function isPlainObject(value: unknown): value is AnyRecord {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mergeValue(deep: boolean, targetValue: unknown, sourceValue: unknown) {
  if (!deep || (!Array.isArray(sourceValue) && !isPlainObject(sourceValue))) {
    return sourceValue;
  }

  if (Array.isArray(sourceValue)) {
    const targetArray = Array.isArray(targetValue) ? targetValue : [];
    return extend(true, targetArray, sourceValue);
  }

  const targetObject = isPlainObject(targetValue) ? targetValue : {};
  return extend(true, targetObject, sourceValue);
}

export default function extend<T extends object>(
  deepOrTarget: boolean | T,
  ...sources: object[]
): T {
  const deep = typeof deepOrTarget === "boolean";
  const target = (deep ? sources.shift() : deepOrTarget) as AnyRecord;

  for (const source of sources) {
    if (source == null) continue;
    for (const [key, value] of Object.entries(source)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      target[key] = mergeValue(deep, target[key], value);
    }
  }

  return target as T;
}
