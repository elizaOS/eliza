import { describe, expect, it } from "vitest";
import { applyOnboardingConnectionConfig } from "../provider-switch-config.js";

describe("applyOnboardingConnectionConfig", () => {
  it("clears stale direct-provider model state when switching to Eliza Cloud", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai" },
          subscriptionProvider: "openai-codex",
        },
      },
      serviceRouting: {
        llmText: {
          backend: "openai",
          transport: "direct",
          primaryModel: "gpt-5",
        },
      },
    };

    await applyOnboardingConnectionConfig(config, {
      kind: "cloud-managed",
      cloudProvider: "elizacloud",
      apiKey: "eliza_test_key",
    });

    expect(config.agents.defaults.subscriptionProvider).toBeUndefined();
    expect(config.agents.defaults.model?.primary).toBeUndefined();
    expect(config.serviceRouting?.llmText?.backend).toBe("elizacloud");
    expect(config.serviceRouting?.llmText?.transport).toBe("cloud-proxy");
  });

  it("clears stale direct-provider model state when switching to a remote provider", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai" },
        },
      },
      serviceRouting: {
        llmText: {
          backend: "openai",
          transport: "direct",
          primaryModel: "gpt-5",
        },
      },
    };

    await applyOnboardingConnectionConfig(config, {
      kind: "remote-provider",
      provider: "openai",
      remoteApiBase: "https://example.invalid/api",
    });

    expect(config.agents.defaults.model?.primary).toBeUndefined();
    expect(config.serviceRouting?.llmText?.backend).toBe("openai");
    expect(config.serviceRouting?.llmText?.transport).toBe("remote");
  });
});
