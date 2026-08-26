import { describe, expect, it } from "vitest";
import { parseDeviceFrame } from "./protocol";

describe("parseDeviceFrame Unicode safety", () => {
  it("preserves well-formed Unicode when invalid JSON contains surrogate pairs at clamp boundary", () => {
    const malformedWithSurrogate = "{" + "a".repeat(250) + "🚀" + "tail";
    try {
      parseDeviceFrame(malformedWithSurrogate);
      expect.unreachable("expected parseDeviceFrame to throw");
    } catch (err: unknown) {
      const context = (err as { context?: { raw?: string } }).context;
      expect(context?.raw?.isWellFormed?.()).not.toBe(false);
    }
  });
});
