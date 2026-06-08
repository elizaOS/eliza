import { describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { normalizeDirectCerebrasProviderConfig } from "./provider-config-normalization.ts";

function buildConfig(value: Record<string, unknown>): ElizaConfig {
  return value as unknown as ElizaConfig;
}

describe("provider runtime config", () => {
  it("normalizes direct Cerebras routing away from stale OpenAI model defaults", () => {
    const env = {
      CEREBRAS_API_KEY: "csk-test",
      OPENAI_SMALL_MODEL: "gpt-5.4-mini",
      OPENAI_LARGE_MODEL: "gpt-5",
    } as NodeJS.ProcessEnv;
    const config = buildConfig({
      env: {
        vars: {
          CEREBRAS_API_KEY: "csk-test",
          OPENAI_SMALL_MODEL: "gpt-5.4-mini",
          OPENAI_LARGE_MODEL: "gpt-5",
        },
      },
      serviceRouting: {
        llmText: {
          backend: "cerebras",
          transport: "direct",
          primaryModel: "gpt-oss-120b",
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "gpt-oss-120b",
          },
        },
      },
    });

    expect(normalizeDirectCerebrasProviderConfig(config, env)).toBe(true);
    expect(env.ELIZA_PROVIDER).toBe("cerebras");
    expect(env.CEREBRAS_BASE_URL).toBe("https://api.cerebras.ai/v1");
    expect(env.CEREBRAS_MODEL).toBe("gpt-oss-120b");
    expect(env.OPENAI_SMALL_MODEL).toBe("gpt-oss-120b");
    expect(env.OPENAI_LARGE_MODEL).toBe("gpt-oss-120b");
    expect(
      (config.env as { vars: Record<string, string> }).vars.OPENAI_SMALL_MODEL,
    ).toBe("gpt-oss-120b");
    expect(
      (config.env as { vars: Record<string, string> }).vars.OPENAI_LARGE_MODEL,
    ).toBe("gpt-oss-120b");
  });

  it("keeps explicit small and large Cerebras-compatible route models", () => {
    const env = {
      CEREBRAS_API_KEY: "csk-test",
      OPENAI_SMALL_MODEL: "gpt-5.4-mini",
      OPENAI_LARGE_MODEL: "gpt-5",
    } as NodeJS.ProcessEnv;
    const config = buildConfig({
      serviceRouting: {
        llmText: {
          backend: "cerebras",
          transport: "direct",
          primaryModel: "gpt-oss-120b",
          smallModel: "gpt-oss-120b",
          largeModel: "cerebras-large-test",
        },
      },
    });

    expect(normalizeDirectCerebrasProviderConfig(config, env)).toBe(true);
    expect(env.OPENAI_SMALL_MODEL).toBe("gpt-oss-120b");
    expect(env.OPENAI_LARGE_MODEL).toBe("cerebras-large-test");
    expect(env.CEREBRAS_MODEL).toBe("gpt-oss-120b");
  });
});
