/**
 * Unit tests for config-catalog path safety, field visibility, and built-in
 * validation. The deterministic harness exercises the exported helpers and
 * validation runner directly without UI or network dependencies.
 */
import { describe, expect, it } from "vitest";
import {
  builtInValidators,
  evaluateFieldVisibility,
  getByPath,
  isConfigKeySatisfied,
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
