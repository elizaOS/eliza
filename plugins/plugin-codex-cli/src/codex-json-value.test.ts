/**
 * Deterministic unit test for isJsonValue/isJsonRecord (plugin-codex-cli):
 * the bounded JSON type-guard used when Codex SSE function-call arguments are
 * parsed. Pins the depth budget, node budget, cycle detection, accessor
 * rejection, symbol-key handling, and non-JSON value rejection. Pure-function
 * test — no runtime.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  ElizaError: class ElizaError extends Error {
    code?: string;
    severity?: string;
    context?: unknown;
    constructor(
      message: string,
      opts?: { code?: string; severity?: string; context?: unknown; cause?: unknown },
    ) {
      super(message);
      this.code = opts?.code;
      this.severity = opts?.severity;
      this.context = opts?.context;
    }
  },
}));

import {
  CODEX_JSON_UNBOUNDED,
  isJsonRecord,
  isJsonValue,
  MAX_CODEX_JSON_DEPTH,
  MAX_CODEX_JSON_NODES,
} from "./codex-json-value.ts";

/** Assert that fn throws the unbounded-budget error with a matching code. */
function expectUnbounded(fn: () => boolean): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error & { code?: string }).code).toBe(CODEX_JSON_UNBOUNDED);
}

/** Build a nested object of the requested depth: { a: { a: ... 0 } }. */
function nest(depth: number): unknown {
  let value: unknown = 0;
  for (let i = 0; i < depth; i += 1) {
    value = { a: value };
  }
  return value;
}

describe("isJsonValue — primitive acceptance", () => {
  it("accepts strings, numbers, booleans, and null", () => {
    expect(isJsonValue("x")).toBe(true);
    expect(isJsonValue(42)).toBe(true);
    expect(isJsonValue(-0.5)).toBe(true);
    expect(isJsonValue(true)).toBe(true);
    expect(isJsonValue(false)).toBe(true);
    expect(isJsonValue(null)).toBe(true);
  });

  it("rejects undefined, functions, symbols, and bigint", () => {
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(() => 1)).toBe(false);
    expect(isJsonValue(Symbol("s"))).toBe(false);
    expect(isJsonValue(10n)).toBe(false);
  });

  it("accepts flat arrays and records", () => {
    expect(isJsonValue([1, 2, 3])).toBe(true);
    expect(isJsonValue({ a: 1, b: "two" })).toBe(true);
    expect(isJsonValue([])).toBe(true);
    expect(isJsonValue({})).toBe(true);
  });

  it("accepts nested values within the depth budget", () => {
    expect(isJsonValue(nest(MAX_CODEX_JSON_DEPTH))).toBe(true);
  });
});

describe("isJsonValue — budget enforcement", () => {
  it("rejects nesting deeper than MAX_CODEX_JSON_DEPTH", () => {
    expectUnbounded(() => isJsonValue(nest(MAX_CODEX_JSON_DEPTH + 1)));
  });

  it("rejects a wide record exceeding the node budget", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < MAX_CODEX_JSON_NODES + 1; i += 1) {
      wide[`k${i}`] = i;
    }
    expectUnbounded(() => isJsonValue(wide));
  });

  it("accepts a wide record within the node budget", () => {
    const wide: Record<string, number> = {};
    // Budget: 1 root + keys.length pre-reserve + 1 per leaf walk.
    const keys = Math.floor((MAX_CODEX_JSON_NODES - 1) / 2);
    for (let i = 0; i < keys; i += 1) {
      wide[`k${i}`] = i;
    }
    expect(isJsonValue(wide)).toBe(true);
  });
});

describe("isJsonValue — hostile shapes", () => {
  it("rejects self-referential cycles", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectUnbounded(() => isJsonValue(cyclic));
  });

  it("rejects sibling cycles inside arrays", () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    a.other = b;
    b.other = a;
    expectUnbounded(() => isJsonValue([a, b]));
  });

  it("rejects accessor properties on records", () => {
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "evil", {
      enumerable: true,
      get() {
        return "pwned";
      },
    });
    expectUnbounded(() => isJsonValue(value));
  });

  it("rejects accessor properties on arrays", () => {
    const arr: unknown[] = [1];
    Object.defineProperty(arr, "1", {
      enumerable: true,
      get() {
        return 2;
      },
    });
    expectUnbounded(() => isJsonValue(arr));
  });

  it("rejects a Proxy whose traps throw", () => {
    const proxy = new Proxy({ a: 1 }, {
      getOwnPropertyDescriptor() {
        throw new Error("trap");
      },
    });
    expectUnbounded(() => isJsonValue(proxy));
  });

  it("skips non-enumerable keys instead of walking them", () => {
    const value: Record<string, unknown> = { a: 1 };
    Object.defineProperty(value, "hidden", {
      enumerable: false,
      value: { deep: [1, 2, 3] },
    });
    expect(isJsonValue(value)).toBe(true);
  });

  it("skips symbol keys instead of walking them", () => {
    const value: Record<string, unknown> = { a: 1 };
    (value as Record<PropertyKey, unknown>)[Symbol("meta")] = { deep: [1] };
    expect(isJsonValue(value)).toBe(true);
  });
});

describe("isJsonRecord — record-only guard", () => {
  it("returns true for plain records", () => {
    expect(isJsonRecord({ a: 1 })).toBe(true);
    expect(isJsonRecord({ nested: { list: [1, 2] } })).toBe(true);
  });

  it("returns false for arrays, primitives, and null", () => {
    expect(isJsonRecord([1])).toBe(false);
    expect(isJsonRecord("x")).toBe(false);
    expect(isJsonRecord(1)).toBe(false);
    expect(isJsonRecord(null)).toBe(false);
    expect(isJsonRecord(undefined)).toBe(false);
  });
});
