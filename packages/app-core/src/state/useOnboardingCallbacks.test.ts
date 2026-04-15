import { describe, expect, it } from "vitest";
import { buildOnboardingFeatureSubmitPayload } from "./useOnboardingCallbacks";

describe("buildOnboardingFeatureSubmitPayload", () => {
  it("enables computeruse when selected during onboarding", () => {
    const payload = buildOnboardingFeatureSubmitPayload({
      onboardingFeatureTelegram: false,
      onboardingFeatureDiscord: false,
      onboardingFeatureBrowser: false,
      onboardingFeatureComputerUse: true,
    });

    expect(payload.features).toEqual({
      computeruse: { enabled: true },
    });
  });

  it("includes both browser and computeruse without dropping either capability", () => {
    const payload = buildOnboardingFeatureSubmitPayload({
      onboardingFeatureTelegram: false,
      onboardingFeatureDiscord: false,
      onboardingFeatureBrowser: true,
      onboardingFeatureComputerUse: true,
    });

    expect(payload.features).toEqual({
      browser: { enabled: true },
      computeruse: { enabled: true },
    });
  });
});
