/**
 * Deterministic tests for the household audit entity-ID scan. No live
 * runtime: the walker is the production recordContainsAnyEntity used on
 * stored event inputs/decisions.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  HOUSEHOLD_ENTITY_SCAN_UNBOUNDED,
  householdExportAuditVisibleToAudience,
  MAX_HOUSEHOLD_ENTITY_SCAN_DEPTH,
  MAX_HOUSEHOLD_ENTITY_SCAN_NODES,
  recordContainsAnyEntity,
} from "./household-entity-scan";
import type { HouseholdAuditRecord } from "./types";

function nestArray(depth: number): unknown {
  let value: unknown = "target";
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}

function nestObj(depth: number): unknown {
  let value: unknown = { id: "target" };
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return value;
}

const audience = new Set(["target"]);

describe("recordContainsAnyEntity", () => {
  it("finds honest nested entity ids and misses others", () => {
    expect(recordContainsAnyEntity("target", audience)).toBe(true);
    expect(recordContainsAnyEntity("other", audience)).toBe(false);
    expect(recordContainsAnyEntity({ id: "target" }, audience)).toBe(true);
    expect(recordContainsAnyEntity(["x", { id: "target" }], audience)).toBe(
      true,
    );
    expect(recordContainsAnyEntity({ nested: { id: "nope" } }, audience)).toBe(
      false,
    );
  });

  it(`accepts a ${MAX_HOUSEHOLD_ENTITY_SCAN_DEPTH}-deep array nest`, () => {
    expect(
      recordContainsAnyEntity(
        nestArray(MAX_HOUSEHOLD_ENTITY_SCAN_DEPTH),
        audience,
      ),
    ).toBe(true);
    expect(
      recordContainsAnyEntity(
        nestObj(MAX_HOUSEHOLD_ENTITY_SCAN_DEPTH - 1),
        audience,
      ),
    ).toBe(true);
  });

  it(`throws ${HOUSEHOLD_ENTITY_SCAN_UNBOUNDED} one past depth ${MAX_HOUSEHOLD_ENTITY_SCAN_DEPTH}`, () => {
    try {
      recordContainsAnyEntity(
        nestArray(MAX_HOUSEHOLD_ENTITY_SCAN_DEPTH + 1),
        audience,
      );
      expect.unreachable("scan should fail closed on over-budget depth");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(HOUSEHOLD_ENTITY_SCAN_UNBOUNDED);
    }
  });

  it(`throws ${HOUSEHOLD_ENTITY_SCAN_UNBOUNDED} past ${MAX_HOUSEHOLD_ENTITY_SCAN_NODES} sparse holes`, () => {
    const sparse: unknown[] = [];
    sparse[MAX_HOUSEHOLD_ENTITY_SCAN_NODES] = "target";
    try {
      recordContainsAnyEntity(sparse, audience);
      expect.unreachable(
        "scan should fail closed on over-budget sparse length",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(HOUSEHOLD_ENTITY_SCAN_UNBOUNDED);
    }
  });

  it("throws on a cyclic record without hanging", () => {
    const cyclic: { nested?: unknown } = {};
    cyclic.nested = cyclic;
    const started = performance.now();
    try {
      recordContainsAnyEntity(cyclic, audience);
      expect.unreachable("scan should fail closed on a cycle");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(HOUSEHOLD_ENTITY_SCAN_UNBOUNDED);
    }
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("does not invoke accessors while scanning", () => {
    let invoked = 0;
    const hostile = {
      id: "other",
      get trap() {
        invoked += 1;
        return "target";
      },
    };
    try {
      recordContainsAnyEntity(hostile, audience);
      expect.unreachable("scan should fail closed on enumerable accessors");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(HOUSEHOLD_ENTITY_SCAN_UNBOUNDED);
    }
    expect(invoked).toBe(0);
  });

  it("does not invoke array get or has traps", () => {
    let directReads = 0;
    let membershipChecks = 0;
    const hostile = new Proxy(["target"], {
      get() {
        directReads += 1;
        throw new Error("array values must be inspected through descriptors");
      },
      has() {
        membershipChecks += 1;
        throw new Error(
          "array membership must be inspected through descriptors",
        );
      },
    });

    expect(recordContainsAnyEntity(hostile, audience)).toBe(true);
    expect(directReads).toBe(0);
    expect(membershipChecks).toBe(0);
  });

  it(`throws ${HOUSEHOLD_ENTITY_SCAN_UNBOUNDED} on a revoked Proxy instead of TypeError`, () => {
    const { proxy, revoke } = Proxy.revocable(["target"], {});
    revoke();
    try {
      recordContainsAnyEntity(proxy, audience);
      expect.unreachable("scan should fail closed on a revoked Proxy");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(HOUSEHOLD_ENTITY_SCAN_UNBOUNDED);
      expect((error as Error).name).not.toBe("TypeError");
      expect((error as Error).cause).toBeInstanceOf(TypeError);
      expect(String((error as Error).cause)).toMatch(/IsArray/);
    }
  });

  it("translates hostile Proxy inspection failures", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile ownKeys trap");
        },
      },
    );

    try {
      recordContainsAnyEntity(hostile, audience);
      expect.unreachable("scan should translate Proxy inspection failures");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(HOUSEHOLD_ENTITY_SCAN_UNBOUNDED);
      expect((error as Error).cause).toBeInstanceOf(Error);
    }
  });

  it("allows repeated references that are not cycles", () => {
    const shared = { id: "other" };
    expect(
      recordContainsAnyEntity({ left: shared, right: shared }, audience),
    ).toBe(false);
  });

  it("fails closed on an 8k nest in under 50ms instead of RangeError", () => {
    const started = performance.now();
    try {
      recordContainsAnyEntity(nestArray(8_000), audience);
      expect.unreachable("scan should fail closed on an 8k nest");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(HOUSEHOLD_ENTITY_SCAN_UNBOUNDED);
      expect((error as Error).name).not.toBe("RangeError");
    }
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("scans nested entity ids on the household exportFor audit payload", () => {
    const event: Pick<HouseholdAuditRecord, "inputs" | "decision" | "ownerId"> =
      {
        ownerId: "owner-other",
        inputs: {
          householdId: "household:default",
          affectedPartyEntityIds: ["partner"],
          nested: { audience: ["x", { entityId: "target" }] },
        },
        decision: { activatedAgreementId: "agr-1" },
      };
    expect(
      householdExportAuditVisibleToAudience(event, audience, {
        isOwner: false,
        principalEntityId: "principal",
      }),
    ).toBe(true);
    expect(
      householdExportAuditVisibleToAudience(
        { ...event, inputs: { householdId: "household:default" } },
        audience,
        { isOwner: false, principalEntityId: "principal" },
      ),
    ).toBe(false);
    expect(
      householdExportAuditVisibleToAudience(
        { ...event, inputs: { householdId: "household:default" } },
        audience,
        { isOwner: true, principalEntityId: "principal" },
      ),
    ).toBe(true);

    try {
      householdExportAuditVisibleToAudience(
        { ...event, inputs: nestArray(8_000) as Record<string, unknown> },
        audience,
        { isOwner: false, principalEntityId: "principal" },
      );
      expect.unreachable(
        "exportFor audit scan should fail closed on 8k inputs",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(HOUSEHOLD_ENTITY_SCAN_UNBOUNDED);
    }
  });
});
