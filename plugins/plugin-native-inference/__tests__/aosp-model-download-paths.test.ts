/**
 * Protects the Android downloader at the published-model boundary. A stable
 * tier id is not necessarily the current Hugging Face bundle directory.
 */

import { describe, expect, it } from "bun:test";
import {
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  tierBundleSlug,
} from "@elizaos/shared/local-inference";
import {
  assertAospModelDownloadSize,
  bundleSlugFromModelName,
  fetchRecommendedAospModel,
  resolveRecommendedAospModel,
} from "../src/aosp-model-paths.js";

describe("AOSP published model resolution", () => {
  it("resolves the first-run chat download through the shared catalog", () => {
    const catalogModel = findCatalogModel(FIRST_RUN_DEFAULT_MODEL_ID);
    expect(catalogModel).toBeDefined();
    if (!catalogModel) throw new Error("first-run catalog model is missing");

    const resolved = resolveRecommendedAospModel("chat");
    expect(resolved.id).toBe(catalogModel.id);
    expect(resolved.expectedSizeBytes).toBe(4_967_494_592);
    expect(resolved.candidates.at(-1)?.url).toContain("huggingface.co");
    expect(resolved.ggufFile).toBe(
      [catalogModel.hfPathPrefix, catalogModel.ggufFile]
        .filter(Boolean)
        .join("/"),
    );
  });

  it("maps stable ids and published filenames to the same voice bundle", () => {
    const catalogModel = findCatalogModel(FIRST_RUN_DEFAULT_MODEL_ID);
    expect(catalogModel).toBeDefined();
    if (!catalogModel) throw new Error("first-run catalog model is missing");

    const expected = tierBundleSlug(FIRST_RUN_DEFAULT_MODEL_ID);
    expect(bundleSlugFromModelName(catalogModel.id)).toBe(expected);
    expect(bundleSlugFromModelName(catalogModel.ggufFile)).toBe(expected);
    expect(bundleSlugFromModelName("unknown.gguf")).toBe(expected);
  });

  it("resolves the embedding download under the published architecture slug", () => {
    const resolved = resolveRecommendedAospModel("embedding");
    expect(resolved.expectedSizeBytes).toBe(639_150_592);
    expect(resolved.ggufFile).toContain(
      `bundles/${tierBundleSlug("eliza-1-4b")}/embedding/`,
    );
    expect(
      decodeURIComponent(
        new URL(resolved.candidates.at(-1)?.url ?? "").pathname,
      ),
    ).toContain(resolved.ggufFile);
  });

  it("rejects a partial 200 response before it can become the live model", () => {
    const model = resolveRecommendedAospModel("chat");
    expect(() => assertAospModelDownloadSize(model, 4_967_494_591)).toThrow(
      /size 4967494591 != expected 4967494592/,
    );
    expect(() =>
      assertAospModelDownloadSize(model, 4_967_494_592),
    ).not.toThrow();
  });

  it("forwards cloud authorization and falls through to direct HF", async () => {
    const controlledEnv = [
      "ELIZAOS_CLOUD_API_KEY",
      "ELIZA_HF_BASE_URLS",
      "ELIZA_HF_BASE_URL",
    ] as const;
    const originalEnv = Object.fromEntries(
      controlledEnv.map((name) => [name, process.env[name]]),
    );
    process.env.ELIZAOS_CLOUD_API_KEY = "cloud-key";
    delete process.env.ELIZA_HF_BASE_URLS;
    delete process.env.ELIZA_HF_BASE_URL;
    try {
      const model = resolveRecommendedAospModel("chat");
      const requests: Array<{ url: string; authorization?: string }> = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url,
          authorization: headers.get("authorization") ?? undefined,
        });
        if (requests.length === 1) {
          return new Response("temporarily unavailable", { status: 503 });
        }
        return new Response("model", { status: 200 });
      };

      const result = await fetchRecommendedAospModel(model, fetchImpl);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.authorization).toBe("Bearer cloud-key");
      expect(requests[1]?.authorization).toBeUndefined();
      expect(result.candidate.label).toBe("direct");
      expect(result.response.status).toBe(200);
    } finally {
      for (const name of controlledEnv) {
        const originalValue = originalEnv[name];
        if (originalValue === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = originalValue;
        }
      }
    }
  });
});
