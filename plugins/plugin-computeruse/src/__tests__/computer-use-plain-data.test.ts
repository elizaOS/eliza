/**
 * Deterministic tests for the computer-use snapshot pretty-print walk. No
 * live browser: the walker is the production stringifyData used on action
 * `content`.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  COMPUTER_USE_PLAIN_DATA_UNBOUNDED,
  MAX_COMPUTER_USE_PLAIN_DATA_DEPTH,
  MAX_COMPUTER_USE_PLAIN_DATA_NODES,
  renderPlainData,
  stringifyData,
} from "../services/computer-use-plain-data";

function nestArray(depth: number): unknown {
  let value: unknown = "x";
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}

describe("stringifyData / renderPlainData", () => {
  it("pretty-prints honest scalars, lists, and records", () => {
    expect(stringifyData("plain")).toBe("plain");
    expect(renderPlainData(null)).toBe("none");
    expect(renderPlainData({ a: ["b", { c: 1 }] })).toContain("items[2]:");
    expect(renderPlainData({ a: ["b", { c: 1 }] })).toContain("c: 1");
  });

  it(`accepts a ${MAX_COMPUTER_USE_PLAIN_DATA_DEPTH}-deep array nest`, () => {
    expect(
      renderPlainData(nestArray(MAX_COMPUTER_USE_PLAIN_DATA_DEPTH)),
    ).toContain("x");
  });

  it(`throws ${COMPUTER_USE_PLAIN_DATA_UNBOUNDED} one past depth ${MAX_COMPUTER_USE_PLAIN_DATA_DEPTH}`, () => {
    try {
      renderPlainData(nestArray(MAX_COMPUTER_USE_PLAIN_DATA_DEPTH + 1));
      expect.unreachable("print should fail closed on over-budget depth");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(
        COMPUTER_USE_PLAIN_DATA_UNBOUNDED,
      );
    }
  });

  it(`throws ${COMPUTER_USE_PLAIN_DATA_UNBOUNDED} past ${MAX_COMPUTER_USE_PLAIN_DATA_NODES} sparse holes`, () => {
    const sparse: unknown[] = [];
    sparse[MAX_COMPUTER_USE_PLAIN_DATA_NODES] = "x";
    try {
      renderPlainData(sparse);
      expect.unreachable(
        "print should fail closed on over-budget sparse length",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(
        COMPUTER_USE_PLAIN_DATA_UNBOUNDED,
      );
    }
  });

  it("throws on a cyclic snapshot without hanging", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const started = performance.now();
    try {
      renderPlainData(cyclic);
      expect.unreachable("print should fail closed on a cycle");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(
        COMPUTER_USE_PLAIN_DATA_UNBOUNDED,
      );
    }
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("does not invoke accessors while printing", () => {
    let invoked = 0;
    const hostile = {
      get trap() {
        invoked += 1;
        return "x";
      },
    };
    try {
      renderPlainData(hostile);
      expect.unreachable("print should fail closed on enumerable accessors");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(
        COMPUTER_USE_PLAIN_DATA_UNBOUNDED,
      );
    }
    expect(invoked).toBe(0);
  });

  it("does not invoke array Proxy get/has traps", () => {
    let gets = 0;
    let hasCalls = 0;
    const proxy = new Proxy(["x"], {
      get() {
        gets += 1;
        throw new Error("get trap escaped");
      },
      has() {
        hasCalls += 1;
        throw new Error("has trap escaped");
      },
    });
    expect(renderPlainData(proxy)).toContain("x");
    expect(gets).toBe(0);
    expect(hasCalls).toBe(0);
  });

  it(`throws ${COMPUTER_USE_PLAIN_DATA_UNBOUNDED} on a revoked Proxy instead of TypeError`, () => {
    const { proxy, revoke } = Proxy.revocable(["x"], {});
    revoke();
    try {
      renderPlainData(proxy);
      expect.unreachable("print should fail closed on a revoked Proxy");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(
        COMPUTER_USE_PLAIN_DATA_UNBOUNDED,
      );
      expect((error as Error).name).not.toBe("TypeError");
    }
  });

  it("fails closed on an 8k nest in under 50ms instead of RangeError", () => {
    const started = performance.now();
    try {
      renderPlainData(nestArray(8_000));
      expect.unreachable("print should fail closed on an 8k nest");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(
        COMPUTER_USE_PLAIN_DATA_UNBOUNDED,
      );
      expect((error as Error).name).not.toBe("RangeError");
    }
    expect(performance.now() - started).toBeLessThan(50);
  });
});
