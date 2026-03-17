import { describe, expect, it } from "vitest";
import {
  deriveOnboardingResumeConnection,
  deriveOnboardingResumeFields,
  hasPartialOnboardingConnectionConfig,
  inferOnboardingResumeStep,
} from "./onboarding-resume";

describe("hasPartialOnboardingConnectionConfig", () => {
  it.each([
    {
      config: null,
      expected: false,
      name: "returns false when config is missing",
    },
    {
      config: {},
      expected: false,
      name: "returns false when cloud config is missing",
    },
    {
      config: { cloud: { enabled: true } },
      expected: true,
      name: "returns true when cloud is enabled",
    },
    {
      config: { cloud: { apiKey: "sk-test" } },
      expected: true,
      name: "returns true when api key is present",
    },
    {
      config: { cloud: { apiKey: "   " } },
      expected: false,
      name: "ignores blank strings",
    },
  ])("$name", ({ config, expected }) => {
    expect(
      hasPartialOnboardingConnectionConfig(
        config as Record<string, unknown> | null,
      ),
    ).toBe(expected);
  });
});

describe("inferOnboardingResumeStep", () => {
  it("prefers the persisted step over inferred config", () => {
    expect(
      inferOnboardingResumeStep({
        persistedStep: "rpc",
        config: { cloud: { enabled: true } },
      }),
    ).toBe("rpc");
  });

  it("resumes at senses when partial onboarding connection config exists", () => {
    expect(
      inferOnboardingResumeStep({
        config: { cloud: { remoteApiBase: "https://example.com" } },
      }),
    ).toBe("senses");
  });

  it("falls back to identity when nothing is persisted yet", () => {
    expect(
      inferOnboardingResumeStep({
        config: {},
      }),
    ).toBe("identity");
  });
});

describe("deriveOnboardingResumeConnection", () => {
  it("reconstructs an eliza cloud connection from partial saved config", () => {
    expect(
      deriveOnboardingResumeConnection({
        cloud: { enabled: true, apiKey: "[REDACTED]" },
        models: {
          small: "openai/gpt-5-mini",
          large: "anthropic/claude-sonnet-4.5",
        },
      }),
    ).toEqual({
      kind: "cloud-managed",
      cloudProvider: "elizacloud",
      apiKey: undefined,
      smallModel: "openai/gpt-5-mini",
      largeModel: "anthropic/claude-sonnet-4.5",
    });
  });

  it("reconstructs a local provider connection from saved env config", () => {
    expect(
      deriveOnboardingResumeConnection({
        env: {
          vars: {
            OPENROUTER_API_KEY: "sk-or-test",
          },
        },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5-mini" },
          },
        },
      }),
    ).toEqual({
      kind: "local-provider",
      provider: "openrouter",
      apiKey: "sk-or-test",
      primaryModel: "openai/gpt-5-mini",
    });
  });
});

describe("deriveOnboardingResumeFields", () => {
  it("maps an openrouter connection back into onboarding state", () => {
    expect(
      deriveOnboardingResumeFields({
        kind: "local-provider",
        provider: "openrouter",
        apiKey: "sk-or-test",
        primaryModel: "openai/gpt-5-mini",
      }),
    ).toEqual({
      onboardingRunMode: "local",
      onboardingCloudProvider: "",
      onboardingProvider: "openrouter",
      onboardingApiKey: "sk-or-test",
      onboardingPrimaryModel: "",
      onboardingOpenRouterModel: "openai/gpt-5-mini",
      onboardingRemoteConnected: false,
      onboardingRemoteApiBase: "",
      onboardingRemoteToken: "",
    });
  });
});
