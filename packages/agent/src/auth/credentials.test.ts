import { afterEach, describe, expect, it, vi } from "vitest";
import { applySubscriptionCredentials } from "./credentials";

describe("applySubscriptionCredentials", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not expose Codex subscription credentials as OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const config = {
      agents: {
        defaults: {
          subscriptionProvider: "openai-codex",
        },
      },
    };

    await applySubscriptionCredentials(config);

    expect(process.env.OPENAI_API_KEY).toBe("");
    expect(config.agents.defaults.model?.primary).toBe("codex-cli");
  });

  it("leaves a direct OpenAI API key untouched", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-direct-openai-key");
    const config = {
      agents: {
        defaults: {
          subscriptionProvider: "openai-codex",
        },
      },
    };

    await applySubscriptionCredentials(config);

    expect(process.env.OPENAI_API_KEY).toBe("sk-direct-openai-key");
    expect(config.agents.defaults.model?.primary).toBe("codex-cli");
  });
});
