/**
 * Local embedding wiring for Eliza-1 bundles.
 *
 * Per `packages/inference/AGENTS.md` §1:
 *   - On the `0_6b` tier the **embedding model IS the text backbone**,
 *     served with `--pooling last` — there is no separate `embedding/`
 *     GGUF, no duplicate weights.
 *   - On `1_7b` / `9b` / `27b` / `27b-256k` / `27b-1m` a dedicated
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
 * and the local-embedding route.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Eliza1TierId } from "../catalog";
import { VoiceStartupError } from "./errors";

/** Bundle-relative directory holding a dedicated embedding GGUF (non-0_6b tiers). */
export const EMBEDDING_DIR_REL_PATH = "embedding";

/**
 * Tiers whose embedding model is the text backbone with `--pooling last`
 * (no separate GGUF). Only `0_6b` per AGENTS.md §1.
 */
export const POOLED_TEXT_EMBEDDING_TIERS: ReadonlySet<Eliza1TierId> = new Set([
  "eliza-1-0_6b",
]);

export type LocalEmbeddingSource =
  | {
      /** `0_6b`: reuse the text backbone GGUF; serve with `--pooling last`. */
      readonly kind: "pooled-text";
      readonly textModelPath: string;
      readonly poolingType: "last";
    }
  | {
      /** Non-`0_6b`: a dedicated `embedding/<name>.gguf` region. */
      readonly kind: "dedicated-region";
      readonly embeddingModelPath: string;
      /** 1024-dim Matryoshka (the published Qwen3-Embedding-0.6B contract). */
      readonly dimensions: 1024;
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
 * Resolve the embedding source for an activated Eliza-1 bundle.
 *
 * @param bundleRoot   Bundle directory on disk.
 * @param tierId       The Eliza-1 tier id (`eliza-1-0_6b`, …).
 * @param textModelPath Absolute path of the activated text GGUF (needed for
 *                      the `pooled-text` case).
 *
 * Hard-fails (AGENTS.md §3) when a non-`0_6b` tier is missing its
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
      `[embedding] ${args.tierId}: required dedicated embedding region missing under ${dir}. Tiers above 0_6b ship a separate 1024-dim Matryoshka embedding GGUF (AGENTS.md §1) — do not fall back to pooled text.`,
    );
  }
  return {
    kind: "dedicated-region",
    embeddingModelPath: gguf,
    dimensions: 1024,
  };
}

/**
 * Descriptor for the local-embedding route the engine exposes. The
 * route's job is `text[] → number[1024][]`; the runtime mounts the source
 * (pooled text or dedicated region) and forwards. Kept as a plain data
 * shape so both the API layer and tests can assert it without standing up
 * a server.
 */
export interface LocalEmbeddingRoute {
  readonly tierId: Eliza1TierId;
  readonly source: LocalEmbeddingSource;
  /** Output dimensionality the route guarantees. 1024 on every tier. */
  readonly dimensions: 1024;
  /**
   * llama-server flags this route needs when the source is `pooled-text`
   * (the same process serves chat + embeddings on `0_6b`). Empty for the
   * dedicated-region case (a separate server / region handles it).
   */
  readonly serverFlags: ReadonlyArray<string>;
}

export function buildLocalEmbeddingRoute(args: {
  bundleRoot: string;
  tierId: Eliza1TierId;
  textModelPath: string;
}): LocalEmbeddingRoute {
  const source = resolveLocalEmbeddingSource(args);
  const serverFlags =
    source.kind === "pooled-text"
      ? (["--embeddings", "--pooling", source.poolingType] as const)
      : ([] as const);
  return {
    tierId: args.tierId,
    source,
    dimensions: 1024,
    serverFlags: [...serverFlags],
  };
}
