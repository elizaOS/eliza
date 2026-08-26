/**
 * Protects the Android downloader at the published-model boundary. A stable
 * tier id is not necessarily the current Hugging Face bundle directory.
 */

import { describe, expect, it } from "bun:test";
import {
  buildHuggingFaceResolveUrlForPath,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  tierBundleSlug,
} from "@elizaos/shared/local-inference";
import {
  bundleSlugFromModelName,
  resolveRecommendedAospModel,
} from "../src/aosp-model-paths.js";

describe("AOSP published model resolution", () => {
  it("resolves the first-run chat download through the shared catalog", () => {
    const catalogModel = findCatalogModel(FIRST_RUN_DEFAULT_MODEL_ID);
    expect(catalogModel).toBeDefined();
    if (!catalogModel) throw new Error("first-run catalog model is missing");

    const resolved = resolveRecommendedAospModel("chat");
    expect(resolved.id).toBe(catalogModel.id);
    expect(resolved.url).toBe(
      buildHuggingFaceResolveUrlForPath(catalogModel, catalogModel.ggufFile),
    );
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
    expect(resolved.ggufFile).toContain(
      `bundles/${tierBundleSlug("eliza-1-4b")}/embedding/`,
    );
    expect(decodeURIComponent(new URL(resolved.url).pathname)).toContain(
      resolved.ggufFile,
    );
  });
});
