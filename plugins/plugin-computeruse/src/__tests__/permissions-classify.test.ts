/**
 * Unit coverage for classifyPermissionDeniedError (#9170 / #9058).
 *
 * The computer-use service's dispatch catch routes raw OS errors through this
 * classifier to surface a typed, actionable permission-denied result instead of
 * a bare stack trace. The macOS Accessibility / Screen-Recording paths run on
 * every OS; the Windows privacy/Group-Policy/UAC paths are gated to win32 (and
 * therefore actually execute on this Windows box). Untested until now.
 */

import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import {
  classifyPermissionDeniedError,
  createPermissionDeniedError,
} from "../platform/permissions.js";

const IS_WIN = platform() === "win32";

describe("classifyPermissionDeniedError", () => {
  it("returns an already-classified PermissionDeniedError unchanged", () => {
    const original = createPermissionDeniedError({
      permissionType: "accessibility",
      operation: "click",
      message: "already denied",
    });
    expect(
      classifyPermissionDeniedError(original, {
        permissionType: "screen_recording",
        operation: "screenshot",
      }),
    ).toBe(original);
  });

  it("classifies an accessibility permission error (any OS)", () => {
    const out = classifyPermissionDeniedError(
      new Error(
        "System Events got an error: not authorized to send Apple events",
      ),
      { permissionType: "accessibility", operation: "type" },
    );
    expect(out?.permissionDenied).toBe(true);
    expect(out?.permissionType).toBe("accessibility");
    expect(out?.message).toMatch(/Accessibility/);
  });

  it("classifies a screen-recording permission error (any OS)", () => {
    const out = classifyPermissionDeniedError(
      new Error("could not create image from display 0"),
      { permissionType: "screen_recording", operation: "screenshot" },
    );
    expect(out?.permissionType).toBe("screen_recording");
    expect(out?.message).toMatch(/Screen Recording/);
  });

  it("returns null for an unrelated error", () => {
    expect(
      classifyPermissionDeniedError(new Error("disk full"), {
        permissionType: "screen_recording",
        operation: "screenshot",
      }),
    ).toBeNull();
  });

  it.skipIf(!IS_WIN)(
    "classifies a Windows screen-capture block (win32)",
    () => {
      const out = classifyPermissionDeniedError(
        new Error("GraphicsCaptureSession could not start"),
        { permissionType: "screen_recording", operation: "screenshot" },
      );
      expect(out?.permissionType).toBe("screen_recording");
      expect(out?.message).toMatch(/Windows privacy|Group Policy/);
    },
  );

  it.skipIf(!IS_WIN)(
    "classifies a Windows camera privacy denial (win32)",
    () => {
      const out = classifyPermissionDeniedError(
        new Error("Access is denied (0x80070005)"),
        { permissionType: "camera", operation: "capture" },
      );
      expect(out?.permissionType).toBe("camera");
      expect(out?.message).toMatch(/Camera access is denied/);
    },
  );

  it.skipIf(!IS_WIN)(
    "classifies a Windows input refusal as accessibility / UAC (win32)",
    () => {
      const out = classifyPermissionDeniedError(new Error("Access is denied"), {
        permissionType: "accessibility",
        operation: "click",
      });
      expect(out?.permissionType).toBe("accessibility");
      expect(out?.message).toMatch(/elevated \(UAC\)|protected process/);
    },
  );
});
