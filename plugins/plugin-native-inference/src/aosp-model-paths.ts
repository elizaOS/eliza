/** Resolves published AOSP model paths and voice bundle slugs from the shared catalog. */

import {
  buildHuggingFaceResolveUrlCandidatesForPath,
  ELIZA_1_TIER_IDS,
  type Eliza1TierId,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  type HfResolveUrlCandidate,
  tierBundleSlug,
} from "@elizaos/shared/local-inference";

export type AospRecommendedModel = {
  id: string;
  ggufFile: string;
  candidates: HfResolveUrlCandidate[];
  expectedSizeBytes?: number;
};

export type AospModelFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

function isTransientDownloadStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const AOSP_EMBEDDING_TIER_ID = "eliza-1-4b" satisfies Eliza1TierId;
const AOSP_CHAT_MODEL_SIZE_BYTES = 4_967_494_592;
const AOSP_EMBEDDING_MODEL_SIZE_BYTES = 639_150_592;

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
      candidates: buildHuggingFaceResolveUrlCandidatesForPath(
        model,
        model.ggufFile,
      ),
      expectedSizeBytes: AOSP_CHAT_MODEL_SIZE_BYTES,
    };
  }

  const ggufFile = `bundles/${tierBundleSlug(tierId)}/embedding/eliza-1-embedding.gguf`;
  return {
    id: "eliza-1-embedding",
    ggufFile,
    candidates: buildHuggingFaceResolveUrlCandidatesForPath(
      { ...model, hfPathPrefix: undefined },
      ggufFile,
    ),
    expectedSizeBytes: AOSP_EMBEDDING_MODEL_SIZE_BYTES,
  };
}

export function assertAospModelDownloadSize(
  model: AospRecommendedModel,
  actualSizeBytes: number,
): void {
  if (
    model.expectedSizeBytes !== undefined &&
    actualSizeBytes !== model.expectedSizeBytes
  ) {
    throw new Error(
      `[aosp-local-inference] Downloaded ${model.ggufFile} size ${actualSizeBytes} != expected ${model.expectedSizeBytes}.`,
    );
  }
}

export async function fetchRecommendedAospModel(
  model: AospRecommendedModel,
  fetchImpl: AospModelFetch = fetch,
): Promise<{ response: Response; candidate: HfResolveUrlCandidate }> {
  let lastError: unknown;
  for (let index = 0; index < model.candidates.length; index += 1) {
    const candidate = model.candidates[index];
    try {
      const response = await fetchImpl(candidate.url, {
        redirect: "follow",
        headers: candidate.authHeader,
      });
      if (
        isTransientDownloadStatus(response.status) &&
        index < model.candidates.length - 1
      ) {
        await response.body?.cancel();
        lastError = new Error(
          `HTTP ${response.status} from ${candidate.label ?? candidate.base}`,
        );
        continue;
      }
      return { response, candidate };
    } catch (error) {
      // error-policy:J2 ordered model-source failover records the failure and
      // rethrows it if every candidate fails; caller cancellation is not used
      // by this first-boot path.
      lastError = error;
      if (index === model.candidates.length - 1) throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`[aosp-local-inference] No download source for ${model.id}.`);
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
