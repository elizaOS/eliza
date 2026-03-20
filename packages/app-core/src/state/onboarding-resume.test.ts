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
  it("defaults to welcome with no persisted step and no config", () => {
    expect(inferOnboardingResumeStep({})).toBe("welcome");
  });

  it("defaults to welcome with empty config and no persisted step", () => {
    expect(inferOnboardingResumeStep({ config: {} })).toBe("welcome");
  });

  it("defaults to welcome with null config and no persisted step", () => {
    expect(inferOnboardingResumeStep({ config: null })).toBe("welcome");
  });

  it("returns the persisted step when available", () => {
    expect(
      inferOnboardingResumeStep({ persistedStep: "rpc", config: {} }),
    ).toBe("rpc");
  });

  it("prefers the persisted step over inferred config", () => {
    expect(
      inferOnboardingResumeStep({
        persistedStep: "rpc",
        config: { cloud: { enabled: true } },
      }),
    ).toBe("rpc");
  });

  it("returns persisted step 'connection' when persisted", () => {
    expect(
      inferOnboardingResumeStep({ persistedStep: "connection" }),
    ).toBe("connection");
  });

  it("returns persisted step 'senses' when persisted", () => {
    expect(
      inferOnboardingResumeStep({ persistedStep: "senses" }),
    ).toBe("senses");
  });

  it("returns persisted step 'activate' when persisted", () => {
    expect(
      inferOnboardingResumeStep({ persistedStep: "activate" }),
    ).toBe("activate");
  });

  it("does not return identity as a default (welcome is the default now)", () => {
    const result = inferOnboardingResumeStep({ config: {} });
    expect(result).not.toBe("identity");
  });

  it("does not return connection as a default", () => {
    const result = inferOnboardingResumeStep({ config: {} });
    expect(result).not.toBe("connection");
  });

  it("does not return rpc as a default", () => {
    const result = inferOnboardingResumeStep({ config: {} });
    expect(result).not.toBe("rpc");
  });

  it("does not return senses as a default", () => {
    const result = inferOnboardingResumeStep({ config: {} });
    expect(result).not.toBe("senses");
  });

  it("does not return activate as a default", () => {
    const result = inferOnboardingResumeStep({ config: {} });
    expect(result).not.toBe("activate");
  });

  it("resumes at senses when partial onboarding connection config exists", () => {
    expect(
      inferOnboardingResumeStep({
        config: { cloud: { remoteApiBase: "https://example.com" } },
      }),
    ).toBe("welcome");
  });

  it("falls back to welcome when nothing is persisted yet", () => {
    expect(
      inferOnboardingResumeStep({
        config: {},
      }),
    ).toBe("welcome");
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
