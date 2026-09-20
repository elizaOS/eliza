/**
 * Counts real HTTP attempts through AgentRuntime and the actual OpenAI adapter.
 * Exhausted server retries must not restart through aliases of the same model;
 * distinct models and later calls retain their independent retry budgets.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentRuntime, ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../packages/core/src/database/inMemoryAdapter";
import { installRouterHandler } from "../../plugin-local-inference/src/services/router-handler";
import {
  handleResponseHandler,
  handleTextLarge,
  handleTextMedium,
  handleTextNano,
  handleTextSmall,
} from "../models/text";

vi.mock("../../plugin-local-inference/src/services/routing-preferences", () => ({
  DEFAULT_ROUTING_POLICY: "cloud-only",
  readRoutingPreferences: async () => ({
    policy: { TEXT_SMALL: "cloud-only", TEXT_LARGE: "cloud-only" },
    preferredProvider: {},
  }),
}));
vi.mock("../../plugin-local-inference/src/services/assignments", () => ({
  readEffectiveAssignments: async () => ({}),
}));

let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve()))
    );
    server = undefined;
  }
});

async function fixture(alternative = false, router = false, status = 503) {
  const models: string[] = [];
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    models.push(payload.model);
    response.setHeader("Content-Type", "application/json");
    if (payload.model !== "healthy-model") {
      response.writeHead(status);
      response.end(
        JSON.stringify({ error: { message: "Fixture server unavailable", type: "server_error" } })
      );
      return;
    }
    response.end(
      JSON.stringify({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: payload.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "Recovered" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  for (const [key, value] of Object.entries({
    OPENAI_API_KEY: "fixture-key",
    OPENAI_BASE_URL: baseURL,
    CEREBRAS_API_KEY: "",
    ELIZA_PROVIDER: "openai",
    ELIZA_BRAIN_PROVIDER: "",
    OPENROUTER_API_KEY: "",
    ELIZA_TRAJECTORY_LOGGING: "0",
    ELIZA_TRAJECTORY_STRICT: "0",
  }))
    vi.stubEnv(key, value);
  const runtime = new AgentRuntime({
    character: {
      name: "RetryFixture",
      settings: {
        OPENAI_API_KEY: "fixture-key",
        OPENAI_BASE_URL: baseURL,
        OPENAI_SMALL_MODEL: "failed-model",
        OPENAI_NANO_MODEL: "failed-model",
        OPENAI_MEDIUM_MODEL: "failed-model",
        OPENAI_RESPONSE_HANDLER_MODEL: "failed-model",
        OPENAI_LARGE_MODEL: alternative ? "healthy-model" : "failed-model",
      },
    },
    adapter: new InMemoryDatabaseAdapter(),
    logLevel: "fatal",
  });
  runtime.registerModel(ModelType.RESPONSE_HANDLER, handleResponseHandler, "openai", 100);
  runtime.registerModel(ModelType.TEXT_NANO, handleTextNano, "openai", 100);
  runtime.registerModel(ModelType.TEXT_SMALL, handleTextSmall, "openai", 100);
  runtime.registerModel(ModelType.TEXT_MEDIUM, handleTextMedium, "openai", 100);
  runtime.registerModel(ModelType.TEXT_LARGE, handleTextLarge, "openai", 100);
  if (router)
    installRouterHandler(runtime, {
      skipSlots: ["TEXT_EMBEDDING", "TEXT_TO_SPEECH", "TRANSCRIPTION"],
    });
  return { runtime, models };
}

describe("concrete model retry budget", () => {
  it.each([408, 429])("shares exhausted HTTP %s budget across model tiers", async (status) => {
    const { runtime, models } = await fixture(false, false, status);
    await expect(
      runtime.useModel(ModelType.RESPONSE_HANDLER, {
        prompt: "Original complete request",
        stream: false,
      })
    ).rejects.toThrow("Fixture server unavailable");
    expect(models).toEqual(Array(4).fill("failed-model"));
  });

  it("preserves the budget through router stream-owner parameter copies", async () => {
    const { runtime, models } = await fixture(false, true);
    const call = async () => {
      const result = await runtime.useModel(ModelType.RESPONSE_HANDLER, {
        prompt: "Original complete request",
        stream: true,
        onStreamChunk: () => undefined,
      });
      if (typeof result !== "string")
        for await (const _ of result.textStream) {
          /* consume */
        }
    };
    await expect(call()).rejects.toThrow("Fixture server unavailable");
    expect(models).toEqual(Array(6).fill("failed-model"));
  });

  it.each(
    [503, 429].flatMap((status) =>
      ["generate", "live", "buffered"].map((mode) => ({ status, mode }))
    )
  )("shares exhausted $status budget across tiers: $mode", async ({ status, mode }) => {
    const { runtime, models } = await fixture(false, false, status);
    vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", mode === "buffered" ? "1" : "0");
    const call = async () => {
      const result = await runtime.useModel(ModelType.RESPONSE_HANDLER, {
        prompt: "Original complete request",
        stream: mode !== "generate",
      });
      if (typeof result !== "string")
        for await (const _ of result.textStream) {
          /* consume the real failure */
        }
    };
    await expect(call()).rejects.toThrow("Fixture server unavailable");
    expect(models).toEqual(Array(mode === "generate" ? 4 : 6).fill("failed-model"));
  });

  it.each([503, 429])(
    "retains a different model fallback and a new call budget after %s",
    async (status) => {
      const { runtime, models } = await fixture(true, false, status);
      for (let i = 0; i < 2; i++) {
        await expect(
          runtime.useModel(ModelType.RESPONSE_HANDLER, {
            prompt: "Original complete request",
            stream: false,
          })
        ).resolves.toBe("Recovered");
      }
      expect(models).toEqual([
        ...Array(4).fill("failed-model"),
        "healthy-model",
        ...Array(4).fill("failed-model"),
        "healthy-model",
      ]);
    }
  );
});
