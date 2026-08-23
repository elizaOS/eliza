import { describe, expect, it } from "vitest";
import { decodeUrlPathComponent } from "./path-component.ts";

describe("decodeUrlPathComponent", () => {
  it("decodes valid components", () => {
    expect(decodeUrlPathComponent("hello%20world")).toEqual({
      ok: true,
      value: "hello world",
    });
    expect(decodeUrlPathComponent("plain")).toEqual({
      ok: true,
      value: "plain",
    });
  });

  it("rejects malformed percent escapes", () => {
    expect(decodeUrlPathComponent("%zz")).toEqual({
      ok: false,
      reason: "malformed-encoding",
    });
    expect(decodeUrlPathComponent("%E0%A4%A")).toEqual({
      ok: false,
      reason: "malformed-encoding",
    });
  });
});
