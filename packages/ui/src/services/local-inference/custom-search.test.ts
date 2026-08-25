/**
 * Covers the custom model-search provider descriptors.
 *
 * Search is currently disabled for every provider, so the assertions here are
 * written as invariants rather than as a snapshot of that decision: a provider
 * that cannot be searched must carry an explanation, and a provider that cannot
 * be downloaded from must carry a reason on every result it wraps. Those hold
 * whether or not search is re-enabled later, so re-enabling it will not force a
 * rewrite of this suite — but shipping a disabled provider with no explanation
 * will fail.
 *
 * Pure descriptors — no network.
 */
import { describe, expect, it } from "vitest";
import {
  CUSTOM_MODEL_SEARCH_DISABLED_MESSAGE,
  DEFAULT_LOCAL_MODEL_SEARCH_PROVIDER_ID,
  getLocalModelSearchProvider,
  isLocalModelSearchProviderId,
  type LocalModelSearchProviderId,
  listLocalModelSearchProviders,
  searchLocalModelProvider,
  wrapLocalModelSearchResults,
} from "./custom-search.ts";
import type { CatalogModel } from "./types";

const model = (hfRepo: string) => ({ hfRepo, id: hfRepo }) as CatalogModel;
const ids = () =>
  listLocalModelSearchProviders().map((provider) => provider.id);

describe("provider registry", () => {
  it("lists at least one provider, each with usable labels", () => {
    const providers = listLocalModelSearchProviders();
    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      expect(provider.label.trim().length).toBeGreaterThan(0);
      expect(provider.shortLabel.trim().length).toBeGreaterThan(0);
      expect(provider.placeholder.trim().length).toBeGreaterThan(0);
    }
  });

  it("assigns a distinct id to every provider", () => {
    expect(new Set(ids()).size).toBe(ids().length);
  });

  it("does not hand out the live descriptors", () => {
    const first = listLocalModelSearchProviders()[0];
    if (first) first.label = "mutated";
    expect(listLocalModelSearchProviders()[0]?.label).not.toBe("mutated");
  });

  it("explains itself whenever search is unavailable", () => {
    // Invariant, not a snapshot: a provider may become searchable later, but a
    // provider that cannot be searched must say why.
    for (const provider of listLocalModelSearchProviders()) {
      if (!provider.searchSupported) {
        expect(provider.unavailableMessage?.trim().length ?? 0).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it("explains itself whenever download is unavailable", () => {
    for (const provider of listLocalModelSearchProviders()) {
      if (!provider.downloadSupported) {
        expect(
          provider.downloadUnsupportedReason?.trim().length ?? 0,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("exposes a default provider that actually exists", () => {
    expect(ids()).toContain(DEFAULT_LOCAL_MODEL_SEARCH_PROVIDER_ID);
  });
});

describe("isLocalModelSearchProviderId", () => {
  it("accepts every registered id", () => {
    for (const id of ids()) expect(isLocalModelSearchProviderId(id)).toBe(true);
  });

  it("rejects unknown ids", () => {
    for (const value of ["", "   ", "openai", "HuggingFace"]) {
      expect(isLocalModelSearchProviderId(value)).toBe(false);
    }
  });
});

describe("getLocalModelSearchProvider", () => {
  it("resolves each registered id to its own descriptor", () => {
    for (const id of ids()) {
      expect(getLocalModelSearchProvider(id).id).toBe(id);
    }
  });

  it("falls back to a real provider for an unknown id rather than returning undefined", () => {
    const fallback = getLocalModelSearchProvider(
      "nope" as LocalModelSearchProviderId,
    );
    expect(fallback).toBeDefined();
    expect(ids()).toContain(fallback.id);
  });
});

describe("wrapLocalModelSearchResults", () => {
  it("returns an empty list for no models", () => {
    expect(wrapLocalModelSearchResults("huggingface", [])).toEqual([]);
  });

  it("tags each result with the requesting provider", () => {
    const wrapped = wrapLocalModelSearchResults("modelscope", [
      model("org/repo"),
    ]);
    expect(wrapped[0]?.providerId).toBe("modelscope");
    expect(wrapped[0]?.model.hfRepo).toBe("org/repo");
  });

  it("builds a provider-specific external URL containing the repo", () => {
    const hf = wrapLocalModelSearchResults("huggingface", [
      model("org/repo"),
    ])[0];
    const ms = wrapLocalModelSearchResults("modelscope", [
      model("org/repo"),
    ])[0];
    expect(hf?.externalUrl).toContain("huggingface.co");
    expect(hf?.externalUrl).toContain("org/repo");
    expect(ms?.externalUrl).toContain("modelscope.cn");
    expect(ms?.externalUrl).toContain("org/repo");
    expect(hf?.externalUrl).not.toBe(ms?.externalUrl);
  });

  it("mirrors the provider's download support onto every result", () => {
    for (const id of ids()) {
      const provider = getLocalModelSearchProvider(id);
      const [wrapped] = wrapLocalModelSearchResults(id, [model("org/repo")]);
      expect(wrapped?.download.supported).toBe(provider.downloadSupported);
      if (!provider.downloadSupported) {
        // A blocked download must always carry a reason the UI can show.
        expect(wrapped?.download.reason?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it("wraps every model it is given", () => {
    const wrapped = wrapLocalModelSearchResults("huggingface", [
      model("a/one"),
      model("b/two"),
      model("c/three"),
    ]);
    expect(wrapped).toHaveLength(3);
  });
});

describe("searchLocalModelProvider", () => {
  it("returns the provider descriptor alongside its results", async () => {
    const response = await searchLocalModelProvider("huggingface", "llama");
    expect(response.provider.id).toBe("huggingface");
    expect(Array.isArray(response.results)).toBe(true);
  });

  it("surfaces the unavailable message when the provider cannot be searched", async () => {
    for (const id of ids()) {
      const response = await searchLocalModelProvider(id, "llama", 5);
      if (!response.provider.searchSupported) {
        expect(response.results).toEqual([]);
        expect(response.unavailableMessage).toBe(
          response.provider.unavailableMessage,
        );
      }
    }
  });

  it("uses the shared disabled message while search is off", async () => {
    const response = await searchLocalModelProvider("huggingface", "llama");
    if (!response.provider.searchSupported) {
      expect(response.unavailableMessage).toBe(
        CUSTOM_MODEL_SEARCH_DISABLED_MESSAGE,
      );
    }
  });

  it("falls back to a real provider for an unknown id", async () => {
    const response = await searchLocalModelProvider(
      "nope" as LocalModelSearchProviderId,
      "llama",
    );
    expect(ids()).toContain(response.provider.id);
  });
});
