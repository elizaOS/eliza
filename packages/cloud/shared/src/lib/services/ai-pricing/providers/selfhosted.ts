/** Platform-owned embedding tariffs are independent of external provider catalogs. */
import type { PreparedPricingEntry } from "../types";

export const SELF_HOSTED_EMBEDDING_PRICING_SOURCE_URL = "internal://selfhosted/embeddings-pricing";

export function fetchSelfHostedEmbeddingEntries(): PreparedPricingEntry[] {
  return ["bge-small-en-v1.5", "selfhosted/bge-small-en-v1.5"].flatMap((model) =>
    (["input", "output"] as const).map((chargeType) => ({
      billingSource: "selfhosted",
      provider: "selfhosted",
      model,
      productFamily: "embedding",
      chargeType,
      unit: "token",
      unitPrice: chargeType === "input" ? 0.000000005 : 0,
      priority: -1,
      sourceKind: "selfhosted_platform_snapshot",
      sourceUrl: SELF_HOSTED_EMBEDDING_PRICING_SOURCE_URL,
      metadata: {
        sourceNote:
          "Platform rate for the self-hosted TEI BGE-small-en-v1.5 sidecar: $0.005/1M input tokens covers platform serving infrastructure, not an upstream provider invoice.",
      },
    })),
  );
}
