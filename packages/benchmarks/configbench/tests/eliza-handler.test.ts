import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectConfigBenchProviderSettings,
  isCerebrasBaseUrl,
  isTextEmbeddingSetupFailure,
  loadModelProviderPlugin,
  normalizeConfigBenchProviderName,
  sendMessageAndWaitForResponseForTest,
} from "../src/handlers/eliza.js";

describe("Eliza handler setup helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("routes OpenAI-compatible provider labels through plugin-openai", () => {
    expect(normalizeConfigBenchProviderName("cerebras")).toBe("openai");
    expect(normalizeConfigBenchProviderName("openrouter")).toBe("openai");
    expect(normalizeConfigBenchProviderName("vllm")).toBe("openai");
    expect(normalizeConfigBenchProviderName("anthropic")).toBe("anthropic");
  });

  it("keeps configured embedding backends in OpenAI-compatible settings", () => {
    const settings = collectConfigBenchProviderSettings("cerebras", {
      OPENAI_API_KEY: "sk-chat",
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
      OPENAI_SMALL_MODEL: "gpt-oss-120b",
      OPENAI_LARGE_MODEL: "gpt-oss-120b",
      OPENAI_EMBEDDING_URL: "https://api.openai.com/v1",
      OPENAI_EMBEDDING_API_KEY: "sk-embedding",
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
      OPENAI_EMBEDDING_DIMENSIONS: "1536",
      CEREBRAS_API_KEY: "csk-chat",
    });

    expect(settings).toMatchObject({
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
      OPENAI_EMBEDDING_URL: "https://api.openai.com/v1",
      OPENAI_EMBEDDING_API_KEY: "sk-embedding",
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
      OPENAI_EMBEDDING_DIMENSIONS: "1536",
      CEREBRAS_API_KEY: "csk-chat",
    });
  });

  it("classifies embedding backend setup failures", () => {
    expect(isCerebrasBaseUrl("https://api.cerebras.ai/v1")).toBe(true);
    expect(
      isTextEmbeddingSetupFailure(
        new Error(
          "[local-inference] Active local backend does not implement TEXT_EMBEDDING",
        ),
      ),
    ).toBe(true);
    expect(isTextEmbeddingSetupFailure(new Error("planner parse failed"))).toBe(
      false,
    );
  });

  it("keeps plugin-openai TEXT_EMBEDDING for Cerebras fallback", async () => {
    vi.stubEnv("CONFIGBENCH_AGENT_PROVIDER", "cerebras");
    vi.stubEnv("CEREBRAS_API_KEY", "csk-test");
    vi.stubEnv("OPENAI_BASE_URL", "https://api.cerebras.ai/v1");

    const plugin = await loadModelProviderPlugin();

    expect(plugin?.name).toBe("openai");
    expect(plugin?.models).toHaveProperty("TEXT_EMBEDDING");
    expect(process.env.OPENAI_API_KEY).toBe("csk-test");
  });

  it("uses handleMessage responseContent when no callback response is emitted", async () => {
    const response = await sendMessageAndWaitForResponseForTest(
      {
        agentId: "00000000-0000-0000-0000-000000000001",
        messageService: {
          handleMessage: vi.fn(async () => ({
            responseContent: {
              text: "I've securely stored your OPENAI_API_KEY.",
              actions: ["SECRETS"],
            },
          })),
        },
      } as never,
      {
        id: "00000000-0000-0000-0000-000000000002",
        type: "dm",
      } as never,
      {
        id: "00000000-0000-0000-0000-000000000003",
      } as never,
      "Set my OPENAI_API_KEY to sk-test-abc123",
      100,
    );

    expect(response.text).toContain("OPENAI_API_KEY");
    expect(response.actions).toEqual(["SECRETS"]);
  });
});
