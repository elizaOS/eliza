/**
 * Exercises the Cloud completion contract used by the iOS/Android
 * cloud-onboarding smoke harness. The cases are intentionally pure: device
 * evidence proves the WebView flow, while this suite locks the result predicate
 * that CI can evaluate deterministically.
 */

import { describe, expect, it } from "vitest";
import { isIosCloudOnboardingComplete } from "./ios-cloud-onboarding-smoke-result";

const completeState = {
  homeVisible: true,
  composerVisible: true,
  onboardingHidden: true,
  cloudActiveServer: true,
  firstRunPostCount: 1,
};

describe("isIosCloudOnboardingComplete", () => {
  it("accepts Cloud completion after the app-shell first-run POST", () => {
    expect(isIosCloudOnboardingComplete(completeState)).toBe(true);
  });

  it.each([
    ["home hidden", { homeVisible: false }],
    ["composer hidden", { composerVisible: false }],
    ["onboarding still visible", { onboardingHidden: false }],
    ["active server not cloud", { cloudActiveServer: false }],
    ["app-shell first-run POST missing", { firstRunPostCount: 0 }],
    ["duplicate app-shell first-run POST observed", { firstRunPostCount: 2 }],
  ])("rejects incomplete state when %s", (_label, override) => {
    expect(
      isIosCloudOnboardingComplete({
        ...completeState,
        ...override,
      }),
    ).toBe(false);
  });
});
