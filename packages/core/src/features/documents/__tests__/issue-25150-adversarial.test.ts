/**
 * Exercises complete document retrieval through the real DocumentService with
 * adversarial adapters that expose relevance and snapshot-pagination defects.
 */

import { describe, expect, it, vi } from "vitest";
import {
	createStableRetrievalPage,
	stableRetrievalQueryFingerprint,
} from "../../../database/stable-retrieval";
import type { Memory, StableRetrievalSnapshot, UUID } from "../../../types";
import { MemoryType, ModelType } from "../../../types";
import { DocumentService } from "../service";

const AGENT_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-000000000002" as UUID;
const ENTITY_ID = "00000000-0000-4000-8000-000000000003" as UUID;

function fragment(index: number, text: string, similarity?: number): Memory {
	return {
		id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}` as UUID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		entityId: ENTITY_ID,
		createdAt: 1_000_000 - index,
		content: { text },
		metadata: {
			type: MemoryType.FRAGMENT,
			documentId: "20000000-0000-4000-8000-000000000001" as UUID,
			position: index,
			timestamp: 1_000_000 - index,
		},
		...(similarity === undefined ? {} : { similarity }),
	};
}

function runtimeWithQuery(
	queryDocumentFragments: (params: {
		embedding?: number[];
		limit: number;
		offset?: number;
		cursor?: unknown;
		snapshot?: unknown;
	}) => Promise<Memory[]>,
) {
	const queryDocumentFragmentsPage = vi.fn(async (params) => {
		const rows = await queryDocumentFragments({
			embedding: params.embedding,
			limit: 10_000,
			offset: 0,
		});
		return createStableRetrievalPage(rows, {
			limit: params.limit,
			cursor: params.cursor,
			rankBySimilarity: params.embedding !== undefined,
			queryFingerprint: stableRetrievalQueryFingerprint({
				kind: "test-document-fragments",
				embedding: params.embedding,
			}),
		});
	});
	return {
		agentId: AGENT_ID,
		adapter: {
			stableRetrievalCapability: 1 as const,
			queryDocumentFragments: vi.fn(queryDocumentFragments),
			queryDocumentFragmentsPage,
		},
		getModel: vi.fn((type: string) =>
			type === ModelType.TEXT_EMBEDDING ? vi.fn() : undefined,
		),
		useModel: vi.fn(async () => [1, 0]),
		getRoomsForParticipants: vi.fn(async () => [ROOM_ID]),
		getRoom: vi.fn(async () => ({
			id: ROOM_ID,
			agentId: AGENT_ID,
			worldId: AGENT_ID,
		})),
		getWorld: vi.fn(async () => ({
			id: AGENT_ID,
			agentId: AGENT_ID,
			metadata: { roles: { [ENTITY_ID]: "USER" } },
		})),
		reportError: vi.fn(),
	};
}

function snapshot(
	rows: Memory[],
	totalCount = rows.length,
): StableRetrievalSnapshot {
	return {
		version: 1,
		upperCreatedAt: rows[0]?.createdAt ?? 0,
		upperId: rows[0]?.id ?? ("00000000-0000-4000-8000-000000000000" as UUID),
		totalCount,
		queryFingerprint: "a".repeat(64),
		fingerprint: "b".repeat(64),
	};
}

function service(
	runtime: ReturnType<typeof runtimeWithQuery>,
): DocumentService {
	return new (DocumentService as new (runtime: unknown) => DocumentService)(
		runtime,
	);
}

function message(text: string): Memory {
	return {
		id: "30000000-0000-4000-8000-000000000001" as UUID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		entityId: ENTITY_ID,
		createdAt: 1,
		content: { text },
	};
}

describe("issue #25150 document retrieval adversarial seams", () => {
	it("does not inject a query-disjoint keyword corpus when vector recall is empty", async () => {
		const corpus = [
			fragment(1, "banana bread"),
			fragment(2, "weather tomorrow"),
			fragment(3, "classical guitar"),
		];
		const runtime = runtimeWithQuery(async (params) => {
			const rows = params.embedding ? [] : corpus;
			const offset = params.offset ?? 0;
			return rows.slice(offset, offset + params.limit);
		});

		await expect(
			service(runtime).searchDocuments(
				message("quantum chromodynamics"),
				undefined,
				"hybrid",
			),
		).resolves.toEqual([]);
	});

	it("keeps a sparse semantic hit without adding disjoint corpus rows", async () => {
		const semantic = fragment(1, "conceptually related passage", 0.91);
		const irrelevant = [
			fragment(2, "banana bread"),
			fragment(3, "weather tomorrow"),
			fragment(4, "classical guitar"),
		];
		const runtime = runtimeWithQuery(async (params) => {
			const rows = params.embedding ? [semantic] : [semantic, ...irrelevant];
			const offset = params.offset ?? 0;
			return rows.slice(offset, offset + params.limit);
		});

		const results = await service(runtime).searchDocuments(
			message("quantum chromodynamics"),
			undefined,
			"hybrid",
		);
		expect(results.map((result) => result.id)).toEqual([semantic.id]);
	});

	it("rejects deterministic overlap instead of duplicating one row and omitting another", async () => {
		const rows = Array.from({ length: 2_000 }, (_, index) =>
			fragment(index, `needle ${index}`),
		);
		const runtime = runtimeWithQuery(async (params) => {
			const offset = params.offset ?? 0;
			if (offset === 0) return rows.slice(0, 1_000);
			if (offset === 1_000) return rows.slice(999, 1_999);
			return [];
		});
		const stable = snapshot(rows);
		let pageNumber = 0;
		runtime.adapter.queryDocumentFragmentsPage.mockImplementation(async () => {
			pageNumber += 1;
			if (pageNumber === 1) {
				const items = rows.slice(0, 1_000);
				const last = items.at(-1);
				return {
					items,
					snapshot: stable,
					hasMore: true,
					nextCursor: {
						id: last?.id as UUID,
						createdAt: last?.createdAt as number,
						snapshot: stable,
					},
				};
			}
			return {
				items: rows.slice(999, 1_999),
				snapshot: stable,
				hasMore: false,
			};
		});

		await expect(
			service(runtime).searchDocuments(message("needle"), undefined, "keyword"),
		).rejects.toMatchObject({ code: "RETRIEVAL_PAGINATION_CONFLICT" });
	});

	it("rejects a deterministic missing page even when repeated scans agree", async () => {
		const rows = Array.from({ length: 2_001 }, (_, index) =>
			fragment(index, `needle ${index}`),
		);
		const runtime = runtimeWithQuery(async (params) => {
			const offset = params.offset ?? 0;
			if (offset === 0) return rows.slice(0, 1_000);
			if (offset === 1_000) return rows.slice(1_001, 2_001);
			return [];
		});
		const stable = snapshot(rows);
		let pageNumber = 0;
		runtime.adapter.queryDocumentFragmentsPage.mockImplementation(async () => {
			pageNumber += 1;
			if (pageNumber === 1) {
				const items = rows.slice(0, 1_000);
				const last = items.at(-1);
				return {
					items,
					snapshot: stable,
					hasMore: true,
					nextCursor: {
						id: last?.id as UUID,
						createdAt: last?.createdAt as number,
						snapshot: stable,
					},
				};
			}
			return {
				items: rows.slice(1_001, 2_001),
				snapshot: stable,
				hasMore: false,
			};
		});

		await expect(
			service(runtime).searchDocuments(message("needle"), undefined, "keyword"),
		).rejects.toMatchObject({ code: "DOCUMENT_SEARCH_PAGINATION_CONFLICT" });
	});

	it("rejects a reordered continuation page", async () => {
		const rows = Array.from({ length: 1_001 }, (_, index) =>
			fragment(index, `needle ${index}`),
		);
		const runtime = runtimeWithQuery(async () => rows);
		const stable = snapshot(rows);
		let pageNumber = 0;
		runtime.adapter.queryDocumentFragmentsPage.mockImplementation(async () => {
			pageNumber += 1;
			if (pageNumber === 1) {
				const items = rows.slice(0, 1_000);
				const last = items.at(-1);
				return {
					items,
					snapshot: stable,
					hasMore: true,
					nextCursor: {
						id: last?.id as UUID,
						createdAt: last?.createdAt as number,
						snapshot: stable,
					},
				};
			}
			return {
				items: [rows[1_000], rows[999]],
				snapshot: stable,
				hasMore: false,
			};
		});

		await expect(
			service(runtime).searchDocuments(message("needle"), undefined, "keyword"),
		).rejects.toMatchObject({ code: "RETRIEVAL_PAGINATION_CONFLICT" });
	});

	it("rejects an adapter that ignores the continuation cursor", async () => {
		const rows = Array.from({ length: 1_001 }, (_, index) =>
			fragment(index, `needle ${index}`),
		);
		const runtime = runtimeWithQuery(async () => rows);
		const stable = snapshot(rows);
		const items = rows.slice(0, 1_000);
		const last = items.at(-1);
		runtime.adapter.queryDocumentFragmentsPage.mockResolvedValue({
			items,
			snapshot: stable,
			hasMore: true,
			nextCursor: {
				id: last?.id as UUID,
				createdAt: last?.createdAt as number,
				snapshot: stable,
			},
		});

		await expect(
			service(runtime).searchDocuments(message("needle"), undefined, "keyword"),
		).rejects.toMatchObject({ code: "RETRIEVAL_PAGINATION_CONFLICT" });
	});

	it("rejects a nonterminal page that makes no progress", async () => {
		const row = fragment(0, "needle");
		const runtime = runtimeWithQuery(async () => [row]);
		const stable = snapshot([row]);
		runtime.adapter.queryDocumentFragmentsPage.mockResolvedValue({
			items: [],
			snapshot: stable,
			hasMore: true,
			nextCursor: {
				id: row.id as UUID,
				createdAt: row.createdAt as number,
				snapshot: stable,
			},
		});

		await expect(
			service(runtime).searchDocuments(message("needle"), undefined, "keyword"),
		).rejects.toMatchObject({ code: "RETRIEVAL_PAGE_INVALID" });
	});

	it("traverses the original keyset snapshot when a concurrent append prepends a row", async () => {
		const originals = Array.from({ length: 1_001 }, (_, index) =>
			fragment(index, `needle original ${index}`),
		);
		const appended = {
			...fragment(9_999, "needle appended"),
			createdAt: Date.now() + 1_000,
		};
		let current = originals;
		const runtime = runtimeWithQuery(async () => current);
		runtime.adapter.queryDocumentFragmentsPage.mockImplementation(
			async (params) => {
				const page = createStableRetrievalPage(current, {
					limit: params.limit,
					cursor: params.cursor,
					rankBySimilarity: false,
					queryFingerprint: stableRetrievalQueryFingerprint({
						kind: "test-concurrent-document-fragments",
					}),
				});
				current = [appended, ...originals];
				return page;
			},
		);

		const results = await service(runtime).searchDocuments(
			message("needle"),
			undefined,
			"keyword",
		);
		expect(results).toHaveLength(originals.length);
		expect(results.map((result) => result.id)).not.toContain(appended.id);
	});
});
