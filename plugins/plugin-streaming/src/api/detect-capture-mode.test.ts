import { ServiceType } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { detectCaptureMode } from "./stream-routes.js";

/**
 * `detectCaptureMode` selects the FFmpeg input mode. The desktop screen-capture
 * bridge is discovered by the caller via
 * `runtime.getService(ServiceType.SCREEN_CAPTURE)` (a typed
 * {@link IScreenCaptureService}) and passed in explicitly, never read from a
 * global screen-capture bridge.
 */
describe("detectCaptureMode", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("exposes a canonical SCREEN_CAPTURE service type", () => {
    expect(ServiceType.SCREEN_CAPTURE).toBe("screen_capture");
  });

  it("selects pipe when the desktop screen-capture service is present", () => {
    delete process.env.STREAM_MODE;
    expect(detectCaptureMode(true)).toBe("pipe");
  });

  it("does not select pipe from the bridge when the service is absent", () => {
    delete process.env.STREAM_MODE;
    delete process.env.DISPLAY;
    // With no bridge and no DISPLAY, it falls through to a non-pipe mode.
    expect(detectCaptureMode(false)).not.toBe("pipe");
  });

  it("honors an explicit STREAM_MODE override regardless of the bridge", () => {
    process.env.STREAM_MODE = "x11grab";
    expect(detectCaptureMode(true)).toBe("x11grab");
  });
});
