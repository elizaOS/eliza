/**
 * Contract tests for the `CameraWeb` fallback's preview options.
 */
import { describe, expect, it } from "vitest";

import type { CameraPreviewOptions } from "./definitions";
import { CameraWeb } from "./web";

describe("CameraWeb startPreview", () => {
  it("rejects a preview without a host element", async () => {
    // Native callers omit `element`, so the shared options type allows it;
    // the web fallback still needs one to attach its <video>.
    const options: CameraPreviewOptions = { direction: "back", mirror: false };

    await expect(new CameraWeb().startPreview(options)).rejects.toThrow(
      "Preview element is required",
    );
  });
});
