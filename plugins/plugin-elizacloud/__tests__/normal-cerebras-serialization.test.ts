import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDevCloudEnvAuthorityForTests } from "../src/cloud-config/dev-cloud-env-authority";
import { handleResponseHandler } from "../src/models/text";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetDevCloudEnvAuthorityForTests();
});

describe("normal Cloud Cerebras request serialization", () => {
  async function request(
    options: {
      canonical?: boolean;
      selected?: boolean;
      tools?: boolean;
      staging?: boolean;
      stagingOptIn?: boolean;
      mobileKey?: boolean;
    } = {}
  ) {
    const settings: Record<string, string> = {
      ELIZAOS_CLOUD_API_KEY: options.mobileKey ? "eliza_mobile_synthetic" : "synthetic-test-key",
      ELIZAOS_CLOUD_BASE_URL:
        options.canonical === false
          ? "https://custom.example/api/v1"
          : options.staging
            ? "https://api-staging.eliza.app/api/v1"
            : "https://api.eliza.app/api/v1",
      ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL: "qwen-3.8-27b",
    };
    if (options.stagingOptIn) {
      vi.stubEnv("ELIZA_DEV_SOURCE", "1");
      vi.stubEnv("ELIZA_DEV_CLOUD_ENV_AUTHORITY", "staging-explicit");
      vi.stubEnv("ELIZAOS_CLOUD_API_KEY", settings.ELIZAOS_CLOUD_API_KEY);
    }
    const runtime = {
      character: { name: "Serialization test", bio: [] },
      getSetting: (key: string) => settings[key],
      getModel: (type: string) =>
        options.selected !== false && type === "RESPONSE_HANDLER"
          ? handleResponseHandler
          : undefined,
      emitEvent: vi.fn(),
    } as unknown as IAgentRuntime;
    const requests: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        choices: [
          { message: { role: "assistant", content: '{"text":"ok"}' }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    await handleResponseHandler(runtime, {
      messages: [{ role: "user", content: "Return ok" }],
      stream: false,
      ...(options.tools
        ? {
            tools: [
              {
                type: "function",
                function: {
                  name: "bounded",
                  strict: true,
                  parameters: {
                    type: "object",
                    properties: { text: { type: "string", minLength: 1 } },
                    required: ["text"],
                    additionalProperties: false,
                  },
                },
              },
              {
                type: "function",
                function: {
                  name: "plain",
                  strict: true,
                  parameters: { type: "object", properties: {}, additionalProperties: false },
                },
              },
            ],
          }
        : {
            responseSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false,
            },
          }),
    } as never);
    expect(requests).toHaveLength(1);
    return requests[0];
  }
  it("uses one non-strict tool batch without removing schemas", async () => {
    const sent = await request({ tools: true });
    const tools = sent.tools as Array<{ function: { strict: boolean; parameters: unknown } }>;
    expect(tools.map((tool) => tool.function.strict)).toEqual([false, false]);
    expect(tools[0].function.parameters).toMatchObject({ properties: { text: { minLength: 1 } } });
  });
  it("preserves schemas with a non-strict tool batch on the opted-in staging mobile route", async () => {
    const sent = await request({ tools: true, staging: true, stagingOptIn: true, mobileKey: true });
    const tools = sent.tools as Array<{ function: { strict: boolean; parameters: unknown } }>;
    expect(tools.map((tool) => tool.function.strict)).toEqual([false, false]);
    expect(tools[0].function.parameters).toMatchObject({ properties: { text: { minLength: 1 } } });
  });
  it.each([
    { staging: true, mobileKey: true },
    { staging: true, stagingOptIn: true },
  ])("keeps staging tool strictness outside the mobile opt-in route (%j)", async (options) => {
    const sent = await request({ ...options, tools: true });
    expect(
      (sent.tools as Array<{ function: { strict: boolean } }>).map((tool) => tool.function.strict)
    ).toEqual([true, true]);
  });
  it("does not choose the special contract from model name on a custom endpoint", async () => {
    const sent = await request({ canonical: false, tools: true });
    expect(
      (sent.tools as Array<{ function: { strict: boolean } }>).map((tool) => tool.function.strict)
    ).toEqual([true, true]);
  });
  it("does not choose the special contract when this provider is not selected", async () => {
    const sent = await request({ selected: false, tools: true });
    expect(
      (sent.tools as Array<{ function: { strict: boolean } }>).map((tool) => tool.function.strict)
    ).toEqual([true, true]);
  });
  it("uses JSON-object output for a schema-only request on the selected normal route", async () => {
    expect((await request()).response_format).toEqual({ type: "json_object" });
  });
});
