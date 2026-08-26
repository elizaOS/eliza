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
      expect(rawContext.isWellFormed?.()).not.toBe(false);
      expect(rawContext).toBe("{" + "a".repeat(254));
    }
  });

  it("preserves surrogate pairs when clamping invalid frame in badFrame", () => {
    const rawInvalid = JSON.stringify({ type: "register", deviceId: "" }) + "a".repeat(200) + "🚀" + "extra";
    try {
      parseDeviceFrame(rawInvalid);
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("COMPANION_BAD_FRAME");
      const rawContext = err.context?.raw as string;
      expect(rawContext.isWellFormed?.()).not.toBe(false);
    }
  });
});
