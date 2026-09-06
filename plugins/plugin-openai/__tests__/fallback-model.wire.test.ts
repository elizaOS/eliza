/**
 * Operator fallback model at the HTTP boundary: a loopback provider rejects
 * the primary model with a long Retry-After and serves the fallback model.
 * After the first 429 the same runtime's next requests go to the fallback for
 * the cooldown window, without a hold error. Real HTTP fixture; no live model.
 */
import { createServer, type Server } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __INTERNAL_resolveFallbackModelName,
  __INTERNAL_selectRequestModelName,
  handleTextSmall,
} from "../models/text";

let server: Server;
let baseUrl: string;
let requestedModels: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const model = String((JSON.parse(body) as { model?: string }).model ?? "");
      requestedModels.push(model);
      if (model === "qwen-3.8-27b") {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
        response.end(JSON.stringify({ error: { message: "Tokens per minute limit exceeded" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-fallback",
          object: "chat.completion",
          created: 1,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "served by fallback" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

beforeEach(() => {
  requestedModels = [];
  vi.stubEnv("ELIZA_PROVIDER", "cerebras");
  vi.stubEnv("OPENAI_BASE_URL", baseUrl);
  vi.stubEnv("OPENAI_API_KEY", "loopback-only-key");
  vi.stubEnv("CEREBRAS_API_KEY", undefined);
  vi.stubEnv("ELIZA_MOCK_OPENAI_BASE", undefined);
  vi.stubEnv("ELIZA_TRAJECTORY_STRICT", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function runtime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
    character: { name: "Ada", system: "Reply to the user." },
    emitEvent: async () => {},
    getService: () => null,
    getServicesByType: () => [],
  } as unknown as IAgentRuntime;
}

describe("fallback model while the primary is rate limited", () => {
  it("serves the next requests with OPENAI_FALLBACK_MODEL after the primary's 429", async () => {
    // Live 2026-09-06 22:18: every slot pinned to qwen-3.8-27b, one 429 held
    // it for 60 s, the runtime's slot chain re-entered the same model and the
    // user got "Too many requests reached me at once".
    const agent = runtime({ OPENAI_FALLBACK_MODEL: "gemma-4-31b" });
    await expect(
      handleTextSmall(agent, { prompt: "first", model: "qwen-3.8-27b", stream: false })
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(requestedModels).toEqual(["qwen-3.8-27b"]);

    const second = await handleTextSmall(agent, {
      prompt: "second",
      model: "qwen-3.8-27b",
      stream: false,
    });
    expect(second).toBe("served by fallback");
    const third = await handleTextSmall(agent, {
      prompt: "third",
      model: "qwen-3.8-27b",
      stream: false,
    });
    expect(third).toBe("served by fallback");
    expect(requestedModels).toEqual(["qwen-3.8-27b", "gemma-4-31b", "gemma-4-31b"]);
  });

  it("keeps the hold error when no fallback is configured", async () => {
    const agent = runtime();
    await expect(
      handleTextSmall(agent, { prompt: "first", model: "qwen-3.8-27b", stream: false })
    ).rejects.toMatchObject({ statusCode: 429 });
    await expect(
      handleTextSmall(agent, { prompt: "second", model: "qwen-3.8-27b", stream: false })
    ).rejects.toMatchObject({ name: "ProviderRateLimitCooldownError" });
    expect(requestedModels).toEqual(["qwen-3.8-27b"]);
  });
});

describe("selectRequestModelName", () => {
  const cooling = (...models: string[]) =>
    new Map(models.map((model) => [model, Date.now() + 60_000] as const));

  it("uses the primary unless it is cooling down and a distinct fallback is free", () => {
    expect(__INTERNAL_selectRequestModelName(new Map(), "qwen", "gemma")).toBe("qwen");
    expect(__INTERNAL_selectRequestModelName(cooling("qwen"), "qwen", "gemma")).toBe("gemma");
    expect(__INTERNAL_selectRequestModelName(cooling("qwen", "gemma"), "qwen", "gemma")).toBe(
      "qwen"
    );
    expect(__INTERNAL_selectRequestModelName(cooling("qwen"), "qwen", undefined)).toBe("qwen");
  });

  it("ignores an unset or identical fallback setting", () => {
    expect(__INTERNAL_resolveFallbackModelName(runtime(), "qwen")).toBeUndefined();
    expect(
      __INTERNAL_resolveFallbackModelName(runtime({ OPENAI_FALLBACK_MODEL: " qwen " }), "qwen")
    ).toBeUndefined();
    expect(
      __INTERNAL_resolveFallbackModelName(runtime({ CEREBRAS_FALLBACK_MODEL: "gemma" }), "qwen")
    ).toBe("gemma");
  });
});
