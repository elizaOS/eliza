/**
 * Bounded JSON clone for workflow persist/execute paths. Create/update and
 * run input clone untrusted graphs (`inputSchema`, trigger payload) with
 * `JSON.stringify`; a hostile nest RangeErrors Node before the route can
 * translate the failure. Walk first, then stringify.
 */
import { WorkflowApiError } from '../types/index';

/** Nesting ceiling. Honest workflow records are a handful of objects deep. */
export const MAX_WORKFLOW_JSON_DEPTH = 64;
export const WORKFLOW_JSON_UNBOUNDED = 'WORKFLOW_JSON_UNBOUNDED';

function failUnbounded(message: string): never {
  throw new WorkflowApiError(message, 400, { code: WORKFLOW_JSON_UNBOUNDED });
}

function assertBoundedJson(value: unknown, depth: number, seen: WeakSet<object>): void {
  if (depth > MAX_WORKFLOW_JSON_DEPTH) {
    failUnbounded(`Workflow JSON exceeds ${MAX_WORKFLOW_JSON_DEPTH} nesting depth`);
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (seen.has(value)) {
    failUnbounded('Workflow JSON contains a cyclic object');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertBoundedJson(entry, depth + 1, seen);
    }
    return;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    assertBoundedJson(entry, depth + 1, seen);
  }
}

/**
 * Structured clone used by persist/execute. Fails closed on hostile depth or
 * cycles instead of letting `JSON.stringify` RangeError the request.
 */
export function cloneJson<T>(value: T): T {
  assertBoundedJson(value, 0, new WeakSet<object>());
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (error) {
    // error-policy:J3 stringify still rejects BigInt/undefined-only graphs
    failUnbounded(error instanceof Error ? error.message : 'Workflow JSON is not serializable');
  }
}
