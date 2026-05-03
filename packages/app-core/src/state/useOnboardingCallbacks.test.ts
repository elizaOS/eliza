import { describe, expect, it } from "vitest";
import { buildOnboardingFeatureSubmitPayload } from "./useOnboardingCallbacks";

describe("buildOnboardingFeatureSubmitPayload", () => {
  it("includes computeruse in the onboarding feature payload when enabled", () => {
    expect(
      buildOnboardingFeatureSubmitPayload({
        onboardingFeatureTelegram: false,
        onboardingFeatureDiscord: false,
        onboardingFeatureBrowser: false,
        onboardingFeatureComputerUse: true,
      }),
    ).toEqual({
      features: {
        computeruse: { enabled: true },
      },
    });
  });

  it("combines browser and computeruse feature toggles without dropping either", () => {
    expect(
      buildOnboardingFeatureSubmitPayload({
        onboardingFeatureTelegram: false,
        onboardingFeatureDiscord: false,
        onboardingFeatureBrowser: true,
        onboardingFeatureComputerUse: true,
      }),
    ).toEqual({
      features: {
        browser: { enabled: true },
        computeruse: { enabled: true },
      },
    });
  });
});
