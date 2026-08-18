import { describe, expect, it } from "bun:test";
import {
  applyElizaCodeProviderEnv,
  resolveModelProvider,
} from "./model-provider";

describe("Eliza Code provider environment", () => {
  it("maps the native Eliza Code contract onto the OpenAI-compatible plugin", () => {
    const env: Record<string, string | undefined> = {
      ELIZA_CODE_API_KEY: "native-test-key",
      ELIZA_CODE_BASE_URL: "https://provider.example.test/v1",
      ELIZA_CODE_MODEL_POWERFUL: "power-model",
      ELIZA_CODE_MODEL_FAST: "fast-model",
    };

    applyElizaCodeProviderEnv(env);

    expect(env).toMatchObject({
      ELIZA_CODE_PROVIDER: "openai",
      OPENAI_API_KEY: "native-test-key",
      OPENAI_BASE_URL: "https://provider.example.test/v1",
      OPENAI_LARGE_MODEL: "power-model",
      OPENAI_SMALL_MODEL: "fast-model",
      OPENAI_MEDIUM_MODEL: "fast-model",
    });
    expect(resolveModelProvider(env)).toBe("openai");
  });

  it("never overrides explicit OpenAI-compatible provider settings", () => {
    const env: Record<string, string | undefined> = {
      OPENAI_API_KEY: "explicit-key",
      OPENAI_BASE_URL: "https://explicit.example.test/v1",
      OPENAI_LARGE_MODEL: "explicit-large",
      OPENAI_SMALL_MODEL: "explicit-small",
      OPENAI_MEDIUM_MODEL: "explicit-medium",
      ELIZA_CODE_API_KEY: "native-key",
      ELIZA_CODE_BASE_URL: "https://native.example.test/v1",
      ELIZA_CODE_MODEL_POWERFUL: "native-large",
      ELIZA_CODE_MODEL_FAST: "native-fast",
    };

    applyElizaCodeProviderEnv(env);

    expect(env.OPENAI_API_KEY).toBe("explicit-key");
    expect(env.OPENAI_BASE_URL).toBe("https://explicit.example.test/v1");
    expect(env.OPENAI_LARGE_MODEL).toBe("explicit-large");
    expect(env.OPENAI_SMALL_MODEL).toBe("explicit-small");
    expect(env.OPENAI_MEDIUM_MODEL).toBe("explicit-medium");
  });

  it("uses the authorized Cerebras contract and default compatible endpoint", () => {
    const env: Record<string, string | undefined> = {
      CEREBRAS_API_KEY: "cerebras-test-key",
      CEREBRAS_MODEL: "gpt-oss-120b",
    };

    applyElizaCodeProviderEnv(env);

    expect(env.OPENAI_API_KEY).toBe("cerebras-test-key");
    expect(env.OPENAI_BASE_URL).toBe("https://api.cerebras.ai/v1");
    expect(env.OPENAI_LARGE_MODEL).toBe("gpt-oss-120b");
    expect(resolveModelProvider(env)).toBe("openai");
  });

  it("preserves Cerebras small and large tiers instead of letting the legacy model override powerful", () => {
    const env: Record<string, string | undefined> = {
      CEREBRAS_API_KEY: "cerebras-test-key",
      CEREBRAS_MODEL: "legacy-small-model",
      CEREBRAS_SMALL_MODEL: "configured-fast-model",
      CEREBRAS_LARGE_MODEL: "configured-powerful-model",
    };

    applyElizaCodeProviderEnv(env);

    expect(env.OPENAI_LARGE_MODEL).toBe("configured-powerful-model");
    expect(env.OPENAI_SMALL_MODEL).toBe("configured-fast-model");
    expect(env.OPENAI_MEDIUM_MODEL).toBe("configured-fast-model");
  });

  it("normalizes provider-qualified Cerebras ids at the consumed provider seam", () => {
    const env: Record<string, string | undefined> = {
      CEREBRAS_API_KEY: "cerebras-test-key",
      ELIZA_CODE_MODEL_POWERFUL: "cerebras/gpt-oss-120b",
      OPENAI_SMALL_MODEL: "openai/gpt-oss-120b",
    };

    applyElizaCodeProviderEnv(env);

    expect(env.OPENAI_SMALL_MODEL).toBe("gpt-oss-120b");
    // OPENAI_LARGE_MODEL is the exact tier key consumed by plugin-openai's
    // TEXT_LARGE handler; this boundary must emit the wire id, not a routing
    // prefix that the Cerebras endpoint does not accept.
    expect(env.OPENAI_LARGE_MODEL).toBe("gpt-oss-120b");
  });

  it("preserves namespaced model ids for non-Cerebras compatible endpoints", () => {
    const env: Record<string, string | undefined> = {
      OPENAI_API_KEY: "explicit-key",
      OPENAI_BASE_URL: "https://router.example.test/v1",
      OPENAI_LARGE_MODEL: "vendor/custom-model",
    };

    applyElizaCodeProviderEnv(env);

    expect(env.OPENAI_LARGE_MODEL).toBe("vendor/custom-model");
  });

  it("keeps legacy in-house model aliases as read-only migration inputs", () => {
    const env: Record<string, string | undefined> = {
      ELIZA_CODE_API_KEY: "native-test-key",
      ELIZA_ELIZAOS_MODEL_POWERFUL: "legacy-power",
      ELIZA_ELIZAOS_MODEL_FAST: "legacy-fast",
    };

    applyElizaCodeProviderEnv(env);

    expect(env.OPENAI_LARGE_MODEL).toBe("legacy-power");
    expect(env.OPENAI_SMALL_MODEL).toBe("legacy-fast");
    expect(env.OPENAI_MEDIUM_MODEL).toBe("legacy-fast");
  });
});
