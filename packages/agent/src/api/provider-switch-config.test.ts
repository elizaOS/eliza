import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/types.eliza";
import {
  applySubscriptionProviderConfig,
  clearSubscriptionProviderConfig,
  openAiBaseUrlIsThirdParty,
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

describe("openAiBaseUrlIsThirdParty", () => {
  // Tests are sequential so they can mutate `process.env.OPENAI_BASE_URL`
  // without cross-test contamination — vitest serializes tests within a
  // single `describe` block.
  const originalBaseUrl = process.env.OPENAI_BASE_URL;

  beforeEach(() => {
    delete process.env.OPENAI_BASE_URL;
  });

  afterEach(() => {
    if (typeof originalBaseUrl === "string") {
      process.env.OPENAI_BASE_URL = originalBaseUrl;
    } else {
      delete process.env.OPENAI_BASE_URL;
    }
  });

  it("returns false when OPENAI_BASE_URL is unset", () => {
    expect(openAiBaseUrlIsThirdParty()).toBe(false);
  });

  it("returns false when OPENAI_BASE_URL is whitespace-only", () => {
    process.env.OPENAI_BASE_URL = "   ";
    expect(openAiBaseUrlIsThirdParty()).toBe(false);
  });

  it("returns false when OPENAI_BASE_URL points at api.openai.com (canonical)", () => {
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(false);
  });

  it("returns false for api.openai.com with a trailing path / query", () => {
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1/?tracing=1";
    expect(openAiBaseUrlIsThirdParty()).toBe(false);
  });

  it("returns true for the Cerebras host (the case that motivated this guard)", () => {
    process.env.OPENAI_BASE_URL = "https://api.cerebras.ai/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("returns true for Groq", () => {
    process.env.OPENAI_BASE_URL = "https://api.groq.com/openai/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("returns true for OpenRouter", () => {
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("returns true for Together AI", () => {
    process.env.OPENAI_BASE_URL = "https://api.together.xyz/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("returns true for localhost (vLLM / LM Studio / Ollama gateway)", () => {
    process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("returns true for an arbitrary in-house gateway", () => {
    process.env.OPENAI_BASE_URL = "https://gateway.acme.internal/openai";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("treats unparseable URLs as third-party (fail-safe)", () => {
    process.env.OPENAI_BASE_URL = "not://a real:url";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("returns true for openai.com subdomains other than api.openai.com", () => {
    // Future-proof: this protects against someone pointing at
    // `platform.openai.com` or `dashboard.openai.com` by mistake.
    process.env.OPENAI_BASE_URL = "https://platform.openai.com/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("is case-insensitive on the hostname", () => {
    process.env.OPENAI_BASE_URL = "https://API.OpenAI.COM/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(false);
  });
});
