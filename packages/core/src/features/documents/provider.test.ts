/**
 * Behavior tests for renderPinnedDocuments — the DOCUMENTS provider's pinned
 * document renderer. Covers the pinned-only filter, deterministic sort order,
 * complete authored content, and the no-pinned-documents empty case.
 */
import { describe, expect, it } from "vitest";
import type { Memory } from "../../types/index.ts";
import { renderPinnedDocuments } from "./provider.ts";

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

	it("renders complete content", () => {
		const documents = [pinnedMemory("doc-1", "short content", { title: "T" })];
		const result = renderPinnedDocuments(documents, 10_000);
		expect(result.truncated).toBe(false);
		expect(result.text).toContain("short content");
		expect(result.includedIds).toEqual(["doc-1"]);
	});

	it("preserves long content even when a legacy budget argument is supplied", () => {
		const documents = [
			pinnedMemory("doc-1", "x".repeat(5_000), { title: "Long" }),
			pinnedMemory("doc-2", "y".repeat(5_000), { title: "Longer" }),
		];
		const result = renderPinnedDocuments(documents, 100);
		expect(result.truncated).toBe(false);
		expect(result.text).toContain("x".repeat(5_000));
		expect(result.text).toContain("y".repeat(5_000));
		expect(result.includedIds).toEqual(["doc-1", "doc-2"]);
	});

	it("preserves complete pinned identities", () => {
		const documents = [
			pinnedMemory("doc-1", "content", {
				title: "A".repeat(2_000),
			}),
		];
		expect(renderPinnedDocuments(documents, 1).text).toContain(
			"A".repeat(2_000),
		);
	});

	it("includes a document with empty content as a header-only block", () => {
		const documents = [pinnedMemory("doc-1", "", { title: "Empty" })];
		const result = renderPinnedDocuments(documents, 10_000);
		expect(result.truncated).toBe(false);
		expect(result.text).toContain("## Empty (doc-1");
		expect(result.includedIds).toEqual(["doc-1"]);
	});
});
