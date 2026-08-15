/**
 * Deterministic unit coverage for the synthetic-conversation-artifact
 * classifier. Both predicates are pure, so every case is an exact
 * input/output assertion.
 *
 * This gate keeps runtime-generated compaction/summary records out of paths
 * that should only see real turns, so both directions cost something: a missed
 * artifact leaks synthesized state into a real-message path, and a false
 * positive silently drops a genuine user turn.
 *
 * Where a branch can be isolated it is driven with input only that branch
 * matches, so deleting the branch fails the case. Two branches cannot be
 * isolated — the `compacted prior planner` prefix and the `Conversation
 * Summary` heading both also satisfy the loose phrase test by construction —
 * and the comments say so rather than implying coverage the inputs do not give.
 */

import { describe, expect, it } from "vitest";
import {
	isSyntheticConversationArtifactMemory,
	isSyntheticConversationArtifactText,
} from "./synthetic-conversation-artifact";

const memory = (text: unknown, metadata?: unknown) =>
	({ content: { text }, metadata }) as never;

describe("isSyntheticConversationArtifactText", () => {
	describe("bracketed marker prefix", () => {
		// These carry no loose phrase, so the marker regex is the only branch that
		// can match them — deleting it fails these cases specifically.
		it.each([
			"[system hybrid-ledger]",
			"[conversation state]",
			"[conversation hybrid-ledger]",
			"[system state]",
			"[conversation state [run-42]]",
			"[SYSTEM HYBRID-LEDGER] trailing prose",
		])("matches %j", (text) => {
			expect(isSyntheticConversationArtifactText(text)).toBe(true);
		});

		it("trims before anchoring the marker", () => {
			expect(isSyntheticConversationArtifactText("   [system state]")).toBe(
				true,
			);
		});

		it("requires the marker at the start, not anywhere", () => {
			expect(
				isSyntheticConversationArtifactText("prose then [system state]"),
			).toBe(false);
		});

		it("does not match an unrelated bracketed prefix", () => {
			expect(isSyntheticConversationArtifactText("[note] ordinary text")).toBe(
				false,
			);
			expect(
				isSyntheticConversationArtifactText("[system] ordinary text"),
			).toBe(false);
		});
	});

	describe("compaction prefix and summary heading", () => {
		// Not isolated: each of these also contains a loose phrase, so they stay
		// true if their own branch is removed. They pin the documented shapes, not
		// the individual branches.
		it.each([
			"compacted prior planner trajectory steps 1-4",
			"### Conversation Summary",
			"# conversation summary",
		])("matches %j", (text) => {
			expect(isSyntheticConversationArtifactText(text)).toBe(true);
		});
	});

	describe("loose phrase match is deliberately unanchored", () => {
		// The module header calls this "phrasing" matching. It is worth pinning
		// because it also classifies ordinary user turns that merely mention the
		// phrase — the false-positive side of this gate.
		it.each([
			"can you give me a conversation summary?",
			"I switched to summary mode yesterday",
			"the compactor broke again",
		])("classifies the ordinary message %j as synthetic", (text) => {
			expect(isSyntheticConversationArtifactText(text)).toBe(true);
		});
	});

	describe("genuine turns are left alone", () => {
		it.each([
			"hello world",
			"let's summarize the conversation",
			"summary of my day",
			"conversationsummary",
			"",
			"   ",
		])("does not classify %j", (text) => {
			expect(isSyntheticConversationArtifactText(text)).toBe(false);
		});
	});
});

describe("isSyntheticConversationArtifactMemory", () => {
	describe("metadata.source", () => {
		// Text is deliberately inert here so only the source branch can match.
		it.each(["compaction", "compactor", "synthetic", "summary", "COMPACTION"])(
			"matches source %j",
			(source) => {
				expect(
					isSyntheticConversationArtifactMemory(memory("hello", { source })),
				).toBe(true);
			},
		);

		it("matches on a word boundary, not a substring", () => {
			// "compaction-v2" has a boundary before the word; "recompaction" does not.
			expect(
				isSyntheticConversationArtifactMemory(
					memory("hello", { source: "compaction-v2" }),
				),
			).toBe(true);
			expect(
				isSyntheticConversationArtifactMemory(
					memory("hello", { source: "recompaction" }),
				),
			).toBe(false);
		});
	});

	describe("metadata.tags", () => {
		it("matches when any tag names a synthetic source", () => {
			expect(
				isSyntheticConversationArtifactMemory(
					memory("hello", { tags: ["chat", "synthetic"] }),
				),
			).toBe(true);
		});

		it("ignores non-string tags without throwing", () => {
			expect(
				isSyntheticConversationArtifactMemory(
					memory("hello", { tags: [123, null, { a: 1 }, "summary"] }),
				),
			).toBe(true);
			expect(
				isSyntheticConversationArtifactMemory(
					memory("hello", { tags: [123, null, { a: 1 }] }),
				),
			).toBe(false);
		});

		it("ignores a non-array tags value", () => {
			expect(
				isSyntheticConversationArtifactMemory(
					memory("hello", { tags: "synthetic" }),
				),
			).toBe(false);
		});
	});

	describe("falls back to the text form", () => {
		it("matches on content text alone", () => {
			expect(
				isSyntheticConversationArtifactMemory(
					memory("[system hybrid-ledger]", { source: "discord" }),
				),
			).toBe(true);
		});
	});

	describe("malformed input yields false rather than throwing", () => {
		it.each([
			["absent metadata", memory("hello", undefined)],
			["null metadata", memory("hello", null)],
			["non-object metadata", memory("hello", "compaction")],
			["non-string content text", memory(123, {})],
			["clean memory", memory("hello", { source: "discord", tags: ["chat"] })],
		])("returns false for %s", (_label, value) => {
			expect(isSyntheticConversationArtifactMemory(value)).toBe(false);
		});
	});
});
