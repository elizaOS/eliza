/**
 * Bounds the household audit walk that searches stored event `inputs` /
 * `decision` graphs for audience entity IDs. A hostile nest RangeError'd
 * recordContainsAnyEntity at 8k depth on Node 24.15.0. Depth, node, and
 * cycle limits are all load-bearing. Every reflective read is fail-closed
 * to the typed unbounded error; array length and indexes come from own
 * data descriptors so Proxy get/has traps cannot hang the export path.
 */

import { ElizaError } from "@elizaos/core";

export const MAX_HOUSEHOLD_ENTITY_SCAN_DEPTH = 32;
export const MAX_HOUSEHOLD_ENTITY_SCAN_NODES = 2_048;
export const HOUSEHOLD_ENTITY_SCAN_UNBOUNDED =
  "HOUSEHOLD_ENTITY_SCAN_UNBOUNDED";

type WalkContext = {
  visits: number;
  visiting: WeakSet<object>;
};

function failUnbounded(
  context: Record<string, unknown>,
  cause?: unknown,
): never {
  throw new ElizaError("Household entity scan exceeds the record-walk budget", {
    code: HOUSEHOLD_ENTITY_SCAN_UNBOUNDED,
    context,
    cause,
    severity: "fatal",
  });
}

function reserve(ctx: WalkContext, count: number): void {
  if (count > MAX_HOUSEHOLD_ENTITY_SCAN_NODES - ctx.visits) {
    failUnbounded({
      visits: ctx.visits + count,
      maxNodes: MAX_HOUSEHOLD_ENTITY_SCAN_NODES,
    });
  }
  ctx.visits += count;
}

function inspectRecord<T>(operation: string, inspect: () => T): T {
  try {
    return inspect();
  } catch (cause) {
    // error-policy:J3 Proxy inspection failures make an untrusted stored record invalid.
    failUnbounded({ inspection: operation }, cause);
  }
}

function ownDescriptor(
  value: object,
  key: PropertyKey,
): PropertyDescriptor | undefined {
  return inspectRecord("getOwnPropertyDescriptor", () =>
    Object.getOwnPropertyDescriptor(value, key),
  );
}

function isArrayRecord(value: object): value is unknown[] {
  return inspectRecord("isArray", () => Array.isArray(value));
}

export function recordContainsAnyEntity(
  value: unknown,
  entityIds: ReadonlySet<string>,
): boolean {
  return recordContainsAnyEntityInner(value, entityIds, 0, {
    visits: 0,
    visiting: new WeakSet<object>(),
  });
}

/**
 * Visibility predicate used by `HouseholdCoordinationService.exportFor`
 * when filtering audit rows for a non-owner principal.
 */
export function householdExportAuditVisibleToAudience(
  event: { inputs: unknown; decision: unknown; ownerId: string },
  audience: ReadonlySet<string>,
  options: { isOwner: boolean; principalEntityId: string },
): boolean {
  return (
    options.isOwner ||
    recordContainsAnyEntity(event.inputs, audience) ||
    recordContainsAnyEntity(event.decision, audience) ||
    event.ownerId === options.principalEntityId
  );
}

function recordContainsAnyEntityInner(
  value: unknown,
  entityIds: ReadonlySet<string>,
  depth: number,
  ctx: WalkContext,
  visitAlreadyReserved = false,
): boolean {
  if (depth > MAX_HOUSEHOLD_ENTITY_SCAN_DEPTH) {
    failUnbounded({ depth, max: MAX_HOUSEHOLD_ENTITY_SCAN_DEPTH });
  }
  if (typeof value === "string") {
    if (!visitAlreadyReserved) reserve(ctx, 1);
    return entityIds.has(value);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (!visitAlreadyReserved) reserve(ctx, 1);
  if (ctx.visiting.has(value)) {
    failUnbounded({ cycle: true });
  }
  ctx.visiting.add(value);
  try {
    if (isArrayRecord(value)) {
      const lengthDescriptor = ownDescriptor(value, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor)) {
        failUnbounded({ invalidArrayLength: true });
      }
      const length = lengthDescriptor.value;
      if (!Number.isSafeInteger(length) || length < 0) {
        failUnbounded({ invalidArrayLength: true });
      }
      reserve(ctx, length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = ownDescriptor(value, String(index));
        if (!descriptor) continue;
        if (!("value" in descriptor)) {
          failUnbounded({ accessor: true, side: "array" });
        }
        if (
          recordContainsAnyEntityInner(
            descriptor.value,
            entityIds,
            depth + 1,
            ctx,
            true,
          )
        ) {
          return true;
        }
      }
      return false;
    }

    const entries: unknown[] = [];
    for (const key of inspectRecord("ownKeys", () => Reflect.ownKeys(value))) {
      if (typeof key !== "string") continue;
      const descriptor = ownDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (!("value" in descriptor)) {
        failUnbounded({ accessor: true, side: "object" });
      }
      entries.push(descriptor.value);
    }
    reserve(ctx, entries.length);
    for (const entry of entries) {
      if (
        recordContainsAnyEntityInner(entry, entityIds, depth + 1, ctx, true)
      ) {
        return true;
      }
    }
    return false;
  } finally {
    ctx.visiting.delete(value);
  }
}
