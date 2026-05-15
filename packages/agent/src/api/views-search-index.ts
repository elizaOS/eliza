/**
 * Semantic search index for the view registry.
 *
 * Stores embeddings for each registered view and supports cosine-similarity
 * ranking. Embeddings are computed lazily via `runtime.useModel(TEXT_EMBEDDING)`
 * so startup is never blocked.
 *
 * Usage:
 *   await viewSearchIndex.indexView(entry, runtime);
 *   const results = await viewSearchIndex.search(query, runtime, 10);
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import type { ViewRegistryEntry } from "./views-registry.ts";

export interface ViewSearchEntry {
  viewId: string;
  embedding: number[];
  /** The text that was embedded: label + description + tags joined. */
  text: string;
}

/** Cosine similarity in [−1, 1]; returns 0 for zero-length vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Build the text to embed for a view. */
export function buildViewEmbeddingText(view: ViewRegistryEntry): string {
  return [
    view.label,
    view.description,
    ...(view.tags ?? []),
    view.capabilities?.map((c) => c.description).join(" ") ?? "",
  ]
    .filter(Boolean)
    .join(" | ");
}

class ViewSearchIndex {
  private readonly entries = new Map<string, ViewSearchEntry>();

  /**
   * Compute and store an embedding for `view`.
   * No-ops gracefully when the runtime has no embedding model configured.
   */
  async indexView(
    view: ViewRegistryEntry,
    runtime: IAgentRuntime,
  ): Promise<void> {
    const text = buildViewEmbeddingText(view);
    try {
      const result = await runtime.useModel(ModelType.TEXT_EMBEDDING, { text });
      const embedding = Array.isArray(result) ? (result as number[]) : [];
      if (embedding.length === 0) {
        logger.debug(
          { src: "ViewSearchIndex", viewId: view.id },
          "[ViewSearchIndex] Empty embedding returned for view — skipping",
        );
        return;
      }
      this.entries.set(view.id, { viewId: view.id, embedding, text });
    } catch (err) {
      logger.debug(
        { src: "ViewSearchIndex", viewId: view.id, err },
        "[ViewSearchIndex] Could not embed view — falling back to keyword search",
      );
    }
  }

  /** Remove the index entry for `viewId`. */
  removeView(viewId: string): void {
    this.entries.delete(viewId);
  }

  /**
   * Rank indexed views by semantic similarity to `query`.
   *
   * @param query   - The user's raw search query.
   * @param runtime - Agent runtime used to embed the query.
   * @param topK    - Maximum number of results to return (default 10).
   * @returns       Array of `{ viewId, score }` sorted descending by score,
   *                where score is cosine similarity in [0, 1].
   *                Returns an empty array when the runtime has no embedding model.
   */
  async search(
    query: string,
    runtime: IAgentRuntime,
    topK = 10,
  ): Promise<Array<{ viewId: string; score: number }>> {
    if (this.entries.size === 0) return [];

    let queryEmbedding: number[];
    try {
      const result = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
        text: query,
      });
      queryEmbedding = Array.isArray(result) ? (result as number[]) : [];
    } catch (err) {
      logger.debug(
        { src: "ViewSearchIndex", err },
        "[ViewSearchIndex] Could not embed query — semantic search unavailable",
      );
      return [];
    }

    if (queryEmbedding.length === 0) return [];

    const scored: Array<{ viewId: string; score: number }> = [];
    for (const entry of this.entries.values()) {
      const score = cosineSimilarity(queryEmbedding, entry.embedding);
      scored.push({ viewId: entry.viewId, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Remove all entries (e.g. between test runs). */
  clear(): void {
    this.entries.clear();
  }

  /** Number of indexed views. */
  get size(): number {
    return this.entries.size;
  }
}

/** Singleton shared across the process. */
export const viewSearchIndex = new ViewSearchIndex();
