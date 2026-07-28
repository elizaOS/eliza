/**
 * Verifies strict document-list capability negotiation and integrity checks
 * without allowing legacy pagination behavior to fabricate exact results.
 */
import { describe, expect, it, vi } from "vitest";
import type { DocumentListQueryParams, Memory, UUID } from "../types";
import { MemoryType } from "../types";
import {
	queryDocumentsInMemory,
	queryDocumentsWithCapability,
} from "./document-list-query";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const AGENT_ID = "00000000-0000-0000-0000-00000000a9e7" as UUID;
const REQUESTER_ID = "00000000-0000-0000-0000-00000000c0de" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000d00d" as UUID;

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
		metadata: { type: MemoryType.DOCUMENT, timestamp: 1_000 + index },
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
			code: "DOCUMENT_LIST_QUERY_CAPABILITY_REQUIRED",
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
			code: "DOCUMENT_LIST_QUERY_CAPABILITY_REQUIRED",
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
			value: 2,
		});
		const queryDocuments = vi.spyOn(adapter, "queryDocuments");

		await expect(
			queryDocumentsWithCapability(adapter, params),
		).rejects.toMatchObject({
			code: "DOCUMENT_LIST_QUERY_CAPABILITY_REQUIRED",
			context: expect.objectContaining({
				expectedVersion: 1,
				advertisedVersion: 2,
			}),
		});
		expect(queryDocuments).not.toHaveBeenCalled();
	});
});
