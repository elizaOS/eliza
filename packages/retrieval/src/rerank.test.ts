/**
 * Coverage for `rerankMemories` — merging BM25 keyword ranking with
 * zero-overlap vector hits so semantic-only and attachment-only memories survive
 * reranking. Exercises the shared algorithm; no model.
 */
import { describe, expect, it } from "vitest";
import { rerankMemories } from "./rerank";

type Memory = {
  id?: string;
  entityId: string;
  roomId: string;
  content: { text?: string };
};

function memory(id: string, text?: string): Memory {
  return {
    id: id as Memory["id"],
    entityId: "entity-id" as Memory["entityId"],
    roomId: "room-id" as Memory["roomId"],
    content: text === undefined ? {} : { text },
  } as Memory;
}

describe("rerankMemories", () => {
  it("preserves zero-overlap vector hits after BM25-ranked matches", async () => {
    const semanticOnly = memory("semantic-only", "I bought a new car");
    const keywordMatch = memory("keyword-match", "automobile purchase receipt");
    const attachmentOnly = memory("attachment-only");

    const reranked = await rerankMemories("automobile purchase", [
      semanticOnly,
      keywordMatch,
      attachmentOnly,
    ]);

    expect(reranked).toEqual([keywordMatch, semanticOnly, attachmentOnly]);
  });

  it("does not throw when an attachment-only memory carries an empty text field", async () => {
    const keywordMatch = memory("keyword-match", "automobile purchase receipt");
    const emptyText = memory("empty-text", "");

    const reranked = await rerankMemories("automobile purchase", [
      keywordMatch,
      emptyText,
    ]);

    expect(reranked[0]).toBe(keywordMatch);
    expect(reranked).toContain(emptyText);
  });
});
