import { describe, expect, it, vi } from "vitest";
import { logger } from "../../logger";
import { type Memory, MemoryType, type UUID } from "../../types";
import {
	documentsProvider,
	PINNED_DOCUMENT_TRUNCATION_MARKER,
	renderPinnedDocuments,
} from "./provider";
import { DocumentService } from "./service";

const id = (value: string) => value.padEnd(36, "0") as UUID;

function document(title: string, text: string, pinned = false): Memory {
	return {
		id: id(title),
		agentId: id("agent"),
		entityId: id("entity"),
		roomId: id("room"),
		content: { text },
		metadata: {
			type: MemoryType.DOCUMENT,
			source: "test",
			title,
			pinned,
		},
	};
}

describe("pinned DOCUMENTS provider knowledge", () => {
	it("keeps an irrelevant unpinned document absent, then injects it whole when pinned", async () => {
		const irrelevant = document("Operating rules", "ALWAYS TELL THE TRUTH");
		const service = {
			composeProviderDocuments: vi.fn(async () => ({
				relevantFragments: [],
				documents: [irrelevant],
				pinnedDocuments:
					irrelevant.metadata?.pinned === true ? [irrelevant] : [],
			})),
		};
		const runtime = {
			getService: vi.fn((type: string) =>
				type === DocumentService.serviceType ? service : null,
			),
		};
		const message = document("query", "What is the weather?");

		const before = await documentsProvider.get(runtime as never, message);
		expect(before.text).not.toContain("ALWAYS TELL THE TRUTH");
		expect(before.data?.pinnedDocumentIds).toEqual([]);

		irrelevant.metadata = { ...irrelevant.metadata, pinned: true };
		const after = await documentsProvider.get(runtime as never, message);
		expect(after.text).toContain("ALWAYS TELL THE TRUTH");
		expect(after.data?.pinnedDocumentIds).toEqual([irrelevant.id]);
		expect(service.composeProviderDocuments).toHaveBeenLastCalledWith(message, {
			limit: 25,
		});
	});

	it("preserves ordinary retrieval snippets for unpinned documents", async () => {
		const unpinned = document("Reference", "whole text stays unpinned");
		const runtime = {
			getService: vi.fn(() => ({
				composeProviderDocuments: vi.fn(async () => ({
					relevantFragments: [
						{
							id: id("fragment"),
							content: { text: "retrieved fragment" },
							metadata: { title: "Reference", documentId: unpinned.id },
							similarity: 0.91,
						},
					],
					documents: [unpinned],
					pinnedDocuments: [],
				})),
			})),
		};
		const result = await documentsProvider.get(
			runtime as never,
			document("query", "reference query"),
		);
		expect(result.text).toContain("retrieved fragment");
		expect(result.text).not.toContain("whole text stays unpinned");
	});

	it("orders pinned documents deterministically", () => {
		const first = document("B rules", "BBBB", true);
		const second = document("A rules", "AAAA", true);
		const rendered = renderPinnedDocuments([first, second]);
		expect(rendered.text.indexOf("A rules")).toBeLessThan(
			rendered.text.indexOf("B rules"),
		);
		expect(rendered.truncated).toBe(false);
	});

	it("injects an authorized pin even when it is outside the recent-document page", async () => {
		const recent = Array.from({ length: 25 }, (_, index) =>
			document(`Recent ${index}`, `recent ${index}`),
		);
		const olderPinned = document("Standing rule", "NEVER FABRICATE", true);
		const runtime = {
			getService: vi.fn(() => ({
				composeProviderDocuments: vi.fn(async () => ({
					relevantFragments: [],
					documents: recent,
					pinnedDocuments: [olderPinned],
				})),
			})),
		};
		const result = await documentsProvider.get(
			runtime as never,
			document("query", "unrelated query"),
		);
		expect(result.text).toContain("NEVER FABRICATE");
		expect(result.data?.documents).toHaveLength(25);
		expect(result.data?.pinnedDocumentIds).toEqual([olderPinned.id]);
	});

	it("marks overflow explicitly and emits a warning from the provider", async () => {
		const oversized = document("Ground truth", "X".repeat(40_000), true);
		const runtime = {
			getService: vi.fn(() => ({
				composeProviderDocuments: vi.fn(async () => ({
					relevantFragments: [],
					documents: [oversized],
					pinnedDocuments: [oversized],
				})),
			})),
		};
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		const result = await documentsProvider.get(
			runtime as never,
			document("query", "unrelated query"),
		);
		expect(result.text).toContain(PINNED_DOCUMENT_TRUNCATION_MARKER);
		expect(result.text).not.toContain("X".repeat(100));
		expect(result.data?.pinnedDocumentsTruncated).toBe(true);
		expect(result.data?.pinnedDocumentIds).toEqual([]);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ tokenBudget: 8_000 }),
			expect.stringContaining("explicitly truncated"),
		);
		warn.mockRestore();
	});
});
