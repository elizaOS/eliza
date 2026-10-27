/**
 * Contract tests for the shared camera host ports: explicit denial classification, resume
 * recovery that never re-prompts, and Keep outcomes that never claim an unconfirmed save.
 */
import { describe, expect, it, vi } from "vitest";
import type { PhotoResult } from "./definitions";
import {
  cameraAccessDenied,
  captureOperationId,
  keepCapture,
  restartAfterResume,
} from "./host-ports";

const photo: PhotoResult = {
  base64: "AA==",
  format: "jpeg",
  width: 4,
  height: 3,
};
const stopped = () => ({ denied: "camera", phase: "error", disposed: false });

describe("cameraAccessDenied", () => {
  it("classifies only explicit denials", () => {
    expect(
      cameraAccessDenied({ code: "CAMERA_PERMISSION_DENIED", message: "x" }),
    ).toBe("camera");
    expect(cameraAccessDenied({ name: "NotAllowedError" })).toBe("camera");
    expect(cameraAccessDenied({ name: "PermissionDeniedError" })).toBe(
      "camera",
    );
    expect(cameraAccessDenied(new Error("Camera permission denied"))).toBe(
      "camera",
    );
    expect(cameraAccessDenied({ code: "MICROPHONE_DENIED" })).toBe(
      "microphone",
    );
    expect(cameraAccessDenied(new Error("Microphone permission denied"))).toBe(
      "microphone",
    );
    for (const error of [
      new Error("Camera is in use"),
      new Error("permission check timed out"),
      { name: "NotReadableError" },
      null,
      undefined,
      "denied",
    ])
      expect(cameraAccessDenied(error)).toBeUndefined();
  });
});

describe("restartAfterResume", () => {
  it("does not ask for the camera again after a denial", async () => {
    const check = vi.fn();
    for (const camera of [
      "denied",
      "prompt",
      "prompt-with-rationale",
      undefined,
    ]) {
      check.mockResolvedValueOnce({ camera });
      expect(await restartAfterResume(stopped, check)).toBe(false);
    }
    expect(check).toHaveBeenCalledTimes(4);
    expect(
      await restartAfterResume(stopped, async () => {
        throw new Error("bridge closed");
      }),
    ).toBe(false);
  });

  it("restarts after a grant made in settings", async () => {
    expect(
      await restartAfterResume(stopped, async () => ({ camera: "granted" })),
    ).toBe(true);
  });

  it("restarts nothing else, and a state that changed while reading wins", async () => {
    const granted = vi.fn(async () => ({ camera: "granted" }));
    for (const state of [
      { phase: "error", disposed: false },
      { denied: "microphone", phase: "error", disposed: false },
      { denied: "camera", phase: "live", disposed: false },
      { denied: "camera", phase: "error", disposed: true },
    ])
      expect(await restartAfterResume(() => state, granted)).toBe(false);
    expect(granted).not.toHaveBeenCalled();
    let current = stopped();
    expect(
      await restartAfterResume(
        () => current,
        async () => {
          current = { denied: "camera", phase: "starting", disposed: false };
          return { camera: "granted" };
        },
      ),
    ).toBe(false);
  });
});

describe("keepCapture", () => {
  it("passes the stable operation identity and returns the store's receipt", async () => {
    const run = vi.fn(async () => ({ status: "saved" as const, id: "42" }));
    const operationId = captureOperationId();
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await keepCapture({ label: "Keep", run }, photo, operationId),
    ).toEqual({
      status: "saved",
      id: "42",
    });
    expect(run).toHaveBeenCalledWith(photo, operationId);
  });

  it("never claims a save the store did not confirm", async () => {
    expect(
      await keepCapture(
        {
          label: "Keep",
          run: async () => {
            throw new Error("bridge closed");
          },
        },
        photo,
        "op",
      ),
    ).toMatchObject({ status: "unknown" });
    expect(
      await keepCapture(
        { label: "Keep", run: async () => ({ status: "failed", message: "" }) },
        photo,
        "op",
      ),
    ).toEqual({ status: "failed", message: "The photo was not kept." });
    expect(
      await keepCapture(
        // A malformed answer from a host port.
        { label: "Keep", run: async () => ({ status: "done" }) as never },
        photo,
        "op",
      ),
    ).toMatchObject({ status: "unknown" });
  });
});
