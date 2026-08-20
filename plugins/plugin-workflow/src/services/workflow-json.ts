/**
 * Bounded JSON snapshot for workflow persistence and execution. It inspects
 * untrusted graphs without invoking accessors or prototypes and accounts for
 * their exact serialized UTF-8 size before Drizzle or worker serialization.
 */
import { types as utilTypes } from 'node:util';
import { WorkflowApiError } from '../types/index';

/** Nesting ceiling. Honest workflow records are a handful of objects deep. */
export const MAX_WORKFLOW_JSON_DEPTH = 64;
/** Logical values copied by one workflow clone. */
export const MAX_WORKFLOW_JSON_NODES = 10_000;
/** Serialized UTF-8 ceiling, aligned with the authenticated workflow route. */
export const MAX_WORKFLOW_JSON_BYTES = 2_000_000;
export const WORKFLOW_JSON_UNBOUNDED = 'WORKFLOW_JSON_UNBOUNDED';
const OMIT = Symbol('workflow-json-omit');

function failUnbounded(message: string): never {
  throw new WorkflowApiError(message, 400, { code: WORKFLOW_JSON_UNBOUNDED });
}

interface CloneContext {
  ancestors: WeakSet<object>;
  bytes: number;
  visits: number;
}

type CloneLocation = 'root' | 'array' | 'object';

function reflectOrFail<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    // error-policy:J3 reflection failures are invalid workflow JSON; do not
    // inspect an attacker-thrown value while translating the boundary error.
    failUnbounded('Workflow JSON could not be inspected safely');
  }
}

function unsupportedValue(location: CloneLocation): null | typeof OMIT {
  if (location === 'array') return null;
  if (location === 'object') return OMIT;
  failUnbounded('Workflow JSON root is not serializable');
}

function chargeBytes(context: CloneContext, bytes: number): void {
  if (bytes > MAX_WORKFLOW_JSON_BYTES - context.bytes) {
    failUnbounded(`Workflow JSON exceeds ${MAX_WORKFLOW_JSON_BYTES} serialized bytes`);
  }
  context.bytes += bytes;
}

/** Returns the exact UTF-8 byte length emitted by JSON.stringify for a string. */
function jsonStringBytes(value: string): number {
  if (value.length > MAX_WORKFLOW_JSON_BYTES) {
    failUnbounded(`Workflow JSON exceeds ${MAX_WORKFLOW_JSON_BYTES} serialized bytes`);
  }
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes +=
        code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
    if (bytes > MAX_WORKFLOW_JSON_BYTES) {
      failUnbounded(`Workflow JSON exceeds ${MAX_WORKFLOW_JSON_BYTES} serialized bytes`);
    }
  }
  return bytes;
}

function chargeJsonString(context: CloneContext, value: string, extraBytes = 0): void {
  const remaining = MAX_WORKFLOW_JSON_BYTES - context.bytes;
  if (extraBytes > remaining || value.length > remaining - extraBytes - 2) {
    failUnbounded(`Workflow JSON exceeds ${MAX_WORKFLOW_JSON_BYTES} serialized bytes`);
  }
  chargeBytes(context, extraBytes + jsonStringBytes(value));
}

function cloneJsonValue(
  value: unknown,
  depth: number,
  location: CloneLocation,
  context: CloneContext
): unknown | typeof OMIT {
  if (depth > MAX_WORKFLOW_JSON_DEPTH) {
    failUnbounded(`Workflow JSON exceeds ${MAX_WORKFLOW_JSON_DEPTH} nesting depth`);
  }
  context.visits += 1;
  if (context.visits > MAX_WORKFLOW_JSON_NODES) {
    failUnbounded(`Workflow JSON exceeds ${MAX_WORKFLOW_JSON_NODES} logical values`);
  }

  if (value === null) {
    chargeBytes(context, 4);
    return value;
  }
  if (typeof value === 'string') {
    chargeJsonString(context, value);
    return value;
  }
  if (typeof value === 'boolean') {
    chargeBytes(context, value ? 4 : 5);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      chargeBytes(context, 4);
      return null;
    }
    const normalized = value === 0 ? 0 : value;
    chargeBytes(context, String(normalized).length);
    return normalized;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    const unsupported = unsupportedValue(location);
    if (unsupported === null) chargeBytes(context, 4);
    return unsupported;
  }
  if (typeof value === 'bigint') {
    failUnbounded('Workflow JSON may not contain bigint values');
  }

  // Proxy reflection can execute caller-controlled traps even when no property
  // value is read. Reject before the first reflective operation.
  if (utilTypes.isProxy(value)) {
    failUnbounded('Workflow JSON may not contain proxies');
  }

  if (context.ancestors.has(value)) {
    failUnbounded('Workflow JSON contains a cyclic object');
  }
  context.ancestors.add(value);
  try {
    const toJsonDescriptor = reflectOrFail(() => Object.getOwnPropertyDescriptor(value, 'toJSON'));
    if (
      toJsonDescriptor &&
      ('get' in toJsonDescriptor ||
        'set' in toJsonDescriptor ||
        typeof toJsonDescriptor.value === 'function')
    ) {
      failUnbounded('Workflow JSON may not define custom serialization');
    }

    let dateTime: number | undefined;
    try {
      // The native brand check is constant-work and does not traverse a
      // caller-controlled prototype chain as `instanceof Date` would.
      dateTime = Date.prototype.getTime.call(value);
    } catch {
      dateTime = undefined;
    }
    if (dateTime !== undefined) {
      if (!Number.isFinite(dateTime)) {
        chargeBytes(context, 4);
        return null;
      }
      const timestamp = Date.prototype.toISOString.call(value);
      chargeJsonString(context, timestamp);
      return timestamp;
    }

    if (reflectOrFail(() => Array.isArray(value))) {
      const lengthDescriptor = reflectOrFail(() =>
        Object.getOwnPropertyDescriptor(value, 'length')
      );
      const length = lengthDescriptor?.value;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_WORKFLOW_JSON_NODES - context.visits
      ) {
        failUnbounded(`Workflow JSON exceeds ${MAX_WORKFLOW_JSON_NODES} logical values`);
      }
      chargeBytes(context, 2 + Math.max(0, length - 1));
      const snapshot = new Array<unknown>(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = reflectOrFail(() =>
          Object.getOwnPropertyDescriptor(value, String(index))
        );
        if (descriptor && ('get' in descriptor || 'set' in descriptor)) {
          failUnbounded('Workflow JSON may not contain accessors');
        }
        if (descriptor) {
          snapshot[index] = cloneJsonValue(descriptor.value, depth + 1, 'array', context);
        } else {
          context.visits += 1;
          if (context.visits > MAX_WORKFLOW_JSON_NODES) {
            failUnbounded(`Workflow JSON exceeds ${MAX_WORKFLOW_JSON_NODES} logical values`);
          }
          chargeBytes(context, 4);
          snapshot[index] = null;
        }
      }
      return snapshot;
    }

    const keys = reflectOrFail(() => Reflect.ownKeys(value));
    if (keys.length > MAX_WORKFLOW_JSON_NODES - context.visits) {
      failUnbounded(`Workflow JSON exceeds ${MAX_WORKFLOW_JSON_NODES} logical values`);
    }
    // Drizzle inspects ordinary object prototypes when binding jsonb values, so
    // retain Object.prototype while defining every key as an own data property
    // (`__proto__` included) instead of using assignment setters.
    const snapshot: Record<string, unknown> = {};
    chargeBytes(context, 2);
    let retainedEntries = 0;
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      const descriptor = reflectOrFail(() => Object.getOwnPropertyDescriptor(value, key));
      if (!descriptor?.enumerable) continue;
      if ('get' in descriptor || 'set' in descriptor) {
        failUnbounded('Workflow JSON may not contain accessors');
      }
      const entry = cloneJsonValue(descriptor.value, depth + 1, 'object', context);
      if (entry === OMIT) continue;
      chargeJsonString(context, key, (retainedEntries > 0 ? 1 : 0) + 1);
      retainedEntries += 1;
      Object.defineProperty(snapshot, key, {
        value: entry,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return snapshot;
  } finally {
    context.ancestors.delete(value);
  }
}

/**
 * JSON clone used by persist/execute. It preserves ordinary JSON semantics but
 * never invokes input getters, prototypes, or custom serializers.
 */
export function cloneJson<T>(value: T): T {
  const snapshot = cloneJsonValue(value, 0, 'root', {
    ancestors: new WeakSet<object>(),
    bytes: 0,
    visits: 0,
  });
  if (snapshot === OMIT) failUnbounded('Workflow JSON root is not serializable');
  return snapshot as T;
}
