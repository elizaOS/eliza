// Regression coverage for trajectory fidelity: surrogate-safe truncation
// (a naive slice splits emoji pairs at the 256-char boundary) and malformed
// Unicode rejection (a corrupted payload must not masquerade as clean).

import { logger } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { emitAndroidAction } from "../mobile/android-trajectory.js";

describe("emitAndroidAction — trajectory fidelity", () => {
  it("truncates at 256 chars without splitting a surrogate pair", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      // 250 ASCII chars + an emoji that straddles the 256 boundary
      const boundary = "x".repeat(254) + "🧠"; // 🧠 is 2 code units
      const payload = emitAndroidAction({
        kind: "tap",
        success: false,
        errorCode: "accessibility_unavailable",
        errorMessage: boundary,
      });
      // truncateWellFormed must not cut inside the surrogate pair
      expect(payload.errorMessage?.length).toBeLessThanOrEqual(256);
      expect(payload.errorMessage).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects malformed Unicode in the error message", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      // Lone high surrogate = malformed
      const malformed = "driver failed \uD800 tail";
      expect(() =>
        emitAndroidAction({
          kind: "tap",
          success: false,
          errorCode: "driver_error",
          errorMessage: malformed,
        }),
      ).toThrowError(
        expect.objectContaining({
          name: "ElizaError",
          code: "COMPUTERUSE_TRAJECTORY_MALFORMED_UNICODE",
          context: { field: "error" },
        }),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
