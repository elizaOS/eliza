import { describe, expect, it } from "vitest";

import {
  preferenceNativeKeys,
  selectIosSmokePreferenceKeys,
  shouldClearIosSmokePreferenceKey,
} from "../scripts/lib/ios-sim-defaults-hygiene.mjs";

describe("iOS simulator defaults hygiene", () => {
  it("selects stale smoke, auth, first-run, and runtime keys from raw domains", () => {
    expect(
      selectIosSmokePreferenceKeys([
        "CapacitorStorage.eliza:ios-onboarding-smoke:request",
        "eliza:ios-full-bun-prewarm:result",
        "CapacitorStorage.eliza:auth-callback-smoke:result",
        "CapacitorStorage.elizaos:active-server",
        "CapacitorStorage.eliza:mobile-runtime-mode",
        "CapacitorStorage.user-visible-setting",
        "unrelated",
      ]),
    ).toEqual([
      "eliza:auth-callback-smoke:result",
      "eliza:ios-full-bun-prewarm:result",
      "eliza:ios-onboarding-smoke:request",
      "eliza:mobile-runtime-mode",
      "elizaos:active-server",
    ]);
  });

  it("does not remove ordinary app state unless it is a known lane poison", () => {
    expect(shouldClearIosSmokePreferenceKey("eliza:chat:draft")).toBe(false);
    expect(
      shouldClearIosSmokePreferenceKey("CapacitorStorage.eliza:chat:draft"),
    ).toBe(false);
    expect(shouldClearIosSmokePreferenceKey("eliza:first-run-complete")).toBe(
      true,
    );
  });

  it("deletes both CapacitorStorage-prefixed and raw native keys", () => {
    expect(preferenceNativeKeys("eliza:ios-onboarding-smoke:request")).toEqual([
      "CapacitorStorage.eliza:ios-onboarding-smoke:request",
      "eliza:ios-onboarding-smoke:request",
    ]);
  });
});
