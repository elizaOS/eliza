/**
 * Persisted direct routing reaches the real OpenAI-compatible handler through
 * AgentRuntime settings. The provider is a loopback HTTP server; model selection,
 * config loading, runtime lookup, and SDK serialization are production code.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { InMemoryDatabaseAdapter } from "@elizaos/testing/in-memory-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleActionPlanner,
  handleResponseHandler,
  handleTextLarge,
  handleTextMedium,
  handleTextMega,
  handleTextNano,
  handleTextSmall,
} from "../../../../plugins/plugin-openai/models/text.ts";
import { type ElizaConfig, loadElizaConfig } from "../config/config.ts";
import {
  createDevCloudConfigAuthorityView,
  DEV_CLOUD_ENV_AUTHORITY_KEY,
  resetDevCloudEnvAuthorityForTests,
} from "../config/dev-cloud-env-authority.ts";
import { createHotStrategy } from "./operations/reload-hot.ts";
import { buildRuntimeSettingsProjection } from "./runtime-settings.ts";

const route = {
  transport: "direct" as const,
  backend: "openrouter",
  nanoModel: "route/nano",
  smallModel: "route/small",
  mediumModel: "route/medium",
  largeModel: "route/large",
  megaModel: "route/mega",
  responseHandlerModel: "route/response-handler",
  shouldRespondModel: "route/legacy-response",
  actionPlannerModel: "route/action-planner",
  plannerModel: "route/legacy-planner",
  responseModel: "cloud-only/response",
  mediaDescriptionModel: "cloud-only/media",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetDevCloudEnvAuthorityForTests();
});

describe("direct model routing", () => {
  it.each(["openrouter", "cerebras"])(
    "sends persisted %s tiers and roles on the actual wire after each runtime rebuild",
    async (backend) => {
      const environmentBefore = { ...process.env };
      const models: string[] = [];
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            model: string;
          };
          models.push(body.model);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              id: "direct-routing-wire",
              object: "chat.completion",
              created: 1,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "ok" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            }),
          );
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const directory = mkdtempSync(join(tmpdir(), "direct-model-routing-"));
      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Missing loopback port");
        const originalFetch = globalThis.fetch;
        vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
          const url = new URL(
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url,
          );
          if (
            url.hostname !== "127.0.0.1" ||
            url.port !== String(address.port)
          ) {
            throw new Error(
              "Direct-routing test forbids external provider calls",
            );
          }
          return originalFetch(input, init);
        });
        vi.stubEnv("ELIZA_CONFIG_PATH", join(directory, "eliza.json"));
        vi.stubEnv("ELIZA_STATE_DIR", directory);
        vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", "");
        vi.stubEnv("ELIZA_DEV_SOURCE", "0");
        vi.stubEnv("ELIZA_MOCK_OPENAI_BASE", "");
        vi.stubEnv("OPENAI_SMALL_MODEL", "launch/small");
        vi.stubEnv("ELIZA_BRAIN_PROVIDER", "  ");
        writeFileSync(
          join(directory, "eliza.json"),
          JSON.stringify({
            serviceRouting: { llmText: { ...route, backend } },
          }),
        );
        for (const pass of ["cold boot", "replacement"]) {
          writeFileSync(
            join(directory, "eliza.json"),
            JSON.stringify({
              serviceRouting: { llmText: { ...route, backend } },
            }),
          );
          const config = loadElizaConfig();
          const adapter = new InMemoryDatabaseAdapter();
          const runtime = new AgentRuntime({
            character: { name: pass, bio: ["Direct routing wire regression"] },
            adapter,
            disableBasicCapabilities: true,
            settings: {
              ...buildRuntimeSettingsProjection(config),
              ELIZA_PROVIDER: backend,
              OPENAI_API_KEY: "synthetic-loopback-key",
              CEREBRAS_API_KEY: "synthetic-loopback-key",
              CEREBRAS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
              CEREBRAS_SMALL_MODEL: "legacy/cerebras-small",
              CEREBRAS_LARGE_MODEL: "legacy/cerebras-large",
              OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            },
            logLevel: "fatal",
          });
          try {
            await adapter.createAgents([
              {
                id: runtime.agentId,
                name: pass,
                settings: {
                  secrets: { OPENAI_SMALL_MODEL: "database/old-small" },
                },
                secrets: { OPENAI_SMALL_MODEL: "database/old-small" },
              },
            ]);
            await runtime.initialize({ skipMigrations: true });
            expect(runtime.character.secrets?.OPENAI_SMALL_MODEL).toBe(
              route.smallModel,
            );
            for (const [handler, expected] of [
              [handleTextNano, route.nanoModel],
              [handleTextSmall, route.smallModel],
              [handleTextMedium, route.mediumModel],
              [handleTextLarge, route.largeModel],
              [handleTextMega, route.megaModel],
              [handleResponseHandler, route.responseHandlerModel],
              [handleActionPlanner, route.actionPlannerModel],
            ] as const) {
              expect(
                await handler(runtime, { prompt: "Reply ok", stream: false }),
              ).toBe("ok");
              expect(models.at(-1)).toBe(expected);
            }
            if (backend === "openrouter") {
              if (!runtime.character.settings || !runtime.character.secrets)
                throw new Error("Missing initialized settings");
              runtime.character.settings.secrets = {
                ...runtime.character.settings.secrets,
                OPENAI_SMALL_MODEL: "newer/hidden-small",
              };
              runtime.character.secrets.OPENAI_LARGE_MODEL = "newer/large";
              const phases: string[] = [];
              expect(
                await createHotStrategy().apply({
                  runtime,
                  intent: { kind: "provider-switch", provider: backend },
                  reportPhase: async (phase) => {
                    phases.push(phase.status);
                  },
                }),
              ).toBe(runtime);
              expect(phases).not.toContain("failed");
              expect(
                await handleTextSmall(runtime, {
                  prompt: "Reply after reset",
                  stream: false,
                }),
              ).toBe("ok");
              expect(models.at(-1)).toBe("launch/small");
              expect(
                runtime.character.settings.secrets?.OPENAI_SMALL_MODEL,
              ).toBe("newer/hidden-small");
              expect(
                await handleTextLarge(runtime, {
                  prompt: "Reply with preserved override",
                  stream: false,
                }),
              ).toBe("ok");
              expect(models.at(-1)).toBe("newer/large");
            }
          } finally {
            await runtime.stop();
          }
        }
        expect(models).toHaveLength(backend === "openrouter" ? 18 : 14);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        rmSync(directory, { recursive: true, force: true });
        for (const key of Object.keys(process.env)) {
          if (!(key in environmentBefore)) delete process.env[key];
        }
        Object.assign(process.env, environmentBefore);
      }
    },
  );

  it("uses legacy role aliases only when canonical roles are absent and does not persist generated settings", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: {
          ...route,
          responseHandlerModel: undefined,
          actionPlannerModel: undefined,
        },
      },
    };
    const before = structuredClone(config);
    const env = { OPENAI_SMALL_MODEL: "launch/small" };
    const settings = buildRuntimeSettingsProjection(config, {
      env,
      brainProviderName: "openai",
    });
    expect(settings.OPENAI_RESPONSE_HANDLER_MODEL).toBe(
      route.shouldRespondModel,
    );
    expect(settings.OPENAI_ACTION_PLANNER_MODEL).toBe(route.plannerModel);
    expect(settings.OPENAI_SMALL_MODEL).toBe(route.smallModel);
    expect(
      buildRuntimeSettingsProjection(config, {
        env: { ELIZA_BRAIN_PROVIDER: "cli-inference" },
        brainProviderName: "openai",
      }).OPENAI_SMALL_MODEL,
    ).toBeUndefined();
    expect(config).toEqual(before);
    expect(env).toEqual({ OPENAI_SMALL_MODEL: "launch/small" });
    config.serviceRouting = {
      llmText: { transport: "direct", backend: "openrouter" },
    };
    expect(
      buildRuntimeSettingsProjection(config, {
        env,
        brainProviderName: "openai",
      }).OPENAI_SMALL_MODEL,
    ).toBeUndefined();
  });

  it.each(["cloud-proxy", "remote"] as const)(
    "does not reinterpret %s pins as direct-provider models",
    (transport) => {
      const settings = buildRuntimeSettingsProjection(
        { serviceRouting: { llmText: { ...route, transport } } },
        { brainProviderName: "openai" },
      );
      expect(settings.OPENAI_SMALL_MODEL).toBeUndefined();
      expect(settings.OPENAI_ACTION_PLANNER_MODEL).toBeUndefined();
    },
  );

  it("does not override another provider or an offline Cloud authority view", () => {
    expect(
      buildRuntimeSettingsProjection(
        { serviceRouting: { llmText: { ...route, backend: "anthropic" } } },
        { brainProviderName: "anthropic" },
      ).OPENAI_SMALL_MODEL,
    ).toBeUndefined();
    vi.stubEnv("ELIZA_DEV_SOURCE", "1");
    vi.stubEnv(DEV_CLOUD_ENV_AUTHORITY_KEY, "offline");
    resetDevCloudEnvAuthorityForTests();
    const view = createDevCloudConfigAuthorityView({
      serviceRouting: {
        llmText: {
          ...route,
          transport: "cloud-proxy" as const,
          backend: "elizacloud",
        },
      },
    });
    const settings = buildRuntimeSettingsProjection(view, {
      brainProviderName: "openai",
    });
    expect(settings.OPENAI_SMALL_MODEL).toBeUndefined();
    expect(settings.OPENAI_ACTION_PLANNER_MODEL).toBeUndefined();
  });
});
