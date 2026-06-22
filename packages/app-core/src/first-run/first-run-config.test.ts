import { describe, expect, it } from "vitest";
import { buildFirstRunRuntimeConfig } from "./first-run-config";

function baseArgs(
  overrides: Partial<Parameters<typeof buildFirstRunRuntimeConfig>[0]> = {},
): Parameters<typeof buildFirstRunRuntimeConfig>[0] {
  return {
    firstRunRuntimeTarget: "local",
    firstRunCloudApiKey: "",
    firstRunProvider: "openai",
    firstRunApiKey: "provider-key",
    firstRunVoiceProvider: "",
    firstRunVoiceApiKey: "",
    firstRunPrimaryModel: "primary-model",
    firstRunOpenRouterModel: "",
    firstRunRemoteConnected: false,
    firstRunRemoteApiBase: "",
    firstRunRemoteToken: "",
    ...overrides,
  };
}

describe("buildFirstRunRuntimeConfig", () => {
  it("routes Cerebras first-run setup to direct Cerebras API inference", () => {
    const result = buildFirstRunRuntimeConfig(
      baseArgs({
        firstRunProvider: "cerebras",
        firstRunApiKey: "test-cerebras-api-key",
        firstRunPrimaryModel: "gpt-oss-120b",
      }),
    );

    expect(result.deploymentTarget).toEqual({ runtime: "local" });
    expect(result.linkedAccounts).toBeUndefined();
    expect(result.serviceRouting?.llmText).toEqual({
      backend: "cerebras",
      transport: "direct",
      primaryModel: "gpt-oss-120b",
    });
    expect(result.credentialInputs).toEqual({
      llmApiKey: "test-cerebras-api-key",
    });
    expect(result.needsProviderSetup).toBe(false);
  });
});
