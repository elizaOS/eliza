/**
 * Unit tests for the config-catalog JSON Pointer path helpers (getByPath /
 * setByPath): RFC 6901 escape handling (~0 / ~1), array-index coercion rules,
 * and prototype-pollution guarding on write.
 */
import { describe, expect, it } from "vitest";
import { getByPath, setByPath } from "./config-catalog.js";

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
