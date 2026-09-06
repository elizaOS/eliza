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

function openAiConfig(): ElizaConfig {
  return {
    serviceRouting: {
      llmText: { transport: "direct", backend: "openai" },
    },
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
    reportError: vi.fn(),
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
  it.each([
    ["canonical", VAULT_REF],
    ["whitespace-padded", ` ${VAULT_REF} `],
  ])(
    "does not hydrate or project an unresolved provider vault reference (%s)",
    (_label, credential) => {
      const config = cerebrasConfig(credential);
      const env: NodeJS.ProcessEnv = {};

      hydrateConfigEnvForBoot(config, env);
      const settings = buildRuntimeSettingsProjection(config, { env });

      expect(env.CEREBRAS_API_KEY).toBeUndefined();
      expect(settings.CEREBRAS_API_KEY).toBeUndefined();
      expect(resolveActiveChat(config, env, runtimeWith({}))).toBeNull();
    },
  );

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

  it("reports a throwing settings lookup inside the cerebras-mode gate without falling back to an env key", () => {
    // `CEREBRAS_API_KEY` is first read by `isCerebrasMode` through the
    // cerebras-mode gate, so the throw is reported from that catch and the
    // credential loop below it is never reached. The two cases that follow
    // pin the loop and the registration lookup on a path with no such gate.
    const runtime = runtimeWith({ throwOnSetting: "CEREBRAS_API_KEY" });
    expect(
      resolveActiveChat(
        cerebrasConfig(),
        { CEREBRAS_API_KEY: "deterministic-env-credential" },
        runtime,
      ),
    ).toBeNull();
    expect(runtime.reportError).toHaveBeenCalledWith(
      "model-config.serving-truth",
      expect.objectContaining({ message: "lookup unavailable" }),
    );
  });

  it("reports a throwing credential lookup on the openai path, which has no cerebras-mode gate", () => {
    const runtime = {
      reportError: vi.fn(),
      getSetting: (key: string) => {
        if (key === "OPENAI_API_KEY") throw new Error("lookup unavailable");
        return null;
      },
      getModelRegistrations: () => [
        { modelType: ModelType.TEXT_SMALL, provider: "openai" },
      ],
    } as unknown as AgentRuntime;
    expect(
      resolveActiveChat(
        openAiConfig(),
        { OPENAI_API_KEY: "deterministic-env-credential" },
        runtime,
      ),
    ).toBeNull();
    expect(runtime.reportError).toHaveBeenCalledWith(
      "model-config.serving-truth",
      expect.objectContaining({ message: "lookup unavailable" }),
      { credentialKey: "OPENAI_API_KEY" },
    );
  });

  it("reports a throwing model-registration lookup instead of claiming a handler", () => {
    const runtime = {
      reportError: vi.fn(),
      getSetting: () => "deterministic-credential",
      getModelRegistrations: () => {
        throw new Error("registrations unavailable");
      },
    } as unknown as AgentRuntime;
    expect(resolveActiveChat(openAiConfig(), {}, runtime)).toBeNull();
    expect(runtime.reportError).toHaveBeenCalledWith(
      "model-config.serving-truth",
      expect.objectContaining({ message: "registrations unavailable" }),
    );
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
