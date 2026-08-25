/** Verifies Android E2E builds package only the runtime payload their backend uses. */
import { describe, expect, it } from "vitest";
import { resolveAndroidE2eBuildScript } from "./lib/android-e2e-build.mjs";

describe("Android E2E build selection", () => {
  it("uses the payload-free APK for a host-backed emulator", () => {
    expect(resolveAndroidE2eBuildScript("host")).toBe("build:android:host-e2e");
  });

  it("keeps the embedded-agent APK for a local backend", () => {
    expect(resolveAndroidE2eBuildScript("local")).toBe("build:android");
  });
});
