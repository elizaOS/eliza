/** Tests live-QA provider precedence and stale-environment cleanup. */
import { describe, expect, it } from "bun:test";
import {
  applyLiveProviderConfig,
  resolveLiveProviderConfig,
} from "./live-provider-config.mjs";

describe("live QA provider configuration", () => {
  it("prefers Cerebras/Gemma and removes stale OpenRouter settings", () => {
    const env = {
      CEREBRAS_API_KEY: "csk-test",
      ELIZA_LIVE_QA_OPENROUTER_KEY: "sk-or-test",
      OPENAI_API_KEY: "stale",
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      OPENAI_LARGE_MODEL: "qwen/stale",
      OPENAI_RESPONSE_HANDLER_MODEL: "qwen/stale",
      ELIZA_OPENCODE_API_KEY: "sk-or-stale",
    };
    const config = resolveLiveProviderConfig(env);
    applyLiveProviderConfig(config, env);

    expect(config.kind).toBe("cerebras");
    expect(config.model).toBe("gemma-4-31b");
    expect(env.ELIZA_PROVIDER).toBe("cerebras");
    expect(env.CEREBRAS_MODEL).toBe("gemma-4-31b");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.OPENAI_LARGE_MODEL).toBeUndefined();
    expect(env.OPENAI_RESPONSE_HANDLER_MODEL).toBeUndefined();
    expect(env.ELIZA_OPENCODE_API_KEY).toBeUndefined();
  });

  it("fails closed instead of falling back to an OpenRouter key", () => {
    expect(() =>
      resolveLiveProviderConfig({
        ELIZA_LIVE_QA_OPENROUTER_KEY: "sk-or-test",
      }),
    ).toThrow("CEREBRAS_API_KEY");
  });
});
