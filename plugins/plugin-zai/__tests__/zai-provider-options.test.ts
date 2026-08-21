/**
 * Deterministic tests for the z.ai providerOptions walk. No live model:
 * the walker is the production readProviderOptions used on generate-text
 * params.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  MAX_ZAI_PROVIDER_OPTIONS_DEPTH,
  MAX_ZAI_PROVIDER_OPTIONS_NODES,
  readProviderOptions,
  ZAI_PROVIDER_OPTIONS_UNBOUNDED,
} from "../models/zai-provider-options";

function nestArray(depth: number): unknown {
  let value: unknown = "x";
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}

describe("readProviderOptions", () => {
  class CustomOptions {
    enabled = true;
  }

  it("preserves root and nested __proto__ keys as inert own data", () => {
    const nested = Object.fromEntries([["__proto__", { nested: true }]]);
    const input = Object.fromEntries([
      ["__proto__", { root: true }],
      ["zai", nested],
    ]);

    const copied = readProviderOptions(input);

    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.hasOwn(copied ?? {}, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(copied, "__proto__")?.value).toEqual({ root: true });
    const copiedNested = copied?.zai as Record<string, unknown>;
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
        zai: { effort: "high", tags: ["a", { b: true }] },
      })
    ).toEqual({
      agentName: "eliza",
      zai: { effort: "high", tags: ["a", { b: true }] },
    });
    for (const invalid of [null, ["not", "a", "record"], "scalar"]) {
      expect(() => readProviderOptions(invalid)).toThrow(
        expect.objectContaining({ code: ZAI_PROVIDER_OPTIONS_UNBOUNDED })
      );
    }
  });

  it("accepts root and nested null-prototype records and copies them to inert records", () => {
    const nested = Object.assign(Object.create(null) as Record<string, unknown>, {
      effort: "high",
    });
    const root = Object.assign(Object.create(null) as Record<string, unknown>, {
      agentName: "eliza",
      zai: nested,
    });

    const copied = readProviderOptions(root);

    expect(copied).toEqual({ agentName: "eliza", zai: { effort: "high" } });
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(copied.zai as object)).toBe(Object.prototype);
  });

  it.each([
    ["Date", () => new Date(0)],
    ["Map", () => new Map([["enabled", true]])],
    ["Set", () => new Set(["enabled"])],
    ["class instance", () => new CustomOptions()],
    ["custom prototype", () => Object.create({ inherited: true })],
  ])("rejects %s values at root and nested record boundaries", (_name, makeValue) => {
    for (const candidate of [makeValue(), { nested: makeValue() }]) {
      expect(() => readProviderOptions(candidate)).toThrow(
        expect.objectContaining({ code: ZAI_PROVIDER_OPTIONS_UNBOUNDED })
      );
    }
  });

  it("rejects invalid present leaves instead of fabricating empty options", () => {
    for (const invalid of [() => "fn", Symbol("bad"), 1n]) {
      expect(() => readProviderOptions({ agentName: "keep", bad: invalid })).toThrow(
        expect.objectContaining({ code: ZAI_PROVIDER_OPTIONS_UNBOUNDED })
      );
    }
  });

  it("preserves allowed undefined fields and the JSON numeric normalization", () => {
    expect(
      readProviderOptions({ missing: undefined, nan: Number.NaN, infinite: Infinity })
    ).toEqual({ missing: undefined, nan: null, infinite: null });
  });

  it(`accepts a ${MAX_ZAI_PROVIDER_OPTIONS_DEPTH}-deep nest under payload`, () => {
    // Root options object is depth 0, so payload may nest MAX-1 arrays.
    const accepted = nestArray(MAX_ZAI_PROVIDER_OPTIONS_DEPTH - 1);
    expect(readProviderOptions({ payload: accepted })).toEqual({ payload: accepted });
  });

  it(`throws ${ZAI_PROVIDER_OPTIONS_UNBOUNDED} one past depth ${MAX_ZAI_PROVIDER_OPTIONS_DEPTH}`, () => {
    try {
      readProviderOptions({
        payload: nestArray(MAX_ZAI_PROVIDER_OPTIONS_DEPTH),
      });
      expect.unreachable("parse should fail closed on over-budget depth");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(ZAI_PROVIDER_OPTIONS_UNBOUNDED);
    }
  });

  it(`throws ${ZAI_PROVIDER_OPTIONS_UNBOUNDED} past ${MAX_ZAI_PROVIDER_OPTIONS_NODES} sparse holes`, () => {
    const sparse: unknown[] = [];
    sparse[MAX_ZAI_PROVIDER_OPTIONS_NODES] = "x";
    try {
      readProviderOptions({ payload: sparse });
      expect.unreachable("parse should fail closed on over-budget sparse length");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(ZAI_PROVIDER_OPTIONS_UNBOUNDED);
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

    try {
      readProviderOptions(cyclic);
      expect.unreachable("parse should fail closed on cyclic input");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(ZAI_PROVIDER_OPTIONS_UNBOUNDED);
    }
  });

  it("copies a shared acyclic subgraph without treating it as a cycle", () => {
    const shared = { enabled: true };
    expect(readProviderOptions({ first: shared, second: shared })).toEqual({
      first: { enabled: true },
      second: { enabled: true },
    });
  });

  it("fails closed on accessor properties", () => {
    const hostile = {};
    Object.defineProperty(hostile, "trap", {
      get() {
        throw new Error("getter side effect");
      },
      enumerable: true,
    });

    try {
      readProviderOptions(hostile);
      expect.unreachable("parse should fail closed on accessor descriptor");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(ZAI_PROVIDER_OPTIONS_UNBOUNDED);
    }
  });

  it("translates proxy reflection failures to the typed boundary error", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("reflection trap");
        },
      }
    );

    expect(() => readProviderOptions(hostile)).toThrow(
      expect.objectContaining({ code: ZAI_PROVIDER_OPTIONS_UNBOUNDED })
    );
  });

  it("translates hostile and revoked prototype reflection at root and nested boundaries", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype reflection trap");
        },
      }
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    for (const candidate of [
      hostile,
      { nested: hostile },
      revoked.proxy,
      { nested: revoked.proxy },
    ]) {
      expect(() => readProviderOptions(candidate)).toThrow(
        expect.objectContaining({ code: ZAI_PROVIDER_OPTIONS_UNBOUNDED })
      );
    }
  });
});
