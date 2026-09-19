/** Reranks an already scoped vector page while preserving every semantic-only result. */
import { BM25 } from "./search.js";

/** Rank a scoped vector result page without discarding semantic-only hits. */
export function rerankMemories<
  T extends { id?: string; content: { text?: string } },
>(query: string | undefined, memories: T[]): T[] {
  if (!query) return memories;
  const ranked = new BM25(
    memories.map((memory) => ({
      title: memory.id,
      content: memory.content.text,
    })),
  ).search(query, memories.length);
  const indexes = new Set(ranked.map((result) => result.index));
  return [
    ...ranked.map((result) => memories[result.index]),
    ...memories.filter((_, index) => !indexes.has(index)),
  ];
}
