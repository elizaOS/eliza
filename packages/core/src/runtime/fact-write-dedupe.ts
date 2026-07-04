/**
 * Structural write-time dedupe for the `facts` table: before a fact insert,
 * find an existing row with the same normalized text in the same
 * room + entity scope so `runtime.createMemory` can skip the write and return
 * the existing row's id.
 *
 * This guard exists because nothing else structurally prevents duplicate fact
 * rows. The adapter-level similarity check requires an embedding (facts
 * writers have none inline — embeddings are backfilled asynchronously) and is
 * bypassed entirely when callers pass an explicit `unique` flag, and the
 * per-turn LLM dedupe pool is advisory (the model can and does miss). The
 * live failure this closes: one extraction turn persisted the same claim
 * twice, milliseconds apart — a fact row plus a relationship-echo row — and
 * the FACTS reader surfaced both.
 *
 * Equivalence is text + scope equality after canonicalization, not semantic
 * similarity: paraphrase-level dedupe stays with the LLM pool and the
 * reflection pass. The candidate pool is bounded to the same recent window
 * the FACTS provider reads, so the check degrades to a plain insert (never an
 * error) on rooms with very deep fact history.
 */

import type { Memory } from "../types/memory";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";

const DEDUPE_CANDIDATE_POOL = 120;

/**
 * Canonical form for fact-text equality: case-, punctuation-, and
 * whitespace-insensitive, unicode-aware. An empty key never matches (so
 * punctuation-only or empty texts are never deduped against each other).
 */
export function normalizeFactTextKey(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Returns the id of an existing `facts` row equivalent to `memory`
 * (same normalized text, same room, same entity), or null when the write
 * should proceed. Rows sharing `memory.id` are ignored — same-id idempotence
 * is the adapter's contract, not a duplicate.
 */
export async function findEquivalentFactId(
	runtime: Pick<IAgentRuntime, "getMemories">,
	memory: Memory,
): Promise<UUID | null> {
	const text =
		typeof memory.content?.text === "string" ? memory.content.text : "";
	const key = normalizeFactTextKey(text);
	if (!key || !memory.roomId) return null;

	const existing = await runtime.getMemories({
		tableName: "facts",
		roomId: memory.roomId,
		count: DEDUPE_CANDIDATE_POOL,
		unique: false,
	});
	for (const candidate of existing) {
		if (!candidate.id || candidate.id === memory.id) continue;
		if ((candidate.entityId ?? null) !== (memory.entityId ?? null)) continue;
		const candidateText =
			typeof candidate.content?.text === "string" ? candidate.content.text : "";
		if (normalizeFactTextKey(candidateText) === key) return candidate.id;
	}
	return null;
}
