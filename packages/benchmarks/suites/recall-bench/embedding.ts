/**
 * recall-bench — a deterministic, secret-free text embedding (#9956).
 *
 * A recall benchmark must run in CI without API keys yet still exercise the REAL
 * semantic-recall path (`DocumentService` vector/hybrid search over a vector
 * index), and it must be reproducible so a metric change means a *pipeline*
 * regression, not embedding noise. A real model (OpenAI / a local transformer)
 * is neither deterministic-in-CI nor secret-free, so this provides a fixed,
 * principled stand-in.
 *
 * Design — a hashed bag-of-features over two signals, TF-weighted then L2
 * normalized so cosine ∈ [0,1]:
 *   1. **whole tokens** — lexical overlap (what BM25 / keyword also see).
 *   2. **character trigrams** of each token — a *subword* signal, so
 *      morphological variants ("configure" / "configuring" / "configuration")
 *      land near each other. This is the bit keyword/substring matching misses,
 *      and it is *why* the vector path can out-recall keyword on the labelled
 *      corpus — which is exactly what makes the fail-open degradation (vector →
 *      keyword) a measurable drop rather than a silent one.
 *
 * This is a pipeline-characterization embedding: the ABSOLUTE numbers are not
 * production recall quality, but they are stable, so regressions in ranking /
 * weights / the fail-open are caught. The README states this explicitly.
 */

export const RECALL_BENCH_EMBEDDING_DIM = 384;

/** Lowercase alphanumeric tokens (matches the core `tokenize` convention). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** FNV-1a → a stable non-negative bucket in [0, dim). */
function bucket(feature: string, dim: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < feature.length; i++) {
    h ^= feature.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % dim;
}

/** Character trigrams of a token, padded so short tokens still contribute. */
function trigrams(token: string): string[] {
  const padded = `^${token}$`;
  if (padded.length <= 3) return [padded];
  const out: string[] = [];
  for (let i = 0; i + 3 <= padded.length; i++) out.push(padded.slice(i, i + 3));
  return out;
}

/**
 * Embed text into a fixed-dimension unit vector. Deterministic: the same text
 * always yields the same vector. Whole-token features are weighted above
 * subword features so exact lexical overlap dominates, with subwords adding the
 * morphological similarity that separates the vector path from keyword.
 */
export function embedText(
  text: string,
  dim: number = RECALL_BENCH_EMBEDDING_DIM,
): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);
  const TOKEN_WEIGHT = 3;
  const TRIGRAM_WEIGHT = 1;
  for (const token of tokens) {
    vec[bucket(`tok:${token}`, dim)] += TOKEN_WEIGHT;
    for (const tri of trigrams(token)) {
      vec[bucket(`tri:${tri}`, dim)] += TRIGRAM_WEIGHT;
    }
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

/** Cosine similarity of two equal-length vectors (already unit-norm → dot). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}
