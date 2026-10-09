/** Supplies the published Workers AI BGE token rate to the normal pricing resolver. */
import type { PreparedPricingEntry } from "../types";

export function fetchCloudflareEmbeddingEntries(): PreparedPricingEntry[] {
  return ["bge-small-en-v1.5", "cloudflare/bge-small-en-v1.5"].flatMap((model) =>
    (["input", "output"] as const).map((chargeType) => ({
      billingSource: "cloudflare",
      provider: "cloudflare",
      model,
      productFamily: "embedding",
      chargeType,
      unit: "token",
      unitPrice: chargeType === "input" ? 0.0202 / 1_000_000 : 0,
      sourceKind: "cloudflare_public_snapshot",
      sourceUrl: "https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/",
      metadata: { verifiedOn: "2026-09-16", upstreamModel: "@cf/baai/bge-small-en-v1.5" },
    })),
  );
}
