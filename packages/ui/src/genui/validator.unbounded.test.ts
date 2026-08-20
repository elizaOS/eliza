/**
 * Deterministic coverage for the GenUI unsafe-field walk budget. The fuzz
 * harness already requires `validateElizaGenUiSpec` never to throw; these
 * cases pin deep, wide, sparse, accessor, and hostile-reflection inputs against
 * the real exported validator without replacing its production walk.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MAX_GENUI_UNSAFE_FIELD_DEPTH,
  MAX_GENUI_UNSAFE_FIELD_NODES,
  validateElizaGenUiSpec,
} from "./validator";

function nestData(depth: number): unknown {
  let value: unknown = { leaf: true };
  for (let i = 0; i < depth; i++) {
    value = { child: value };
  }
  return value;
}

function specWithData(data: unknown) {
  return {
    version: "0.1",
    root: "root",
    components: [{ id: "root", component: "Text", text: "ok" }],
    data,
  };
}

describe("validateElizaGenUiSpec unbounded nests", () => {
  it("accepts a shallow honest data object", () => {
    const result = validateElizaGenUiSpec(
      specWithData({ title: "Sleep", hours: 8 }),
    );
    expect(result.ok).toBe(true);
  });

  it(`rejects a ${MAX_GENUI_UNSAFE_FIELD_DEPTH + 1}-deep data nest without throwing`, () => {
    const result = validateElizaGenUiSpec(
      specWithData(nestData(MAX_GENUI_UNSAFE_FIELD_DEPTH + 1)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) => error.code === "unbounded_nest"),
      ).toBe(true);
    }
  });

  it("rejects a 4000-deep stringifyable nest without RangeError", () => {
    expect(() => {
      const result = validateElizaGenUiSpec(specWithData(nestData(4000)));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((error) => error.code === "unbounded_nest"),
        ).toBe(true);
      }
    }).not.toThrow();
  });

  it(`rejects more than ${MAX_GENUI_UNSAFE_FIELD_NODES} sibling nodes`, () => {
    const siblings: Record<string, string> = {};
    for (let i = 0; i < MAX_GENUI_UNSAFE_FIELD_NODES; i++) {
      siblings[`k${i}`] = "v";
    }
    const result = validateElizaGenUiSpec(specWithData(siblings));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) => error.code === "unbounded_nest"),
      ).toBe(true);
    }
  });

  it("rejects a sparse array by logical slots before scanning it", () => {
    const sparse: unknown[] = [];
    sparse.length = 5_000_000;
    const result = validateElizaGenUiSpec(specWithData(sparse));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "unbounded_nest" }),
      );
    }
  });

  it("rejects accessors without invoking them", () => {
    let calls = 0;
    const data = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        calls += 1;
        return "value";
      },
    });
    const result = validateElizaGenUiSpec(specWithData(data));
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it("severs inherited toJSON hooks without invoking them", () => {
    let calls = 0;
    const prototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(prototype, "toJSON", {
      get() {
        calls += 1;
        return () => ({ expanded: "x".repeat(100_000) });
      },
    });
    const data = Object.create(prototype) as Record<string, unknown>;
    data.safe = true;
    const result = validateElizaGenUiSpec(specWithData(data));
    expect(result.ok).toBe(true);
    expect(calls).toBe(0);
  });

  it("snapshots a Proxy without invoking a synthesized toJSON or ordinary getters", () => {
    let getCalls = 0;
    const data = new Proxy(
      { safe: true },
      {
        get(target, key, receiver) {
          getCalls += 1;
          if (key === "toJSON")
            return () => ({ expanded: "x".repeat(100_000) });
          return Reflect.get(target, key, receiver);
        },
      },
    );

    const result = validateElizaGenUiSpec(specWithData(data));
    expect(result.ok).toBe(true);
    expect(getCalls).toBe(0);
  });

  it("does not traverse an inherited prototype chain", () => {
    let prototype: object | null = null;
    for (let index = 0; index < 10_000; index += 1) {
      prototype = Object.create(prototype);
    }
    const data = Object.create(prototype) as Record<string, unknown>;
    data.safe = true;

    expect(validateElizaGenUiSpec(specWithData(data)).ok).toBe(true);
  });

  it("rejects non-JSON primitives without retaining or executing callables", () => {
    let calls = 0;
    const callback = () => {
      calls += 1;
      return "executed";
    };
    for (const value of [
      callback,
      undefined,
      Symbol("hidden"),
      1n,
      Number.POSITIVE_INFINITY,
    ]) {
      const result = validateElizaGenUiSpec(specWithData({ value }));
      expect(result.ok).toBe(false);
    }
    expect(calls).toBe(0);
  });

  it("returns an honest spec equivalent to its JSON round trip", () => {
    const input = specWithData({ title: "Sleep", values: [1, true, null] });
    const result = validateElizaGenUiSpec(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec).toEqual(JSON.parse(JSON.stringify(input)));
    }
  });

  it("rejects cumulative string bytes before the final stringify", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const data = Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `value${index}`,
          "x".repeat(2_000),
        ]),
      );
      const result = validateElizaGenUiSpec(specWithData(data));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: "too_large" }),
        );
      }
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it("accounts for exact ASCII, escape, and UTF-16 JSON boundaries", () => {
    const empty = specWithData({ payload: "" });
    const emptyBytes = new TextEncoder().encode(JSON.stringify(empty)).length;
    for (const [value, serializedBytes] of [
      ["xxxx", 4],
      ["\u0000", 6],
      ["😀", 4],
      ["\ud800", 6],
    ] as const) {
      expect(
        validateElizaGenUiSpec(specWithData({ payload: value }), {
          maxJsonBytes: emptyBytes + serializedBytes,
        }).ok,
      ).toBe(true);
      const over = validateElizaGenUiSpec(
        specWithData({ payload: `${value}x` }),
        { maxJsonBytes: emptyBytes + serializedBytes },
      );
      expect(over.ok).toBe(false);
      if (!over.ok) {
        expect(over.errors).toContainEqual(
          expect.objectContaining({ code: "too_large" }),
        );
      }
    }
  });

  it("preserves fractional and infinite public byte-limit overrides", () => {
    const spec = specWithData({ payload: "ok" });
    const exactBytes = new TextEncoder().encode(JSON.stringify(spec)).length;

    expect(
      validateElizaGenUiSpec(spec, { maxJsonBytes: exactBytes - 0.5 }).ok,
    ).toBe(false);
    expect(
      validateElizaGenUiSpec(spec, { maxJsonBytes: exactBytes + 0.5 }).ok,
    ).toBe(true);
    expect(
      validateElizaGenUiSpec(spec, { maxJsonBytes: Number.POSITIVE_INFINITY })
        .ok,
    ).toBe(true);
  });

  it("translates hostile reflection traps instead of throwing", () => {
    const data = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("descriptor trap");
        },
      },
    );
    expect(() => validateElizaGenUiSpec(specWithData(data))).not.toThrow();
    const result = validateElizaGenUiSpec(specWithData(data));
    expect(result.ok).toBe(false);
  });
});
