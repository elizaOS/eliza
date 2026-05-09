import { applyPluginAutoEnable } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_PROVIDER_MAP } from "../auth/types";
import { evmAutoEnableReasonFromCapability } from "../services/evm-signing-capability";
import type { ElizaConfig } from "./types.eliza";

// Tests the agent-layer wiring of @elizaos/shared's plugin auto-enable engine:
// the engine itself lives in shared and is dependency-injected with the
// agent-specific SUBSCRIPTION_PROVIDER_MAP and EVM-capability resolver.
describe("applyPluginAutoEnable subscription providers (agent wiring)", () => {
  it("enables the Codex CLI model provider for Codex subscriptions", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            subscriptionProvider: "openai-codex",
          },
        },
      } as Partial<ElizaConfig>,
      env: {},
      subscriptionProviderMap: SUBSCRIPTION_PROVIDER_MAP,
      evmAutoEnableReason: evmAutoEnableReasonFromCapability,
    });

    expect(result.config.plugins?.allow ?? []).toContain(
      "@elizaos/plugin-codex-cli",
    );
    expect(result.config.plugins?.allow ?? []).not.toContain(
      "@elizaos/plugin-openai",
    );
    expect(result.config.plugins?.entries?.["codex-cli"]?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.openai?.enabled).not.toBe(true);
  });

  it("still enables the direct OpenAI plugin when a real API key exists", () => {
    const result = applyPluginAutoEnable({
      config: {} as Partial<ElizaConfig>,
      env: {
        OPENAI_API_KEY: "sk-direct-openai-key",
      } as NodeJS.ProcessEnv,
      subscriptionProviderMap: SUBSCRIPTION_PROVIDER_MAP,
      evmAutoEnableReason: evmAutoEnableReasonFromCapability,
    });

    expect(result.config.plugins?.allow ?? []).toContain(
      "@elizaos/plugin-openai",
    );
  });
});
