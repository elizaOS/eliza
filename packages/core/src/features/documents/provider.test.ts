/**
 * Behavior tests for renderPinnedDocuments — the DOCUMENTS provider's pinned
 * document renderer. Covers the pinned-only filter, deterministic sort order,
 * the fair-share token-budget truncation (with the explicit truncation marker),
 * the identity-budget overflow guard, and the no-pinned-documents empty case.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../../errors.ts";
import type { Memory } from "../../types/index.ts";
import {
	PINNED_DOCUMENT_TRUNCATION_MARKER,
	renderPinnedDocuments,
} from "./provider.ts";

function pinnedMemory(
	id: string,
	text: string,
	overrides: { title?: string; pinned?: boolean; type?: string } = {},
): Memory {
	return {
		id,
		content: { text },
		createdAt: 0,
		metadata: {
			type: overrides.type ?? "document",
			pinned: overrides.pinned ?? true,
			...(overrides.title !== undefined ? { title: overrides.title } : {}),
		},
	} as Memory;
}

describe("renderPinnedDocuments", () => {
	it("returns an empty payload when there are no pinned documents", () => {
		const result = renderPinnedDocuments([]);
		expect(result).toEqual({ text: "", truncated: false, includedIds: [] });
	});

	it("filters out non-document memories and unpinned documents", () => {
		const documents = [
			pinnedMemory("doc-1", "alpha", { pinned: true }),
			pinnedMemory("doc-2", "beta", { pinned: false }),
			pinnedMemory("frag-1", "gamma", { type: "fragment" }),
			pinnedMemory("doc-3", "delta", { pinned: true }),
		];
		const result = renderPinnedDocuments(documents, 10_000);
		expect(result.includedIds).toEqual(["doc-1", "doc-3"]);
		expect(result.text).not.toContain("beta");
		expect(result.text).not.toContain("gamma");
	});

	it("sorts pinned documents by title then id for a deterministic order", () => {
		const documents = [
			pinnedMemory("id-z", "zzz", { title: "zebra" }),
			pinnedMemory("id-a", "aaa", { title: "alpha" }),
			pinnedMemory("id-b", "bbb", { title: "bravo" }),
			pinnedMemory("id-m", "mmm", { title: "zebra" }),
		];
		const result = renderPinnedDocuments(documents, 10_000);
		// title primary (alpha < bravo < zebra), then id tiebreak on "zebra".
		expect(result.includedIds).toEqual(["id-a", "id-b", "id-m", "id-z"]);
	});

	it("falls back to `Document N` for untitled pinned documents", () => {
		const documents = [pinnedMemory("doc-1", "content", { title: "   " })];
		const result = renderPinnedDocuments(documents, 10_000);
		expect(result.text).toContain("## Document 1 (doc-1");
	});

	it("renders full content and no marker when the budget is not exceeded", () => {
		const documents = [pinnedMemory("doc-1", "short content", { title: "T" })];
		const result = renderPinnedDocuments(documents, 10_000);
		expect(result.truncated).toBe(false);
		expect(result.text).toContain("short content");
		expect(result.text).not.toContain(PINNED_DOCUMENT_TRUNCATION_MARKER);
		expect(result.includedIds).toEqual(["doc-1"]);
	});

	it("truncates long content to the fair share and appends the truncation marker", () => {
		const documents = [
			pinnedMemory("doc-1", "x".repeat(5_000), { title: "Long" }),
			pinnedMemory("doc-2", "y".repeat(5_000), { title: "Longer" }),
		];
		// tokenBudget = 100 => 400 characters total, far below 10k of content.
		const result = renderPinnedDocuments(documents, 100);
		expect(result.truncated).toBe(true);
		expect(result.text.endsWith(PINNED_DOCUMENT_TRUNCATION_MARKER)).toBe(true);
		expect(result.includedIds).toEqual(["doc-1", "doc-2"]);
		// The marker is only appended once, after all blocks.
		expect(result.text.split(PINNED_DOCUMENT_TRUNCATION_MARKER)).toHaveLength(
			2,
		);
	});

	it("throws when the pinned identities alone exceed the token budget", () => {
		const documents = [
			pinnedMemory("doc-1", "content", {
				title: "A".repeat(2_000),
			}),
		];
		// tokenBudget = 1 => 4 chars total; headers alone are thousands of chars.
		expect(() => renderPinnedDocuments(documents, 1)).toThrow(ElizaError);
		try {
			renderPinnedDocuments(documents, 1);
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(
				"PINNED_DOCUMENT_IDENTITY_BUDGET_EXCEEDED",
			);
		}
	});

	it("includes a document with empty content as a header-only block", () => {
		const documents = [pinnedMemory("doc-1", "", { title: "Empty" })];
		const result = renderPinnedDocuments(documents, 10_000);
		expect(result.truncated).toBe(false);
		expect(result.text).toContain("## Empty (doc-1");
		expect(result.includedIds).toEqual(["doc-1"]);
	});
});
