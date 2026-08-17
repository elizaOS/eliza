/**
 * Deterministic coverage for transport-neutral URL path-component decoding.
 */

import { describe, expect, it } from "vitest";
import { decodeUrlPathComponent } from "./path-component";

describe("decodeUrlPathComponent", () => {
  it.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed encoding %s",
    (raw) => {
      expect(decodeUrlPathComponent(raw)).toEqual({
        ok: false,
        reason: "malformed-encoding",
      });
    },
  );

  it("decodes valid UTF-8 and leaves domain validation to the caller", () => {
    expect(decodeUrlPathComponent("caf%C3%A9")).toEqual({
      ok: true,
      value: "café",
    });
    expect(decodeUrlPathComponent("a%2Fb")).toEqual({
      ok: true,
      value: "a/b",
    });
    expect(decodeUrlPathComponent("a%252Fb")).toEqual({
      ok: true,
      value: "a%2Fb",
    });
  });

  it("rejects non-string inputs as malformed encoding", () => {
    expect(decodeUrlPathComponent(null)).toEqual({
      ok: false,
      reason: "malformed-encoding",
    });
    expect(decodeUrlPathComponent(undefined)).toEqual({
      ok: false,
      reason: "malformed-encoding",
    });
    expect(decodeUrlPathComponent(123 as unknown as string)).toEqual({
      ok: false,
      reason: "malformed-encoding",
    });
  });
});
