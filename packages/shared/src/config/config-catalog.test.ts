/**
 * Unit tests for the config-catalog JSON Pointer path helpers (getByPath /
 * setByPath): RFC 6901 escape handling (~0 / ~1), array-index coercion rules,
 * and prototype-pollution guarding on write.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateFieldVisibility,
  getByPath,
  isConfigKeySatisfied,
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
