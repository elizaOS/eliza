/**
 * Deterministic tests for the inbox priority-scoring flags walk. No live
 * model: the parser is the production walk used on LLM score records.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import {
  INBOX_PRIORITY_FLAGS_UNBOUNDED,
  MAX_INBOX_PRIORITY_FLAGS_DEPTH,
  MAX_INBOX_PRIORITY_FLAGS_NODES,
  MAX_INBOX_PRIORITY_FLAGS_OUTPUT,
  parseFlags,
} from "./priority-flags";

function nestArray(depth: number): unknown {
  let value: unknown = "urgent";
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}

describe("parseFlags", () => {
  it("parses honest strings, lists, and delimited flags", () => {
    expect(parseFlags("urgent")).toEqual(["urgent"]);
    expect(parseFlags("urgent|vip")).toEqual(["urgent", "vip"]);
    expect(parseFlags(["urgent", "vip"])).toEqual(["urgent", "vip"]);
    expect(parseFlags([["urgent"]])).toEqual(["urgent"]);
    expect(parseFlags("none")).toEqual([]);
    expect(parseFlags(null)).toEqual([]);
  });

  it(`accepts a ${MAX_INBOX_PRIORITY_FLAGS_DEPTH}-deep array nest`, () => {
    expect(parseFlags(nestArray(MAX_INBOX_PRIORITY_FLAGS_DEPTH))).toEqual([
      "urgent",
    ]);
  });

  it(`throws ${INBOX_PRIORITY_FLAGS_UNBOUNDED} one past depth ${MAX_INBOX_PRIORITY_FLAGS_DEPTH}`, () => {
    try {
      parseFlags(nestArray(MAX_INBOX_PRIORITY_FLAGS_DEPTH + 1));
      expect.unreachable("parse should fail closed on over-budget depth");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(INBOX_PRIORITY_FLAGS_UNBOUNDED);
    }
  });

  it(`throws ${INBOX_PRIORITY_FLAGS_UNBOUNDED} past ${MAX_INBOX_PRIORITY_FLAGS_NODES} sparse holes`, () => {
    const sparse: unknown[] = [];
    sparse[MAX_INBOX_PRIORITY_FLAGS_NODES] = "urgent";
    try {
      parseFlags(sparse);
      expect.unreachable(
        "parse should fail closed on over-budget sparse length",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(INBOX_PRIORITY_FLAGS_UNBOUNDED);
    }
  });

  it(`accepts ${MAX_INBOX_PRIORITY_FLAGS_OUTPUT} outputs and throws before allocating one more`, () => {
    const allowedFlags = Array.from(
      { length: MAX_INBOX_PRIORITY_FLAGS_OUTPUT },
      () => "urgent",
    ).join("|");
    expect(parseFlags(allowedFlags)).toHaveLength(
      MAX_INBOX_PRIORITY_FLAGS_OUTPUT,
    );
    const excessiveFlags = Array.from(
      { length: MAX_INBOX_PRIORITY_FLAGS_OUTPUT + 1 },
      () => "urgent",
    ).join("|");
    try {
      parseFlags(excessiveFlags);
      expect.unreachable("parse should fail closed on over-budget output");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(INBOX_PRIORITY_FLAGS_UNBOUNDED);
    }
  });

  it("throws on a cyclic flags array without hanging", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    const started = performance.now();
    try {
      parseFlags(cyclic);
      expect.unreachable("parse should fail closed on a cycle");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(INBOX_PRIORITY_FLAGS_UNBOUNDED);
    }
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("does not invoke accessors while parsing", () => {
    let invoked = 0;
    const hostile: unknown[] = [];
    Object.defineProperty(hostile, "0", {
      enumerable: true,
      get() {
        invoked += 1;
        return "urgent";
      },
    });
    try {
      parseFlags(hostile);
      expect.unreachable("parse should fail closed on enumerable accessors");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(INBOX_PRIORITY_FLAGS_UNBOUNDED);
    }
    expect(invoked).toBe(0);
  });

  it("fails closed on an 8k nest in under 50ms instead of RangeError", () => {
    const started = performance.now();
    try {
      parseFlags(nestArray(8_000));
      expect.unreachable("parse should fail closed on an 8k nest");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(INBOX_PRIORITY_FLAGS_UNBOUNDED);
      expect((error as Error).name).not.toBe("RangeError");
    }
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("does not invoke array get or has traps", () => {
    let directReads = 0;
    let membershipChecks = 0;
    const hostile = new Proxy(["urgent"], {
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
    expect(parseFlags(hostile)).toEqual(["urgent"]);
    expect(directReads).toBe(0);
    expect(membershipChecks).toBe(0);
  });

  it(`throws ${INBOX_PRIORITY_FLAGS_UNBOUNDED} on a revoked Proxy instead of TypeError`, () => {
    const { proxy, revoke } = Proxy.revocable(["urgent"], {});
    revoke();
    try {
      parseFlags(proxy);
      expect.unreachable("parse should fail closed on a revoked Proxy");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(INBOX_PRIORITY_FLAGS_UNBOUNDED);
      expect((error as Error).name).not.toBe("TypeError");
      expect((error as Error).cause).toBeInstanceOf(TypeError);
      expect(String((error as Error).cause)).toMatch(/IsArray|Array\.isArray/);
    }
  });

  it("rescans honest shared child arrays after the parent frame returns", () => {
    const shared = ["urgent"];
    expect(parseFlags([shared, shared])).toEqual(["urgent", "urgent"]);
  });
});
