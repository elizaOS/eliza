type PathSegment = string | number | symbol;
type Iteratee<T> =
  | ((item: T) => unknown)
  | PathSegment
  | readonly PathSegment[]
  | Record<string, unknown>
  | null
  | undefined;

const UNSAFE_PROPERTIES = new Set(["__proto__", "constructor", "prototype"]);

function isUnsafeProperty(property: unknown): boolean {
  return typeof property === "string" && UNSAFE_PROPERTIES.has(property);
}

function toPath(path: string): string[] {
  const segments: string[] = [];
  path.replace(
    /[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]/g,
    (match, number, _quote, quoted) => {
      segments.push(
        quoted !== undefined
          ? quoted.replace(/\\(.)/g, "$1")
          : (number ?? match),
      );
      return "";
    },
  );
  return segments;
}

function isDeepPath(path: string): boolean {
  return /[.[\]]/.test(path);
}

function toArray<T>(
  collection: ArrayLike<T> | Iterable<T> | null | undefined,
): T[] {
  if (collection == null) return [];
  return Array.from(collection as ArrayLike<T>);
}

export function get<T = unknown>(
  object: unknown,
  path: PathSegment | readonly PathSegment[],
  defaultValue?: T,
): T | unknown {
  if (object == null) return defaultValue;

  const segments = Array.isArray(path)
    ? path
    : typeof path === "string" && isDeepPath(path)
      ? toPath(path)
      : [path];

  let current = object as Record<PathSegment, unknown>;
  for (const segment of segments) {
    if (current == null || isUnsafeProperty(segment)) {
      return defaultValue;
    }
    current = current[segment] as Record<PathSegment, unknown>;
  }

  return current === undefined ? defaultValue : current;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function matchesObject<T>(
  expected: Record<string, unknown>,
): (item: T) => boolean {
  return (item) => {
    return Object.entries(expected).every(
      ([key, value]) => get(item, key) === value,
    );
  };
}

function toIteratee<T>(iteratee: Iteratee<T>): (item: T) => unknown {
  if (typeof iteratee === "function") return iteratee;
  if (iteratee == null) return (item) => item;
  if (typeof iteratee === "object") {
    if (Array.isArray(iteratee)) {
      return (item) => get(item, iteratee);
    }
    return matchesObject(iteratee as Record<string, unknown>);
  }
  return (item) => get(item, iteratee as PathSegment | readonly PathSegment[]);
}

export function uniqBy<T>(
  collection: ArrayLike<T> | Iterable<T>,
  iteratee?: Iteratee<T>,
): T[] {
  const seen = new Set<unknown>();
  const resolver = toIteratee(iteratee);
  const result: T[] = [];

  for (const item of toArray(collection)) {
    const key = resolver(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}

export function sortBy<T>(
  collection: ArrayLike<T> | Iterable<T>,
  iteratees?: Iteratee<T> | readonly Iteratee<T>[],
): T[] {
  const resolvers = (Array.isArray(iteratees) ? iteratees : [iteratees]).map(
    (iteratee) => toIteratee(iteratee),
  );

  return toArray(collection)
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      for (const resolver of resolvers) {
        const a = resolver(left.item);
        const b = resolver(right.item);
        if (a == null && b == null) continue;
        if (a == null) return 1;
        if (b == null) return -1;
        if (a < b) return -1;
        if (a > b) return 1;
      }
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

export function throttle<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait = 0,
): T & { cancel: () => void; flush: () => unknown } {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  let lastThis: unknown;
  let lastResult: unknown;
  let lastCall = 0;

  function invoke(now: number) {
    lastCall = now;
    timeout = null;
    if (lastArgs) {
      lastResult = func.apply(lastThis, lastArgs);
      lastArgs = null;
    }
    return lastResult;
  }

  const throttled = function throttled(this: unknown, ...args: Parameters<T>) {
    const now = Date.now();
    lastArgs = args;
    lastThis = this;
    const remaining = wait - (now - lastCall);

    if (remaining <= 0 || remaining > wait) {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      return invoke(now);
    }

    if (!timeout) {
      timeout = setTimeout(() => invoke(Date.now()), remaining);
    }
    return lastResult;
  } as T & { cancel: () => void; flush: () => unknown };

  throttled.cancel = () => {
    if (timeout) clearTimeout(timeout);
    timeout = null;
    lastArgs = null;
  };
  throttled.flush = () => (timeout ? invoke(Date.now()) : lastResult);

  return throttled;
}

export function last<T>(
  collection: ArrayLike<T> | null | undefined,
): T | undefined {
  if (!collection?.length) return undefined;
  return collection[collection.length - 1];
}

export function maxBy<T>(
  collection: ArrayLike<T> | Iterable<T>,
  iteratee?: Iteratee<T>,
): T | undefined {
  return extremumBy(collection, iteratee, (a, b) => a > b);
}

export function minBy<T>(
  collection: ArrayLike<T> | Iterable<T>,
  iteratee?: Iteratee<T>,
): T | undefined {
  return extremumBy(collection, iteratee, (a, b) => a < b);
}

function extremumBy<T>(
  collection: ArrayLike<T> | Iterable<T>,
  iteratee: Iteratee<T>,
  compare: (left: number, right: number) => boolean,
): T | undefined {
  const resolver = toIteratee(iteratee);
  let selected: T | undefined;
  let selectedValue: number | undefined;

  for (const item of toArray(collection)) {
    const value = Number(resolver(item));
    if (Number.isNaN(value)) continue;
    if (selectedValue === undefined || compare(value, selectedValue)) {
      selected = item;
      selectedValue = value;
    }
  }

  return selected;
}

export function range(start: number, end?: number, step?: number): number[] {
  let from = end === undefined ? 0 : start;
  const to = end === undefined ? start : end;
  const by = step ?? (from < to ? 1 : -1);
  if (by === 0) return [];

  const result: number[] = [];
  if (by > 0) {
    for (; from < to; from += by) result.push(from);
  } else {
    for (; from > to; from += by) result.push(from);
  }
  return result;
}

export function omit<T extends Record<string, unknown>>(
  object: T | null | undefined,
  paths: string | readonly string[],
): Partial<T> {
  if (!object) return {};
  const omitted = new Set(Array.isArray(paths) ? paths : [paths]);
  const result: Partial<T> = {};
  for (const key of Object.keys(object)) {
    if (!omitted.has(key)) {
      result[key as keyof T] = object[key] as T[keyof T];
    }
  }
  return result;
}

export function sumBy<T>(
  collection: ArrayLike<T> | Iterable<T>,
  iteratee?: Iteratee<T>,
): number {
  const resolver = toIteratee(iteratee);
  return toArray(collection).reduce((total, item) => {
    const value = Number(resolver(item));
    return total + (Number.isNaN(value) ? 0 : value);
  }, 0);
}
