/**
 * Verifies strict document-list capability negotiation and integrity checks
 * without allowing legacy pagination behavior to fabricate exact results.
 */
import { describe, expect, it, vi } from "vitest";
import type { DocumentListQueryParams, Memory, UUID } from "../types";
import { MemoryType } from "../types";
import {
	portableDocumentSearchTokens,
	queryDocumentsInMemory,
	queryDocumentsWithCapability,
} from "./document-list-query";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const AGENT_ID = "00000000-0000-0000-0000-00000000a9e7" as UUID;
const REQUESTER_ID = "00000000-0000-0000-0000-00000000c0de" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000d00d" as UUID;
const OTHER_ROOM_ID = "00000000-0000-0000-0000-00000000d00e" as UUID;

const params: DocumentListQueryParams = {
	agentId: AGENT_ID,
	requesterEntityId: REQUESTER_ID,
	requesterRoomIds: [],
	requesterRole: "RUNTIME",
	limit: 25,
	offset: 0,
};

function document(index: number): Memory {
	const id =
		`10000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}` as UUID;
	return {
		id,
		agentId: AGENT_ID,
		entityId: REQUESTER_ID,
		roomId: ROOM_ID,
		createdAt: 1_000 + index,
		content: { text: `Document ${index}` },
		metadata: {
			type: MemoryType.DOCUMENT,
			scope: "global",
			timestamp: 1_000 + index,
		},
	};
}

describe("document-list capability contract", () => {
	it("fails before reading a legacy adapter whose 50-row cap would truncate 125 rows", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		Object.defineProperty(adapter, "documentListQueryCapability", {
			configurable: true,
			value: undefined,
		});
		const corpus = Array.from({ length: 125 }, (_, index) => document(index));
		const getMemories = vi
			.spyOn(adapter, "getMemories")
			.mockResolvedValue(corpus.slice(0, 50));

		await expect(
			queryDocumentsWithCapability(adapter, params),
		).rejects.toMatchObject({
			code: "DOCUMENT_STORE_CAPABILITY_REQUIRED",
		});
		expect(getMemories).not.toHaveBeenCalled();
	});

	it("does not enter a scan that can change underneath a concurrent insert", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		Object.defineProperty(adapter, "documentListQueryCapability", {
			configurable: true,
			value: undefined,
		});
		let reads = 0;
		const getMemories = vi
			.spyOn(adapter, "getMemories")
			.mockImplementation(async () => {
				reads += 1;
				return [document(reads)];
			});

		await expect(
			queryDocumentsWithCapability(adapter, params),
		).rejects.toMatchObject({
			code: "DOCUMENT_STORE_CAPABILITY_REQUIRED",
		});
		expect(getMemories).not.toHaveBeenCalled();
		expect(reads).toBe(0);
	});

	it("rejects duplicate document IDs instead of counting duplicate rows", () => {
		const duplicate = document(1);
		expect(() =>
			queryDocumentsInMemory([duplicate, { ...duplicate }], params),
		).toThrow(
			expect.objectContaining({
				code: "DOCUMENT_LIST_DUPLICATE_MEMORY",
			}),
		);
	});

	it("rejects malformed cursors before invoking a native adapter", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const queryDocuments = vi.spyOn(adapter, "queryDocuments");

		await expect(
			queryDocumentsWithCapability(adapter, {
				...params,
				cursor: { createdAt: 1_000, id: "not-a-uuid" as UUID },
			}),
		).rejects.toMatchObject({
			code: "DOCUMENT_LIST_INVALID_PAGINATION",
		});
		expect(queryDocuments).not.toHaveBeenCalled();
	});

	it("rejects wrong capability versions even when a query method exists", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		Object.defineProperty(adapter, "documentListQueryCapability", {
			configurable: true,
			value: 3,
		});
		const queryDocuments = vi.spyOn(adapter, "queryDocuments");

		await expect(
			queryDocumentsWithCapability(adapter, params),
		).rejects.toMatchObject({
			code: "DOCUMENT_STORE_CAPABILITY_REQUIRED",
			context: expect.objectContaining({
				expectedVersion: 2,
				advertisedVersion: 3,
			}),
		});
		expect(queryDocuments).not.toHaveBeenCalled();
	});

	it("fails closed on missing, unknown, and structurally invalid scopes", () => {
		const malformed = [
			{ ...document(1), metadata: { type: MemoryType.DOCUMENT } },
			{
				...document(2),
				metadata: { type: MemoryType.DOCUMENT, scope: "public" },
			},
			{
				...document(3),
				metadata: {
					type: MemoryType.DOCUMENT,
					scope: "user-private",
					scopedToEntityId: "not-a-uuid",
				},
			},
		];
		for (const requesterRole of [
			"OWNER",
			"RUNTIME",
			"AGENT",
			"ADMIN",
			"USER",
		] as const) {
			expect(
				queryDocumentsInMemory(malformed, {
					...params,
					requesterRole,
					requesterRoomIds: [ROOM_ID],
				}).documents,
			).toEqual([]);
		}
	});

	it("keeps ADMIN room-wide user-private access distinct from USER ownership", () => {
		const owned = {
			...document(1),
			metadata: {
				type: MemoryType.DOCUMENT,
				scope: "user-private",
				scopedToEntityId: REQUESTER_ID,
			},
		};
		const otherId = "00000000-0000-0000-0000-00000000beef" as UUID;
		const other = {
			...document(2),
			metadata: {
				type: MemoryType.DOCUMENT,
				scope: "user-private",
				scopedToEntityId: otherId,
			},
		};
		const user = queryDocumentsInMemory([owned, other], {
			...params,
			requesterRole: "USER",
			requesterRoomIds: [ROOM_ID],
		});
		const admin = queryDocumentsInMemory([owned, other], {
			...params,
			requesterRole: "ADMIN",
			requesterRoomIds: [ROOM_ID],
		});
		expect(user.documents.map((memory) => memory.id)).toEqual([owned.id]);
		expect(new Set(admin.documents.map((memory) => memory.id))).toEqual(
			new Set([owned.id, other.id]),
		);
	});

	it("keeps global reads agent-wide while private reads remain room-scoped", () => {
		const globalOtherRoom = { ...document(1), roomId: OTHER_ROOM_ID };
		const privateOtherRoom = {
			...document(2),
			roomId: OTHER_ROOM_ID,
			metadata: {
				type: MemoryType.DOCUMENT,
				scope: "user-private",
				scopedToEntityId: REQUESTER_ID,
			},
		};

		for (const requesterRole of ["USER", "ADMIN"] as const) {
			const result = queryDocumentsInMemory(
				[globalOtherRoom, privateOtherRoom],
				{
					...params,
					requesterRole,
					requesterRoomIds: [ROOM_ID],
				},
			);
			expect(result.documents.map((memory) => memory.id)).toEqual([
				globalOtherRoom.id,
			]);
		}
	});

	it("uses locale-independent tokens that preserve punctuation and Unicode", () => {
		expect(
			portableDocumentSearchTokens(
				"Test.User+Tag@Example.COM v1.2.3 https://Example.com/a?b=c#d C++ 東京 İ",
			),
		).toEqual([
			"test.user+tag@example.com",
			"v1.2.3",
			"https://example.com/a?b=c#d",
			"c++",
			"東京",
			"İ",
		]);
	});

	it("anchors keyset traversal against newer concurrent inserts", () => {
		const original = Array.from({ length: 5 }, (_, index) => document(index));
		const first = queryDocumentsInMemory(original, { ...params, limit: 2 });
		expect(first.nextCursor).toMatchObject({
			snapshotCreatedAt: 1_004,
			snapshotId: original[4]?.id,
		});
		const inserted = document(99);
		const seen = [...first.documents];
		let cursor = first.nextCursor;
		while (cursor) {
			const page = queryDocumentsInMemory([...original, inserted], {
				...params,
				limit: 2,
				cursor,
			});
			seen.push(...page.documents);
			cursor = page.nextCursor;
		}
		expect(new Set(seen.map((memory) => memory.id))).toEqual(
			new Set(original.map((memory) => memory.id)),
		);
		expect(seen.map((memory) => memory.id)).not.toContain(inserted.id);
	});
});
