/**
 * Deterministic serving-truth coverage for provider credentials at the boot,
 * runtime-settings, and model-config boundaries. No provider or network is
 * contacted; fake registrations model only whether a runtime can serve text.
 */
import { type AgentRuntime, ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import {
  buildRuntimeSettingsProjection,
  hydrateConfigEnvForBoot,
} from "../runtime/runtime-settings.ts";
import {
  handleModelConfigRoutes,
  resolveActiveChat,
} from "./model-config-routes.ts";

const VAULT_REF = "vault://providers.cerebras.api-key";

function cerebrasConfig(credential?: string): ElizaConfig {
  return {
    serviceRouting: {
      llmText: { transport: "direct", backend: "cerebras" },
    },
    ...(credential ? { env: { vars: { CEREBRAS_API_KEY: credential } } } : {}),
  } as unknown as ElizaConfig;
}

function runtimeWith(options: {
  credential?: string | null;
  openAiCredential?: string | null;
  baseUrl?: string | null;
  explicitProvider?: string | null;
  provider?: string;
  throwOnSetting?: string;
}): AgentRuntime {
  return {
    getSetting: (key: string) => {
      if (key === options.throwOnSetting) throw new Error("lookup unavailable");
      if (key === "CEREBRAS_API_KEY") return options.credential ?? null;
      if (key === "OPENAI_API_KEY") return options.openAiCredential ?? null;
      if (key === "OPENAI_BASE_URL") return options.baseUrl ?? null;
      if (key === "ELIZA_PROVIDER") return options.explicitProvider ?? null;
      return null;
    },
    getModelRegistrations: () => [
      {
        modelType: ModelType.TEXT_SMALL,
        provider: options.provider ?? "openai",
      },
    ],
  } as unknown as AgentRuntime;
}

describe("provider serving truth", () => {
  it("does not hydrate or project an unresolved provider vault reference", () => {
    const config = cerebrasConfig(VAULT_REF);
    const env: NodeJS.ProcessEnv = {};

    hydrateConfigEnvForBoot(config, env);
    const settings = buildRuntimeSettingsProjection(config, { env });

    expect(env.CEREBRAS_API_KEY).toBeUndefined();
    expect(settings.CEREBRAS_API_KEY).toBeUndefined();
    expect(resolveActiveChat(config, env, runtimeWith({}))).toBeNull();
  });

  it("does not report a registered provider without a usable credential", () => {
    expect(resolveActiveChat(cerebrasConfig(), {}, runtimeWith({}))).toBeNull();
  });

  it("omits activeChat from the HTTP response before runtime serving is ready", async () => {
    const json = vi.fn();
    await handleModelConfigRoutes({
      req: {} as never,
      res: {} as never,
      method: "GET",
      pathname: "/api/models/config",
      json,
      readJsonBody: vi.fn(),
      state: { config: cerebrasConfig(VAULT_REF) },
      saveElizaConfig: vi.fn(),
      runtimeOperationManager: {} as never,
      processEnv: {},
    });

    expect(json).toHaveBeenCalledOnce();
    expect(json.mock.calls[0]?.[1]).not.toHaveProperty("activeChat");
  });

  it("reports a provider only when its runtime handler and credential are usable", () => {
    expect(
      resolveActiveChat(
        cerebrasConfig(VAULT_REF),
        {},
        runtimeWith({ credential: "deterministic-test-credential" }),
      ),
    ).toEqual({
      provider: "cerebras",
      family: "OPENAI",
      endpoint: "api.cerebras.ai",
    });
  });

  it("accepts plugin-openai's usable Cerebras-mode OpenAI key fallback", () => {
    expect(
      resolveActiveChat(
        cerebrasConfig(),
        {},
        runtimeWith({
          openAiCredential: "deterministic-fallback-credential",
          explicitProvider: "cerebras",
        }),
      ),
    ).toMatchObject({ provider: "cerebras", family: "OPENAI" });
  });

  it("does not report Cerebras when plugin-openai resolves a non-Cerebras endpoint", () => {
    expect(
      resolveActiveChat(
        cerebrasConfig(),
        {},
        runtimeWith({
          credential: "deterministic-cerebras-credential",
          openAiCredential: "deterministic-openai-credential",
          baseUrl: "https://gateway.example/v1",
        }),
      ),
    ).toBeNull();
  });

  it("fails closed when runtime credential lookup throws despite an env key", () => {
    expect(
      resolveActiveChat(
        cerebrasConfig(),
        { CEREBRAS_API_KEY: "deterministic-env-credential" },
        runtimeWith({ throwOnSetting: "CEREBRAS_API_KEY" }),
      ),
    ).toBeNull();
  });

  it("does not let an env key override an authoritative runtime vault sentinel", () => {
    expect(
      resolveActiveChat(
        cerebrasConfig(),
        { CEREBRAS_API_KEY: "deterministic-env-credential" },
        runtimeWith({ credential: VAULT_REF }),
      ),
    ).toBeNull();
  });

  it("does not report a usable credential without the matching handler", () => {
    expect(
      resolveActiveChat(
        cerebrasConfig(),
        {},
        runtimeWith({
          credential: "deterministic-test-credential",
          provider: "anthropic",
        }),
      ),
    ).toBeNull();
  });
});
