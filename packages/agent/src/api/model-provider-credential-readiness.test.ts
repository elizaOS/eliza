/**
 * Adversarial contract coverage for direct-provider status and runtime
 * credential projection. The harness uses deterministic registrations and
 * placeholder values; it never reads a live credential or dispatches inference.
 */

import type http from "node:http";
import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import { buildRuntimeSettingsProjection } from "../runtime/runtime-settings.ts";
import { buildModelCatalog } from "./model-catalog.ts";
import { handleModelConfigRoutes } from "./model-config-routes.ts";

const cerebrasConfig = {
  serviceRouting: {
    llmText: {
      backend: "cerebras",
      transport: "direct",
      accountId: "cerebras",
    },
  },
} as ElizaConfig;

function runtimeWithCerebrasCredential(credential: string | undefined) {
  return {
    getModelRegistrations: () => [
      {
        modelType: ModelType.TEXT_SMALL,
        provider: "openai",
        priority: 0,
        registrationOrder: 1,
      },
    ],
    getSetting: (key: string) =>
      key === "CEREBRAS_API_KEY" ? credential : undefined,
  };
}

async function readModelConfig(credential: string | undefined) {
  const json = vi.fn();
  await handleModelConfigRoutes({
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "GET",
    pathname: "/api/models/config",
    json,
    readJsonBody: vi.fn(),
    state: {
      config: cerebrasConfig,
      runtime: runtimeWithCerebrasCredential(credential),
    },
    saveElizaConfig: vi.fn(),
    runtimeOperationManager: {} as never,
    catalog: buildModelCatalog({
      readFile: () => {
        throw new Error("ENOENT");
      },
      env: {},
    }),
    processEnv: {},
  } as never);
  const response = json.mock.calls[0]?.[1] as Record<string, unknown>;
  if (!response) throw new Error("model config route did not respond");
  return response;
}

describe("direct provider credential readiness", () => {
  it("omits active chat for an unresolved Vault sentinel", async () => {
    const response = await readModelConfig(
      "vault://providers.cerebras.api-key",
    );

    expect(response).not.toHaveProperty("activeChat");
  });

  it("omits active chat for an absent credential", async () => {
    const response = await readModelConfig(undefined);

    expect(response).not.toHaveProperty("activeChat");
  });

  it("preserves active chat for a usable credential with serving evidence", async () => {
    const response = await readModelConfig("csk-test-usable");

    expect(response.activeChat).toEqual({
      provider: "cerebras",
      family: "OPENAI",
      endpoint: "api.cerebras.ai",
    });
  });

  it("never projects an unresolved provider sentinel into runtime settings", () => {
    const settings = buildRuntimeSettingsProjection(
      {
        env: {
          CEREBRAS_API_KEY: "vault://providers.cerebras.api-key",
          vars: {
            OPENAI_API_KEY: "  vault://providers.openai.api-key  ",
          },
        },
      } as ElizaConfig,
      {
        env: {},
        providerCredentialsOverlay: {
          ANTHROPIC_API_KEY: "vault://providers.anthropic.api-key",
        },
      },
    );

    expect(settings.CEREBRAS_API_KEY).toBeUndefined();
    expect(settings.OPENAI_API_KEY).toBeUndefined();
    expect(settings.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
