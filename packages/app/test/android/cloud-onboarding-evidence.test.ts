/**
 * Locks the Android Cloud-onboarding evidence descriptors to the issue's JPG
 * contract without executing the credential- and emulator-gated live lane.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ANDROID_CLOUD_ONBOARDING_STILL_NAMES,
  buildAndroidCloudOnboardingJpegArtifact,
} from "./cloud-onboarding-evidence";

describe("Android Cloud-onboarding still evidence", () => {
  it("emits authenticated home and live-reply captures as JPEG artifacts", () => {
    expect(ANDROID_CLOUD_ONBOARDING_STILL_NAMES).toEqual([
      "home-landing",
      "reply-liveness",
    ]);

    for (const name of ANDROID_CLOUD_ONBOARDING_STILL_NAMES) {
      const artifact = buildAndroidCloudOnboardingJpegArtifact(
        "/evidence/android/tap",
        name,
      );
      expect(path.basename(artifact.screenshot.path)).toBe(`${name}.jpg`);
      expect(artifact.screenshot).toMatchObject({
        fullPage: true,
        type: "jpeg",
      });
      expect(artifact.attachment).toEqual({
        path: artifact.screenshot.path,
        contentType: "image/jpeg",
      });
    }
  });
});
