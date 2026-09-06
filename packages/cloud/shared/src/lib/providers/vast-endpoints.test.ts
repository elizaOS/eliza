/**
 * Exercises Vast routing configuration through its resolver and actual HTTP provider.
 * Local HTTP records dispatch; credentials and endpoint maps are synthetic.
 */
import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { getProviderForModelWithFallback, getVastProvider } from "./index";
import { resolveVastEndpointConfig, resolveVastFallbackModel } from "./vast-endpoints";

const model = "vast/eliza-1-27b";
const reader = (env: Record<string, string>) => (name: string) => env[name] ?? null;
const base = { VAST_API_KEY: "synthetic", VAST_BASE_URL: "https://global.example" };

describe("Vast configured routing maps", () => {
  test("rejects invalid configured maps with redacted actionable errors", () => {
    for (const raw of [
      '{"secret":"sensitive-audit-value",',
      "[]",
      "null",
      "42",
      '{"vast/eliza-1-27b":{}}',
      '{"vast/eliza-1-27b":{"baseURL":"https://typo.example"}}',
      '{"vast/eliza-1-27b":42}',
      '{"vast/eliza-1-27b":{"baseUrl":7}}',
    ]) {
      try {
        resolveVastEndpointConfig(model, reader({ ...base, VAST_ENDPOINTS_JSON: raw }));
        throw new Error("invalid configuration was accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(ElizaError);
        expect((error as ElizaError).code).toBe("INVALID_VAST_ROUTING_CONFIG");
        expect((error as Error).message).toContain("VAST_ENDPOINTS_JSON");
        expect(String((error as Error).cause)).not.toContain("sensitive-audit-value");
        expect(JSON.stringify(error)).not.toContain("sensitive-audit-value");
      }
    }
  });

  test("preserves absent maps, valid aliases and explicit model environment precedence", () => {
    expect(resolveVastEndpointConfig(model, reader(base))?.baseUrl).toBe(base.VAST_BASE_URL);
    expect(resolveVastEndpointConfig(model, reader({}))).toBeNull();
    expect(
      resolveVastEndpointConfig(model, reader({ ...base, VAST_ENDPOINTS_JSON: "" }))?.baseUrl,
    ).toBe(base.VAST_BASE_URL);
    expect(
      resolveVastEndpointConfig(model, reader({ ...base, VAST_ENDPOINTS_JSON: "  " }))?.baseUrl,
    ).toBe(base.VAST_BASE_URL);
    for (const config of [
      "https://dedicated.example/",
      { url: "https://dedicated.example/", apiKeyEnv: "DEDICATED_KEY", model: "served-model" },
    ]) {
      const result = resolveVastEndpointConfig(
        model,
        reader({
          ...base,
          DEDICATED_KEY: "dedicated",
          VAST_ENDPOINTS_JSON: JSON.stringify({ [model]: config }),
        }),
      );
      expect(result?.baseUrl).toBe("https://dedicated.example");
      expect(result?.source).toBe("json");
      if (typeof config !== "string") {
        expect(result?.apiKey).toBe("dedicated");
        expect(result?.apiModelId).toBe("served-model");
      }
    }
    expect(
      resolveVastEndpointConfig(
        model,
        reader({
          ...base,
          VAST_ENDPOINTS_JSON: "{invalid",
          VAST_BASE_URL_ELIZA_1_27B: "https://explicit.example",
        }),
      )?.baseUrl,
    ).toBe("https://explicit.example");
  });

  test("validates fallback maps separately from endpoint entries", () => {
    const env = {
      ...base,
      VAST_BASE_URL_ELIZA_1_9B: "https://nine.example",
      VAST_BASE_URL_ELIZA_1_2B: "https://two.example",
    };
    expect(resolveVastFallbackModel(model, reader(env))).toBe("vast/eliza-1-9b");
    expect(
      resolveVastFallbackModel(
        model,
        reader({
          ...env,
          VAST_FALLBACK_MODEL_MAP_JSON: JSON.stringify({ [model]: "vast/eliza-1-2b" }),
        }),
      ),
    ).toBe("vast/eliza-1-2b");
    for (const raw of [
      "{invalid",
      "[]",
      JSON.stringify({ [model]: { url: "https://invalid.example" } }),
    ]) {
      expect(() =>
        resolveVastFallbackModel(model, reader({ ...env, VAST_FALLBACK_MODEL_MAP_JSON: raw })),
      ).toThrow("VAST_FALLBACK_MODEL_MAP_JSON");
    }
  });
});

test("provider factory rejects malformed routing before dispatch and preserves valid HTTP requests", async () => {
  const calls: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      calls.push({ path: new URL(request.url).pathname, body: await request.json() });
      return Response.json({
        choices: [{ message: { role: "assistant", content: "local receipt" } }],
      });
    },
  });
  const keys = [
    "VAST_ENDPOINTS_JSON",
    "VAST_FALLBACK_MODEL_MAP_JSON",
    "VAST_BASE_URL",
    "VAST_API_KEY",
    "VAST_BASE_URL_ELIZA_1_27B",
    "VAST_ENDPOINT_URL_ELIZA_1_27B",
  ];
  const prior = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.VAST_ENDPOINTS_JSON = "{broken";
    process.env.VAST_BASE_URL = `http://127.0.0.1:${server.port}`;
    process.env.VAST_API_KEY = "synthetic-test-key";
    for (const raw of ["{broken", "{placeholder broken", "{your_model broken"]) {
      process.env.VAST_ENDPOINTS_JSON = raw;
      expect(() => getVastProvider(model)).toThrow("VAST_ENDPOINTS_JSON");
      expect(calls).toEqual([]);
    }
    process.env.VAST_ENDPOINTS_JSON = JSON.stringify({
      [model]: { url: process.env.VAST_BASE_URL, model: "your_placeholder_model" },
    });
    for (const raw of ["{placeholder broken", "{your_model broken"]) {
      process.env.VAST_FALLBACK_MODEL_MAP_JSON = raw;
      expect(() => getProviderForModelWithFallback(model)).toThrow("VAST_FALLBACK_MODEL_MAP_JSON");
      expect(calls).toEqual([]);
    }
    delete process.env.VAST_FALLBACK_MODEL_MAP_JSON;
    const messages = [{ role: "user" as const, content: "Complete routing request payload" }];
    const response = await getVastProvider(model).chatCompletions({
      model,
      messages,
      stream: false,
    });
    expect(await response.json()).toEqual({
      choices: [{ message: { role: "assistant", content: "local receipt" } }],
    });
    expect(calls).toEqual([
      {
        path: "/v1/chat/completions",
        body: { model: "your_placeholder_model", messages, stream: false },
      },
    ]);
  } finally {
    keys.forEach((key, index) => {
      if (prior[index] === undefined) delete process.env[key];
      else process.env[key] = prior[index];
    });
    server.stop(true);
  }
});
