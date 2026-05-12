import { describe, expect, test } from "bun:test";
import {
  canonicalUsageGroupingModel,
  expandOpenRouterModelIdCandidates,
  fromOpenRouterModelId,
  normalizeProviderKey,
  toOpenRouterModelId,
} from "@/lib/providers/model-id-translation";

describe("toOpenRouterModelId", () => {
  test("rewrites xai/ to x-ai/", () => {
    expect(toOpenRouterModelId("xai/grok-4")).toBe("x-ai/grok-4");
    expect(toOpenRouterModelId("xai/grok-4-fast-reasoning")).toBe("x-ai/grok-4-fast-reasoning");
  });

  test("rewrites mistral/ to mistralai/", () => {
    expect(toOpenRouterModelId("mistral/codestral")).toBe("mistralai/codestral");
    expect(toOpenRouterModelId("mistral/magistral-medium")).toBe("mistralai/magistral-medium");
  });

  test("passes through openai/, anthropic/, google/, groq/", () => {
    expect(toOpenRouterModelId("openai/gpt-5.4-mini")).toBe("openai/gpt-5.4-mini");
    expect(toOpenRouterModelId("anthropic/claude-opus-4.7")).toBe("anthropic/claude-opus-4.7");
    expect(toOpenRouterModelId("google/gemini-3-pro-preview")).toBe("google/gemini-3-pro-preview");
    expect(toOpenRouterModelId("groq/compound")).toBe("groq/compound");
  });

  test("passes through bare ids without slash", () => {
    expect(toOpenRouterModelId("gpt-5.4")).toBe("gpt-5.4");
  });

  test("does not rewrite when prefix already matches OpenRouter format", () => {
    expect(toOpenRouterModelId("x-ai/grok-4")).toBe("x-ai/grok-4");
    expect(toOpenRouterModelId("mistralai/codestral")).toBe("mistralai/codestral");
  });

  test("only rewrites the leading prefix, not occurrences inside the path", () => {
    expect(toOpenRouterModelId("openai/xai-named-model")).toBe("openai/xai-named-model");
  });

  test("handles empty string", () => {
    expect(toOpenRouterModelId("")).toBe("");
  });
});

describe("fromOpenRouterModelId", () => {
  test("rewrites x-ai/ back to xai/", () => {
    expect(fromOpenRouterModelId("x-ai/grok-4")).toBe("xai/grok-4");
  });

  test("rewrites mistralai/ back to mistral/", () => {
    expect(fromOpenRouterModelId("mistralai/codestral")).toBe("mistral/codestral");
  });

  test("passes through other prefixes", () => {
    expect(fromOpenRouterModelId("openai/gpt-5.4-mini")).toBe("openai/gpt-5.4-mini");
    expect(fromOpenRouterModelId("anthropic/claude-opus-4.7")).toBe("anthropic/claude-opus-4.7");
  });

  test("is the inverse of toOpenRouterModelId for round-trippable ids", () => {
    const ids = [
      "xai/grok-4",
      "mistral/codestral",
      "openai/gpt-5.4-mini",
      "anthropic/claude-opus-4.7",
    ];
    for (const id of ids) {
      expect(fromOpenRouterModelId(toOpenRouterModelId(id))).toBe(id);
    }
  });

  test("handles empty string and bare ids without slash", () => {
    expect(fromOpenRouterModelId("")).toBe("");
    expect(fromOpenRouterModelId("gpt-5.4")).toBe("gpt-5.4");
  });

  test("only rewrites the leading prefix, not occurrences inside the path", () => {
    expect(fromOpenRouterModelId("openai/x-ai-named")).toBe("openai/x-ai-named");
    expect(fromOpenRouterModelId("openai/mistralai-named")).toBe("openai/mistralai-named");
  });
});

describe("expandOpenRouterModelIdCandidates", () => {
  test("returns gateway and OpenRouter spelling for xai", () => {
    expect(expandOpenRouterModelIdCandidates("xai/grok-4")).toEqual(["xai/grok-4", "x-ai/grok-4"]);
    expect(expandOpenRouterModelIdCandidates("x-ai/grok-4")).toEqual(["x-ai/grok-4", "xai/grok-4"]);
  });

  test("returns gateway and OpenRouter spelling for mistral", () => {
    expect(expandOpenRouterModelIdCandidates("mistral/codestral")).toEqual([
      "mistral/codestral",
      "mistralai/codestral",
    ]);
    expect(expandOpenRouterModelIdCandidates("mistralai/codestral")).toEqual([
      "mistralai/codestral",
      "mistral/codestral",
    ]);
  });

  test("returns single entry for prefixes that share spelling", () => {
    expect(expandOpenRouterModelIdCandidates("openai/gpt-5.4-mini")).toEqual([
      "openai/gpt-5.4-mini",
    ]);
    expect(expandOpenRouterModelIdCandidates("anthropic/claude-opus-4.7")).toEqual([
      "anthropic/claude-opus-4.7",
    ]);
  });

  test("handles bare ids and blank strings", () => {
    expect(expandOpenRouterModelIdCandidates("gpt-5.4")).toEqual(["gpt-5.4"]);
    expect(expandOpenRouterModelIdCandidates("  xai/grok-4  ")).toEqual([
      "xai/grok-4",
      "x-ai/grok-4",
    ]);
    expect(expandOpenRouterModelIdCandidates("")).toEqual([]);
    expect(expandOpenRouterModelIdCandidates("   ")).toEqual([]);
  });
});

describe("normalizeProviderKey", () => {
  test("collapses OpenRouter prefix-derived keys to logical keys", () => {
    expect(normalizeProviderKey("x-ai")).toBe("xai");
    expect(normalizeProviderKey("mistralai")).toBe("mistral");
  });

  test("passes through other providers", () => {
    expect(normalizeProviderKey("openai")).toBe("openai");
    expect(normalizeProviderKey("anthropic")).toBe("anthropic");
    expect(normalizeProviderKey("google")).toBe("google");
    expect(normalizeProviderKey("groq")).toBe("groq");
    expect(normalizeProviderKey("xai")).toBe("xai");
    expect(normalizeProviderKey("mistral")).toBe("mistral");
  });
});

describe("canonicalUsageGroupingModel", () => {
  test("maps legacy and OpenRouter full ids to the same grouping key", () => {
    expect(canonicalUsageGroupingModel("xai/grok-4")).toBe("x-ai/grok-4");
    expect(canonicalUsageGroupingModel("x-ai/grok-4")).toBe("x-ai/grok-4");
    expect(canonicalUsageGroupingModel("mistral/codestral")).toBe("mistralai/codestral");
    expect(canonicalUsageGroupingModel("mistralai/codestral")).toBe("mistralai/codestral");
  });

  test("passes through suffix-only ids and null", () => {
    expect(canonicalUsageGroupingModel("grok-4")).toBe("grok-4");
    expect(canonicalUsageGroupingModel(null)).toBe("__null__");
    expect(canonicalUsageGroupingModel("")).toBe("__null__");
  });
});
