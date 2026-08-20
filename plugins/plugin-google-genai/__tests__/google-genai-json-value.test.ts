/**
 * Deterministic tests for the Google GenAI tool-call JSON walk. No live
 * model: the walker is the production toJsonValue / toToolArguments used
 * on untrusted `functionCall.args`.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  GOOGLE_GENAI_JSON_UNBOUNDED,
  MAX_GOOGLE_GENAI_JSON_DEPTH,
  MAX_GOOGLE_GENAI_JSON_NODES,
  toJsonValue,
  toToolArguments,
} from "../models/google-genai-json-value";

function nestArray(depth: number): unknown {
  let value: unknown = "x";
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}

describe("toJsonValue", () => {
  it("preserves honest scalars, lists, and nested records", () => {
    expect(toJsonValue("ok")).toBe("ok");
    expect(toJsonValue(3)).toBe(3);
    expect(toJsonValue(Number.NaN)).toBe(null);
    expect(toJsonValue(true)).toBe(true);
    expect(toJsonValue(null)).toBe(null);
    expect(toJsonValue(["1", { b: true }])).toEqual(["1", { b: true }]);
    expect(toJsonValue({ a: ["1", { b: true }] })).toEqual({
      a: ["1", { b: true }],
    });
  });

  it("omits undefined object keys and stringifies present undefined array slots", () => {
    expect(toJsonValue({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(toJsonValue([undefined, "x"])).toEqual(["undefined", "x"]);
  });

  it(`accepts a ${MAX_GOOGLE_GENAI_JSON_DEPTH}-deep array nest`, () => {
    expect(toJsonValue(nestArray(MAX_GOOGLE_GENAI_JSON_DEPTH))).toEqual(
      nestArray(MAX_GOOGLE_GENAI_JSON_DEPTH),
    );
  });

  it(`throws ${GOOGLE_GENAI_JSON_UNBOUNDED} one past depth ${MAX_GOOGLE_GENAI_JSON_DEPTH}`, () => {
    try {
      toJsonValue(nestArray(MAX_GOOGLE_GENAI_JSON_DEPTH + 1));
      expect.unreachable("parse should fail closed on over-budget depth");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_GENAI_JSON_UNBOUNDED);
    }
  });

  it(`throws ${GOOGLE_GENAI_JSON_UNBOUNDED} past ${MAX_GOOGLE_GENAI_JSON_NODES} sparse holes`, () => {
    const sparse: unknown[] = [];
    sparse[MAX_GOOGLE_GENAI_JSON_NODES] = "x";
    try {
      toJsonValue(sparse);
      expect.unreachable(
        "parse should fail closed on over-budget sparse length",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_GENAI_JSON_UNBOUNDED);
    }
  });

  it("preserves within-budget sparse holes and length", () => {
    const value: unknown[] = [];
    value[2] = "x";
    const result = toJsonValue(value) as unknown[];
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
      toJsonValue(cyclic);
      expect.unreachable("parse should fail closed on a cycle");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_GENAI_JSON_UNBOUNDED);
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
      toJsonValue(hostile);
      expect.unreachable("parse should fail closed on enumerable accessors");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_GENAI_JSON_UNBOUNDED);
    }
    expect(invoked).toBe(0);
  });

  it("does not invoke array Proxy get/has traps while parsing", () => {
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
    expect(toJsonValue(proxy)).toEqual(["x"]);
    expect(gets).toBe(0);
    expect(hasCalls).toBe(0);
  });

  it(`throws ${GOOGLE_GENAI_JSON_UNBOUNDED} on a revoked Proxy instead of TypeError`, () => {
    const { proxy, revoke } = Proxy.revocable(["x"], {});
    revoke();
    try {
      toJsonValue(proxy);
      expect.unreachable("parse should fail closed on a revoked Proxy");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_GENAI_JSON_UNBOUNDED);
      expect((error as Error).name).not.toBe("TypeError");
    }
  });

  it("fails closed on an 8k nest in under 50ms instead of RangeError", () => {
    const started = performance.now();
    try {
      toJsonValue(nestArray(8_000));
      expect.unreachable("parse should fail closed on an 8k nest");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_GENAI_JSON_UNBOUNDED);
      expect((error as Error).name).not.toBe("RangeError");
    }
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("toToolArguments", () => {
  it("parses honest tool-call argument records", () => {
    expect(toToolArguments({ command: "ls", n: 1 })).toEqual({
      command: "ls",
      n: 1,
    });
    expect(toToolArguments(["not", "a", "record"])).toEqual({});
    expect(toToolArguments(null)).toEqual({});
  });

  it("does not invoke parameter-slot accessors", () => {
    let invoked = 0;
    const hostile = {
      get payload() {
        invoked += 1;
        return ["x"];
      },
    };
    try {
      toToolArguments(hostile);
      expect.unreachable(
        "parse should fail closed on parameter-slot accessors",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_GENAI_JSON_UNBOUNDED);
    }
    expect(invoked).toBe(0);
  });

  it("preserves an own __proto__ key without mutating the output prototype", () => {
    const args = {} as Record<string, unknown>;
    Object.defineProperty(args, "__proto__", {
      value: { polluted: true },
      enumerable: true,
    });

    const result = toToolArguments(args);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toEqual(
      { polluted: true },
    );
    expect(
      (Object.prototype as { polluted?: boolean }).polluted,
    ).toBeUndefined();
  });

  it("rejects callable Proxies without invoking conversion or reflection traps", () => {
    let calls = 0;
    const callable = new Proxy(() => "unsafe", {
      apply() {
        calls += 1;
        throw new Error("call trap escaped");
      },
      get() {
        calls += 1;
        throw new Error("get trap escaped");
      },
      ownKeys() {
        calls += 1;
        throw new Error("ownKeys trap escaped");
      },
    });

    expect(() => toToolArguments({ payload: callable })).toThrowError(
      expect.objectContaining({ code: GOOGLE_GENAI_JSON_UNBOUNDED }),
    );
    expect(calls).toBe(0);
  });

  it("does not invoke hostile custom conversion methods", () => {
    let calls = 0;
    const hostile = {
      toString() {
        calls += 1;
        throw new Error("toString escaped");
      },
    };

    expect(() => toToolArguments({ payload: hostile })).toThrowError(
      expect.objectContaining({ code: GOOGLE_GENAI_JSON_UNBOUNDED }),
    );
    expect(calls).toBe(0);
  });

  it("fails closed on an 8k nest through toToolArguments", () => {
    const started = performance.now();
    try {
      toToolArguments({ payload: nestArray(8_000) });
      expect.unreachable("production parse should fail closed on an 8k nest");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GOOGLE_GENAI_JSON_UNBOUNDED);
      expect((error as Error).name).not.toBe("RangeError");
    }
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("preserves sparse holes through toToolArguments", () => {
    const payload: unknown[] = [];
    payload[2] = "x";
    const result = toToolArguments({ payload }).payload as unknown[];
    expect(result).toHaveLength(3);
    expect(0 in result).toBe(false);
    expect(1 in result).toBe(false);
    expect(result[2]).toBe("x");
  });
});
