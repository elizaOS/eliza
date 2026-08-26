/** Resolves published AOSP model paths and voice bundle slugs from the shared catalog. */

import {
  buildHuggingFaceResolveUrlForPath,
  ELIZA_1_TIER_IDS,
  type Eliza1TierId,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  tierBundleSlug,
} from "@elizaos/shared/local-inference";

export type AospRecommendedModel = {
  id: string;
  ggufFile: string;
  url: string;
  expectedSizeBytes?: number;
};

const AOSP_EMBEDDING_TIER_ID = "eliza-1-4b" satisfies Eliza1TierId;

export function resolveRecommendedAospModel(
  role: "chat" | "embedding",
): AospRecommendedModel {
  const tierId =
    role === "chat" ? FIRST_RUN_DEFAULT_MODEL_ID : AOSP_EMBEDDING_TIER_ID;
  const model = findCatalogModel(tierId);
  if (model?.category !== "chat") {
    throw new Error(
      `[aosp-local-inference] Catalog is missing ${role} source tier ${tierId}.`,
    );
  }
  if (role === "chat") {
    const ggufFile = model.hfPathPrefix
      ? `${model.hfPathPrefix}/${model.ggufFile}`
      : model.ggufFile;
    return {
      id: model.id,
      ggufFile,
      url: buildHuggingFaceResolveUrlForPath(model, model.ggufFile),
    };
  }

  const ggufFile = `bundles/${tierBundleSlug(tierId)}/embedding/eliza-1-embedding.gguf`;
  return {
    id: "eliza-1-embedding",
    ggufFile,
    url: buildHuggingFaceResolveUrlForPath(
      { ...model, hfPathPrefix: undefined },
      ggufFile,
    ),
  };
}

// Derive the current HF bundle tier slug (e.g. "e2b") from a stable chat
// model id or architecture-slugged GGUF filename. The Kokoro voice URL is
// `bundles/<tier>/tts/kokoro/...`; the old `path.basename(bundleRoot)`
// derivation yielded "bundle" for the on-device `<files>/eliza-1/bundle`
// layout, while the retired size slug (`2b`) no longer names the published
// Gemma bundle (`e2b`). Defaults to the catalog's first-run bundle slug.
export function bundleSlugFromModelName(modelNameOrId: string): string {
  const lower = modelNameOrId.toLowerCase();
  for (const id of [...ELIZA_1_TIER_IDS].reverse()) {
    const stableSlug = id.slice("eliza-1-".length);
    const bundleSlug = tierBundleSlug(id);
    if (
      lower.includes(`eliza-1-${stableSlug}`) ||
      lower.includes(`eliza-1-${bundleSlug}`)
    ) {
      return bundleSlug;
    }
  }
  return tierBundleSlug(FIRST_RUN_DEFAULT_MODEL_ID);
}
