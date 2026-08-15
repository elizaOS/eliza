import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import { detectRuntimeModel } from "./agent-model.ts";

function runtime(settings: Record<string, string | undefined> = {}) {
  return {
    character: {},
    plugins: [],
    getSetting: (key: string) => settings[key],
  } as unknown as AgentRuntime;
}

function directConfig(
  backend: string,
  primaryModel: string,
  env?: ElizaConfig["env"],
): ElizaConfig {
  return {
    serviceRouting: {
      llmText: { transport: "direct", backend, primaryModel },
    },
    ...(env ? { env } : {}),
  } as ElizaConfig;
}

describe("detectRuntimeModel effective direct-provider status", () => {
  it("reports the effective Cerebras small/response model over a stale route default", () => {
    const config = directConfig("cerebras", "gpt-oss-120b", {
      CEREBRAS_SMALL_MODEL: "gemma-4-31b",
    });
    expect(detectRuntimeModel(runtime(), config)).toBe("gemma-4-31b");
  });

  it("matches plugin-openai response-handler override precedence", () => {
    const config = directConfig("cerebras", "gpt-oss-120b", {
      CEREBRAS_SMALL_MODEL: "gemma-4-31b",
    });
    expect(
      detectRuntimeModel(
        runtime({ OPENAI_RESPONSE_HANDLER_MODEL: "zai-glm-4.7" }),
        config,
      ),
    ).toBe("zai-glm-4.7");
  });

  it("reads the nested env.vars compatibility shape", () => {
    const config = directConfig("cerebras", "gpt-oss-120b", {
      vars: { CEREBRAS_SMALL_MODEL: "gemma-4-31b" },
    });
    expect(detectRuntimeModel(runtime(), config)).toBe("gemma-4-31b");
  });

  it("leaves non-Cerebras direct-provider behavior unchanged", () => {
    const config = directConfig("openai", "gpt-5.6-luna", {
      CEREBRAS_SMALL_MODEL: "inactive-cerebras-model",
    });
    expect(detectRuntimeModel(runtime(), config)).toBe("gpt-5.6-luna");
  });
});
