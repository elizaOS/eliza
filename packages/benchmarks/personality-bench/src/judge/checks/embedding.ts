/**
 * @fileoverview Embedding-similarity fallback layer.
 *
 * Many style/escalation rubrics also want a semantic signal — did the
 * post-directive response move in the predicted direction? This file exposes
 * a single async helper that computes cosine similarity between two texts via
 * an OpenAI-compatible embedding endpoint.
 *
 * If no embedder is configured (no key, no base URL), the layer returns a
 * NEEDS_REVIEW result with confidence 0 and a clear "skipped" reason, so the
 * verdict combiner can ignore it instead of blocking on a missing dependency.
 */

import type { LayerResult } from "../../types.ts";

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

async function embed(
  cfg: EmbeddingConfig,
  inputs: string[],
): Promise<number[][] | null> {
  if (!cfg.apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model: cfg.model, input: inputs }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as EmbeddingResponse;
    const vectors = json.data?.map((d) => d.embedding) ?? [];
    if (vectors.length !== inputs.length) return null;
    return vectors;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Check whether two responses are similar enough to count as "style held".
 *
 * `before` and `after` should be the pre-directive and post-directive
 * responses (the style is presumed set in between). The check expects the
 * cosine similarity to be in `[minSimilarity, maxSimilarity]` — the
 * acceptable band depends on the rubric and is supplied by the caller.
 */
export async function similarityWithinBand(
  cfg: EmbeddingConfig,
  before: string,
  after: string,
  band: { min: number; max: number },
): Promise<LayerResult> {
  const vectors = await embed(cfg, [before, after]);
  if (!vectors) {
    return {
      layer: "embedding",
      verdict: "NEEDS_REVIEW",
      confidence: 0,
      reason: "embedding endpoint unavailable — layer skipped",
    };
  }
  const beforeVec = vectors[0];
  const afterVec = vectors[1];
  if (!beforeVec || !afterVec) {
    return {
      layer: "embedding",
      verdict: "NEEDS_REVIEW",
      confidence: 0,
      reason: "embedding endpoint returned malformed payload",
    };
  }
  const similarity = cosineSimilarity(beforeVec, afterVec);
  const inBand = similarity >= band.min && similarity <= band.max;
  if (inBand) {
    return {
      layer: "embedding",
      verdict: "PASS",
      confidence: 0.7,
      reason: `similarity ${similarity.toFixed(3)} ∈ [${band.min}, ${band.max}]`,
      evidence: { similarity, band },
    };
  }
  return {
    layer: "embedding",
    verdict: "FAIL",
    confidence: 0.7,
    reason: `similarity ${similarity.toFixed(3)} ∉ [${band.min}, ${band.max}]`,
    evidence: { similarity, band },
  };
}
