type AnyRecord = Record<PropertyKey, unknown>;

function isPlainObject(value: unknown): value is AnyRecord {
  if (!value || Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function getProperty(source: AnyRecord, name: PropertyKey): unknown {
  if (name === "__proto__" && !Object.hasOwn(source, name)) {
    return undefined;
  }
  return source[name];
}

function setProperty(
  target: AnyRecord,
  name: PropertyKey,
  value: unknown,
): void {
  if (name === "__proto__") {
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
    return;
  }

  target[name] = value;
}

export default function extend(...args: unknown[]): AnyRecord {
  let target = args[0] as AnyRecord | null | undefined;
  let index = 1;
  let deep = false;

  if (typeof target === "boolean") {
    deep = target;
    target = (args[1] as AnyRecord | null | undefined) ?? {};
    index = 2;
  }

  if (!target || (typeof target !== "object" && typeof target !== "function")) {
    target = {};
  }

  for (; index < args.length; index += 1) {
    const options = args[index] as AnyRecord | null | undefined;
    if (!options) continue;

    for (const name of Object.keys(options)) {
      const source = getProperty(target, name);
      const copy = getProperty(options, name);
      if (target === copy || copy === undefined) {
        continue;
      }

      if (deep && (isPlainObject(copy) || Array.isArray(copy))) {
        const clone = Array.isArray(copy)
          ? Array.isArray(source)
            ? source
            : []
          : isPlainObject(source)
            ? source
            : {};
        setProperty(target, name, extend(true, clone, copy));
      } else {
        setProperty(target, name, copy);
      }
    }
  }

  return target;
}
