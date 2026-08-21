/**
 * Deterministic tests for the Anthropic providerOptions walk. No live model:
 * the walker is the production readProviderOptions used on generate-text
 * params.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_PROVIDER_OPTIONS_UNBOUNDED,
  MAX_ANTHROPIC_PROVIDER_OPTIONS_DEPTH,
  MAX_ANTHROPIC_PROVIDER_OPTIONS_NODES,
  readProviderOptions,
} from "../models/anthropic-provider-options";

function nestArray(depth: number): unknown {
  let value: unknown = "x";
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}

describe("readProviderOptions", () => {
  it("preserves root and nested __proto__ keys as inert own data", () => {
    const nested = Object.fromEntries([["__proto__", { nested: true }]]);
    const input = Object.fromEntries([
      ["__proto__", { root: true }],
      ["anthropic", nested],
    ]);

    const copied = readProviderOptions(input);

    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.hasOwn(copied ?? {}, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(copied, "__proto__")?.value).toEqual({ root: true });
    const copiedNested = copied?.anthropic as Record<string, unknown>;
    expect(Object.getPrototypeOf(copiedNested)).toBe(Object.prototype);
    expect(Object.hasOwn(copiedNested, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(copiedNested, "__proto__")?.value).toEqual({
      nested: true,
    });
  });

  it("preserves honest scalars, lists, and nested records", () => {
    expect(
      readProviderOptions({
        agentName: "eliza",
        anthropic: { effort: "high", tags: ["a", { b: true }] },
      })
    ).toEqual({
      agentName: "eliza",
      anthropic: { effort: "high", tags: ["a", { b: true }] },
    });
    expect(readProviderOptions(null)).toBeUndefined();
    expect(readProviderOptions(["not", "a", "record"])).toBeUndefined();
    expect(readProviderOptions({ bad: () => "fn" })).toBeUndefined();
  });

  it(`accepts a ${MAX_ANTHROPIC_PROVIDER_OPTIONS_DEPTH}-deep nest under payload`, () => {
    // Root options object is depth 0, so payload may nest MAX-1 arrays.
    const accepted = nestArray(MAX_ANTHROPIC_PROVIDER_OPTIONS_DEPTH - 1);
    expect(readProviderOptions({ payload: accepted })).toEqual({ payload: accepted });
  });

  it(`throws ${ANTHROPIC_PROVIDER_OPTIONS_UNBOUNDED} one past depth ${MAX_ANTHROPIC_PROVIDER_OPTIONS_DEPTH}`, () => {
    try {
      readProviderOptions({
        payload: nestArray(MAX_ANTHROPIC_PROVIDER_OPTIONS_DEPTH),
      });
      expect.unreachable("parse should fail closed on over-budget depth");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(ANTHROPIC_PROVIDER_OPTIONS_UNBOUNDED);
    }
  });

  it(`throws ${ANTHROPIC_PROVIDER_OPTIONS_UNBOUNDED} past ${MAX_ANTHROPIC_PROVIDER_OPTIONS_NODES} sparse holes`, () => {
    const sparse: unknown[] = [];
    sparse[MAX_ANTHROPIC_PROVIDER_OPTIONS_NODES] = "x";
    try {
      readProviderOptions({ payload: sparse });
      expect.unreachable("parse should fail closed on over-budget sparse length");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(ANTHROPIC_PROVIDER_OPTIONS_UNBOUNDED);
    }
  });

  it("preserves within-budget sparse holes and length", () => {
    const payload: unknown[] = [];
    payload[2] = "x";
    const result = readProviderOptions({ payload })?.payload as unknown[];
    expect(result).toHaveLength(3);
    expect(0 in result).toBe(false);
    expect(1 in result).toBe(false);
    expect(result[2]).toBe("x");
  });

  it("throws on a cyclic record without hanging", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const started = performance.now();
    try {
      readProviderOptions(cyclic);
      expect.unreachable("parse should fail closed on a cycle");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(ANTHROPIC_PROVIDER_OPTIONS_UNBOUNDED);
    }
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("does not invoke accessors while parsing", () => {
    let invoked = 0;
    const hostile = {
      get trap() {
        invoked += 1;
        return "x";
      },
    };
    try {
      readProviderOptions(hostile);
      expect.unreachable("parse should fail closed on enumerable accessors");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(ANTHROPIC_PROVIDER_OPTIONS_UNBOUNDED);
    }
    expect(invoked).toBe(0);
  });

  it("does not invoke Proxy get/has traps while parsing", () => {
    let gets = 0;
    let hasCalls = 0;
    const proxy = new Proxy(
      { payload: "x" },
      {
        get() {
          gets += 1;
          throw new Error("get trap escaped");
        },
        has() {
          hasCalls += 1;
          throw new Error("has trap escaped");
        },
      }
    );
    expect(readProviderOptions(proxy)).toEqual({ payload: "x" });
    expect(gets).toBe(0);
    expect(hasCalls).toBe(0);
  });

  it(`throws ${ANTHROPIC_PROVIDER_OPTIONS_UNBOUNDED} on a revoked Proxy instead of TypeError`, () => {
    const { proxy, revoke } = Proxy.revocable({ payload: "x" }, {});
    revoke();
    try {
      readProviderOptions(proxy);
      expect.unreachable("parse should fail closed on a revoked Proxy");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(ANTHROPIC_PROVIDER_OPTIONS_UNBOUNDED);
      expect((error as Error).name).not.toBe("TypeError");
    }
  });

  it("fails closed on an 8k nest in under 50ms instead of RangeError", () => {
    const started = performance.now();
    try {
      readProviderOptions({ payload: nestArray(8_000) });
      expect.unreachable("parse should fail closed on an 8k nest");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(ANTHROPIC_PROVIDER_OPTIONS_UNBOUNDED);
      expect((error as Error).name).not.toBe("RangeError");
    }
    expect(performance.now() - started).toBeLessThan(50);
  });
});
