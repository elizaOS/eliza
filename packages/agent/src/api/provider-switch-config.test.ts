import { afterEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/types.eliza";
import {
  applySubscriptionProviderConfig,
  clearSubscriptionProviderConfig,
} from "./provider-switch-config";

describe("applySubscriptionProviderConfig", () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("configures Codex subscriptions for the Codex CLI model provider", () => {
    const config: Partial<ElizaConfig> = {};

    applySubscriptionProviderConfig(config, "openai-codex");

    expect(config.agents?.defaults?.subscriptionProvider).toBe("openai-codex");
    expect(config.agents?.defaults?.model?.primary).toBe("codex-cli");
  });

  it("keeps Gemini CLI subscriptions out of runtime model routing", () => {
    const config: Partial<ElizaConfig> = {};

    applySubscriptionProviderConfig(config, "gemini-subscription");

    expect(config.agents?.defaults?.subscriptionProvider).toBe("gemini-cli");
    expect(config.agents?.defaults?.model?.primary).toBeUndefined();
  });

  it("keeps coding-plan endpoint subscriptions out of direct API routing", () => {
    const config: Partial<ElizaConfig> = {};

    applySubscriptionProviderConfig(config, "zai-coding-subscription");

    expect(config.agents?.defaults?.subscriptionProvider).toBe("zai-coding");
    expect(config.agents?.defaults?.model?.primary).toBeUndefined();
  });

  it("clears subscription provider settings without touching direct API env", () => {
    process.env.OPENAI_API_KEY = "sk-direct-openai-key";
    const config: Partial<ElizaConfig> = {};

    applySubscriptionProviderConfig(config, "openai-codex");
    clearSubscriptionProviderConfig(config);

    expect(config.agents?.defaults?.subscriptionProvider).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBe("sk-direct-openai-key");
  });
});
