import { afterEach, expect, spyOn, test } from "bun:test";
import { generateText } from "ai";
import { isAllowedChatModel } from "../eliza/config";
import {
  FALLBACK_TEXT_SELECTOR_MODELS,
  isLegacyMiniMaxTextModel,
  mergeCatalogModels,
  STATIC_TEXT_CATALOG_MODELS,
} from "../models/catalog";
import { AGENT_EDITING_TIERS, MODEL_TIERS, resolveModel } from "../models/model-tiers";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import { getLanguageModel } from "./language-model";
import { OpenRouterProvider } from "./openrouter";

const flash = "minimax/minimax-m3.1-flash:free";
const m3 = "minimax/minimax-m3";
const legacy = "minimax/minimax-m2.7";
const custom = "minimax/custom-deployment";
const calls: { url: string; body: Record<string, unknown> }[] = [];
let transport: { mockRestore(): void } | undefined;

afterEach(() => {
  transport?.mockRestore();
  calls.length = 0;
});

function interceptTransport() {
  transport = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-minimax-test-key");
    const body = (await request.json()) as Record<string, unknown>;
    calls.push({ url: request.url, body });
    return Response.json({
      id: "offline-completion",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
  });
}

test("the fast tier reaches the real SDK serializer with the free Flash route", async () => {
  interceptTransport();
  expect(MODEL_TIERS.fast.modelId).toBe(flash);
  expect(MODEL_TIERS.fast.pricing).toEqual({ inputPer1k: 0, outputPer1k: 0, currency: "USD" });
  expect(MODEL_TIERS.fast.contextWindow).toBe(1000000);
  expect(AGENT_EDITING_TIERS.fast.modelId).toBe(flash);
  await runWithCloudBindings({ OPENROUTER_API_KEY: "synthetic-minimax-test-key" }, async () => {
    const result = await generateText({
      model: getLanguageModel(resolveModel("fast").modelId),
      prompt: "Reply ok.",
      maxOutputTokens: 32,
      maxRetries: 0,
    });
    expect(result.text).toBe("ok");
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].body.model).toBe(flash);
  expect(calls[0].body).not.toHaveProperty("reasoning_effort");
  expect(calls[0].body).not.toHaveProperty("thinking");
  expect(calls[0].body).not.toHaveProperty("service_tier");
});

test("SDK serialization preserves an explicit supported reasoning effort", async () => {
  interceptTransport();
  await runWithCloudBindings({ OPENROUTER_API_KEY: "synthetic-minimax-test-key" }, async () => {
    await generateText({
      model: getLanguageModel(flash),
      prompt: "Reply ok.",
      providerOptions: { openai: { reasoningEffort: "high" } },
      maxRetries: 0,
    });
  });
  expect(calls[0].body.model).toBe(flash);
  expect(calls[0].body.reasoning_effort).toBe("high");
});

test("SDK selection preserves M3, saved legacy and custom IDs", async () => {
  interceptTransport();
  await runWithCloudBindings({ OPENROUTER_API_KEY: "synthetic-minimax-test-key" }, async () => {
    for (const model of [m3, legacy, custom]) {
      await generateText({
        model: getLanguageModel(resolveModel(model).modelId),
        prompt: "Reply ok.",
        maxRetries: 0,
      });
      expect(calls.at(-1)?.body.model).toBe(model);
    }
  });
  expect(isAllowedChatModel(legacy)).toBe(true);
});

test("HTTP forwarding preserves multimodal content, tools and gateway reasoning", async () => {
  interceptTransport();
  const provider = new OpenRouterProvider("synthetic-minimax-test-key");
  const messages = [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Describe this image." },
        { type: "image_url" as const, image_url: { url: "https://example.com/image.png" } },
      ],
    },
  ];
  const tools = [
    {
      type: "function" as const,
      function: { name: "lookup", parameters: { type: "object", properties: {} } },
    },
  ];
  for (const model of [flash, m3, legacy, custom]) {
    const request = {
      model,
      messages,
      tools,
      reasoning: { effort: "high" },
      stream: false,
    };
    const response = await provider.chatCompletions(request);
    expect(response.status).toBe(200);
    expect(calls.at(-1)?.body).toEqual({
      model,
      messages,
      tools,
      reasoning: { effort: "high" },
      stream: false,
    });
  }
});

test("new choices are Flash then M3 while live metadata and non-text models survive", () => {
  expect(
    FALLBACK_TEXT_SELECTOR_MODELS.filter((model) => model.modelId.startsWith("minimax/")).map(
      (model) => model.modelId,
    ),
  ).toEqual([flash, m3]);
  const metadata = {
    id: legacy,
    owned_by: "minimax",
    type: "language",
    pricing: { prompt: "0.0000003" },
  };
  const merged = mergeCatalogModels([metadata], STATIC_TEXT_CATALOG_MODELS);
  expect(merged.find((model) => model.id === legacy)?.pricing).toEqual(metadata.pricing);
  expect(isLegacyMiniMaxTextModel(metadata)).toBe(true);
  for (const type of ["image", "video", "audio", "embedding"]) {
    expect(isLegacyMiniMaxTextModel({ ...metadata, type })).toBe(false);
  }
  expect(
    isLegacyMiniMaxTextModel({
      ...metadata,
      type: undefined,
      architecture: { output_modalities: ["image"] },
    }),
  ).toBe(false);
  expect(isLegacyMiniMaxTextModel({ id: "openai/gpt-5", owned_by: "openai" })).toBe(false);
});
