/** Tests first-party coding-model provider resolution without live requests. */
import { describe, expect, it } from "bun:test";
import {
  applyCerebrasProviderEnv,
  applyOpencodeProviderEnv,
  describeActiveModel,
  hasModelProviderCredential,
  resolveModelProvider,
} from "./model-provider.js";

describe("eliza-code model provider resolution", () => {
  it("accepts a direct Cerebras key and defaults to Gemma without copying the secret", () => {
    const env: Record<string, string | undefined> = {
      CEREBRAS_API_KEY: "csk-test",
    };

    applyCerebrasProviderEnv(env);

    expect(env.ELIZA_CODE_PROVIDER).toBe("cerebras");
    expect(env.ELIZA_PROVIDER).toBe("cerebras");
    expect(env.CEREBRAS_MODEL).toBe("gemma-4-31b");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(resolveModelProvider(env)).toBe("cerebras");
    expect(hasModelProviderCredential("cerebras", env)).toBe(true);
    expect(describeActiveModel(env)).toBe("gemma-4-31b");
  });

  it("honors explicit Cerebras tier models in the status label", () => {
    const env = {
      ELIZA_CODE_PROVIDER: "cerebras",
      ELIZA_PROVIDER: "cerebras",
      CEREBRAS_API_KEY: "csk-test",
      CEREBRAS_LARGE_MODEL: "custom-gemma",
    };
    expect(resolveModelProvider(env)).toBe("cerebras");
    expect(describeActiveModel(env)).toBe("custom-gemma");
  });

  it("does not override an explicitly selected non-Cerebras provider", () => {
    const env = {
      ELIZA_CODE_PROVIDER: "openai",
      ELIZA_PROVIDER: "openai",
      CEREBRAS_API_KEY: "csk-test",
      OPENAI_API_KEY: "sk-test",
    };

    applyCerebrasProviderEnv(env);

    expect(env.ELIZA_CODE_PROVIDER).toBe("openai");
    expect(env.ELIZA_PROVIDER).toBe("openai");
    expect(resolveModelProvider(env)).toBe("openai");
  });

  it("does not hydrate stale OpenCode transport variables in direct Cerebras mode", () => {
    const env: Record<string, string | undefined> = {
      CEREBRAS_API_KEY: "csk-test",
      ELIZA_OPENCODE_API_KEY: "sk-or-test",
      ELIZA_OPENCODE_BASE_URL: "https://openrouter.ai/api/v1",
    };

    applyCerebrasProviderEnv(env);
    applyOpencodeProviderEnv(env);

    expect(env.ELIZA_CODE_PROVIDER).toBe("cerebras");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("keeps Anthropic explicit and reports missing credentials honestly", () => {
    const env = { ELIZA_CODE_PROVIDER: "anthropic" };
    expect(resolveModelProvider(env)).toBe("anthropic");
    expect(hasModelProviderCredential("anthropic", env)).toBe(false);
  });
});
