/**
 * Backward compatibility coverage for gateway-style ↔ OpenRouter model ids
 * after PR #482 (`refactor: replace AI Gateway with OpenRouter`).
 *
 * Verifies that callers, saved settings, and persisted DB rows referencing
 * the old `xai/` and `mistral/` ids still resolve to the new `x-ai/` and
 * `mistralai/` catalog rows (and vice versa) at every lookup boundary.
 */

import { describe, expect, test } from "bun:test";
import { ALLOWED_CHAT_MODELS, isAllowedChatModel } from "@/lib/eliza/config";
import { getTierFromModelId, MODEL_TIERS } from "@/lib/models";
import { getProviderFromModel } from "@/lib/pricing";
import { expandPersistedPricingProviderKeys } from "@/lib/providers/model-id-translation";
import { expandPricingCatalogModelCandidates } from "@/lib/services/ai-pricing";
import { findOpenRouterCatalogModelById } from "@/lib/services/model-catalog";

describe("ALLOWED_CHAT_MODELS membership accepts both spellings", () => {
  test("OpenRouter ids in the curated list are accepted", () => {
    const xaiOpenRouter = ALLOWED_CHAT_MODELS.find((id) => id.startsWith("x-ai/"));
    expect(xaiOpenRouter).toBeDefined();
    expect(isAllowedChatModel(xaiOpenRouter as string)).toBe(true);
  });

  test("legacy xai/ ids resolve to allowlisted OpenRouter ids", () => {
    const xaiOpenRouter = ALLOWED_CHAT_MODELS.find((id) => id.startsWith("x-ai/"));
    expect(xaiOpenRouter).toBeDefined();
    const legacyId = xaiOpenRouter!.replace(/^x-ai\//, "xai/");
    expect(isAllowedChatModel(legacyId)).toBe(true);
  });

  test("legacy mistral/ ids resolve to allowlisted OpenRouter ids", () => {
    const mistralOpenRouter = ALLOWED_CHAT_MODELS.find((id) => id.startsWith("mistralai/"));
    expect(mistralOpenRouter).toBeDefined();
    const legacyId = mistralOpenRouter!.replace(/^mistralai\//, "mistral/");
    expect(isAllowedChatModel(legacyId)).toBe(true);
  });

  test("unknown ids are rejected", () => {
    expect(isAllowedChatModel("xai/grok-from-the-future-1.99")).toBe(false);
    expect(isAllowedChatModel("openai/not-a-real-model")).toBe(false);
  });
});

describe("getTierFromModelId accepts old and new spellings", () => {
  test("returns the same tier regardless of OpenRouter spelling", () => {
    for (const config of Object.values(MODEL_TIERS)) {
      const tierFromConfigured = getTierFromModelId(config.modelId);
      expect(tierFromConfigured).toBe(config.id);

      if (config.modelId.startsWith("xai/")) {
        const openrouter = config.modelId.replace(/^xai\//, "x-ai/");
        expect(getTierFromModelId(openrouter)).toBe(config.id);
      }
      if (config.modelId.startsWith("x-ai/")) {
        const legacy = config.modelId.replace(/^x-ai\//, "xai/");
        expect(getTierFromModelId(legacy)).toBe(config.id);
      }
      if (config.modelId.startsWith("mistral/")) {
        const openrouter = config.modelId.replace(/^mistral\//, "mistralai/");
        expect(getTierFromModelId(openrouter)).toBe(config.id);
      }
      if (config.modelId.startsWith("mistralai/")) {
        const legacy = config.modelId.replace(/^mistralai\//, "mistral/");
        expect(getTierFromModelId(legacy)).toBe(config.id);
      }
    }
  });

  test("returns null for unknown models", () => {
    expect(getTierFromModelId("xai/grok-from-the-future-1.99")).toBeNull();
  });
});

describe("getProviderFromModel normalizes OpenRouter prefixes", () => {
  test("collapses x-ai/ and mistralai/ to logical provider keys", () => {
    expect(getProviderFromModel("x-ai/grok-4")).toBe("xai");
    expect(getProviderFromModel("mistralai/codestral")).toBe("mistral");
  });

  test("preserves other providers", () => {
    expect(getProviderFromModel("openai/gpt-5.4")).toBe("openai");
    expect(getProviderFromModel("anthropic/claude-opus-4.7")).toBe("anthropic");
    expect(getProviderFromModel("google/gemini-3-flash")).toBe("google");
    expect(getProviderFromModel("xai/grok-4")).toBe("xai");
    expect(getProviderFromModel("mistral/codestral")).toBe("mistral");
  });
});

describe("expandPricingCatalogModelCandidates", () => {
  test("includes both spellings for xai", () => {
    const candidates = expandPricingCatalogModelCandidates("xai/grok-4");
    expect(candidates).toContain("xai/grok-4");
    expect(candidates).toContain("x-ai/grok-4");
  });

  test("includes both spellings for mistral", () => {
    const candidates = expandPricingCatalogModelCandidates("mistralai/codestral");
    expect(candidates).toContain("mistral/codestral");
    expect(candidates).toContain("mistralai/codestral");
  });

  test("expands legacy aliases and translates each to OpenRouter form", () => {
    // `xai/grok-3-beta` is mapped to `xai/grok-3` in PRICING_MODEL_ALIASES; both
    // gateway and OpenRouter spellings of the alias target should be tried so
    // pricing rows stored under either form resolve cleanly.
    const candidates = expandPricingCatalogModelCandidates("xai/grok-3-beta");
    expect(candidates).toContain("xai/grok-3-beta");
    expect(candidates).toContain("x-ai/grok-3-beta");
    expect(candidates).toContain("xai/grok-3");
    expect(candidates).toContain("x-ai/grok-3");
  });

  test("expands legacy aliases when caller already uses OpenRouter spelling", () => {
    const candidates = expandPricingCatalogModelCandidates("x-ai/grok-3-beta");
    expect(candidates).toContain("xai/grok-3-beta");
    expect(candidates).toContain("xai/grok-3");
    expect(candidates).toContain("x-ai/grok-3");
  });

  test("non-renamed providers are unaffected", () => {
    const candidates = expandPricingCatalogModelCandidates("openai/gpt-5.4-mini");
    expect(candidates).toEqual(["openai/gpt-5.4-mini"]);
  });

  test("OpenRouter model variants fall back to the base model for pricing", () => {
    const candidates = expandPricingCatalogModelCandidates("openai/gpt-oss-120b:nitro");
    expect(candidates[0]).toBe("openai/gpt-oss-120b:nitro");
    expect(candidates).toContain("openai/gpt-oss-120b");
  });
});

describe("findOpenRouterCatalogModelById", () => {
  test("matches either spelling against an OpenRouter-shaped catalog", () => {
    const fakeCatalog: Parameters<typeof findOpenRouterCatalogModelById>[0] = [
      { id: "x-ai/grok-4", object: "model" as const, created: 0, owned_by: "x-ai" },
      { id: "mistralai/codestral", object: "model" as const, created: 0, owned_by: "mistralai" },
    ];

    expect(findOpenRouterCatalogModelById(fakeCatalog, "xai/grok-4")?.id).toBe("x-ai/grok-4");
    expect(findOpenRouterCatalogModelById(fakeCatalog, "x-ai/grok-4")?.id).toBe("x-ai/grok-4");
    expect(findOpenRouterCatalogModelById(fakeCatalog, "mistral/codestral")?.id).toBe(
      "mistralai/codestral",
    );
    expect(findOpenRouterCatalogModelById(fakeCatalog, "mistralai/codestral")?.id).toBe(
      "mistralai/codestral",
    );
    expect(findOpenRouterCatalogModelById(fakeCatalog, "openai/gpt-5.4")).toBeNull();
  });
});

describe("expandPersistedPricingProviderKeys", () => {
  test("includes raw OpenRouter namespace keys for xai and mistral", () => {
    expect(expandPersistedPricingProviderKeys("xai")).toEqual(["xai", "x-ai"]);
    expect(expandPersistedPricingProviderKeys("x-ai")).toEqual(["xai", "x-ai"]);
    expect(expandPersistedPricingProviderKeys("mistral")).toEqual(["mistral", "mistralai"]);
    expect(expandPersistedPricingProviderKeys("mistralai")).toEqual(["mistral", "mistralai"]);
    expect(expandPersistedPricingProviderKeys("openai")).toEqual(["openai"]);
  });
});
