/**
 * Bounded JSON clone for workflow persist/execute paths. Create/update and
 * run input clone untrusted graphs (`inputSchema`, trigger payload) with
 * `JSON.stringify`; a hostile nest or reflective object can throw before the
 * route translates the failure. Build one trusted JSON snapshot instead.
 */
import { WorkflowApiError } from '../types/index';

/** Nesting ceiling. Honest workflow records are a handful of objects deep. */
export const MAX_WORKFLOW_JSON_DEPTH = 64;
/** Logical values copied by one workflow clone. */
export const MAX_WORKFLOW_JSON_NODES = 10_000;
export const WORKFLOW_JSON_UNBOUNDED = 'WORKFLOW_JSON_UNBOUNDED';
const OMIT = Symbol('workflow-json-omit');

function failUnbounded(message: string): never {
  throw new WorkflowApiError(message, 400, { code: WORKFLOW_JSON_UNBOUNDED });
}

interface CloneContext {
  ancestors: WeakSet<object>;
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

  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value === 0 ? 0 : value;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return unsupportedValue(location);
  }
  if (typeof value === 'bigint') {
    failUnbounded('Workflow JSON may not contain bigint values');
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
      return Number.isFinite(dateTime) ? Date.prototype.toISOString.call(value) : null;
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
      const snapshot = new Array<unknown>(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = reflectOrFail(() =>
          Object.getOwnPropertyDescriptor(value, String(index))
        );
        if (descriptor && ('get' in descriptor || 'set' in descriptor)) {
          failUnbounded('Workflow JSON may not contain accessors');
        }
        snapshot[index] = descriptor
          ? cloneJsonValue(descriptor.value, depth + 1, 'array', context)
          : null;
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
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      const descriptor = reflectOrFail(() => Object.getOwnPropertyDescriptor(value, key));
      if (!descriptor?.enumerable) continue;
      if ('get' in descriptor || 'set' in descriptor) {
        failUnbounded('Workflow JSON may not contain accessors');
      }
      const entry = cloneJsonValue(descriptor.value, depth + 1, 'object', context);
      if (entry === OMIT) continue;
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
    visits: 0,
  });
  if (snapshot === OMIT) failUnbounded('Workflow JSON root is not serializable');
  return snapshot as T;
}
