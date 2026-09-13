import { describe, expect, it } from "vitest";
import { parseDeviceFrame } from "./protocol";

describe("Companion protocol frame parsing surrogate safety", () => {
  it("preserves surrogate pairs when clamping malformed JSON in error context", () => {
    const rawMalformed = "{" + "a".repeat(254) + "🚀" + "tail";
    try {
      parseDeviceFrame(rawMalformed);
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("COMPANION_BAD_FRAME");
      const rawContext = err.context?.raw as string;
      expect(rawContext.isWellFormed()).toBe(true);
      expect(rawContext).toBe("{" + "a".repeat(254));
    }
  });

  it("clamps raw at 256 without splitting a surrogate via badFrame()", () => {
    const prefix = '{"type":"register","deviceId":"","pad":"';
    const raw = prefix + "a".repeat(215) + "🚀" + '"}';
    try {
      parseDeviceFrame(raw);
      expect.unreachable("should throw badFrame");
    } catch (err: any) {
      expect(err.code).toBe("COMPANION_BAD_FRAME");
      expect(err.message).toContain("invalid frame");
      const rawContext = err.context?.raw as string;
      expect(rawContext.isWellFormed()).toBe(true);
      expect(rawContext.length).toBe(255);
    }
  });
});
