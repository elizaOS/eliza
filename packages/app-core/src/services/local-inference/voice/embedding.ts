/**
 * Local embedding wiring for Eliza-1 bundles.
 *
 * Per `packages/inference/AGENTS.md` §1:
 *   - On the `0_8b` tier the **embedding model IS the text backbone**,
 *     served with `--pooling last` — there is no separate `embedding/`
 *     GGUF, no duplicate weights.
 *   - On `2b` / `4b` / `9b` / `27b` / `27b-256k` / `27b-1m` a dedicated
 *     `embedding/` GGUF region (Qwen3-Embedding-0.6B, Apache-2.0,
 *     1024-dim Matryoshka, 32k ctx) is acquired lazily through the same
 *     engine / `SharedResourceRegistry`. **Do not collapse it to pooled
 *     text on the larger tiers** — that breaks the 1024-dim Matryoshka
 *     contract (B1's verdict).
 *
 * This module is a pure resolver: given a bundle root + tier id it
 * describes *where* embeddings come from (the text GGUF with a pooling
 * flag, or a separate region file) without doing any I/O beyond an
 * `existsSync`. The engine consumes the descriptor to mount the region
 * and the local-embedding route. It also owns the Matryoshka-truncation
 * helper that callers / the vector store use to trade dimensionality for
 * storage (see `EMBEDDING_MATRYOSHKA_DIMS` + `truncateMatryoshka`).
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Eliza1TierId } from "../catalog";
import { VoiceStartupError } from "./errors";

/** Bundle-relative directory holding a dedicated embedding GGUF (non-0_8b tiers). */
export const EMBEDDING_DIR_REL_PATH = "embedding";

/** Full output dimensionality of the Eliza-1 embedding model. */
export const EMBEDDING_FULL_DIM = 1024 as const;

/**
 * Valid Matryoshka truncation points for Qwen3-Embedding-0.6B. The model
 * is trained so that the leading N components of the 1024-dim vector are
 * themselves a usable embedding at these widths; quality degrades
 * gracefully as N shrinks (see the tradeoff table in
 * `reports/porting/2026-05-11/embedding-model-review.md`).
 *
 * 1024 (full) → 768 → 512 → 256 → 128 → 64. Smaller widths than 64 are
 * not part of the published contract.
 */
export const EMBEDDING_MATRYOSHKA_DIMS: readonly number[] = [
  64, 128, 256, 512, 768, 1024,
];

/** Type-narrow guard for `EMBEDDING_MATRYOSHKA_DIMS`. */
export function isValidEmbeddingDim(dim: number): boolean {
  return EMBEDDING_MATRYOSHKA_DIMS.includes(dim);
}

/**
 * Truncate a full 1024-dim embedding to one of the Matryoshka widths and
 * L2-renormalize. Renormalization matters: Qwen3-Embedding outputs are
 * unit-norm at 1024 dims, but the leading slice is *not* unit-norm, and
 * downstream cosine-similarity / dot-product retrieval assumes unit
 * vectors.
 *
 * Throws on an invalid `dim` (must be one of `EMBEDDING_MATRYOSHKA_DIMS`)
 * or when `vec` is shorter than `dim` — no silent truncation-to-whatever
 * or zero-padding (Commandment 8: don't hide a broken pipeline).
 */
export function truncateMatryoshka(
  vec: readonly number[],
  dim: number,
): number[] {
  if (!isValidEmbeddingDim(dim)) {
    throw new Error(
      `[embedding] dim ${dim} is not a valid Matryoshka width; expected one of ${EMBEDDING_MATRYOSHKA_DIMS.join(", ")}`,
    );
  }
  if (vec.length < dim) {
    throw new Error(
      `[embedding] cannot truncate a ${vec.length}-dim vector to ${dim} dims`,
    );
  }
  if (vec.length === dim) {
    // Already the requested width; still renormalize so a caller passing a
    // raw last-token state (which may not be unit-norm) gets a clean vec.
    return l2Normalize(vec.slice());
  }
  return l2Normalize(vec.slice(0, dim));
}

/** L2-normalize in place; returns the same array. Zero vectors pass through. */
function l2Normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (const x of vec) sumSq += x * x;
  if (sumSq === 0) return vec;
  const inv = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < vec.length; i += 1) vec[i] *= inv;
  return vec;
}

export type LocalEmbeddingSource =
  | {
      /** `0_8b`: reuse the text backbone GGUF; serve with `--pooling last`. */
      readonly kind: "pooled-text";
      readonly textModelPath: string;
      readonly poolingType: "last";
    }
  | {
      /** Non-`0_8b`: a dedicated `embedding/<name>.gguf` region. */
      readonly kind: "dedicated-region";
      readonly embeddingModelPath: string;
      /** 1024-dim Matryoshka (the published Qwen3-Embedding-0.6B contract). */
      readonly dimensions: typeof EMBEDDING_FULL_DIM;
      /**
       * The dedicated model already ships a contrastive `last`-token
       * pooling head — `--pooling last` is still passed so llama-server
       * doesn't fall back to the GGUF's metadata default (which for a raw
       * Qwen3 base is `mean`). The model's own pooling layer dominates;
       * this just pins the read.
       */
      readonly poolingType: "last";
    };

/** First regular `.gguf` file under `dir`, or null. */
function firstGguf(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && /\.gguf$/i.test(entry.name)) {
      return path.join(dir, entry.name);
    }
  }
  return null;
}

/**
 * Tiers whose embedding model is the text backbone with `--pooling last`
 * (no separate GGUF). Only `0_8b` per AGENTS.md §1.
 */
export const POOLED_TEXT_EMBEDDING_TIERS: ReadonlySet<Eliza1TierId> = new Set([
  "eliza-1-0_8b",
]);

/**
 * Resolve the embedding source for an activated Eliza-1 bundle.
 *
 * @param bundleRoot   Bundle directory on disk.
 * @param tierId       The Eliza-1 tier id (`eliza-1-0_8b`, ...).
 * @param textModelPath Absolute path of the activated text GGUF (needed for
 *                      the `pooled-text` case).
 *
 * Hard-fails (AGENTS.md §3) when a non-`0_8b` tier is missing its
 * `embedding/` region — no silent fallback to pooled text, which would
 * regress dimensions from 1024 to whatever the text model emits.
 */
export function resolveLocalEmbeddingSource(args: {
  bundleRoot: string;
  tierId: Eliza1TierId;
  textModelPath: string;
}): LocalEmbeddingSource {
  if (POOLED_TEXT_EMBEDDING_TIERS.has(args.tierId)) {
    if (!existsSync(args.textModelPath)) {
      throw new VoiceStartupError(
        "missing-bundle-root",
        `[embedding] ${args.tierId}: text model not found at ${args.textModelPath} — cannot serve pooled-text embeddings.`,
      );
    }
    return {
      kind: "pooled-text",
      textModelPath: args.textModelPath,
      poolingType: "last",
    };
  }
  const dir = path.join(args.bundleRoot, EMBEDDING_DIR_REL_PATH);
  const gguf = firstGguf(dir);
  if (!gguf) {
    throw new VoiceStartupError(
      "missing-bundle-root",
      `[embedding] ${args.tierId}: required dedicated embedding region missing under ${dir}. Tiers above 0_8b ship a separate 1024-dim Matryoshka embedding GGUF (AGENTS.md §1) — do not fall back to pooled text.`,
    );
  }
  return {
    kind: "dedicated-region",
    embeddingModelPath: gguf,
    dimensions: EMBEDDING_FULL_DIM,
    poolingType: "last",
  };
}

/**
 * Descriptor for the local-embedding route the engine exposes. The
 * route's job is `text[] → number[dim][]`; the runtime mounts the source
 * (pooled text or dedicated region) and forwards. Kept as a plain data
 * shape so both the API layer and tests can assert it without standing up
 * a server.
 */
export interface LocalEmbeddingRoute {
  readonly tierId: Eliza1TierId;
  readonly source: LocalEmbeddingSource;
  /** Full output dimensionality the route produces before truncation. 1024 on every tier. */
  readonly dimensions: typeof EMBEDDING_FULL_DIM;
  /**
   * Default Matryoshka width the route returns when a caller does not ask
   * for a smaller `dim`. Always 1024 (= `dimensions`) — callers/the vector
   * store opt into a smaller width for storage savings.
   */
  readonly defaultDim: number;
  /** The Matryoshka widths a caller may request. */
  readonly matryoshkaDims: readonly number[];
  /**
   * `llama-server` flags for the embedding server process — always
   * `--embeddings --pooling last`. The embedding server is a lazily-started
   * sidecar over the route's GGUF (the text backbone on `0_8b`, the
   * `embedding/` GGUF on larger tiers); see `embedding-server.ts`. The
   * chat `llama-server` is left untouched (completions-only) — these flags
   * do NOT go on it.
   */
  readonly serverFlags: ReadonlyArray<string>;
}

export function buildLocalEmbeddingRoute(args: {
  bundleRoot: string;
  tierId: Eliza1TierId;
  textModelPath: string;
  /** Default output width; must be one of `EMBEDDING_MATRYOSHKA_DIMS`. Defaults to 1024. */
  defaultDim?: number;
}): LocalEmbeddingRoute {
  const source = resolveLocalEmbeddingSource(args);
  const defaultDim = args.defaultDim ?? EMBEDDING_FULL_DIM;
  if (!isValidEmbeddingDim(defaultDim)) {
    throw new Error(
      `[embedding] defaultDim ${defaultDim} is not a valid Matryoshka width; expected one of ${EMBEDDING_MATRYOSHKA_DIMS.join(", ")}`,
    );
  }
  // Both modes serve through a sidecar `llama-server --embeddings --pooling
  // last` (over the text GGUF on 0_8b, over the embedding/ GGUF on larger
  // tiers). The chat server is never given these flags.
  const serverFlags = ["--embeddings", "--pooling", source.poolingType];
  return {
    tierId: args.tierId,
    source,
    dimensions: EMBEDDING_FULL_DIM,
    defaultDim,
    matryoshkaDims: EMBEDDING_MATRYOSHKA_DIMS,
    serverFlags,
  };
}
