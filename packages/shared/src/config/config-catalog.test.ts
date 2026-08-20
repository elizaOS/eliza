/**
 * Unit tests for config-catalog path safety, field visibility, and built-in
 * validation. The deterministic harness exercises the exported helpers and
 * validation runner directly without UI or network dependencies.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  builtInValidators,
  evaluateFieldVisibility,
  evaluateLogicExpression,
  getByPath,
  isConfigKeySatisfied,
  LOGIC_EXPRESSION_INVALID,
  LOGIC_EXPRESSION_UNBOUNDED,
  MAX_LOGIC_EXPRESSION_DEPTH,
  MAX_LOGIC_EXPRESSION_NODES,
  MAX_LOGIC_EXPRESSION_PATH_LENGTH,
  MAX_LOGIC_EXPRESSION_PATH_SEGMENTS,
  runValidation,
  setByPath,
} from "./config-catalog.js";

describe("config-catalog path helpers", () => {
  it("resolves JSON Pointer escaped object keys", () => {
    const data = {
      "a/b": {
        "tilde~key": "value",
      },
    };

    expect(getByPath(data, "/a~1b/tilde~0key")).toBe("value");
  });

  it("does not coerce malformed array path segments", () => {
    const data = { items: ["zero", "one"] };

    expect(getByPath(data, "/items/1")).toBe("one");
    expect(getByPath(data, "/items/1abc")).toBeUndefined();
    expect(getByPath(data, "/items/foo")).toBeUndefined();
  });

  it("sets JSON Pointer escaped object keys without opening prototype paths", () => {
    const data: Record<string, unknown> = {};

    setByPath(data, "/a~1b/tilde~0key", "value");
    setByPath(data, "/safe/__proto__/polluted", true);

    expect(data).toEqual({ "a/b": { "tilde~key": "value" } });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("config-catalog field visibility gates", () => {
  it("treats persisted setKeys as satisfied even without a draft value", () => {
    expect(
      isConfigKeySatisfied(
        "DISCORD_API_TOKEN",
        {},
        new Set(["DISCORD_API_TOKEN"]),
      ),
    ).toBe(true);
    expect(isConfigKeySatisfied("DISCORD_API_TOKEN", {}, new Set())).toBe(
      false,
    );
    expect(
      isConfigKeySatisfied(
        "DISCORD_API_TOKEN",
        { DISCORD_API_TOKEN: " abc " },
        new Set(),
      ),
    ).toBe(true);
  });

  it("hides requires-gated fields until the credential is present", () => {
    expect(
      evaluateFieldVisibility({
        requires: "DISCORD_API_TOKEN",
        values: {},
      }),
    ).toBe(false);

    expect(
      evaluateFieldVisibility({
        requires: "DISCORD_API_TOKEN",
        values: {},
        setKeys: new Set(["DISCORD_API_TOKEN"]),
      }),
    ).toBe(true);

    expect(
      evaluateFieldVisibility({
        requires: "DISCORD_API_TOKEN",
        values: { DISCORD_API_TOKEN: "draft-token" },
      }),
    ).toBe(true);
  });

  it("unlocks requiresAny when any alternate credential is present", () => {
    expect(
      evaluateFieldVisibility({
        requiresAny: ["TWITTER_ACCESS_TOKEN", "TWITTER_CLIENT_ID"],
        values: { TWITTER_CLIENT_ID: "client" },
      }),
    ).toBe(true);

    expect(
      evaluateFieldVisibility({
        requiresAny: ["TWITTER_ACCESS_TOKEN", "TWITTER_CLIENT_ID"],
        values: {},
      }),
    ).toBe(false);
  });

  it("evaluates visible path checks against masked setKeys", () => {
    expect(
      evaluateFieldVisibility({
        visible: { path: "DISCORD_API_TOKEN" },
        values: {},
        setKeys: new Set(["DISCORD_API_TOKEN"]),
      }),
    ).toBe(true);
  });

  it("enforces visibility path bounds through the production field gate", () => {
    expect(() =>
      evaluateFieldVisibility({
        visible: { path: "x".repeat(MAX_LOGIC_EXPRESSION_PATH_LENGTH + 1) },
        values: {},
      }),
    ).toThrowError(ElizaError);
  });
});

describe("config-catalog built-in validators", () => {
  it.each([
    ["finite number", 12.5, true],
    ["complete decimal string", " -12.5e2 ", true],
    ["trailing unit", "12.5ms", false],
    ["empty string", "", false],
    ["whitespace string", "   ", false],
    ["NaN", Number.NaN, false],
    ["positive infinity", Number.POSITIVE_INFINITY, false],
    ["negative infinity", Number.NEGATIVE_INFINITY, false],
    ["infinity string", "Infinity", false],
    ["non-numeric type", null, false],
  ])("classifies %s", (_case, value, expected) => {
    expect(builtInValidators.numeric(value)).toBe(expected);
  });

  it("rejects malformed values through the declarative validation runner", () => {
    expect(
      runValidation(
        {
          checks: [{ fn: "numeric", message: "Must be a finite number" }],
        },
        "12.5ms",
        {},
      ),
    ).toEqual({ valid: false, errors: ["Must be a finite number"] });
  });
});

describe("evaluateLogicExpression budget", () => {
  it("still evaluates an honest and/or/not tree", () => {
    expect(
      evaluateLogicExpression(
        {
          and: [{ path: "/ready" }, { not: { path: "/hidden" } }],
        },
        { ready: true, hidden: false },
      ),
    ).toBe(true);
  });

  it(`throws ${LOGIC_EXPRESSION_UNBOUNDED} one past depth ${MAX_LOGIC_EXPRESSION_DEPTH}`, () => {
    let expr: Record<string, unknown> = { path: "/x" };
    for (let i = 0; i < MAX_LOGIC_EXPRESSION_DEPTH + 1; i++) {
      expr = { not: expr };
    }
    expect(() => evaluateLogicExpression(expr as never, {})).toThrowError(
      ElizaError,
    );
    try {
      evaluateLogicExpression(expr as never, {});
    } catch (error) {
      expect((error as ElizaError).code).toBe(LOGIC_EXPRESSION_UNBOUNDED);
      expect(error).not.toBeInstanceOf(RangeError);
    }
  });

  it(`accepts a ${MAX_LOGIC_EXPRESSION_DEPTH}-deep not nest`, () => {
    let expr: Record<string, unknown> = { path: "/x" };
    for (let i = 0; i < MAX_LOGIC_EXPRESSION_DEPTH; i++) {
      expr = { not: expr };
    }
    expect(evaluateLogicExpression(expr as never, {})).toBe(
      MAX_LOGIC_EXPRESSION_DEPTH % 2 === 1,
    );
  });

  it(`throws ${LOGIC_EXPRESSION_UNBOUNDED} past ${MAX_LOGIC_EXPRESSION_NODES} nodes`, () => {
    const expr = {
      and: Array.from({ length: MAX_LOGIC_EXPRESSION_NODES }, () => ({
        path: "/x",
      })),
    };
    // Truthy children so `and.every` cannot short-circuit before the cap.
    expect(() => evaluateLogicExpression(expr, { x: true })).toThrowError(
      ElizaError,
    );
  });

  it(`accepts exactly ${MAX_LOGIC_EXPRESSION_NODES} visited nodes`, () => {
    const expr = {
      and: Array.from({ length: MAX_LOGIC_EXPRESSION_NODES - 1 }, () => ({
        path: "/x",
      })),
    };

    expect(evaluateLogicExpression(expr, { x: true })).toBe(true);
  });

  it("allows a shared acyclic node while rejecting only ancestor cycles", () => {
    const shared = { path: "/x" };

    expect(
      evaluateLogicExpression({ and: [shared, shared] }, { x: true }),
    ).toBe(true);
  });

  it("throws LOGIC_EXPRESSION_UNBOUNDED on a cyclic and graph, not RangeError", () => {
    const cyclic: { and: unknown[] } = { and: [] };
    cyclic.and.push(cyclic);
    expect(() => evaluateLogicExpression(cyclic as never, {})).toThrowError(
      ElizaError,
    );
    try {
      evaluateLogicExpression(cyclic as never, {});
    } catch (error) {
      expect((error as ElizaError).code).toBe(LOGIC_EXPRESSION_UNBOUNDED);
      expect(error).not.toBeInstanceOf(RangeError);
    }
  });

  it.each([
    ["non-object node", null],
    ["non-array and", { and: "not-an-array" }],
    ["short comparison tuple", { eq: [1] }],
    ["multiple operators", { path: "/x", not: { path: "/y" } }],
  ])(
    "rejects malformed %s with a typed invalid-expression error",
    (_case, expr) => {
      try {
        evaluateLogicExpression(expr as never, {});
        throw new Error("expected malformed expression to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ElizaError);
        expect((error as ElizaError).code).toBe(LOGIC_EXPRESSION_INVALID);
        expect(error).not.toBeInstanceOf(TypeError);
      }
    },
  );

  it("bounds direct path character work at the exact limit", () => {
    const acceptedPath = "x".repeat(MAX_LOGIC_EXPRESSION_PATH_LENGTH);
    expect(
      evaluateLogicExpression({ path: acceptedPath }, { [acceptedPath]: true }),
    ).toBe(true);

    expect(() =>
      evaluateLogicExpression(
        { path: "x".repeat(MAX_LOGIC_EXPRESSION_PATH_LENGTH + 1) },
        {},
      ),
    ).toThrowError(ElizaError);
  });

  it("bounds direct path traversal at the exact segment limit", () => {
    const acceptedPath = Array.from(
      { length: MAX_LOGIC_EXPRESSION_PATH_SEGMENTS },
      () => "x",
    ).join("/");
    expect(evaluateLogicExpression({ path: acceptedPath }, {})).toBe(false);

    const oversizedPath = `${acceptedPath}/x`;
    expect(() =>
      evaluateLogicExpression({ path: oversizedPath }, {}),
    ).toThrowError(ElizaError);
  });

  it("applies the path bound to dynamic comparison operands", () => {
    expect(() =>
      evaluateLogicExpression(
        {
          eq: [
            { path: "x".repeat(MAX_LOGIC_EXPRESSION_PATH_LENGTH + 1) },
            true,
          ],
        },
        {},
      ),
    ).toThrowError(ElizaError);
  });
});
