import { describe, expect, it } from "vitest";
import { buildOnboardingRuntimeConfig } from "../src/onboarding-config";

describe("buildOnboardingRuntimeConfig", () => {
  it("persists a connected remote backend as a direct runtime provider", () => {
    const runtimeConfig = buildOnboardingRuntimeConfig({
      onboardingServerTarget: "remote",
      onboardingCloudApiKey: "",
      onboardingProvider: "groq",
      onboardingApiKey: "gsk_test_valid_for_groq",
      onboardingVoiceProvider: "",
      onboardingVoiceApiKey: "",
      onboardingPrimaryModel: "llama-3.1-8b-instant",
      onboardingOpenRouterModel: "",
      onboardingRemoteConnected: true,
      onboardingRemoteApiBase: "http://127.0.0.1:31337",
      onboardingRemoteToken: "secret-token",
      onboardingSmallModel: "llama-3.1-8b-instant",
      onboardingLargeModel: "llama-3.1-8b-instant",
    });

    expect(runtimeConfig.deploymentTarget).toEqual({ runtime: "local" });
    expect(runtimeConfig.serviceRouting?.llmText).toEqual({
      backend: "groq",
      transport: "direct",
      primaryModel: "llama-3.1-8b-instant",
    });
    expect(runtimeConfig.credentialInputs).toEqual({
      llmApiKey: "gsk_test_valid_for_groq",
    });
  });
});
