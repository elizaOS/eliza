/**
 * Coverage for `AgentRuntime.rerankMemories` — merging BM25 keyword ranking with
 * zero-overlap vector hits so semantic-only and attachment-only memories survive
 * reranking. Drives a real `AgentRuntime`; no model.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Character, Memory } from "../types";

function memory(id: string, text?: string): Memory {
	return {
		id: id as Memory["id"],
		entityId: "entity-id" as Memory["entityId"],
		roomId: "room-id" as Memory["roomId"],
		content: text === undefined ? {} : { text },
	} as Memory;
}

describe("AgentRuntime.rerankMemories", () => {
	it("preserves zero-overlap vector hits after BM25-ranked matches", async () => {
		const runtime = new AgentRuntime({
			character: { name: "rerank-memory-test" } as Character,
		});

		const semanticOnly = memory("semantic-only", "I bought a new car");
		const keywordMatch = memory("keyword-match", "automobile purchase receipt");
		const attachmentOnly = memory("attachment-only");

		const reranked = await runtime.rerankMemories("automobile purchase", [
			semanticOnly,
			keywordMatch,
			attachmentOnly,
		]);

		expect(reranked).toEqual([keywordMatch, semanticOnly, attachmentOnly]);
	});
});
