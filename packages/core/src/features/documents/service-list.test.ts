/**
 * Exercises document-list filtering and pagination through a real AgentRuntime,
 * DocumentService, and InMemoryDatabaseAdapter with persisted memory records.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import {
	type AccessContext,
	type Character,
	type Memory,
	MemoryType,
	ModelType,
	type Room,
	type UUID,
	type World,
} from "../../types";
import { DocumentService } from "./service";

const AGENT_ID = "00000000-0000-0000-0000-00000000a9e7" as UUID;
const OTHER_AGENT_ID = "00000000-0000-0000-0000-00000000b0b0" as UUID;
const USER_ID = "00000000-0000-0000-0000-00000000c0de" as UUID;
const OTHER_USER_ID = "00000000-0000-0000-0000-00000000face" as UUID;
const ROOM_A = "00000000-0000-0000-0000-00000000d00d" as UUID;
const ROOM_B = "00000000-0000-0000-0000-00000000d00e" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-00000000abcd" as UUID;

async function makeHarness(): Promise<{
	adapter: InMemoryDatabaseAdapter;
	runtime: AgentRuntime;
	service: DocumentService;
}> {
	const adapter = new InMemoryDatabaseAdapter();
	await adapter.initialize();
	const runtime = new AgentRuntime({
		agentId: AGENT_ID,
		character: {
			name: "DocumentListIntegrationAgent",
			bio: "Exercises document list storage semantics.",
			settings: {},
		} as Character,
		adapter,
		logLevel: "fatal",
	});
	await adapter.createRoomParticipants([AGENT_ID, USER_ID], ROOM_A);
	await adapter.createRoomParticipants([AGENT_ID, USER_ID], ROOM_B);
	return {
		adapter,
		runtime,
		service: new DocumentService(runtime),
	};
}

function documentMemory(
	index: number,
	overrides: Partial<Memory> & {
		metadata?: Record<string, unknown>;
	} = {},
): Memory {
	const { metadata, ...memoryOverrides } = overrides;
	const id =
		`10000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}` as UUID;
	return {
		id,
		agentId: AGENT_ID,
		entityId: AGENT_ID,
		roomId: index % 2 === 0 ? ROOM_A : ROOM_B,
		worldId: WORLD_ID,
		createdAt: 1_000,
		content: { text: `Document body ${index}` },
		metadata: {
			type: MemoryType.DOCUMENT,
			documentId: id,
			title: `Document ${index}`,
			scope: "global",
			tags: ["archive"],
			...metadata,
		},
		...memoryOverrides,
	} as Memory;
}

async function seedDocuments(
	runtime: AgentRuntime,
	documents: Memory[],
): Promise<void> {
	await runtime.createMemories(
		documents.map((memory) => ({ memory, tableName: "documents" })),
	);
}

function userMessage(): Memory {
	return {
		id: "20000000-0000-0000-0000-000000000001" as UUID,
		agentId: AGENT_ID,
		entityId: USER_ID,
		roomId: ROOM_A,
		worldId: WORLD_ID,
		createdAt: 2_000,
		content: { text: "list documents" },
	};
}

describe("DocumentService list semantics", () => {
	it("excludes room documents immediately after membership revocation", async () => {
		const { adapter, runtime, service } = await makeHarness();
		const revocationUserId =
			"00000000-0000-0000-0000-00000000cafe" as UUID;
		const revocationRoomId =
			"00000000-0000-0000-0000-00000000da7a" as UUID;
		await adapter.createRoomParticipants(
			[AGENT_ID, revocationUserId],
			revocationRoomId,
		);
		const roomDocument = documentMemory(700, { roomId: revocationRoomId });
		await seedDocuments(runtime, [roomDocument]);
		const accessContext = {
			requesterEntityId: revocationUserId,
			role: "USER",
			isOwner: false,
		} satisfies AccessContext;

		await expect(
			service.listAllDocumentsWithAccessContext(accessContext),
		).resolves.toMatchObject([{ id: roomDocument.id }]);
		await adapter.deleteParticipants([
			{ entityId: revocationUserId, roomId: revocationRoomId },
		]);
		await expect(
			service.listAllDocumentsWithAccessContext(accessContext),
		).resolves.toEqual([]);
	});

	it("adds and updates keyword-searchable documents without an embedding model", async () => {
		const { runtime, service } = await makeHarness();
		expect(runtime.getModel(ModelType.TEXT_EMBEDDING)).toBeUndefined();

		const added = await service.addDocument({
			agentId: AGENT_ID,
			worldId: WORLD_ID,
			roomId: ROOM_A,
			entityId: AGENT_ID,
			clientDocumentId: "" as UUID,
			contentType: "text/plain",
			originalFilename: "keyword-only.txt",
			content: "Original keyword-only draft body",
			scope: "agent-private",
			scopedToEntityId: AGENT_ID,
			addedBy: AGENT_ID,
			addedByRole: "RUNTIME",
			addedFrom: "runtime-internal",
		});
		expect(added.fragmentCount).toBe(1);

		await expect(
			service.updateDocument({
				documentId: added.storedDocumentMemoryId,
				content: "Revised keyword-only standing draft",
			}),
		).resolves.toEqual({
			documentId: added.storedDocumentMemoryId,
			fragmentCount: 1,
		});

		const stored = await service.getDocumentById(added.storedDocumentMemoryId);
		expect(stored?.content.text).toBe("Revised keyword-only standing draft");
		const fragments = await runtime.getMemories({
			tableName: "document_fragments",
			agentId: AGENT_ID,
			roomId: ROOM_A,
			count: 10,
		});
		expect(fragments).toHaveLength(1);
		expect(fragments[0]).toMatchObject({
			content: { text: "Revised keyword-only standing draft" },
			metadata: { documentId: added.storedDocumentMemoryId },
		});
		expect(fragments[0]?.embedding).toBeUndefined();
	});

	it("filters and paginates through one bounded adapter query", async () => {
		const { runtime, service } = await makeHarness();
		const documents = Array.from({ length: 75 }, (_, index) =>
			documentMemory(
				index,
				index === 0 ? { content: { text: "Deep archive needle" } } : undefined,
			),
		);
		await seedDocuments(runtime, documents);
		await seedDocuments(runtime, [
			documentMemory(999, {
				agentId: OTHER_AGENT_ID,
				content: { text: "Other agent needle" },
			}),
		]);

		const queryResult = await service.listDocumentsDetailed(undefined, {
			query: "needle",
			limit: 10,
		});
		expect(queryResult).toMatchObject({
			status: "ok",
			totalVisible: 75,
			totalAvailable: 75,
			totalMatched: 1,
			offset: 0,
			hasMore: false,
		});
		expect(queryResult.documents.map((document) => document.id)).toEqual([
			documents[0]?.id,
		]);

		const page = await service.listDocumentsDetailed(undefined, {
			query: "document",
			limit: 10,
			offset: 60,
		});
		expect(page).toMatchObject({
			status: "ok",
			totalMatched: 75,
			offset: 60,
			hasMore: true,
		});
		expect(page.documents).toHaveLength(10);

		const exhausted = await service.listDocumentsDetailed(undefined, {
			query: "document",
			limit: 10,
			offset: 75,
		});
		expect(exhausted).toMatchObject({
			status: "page_exhausted",
			totalMatched: 75,
			offset: 75,
			hasMore: false,
			documents: [],
			availableDocuments: [],
		});
	});

	it("returns query alternatives separately from matched documents", async () => {
		const { runtime, service } = await makeHarness();
		const documents = Array.from({ length: 60 }, (_, index) =>
			documentMemory(index),
		);
		await seedDocuments(runtime, documents);

		const result = await service.listDocumentsDetailed(undefined, {
			query: "does-not-exist",
			limit: 5,
			offset: 55,
		});
		expect(result).toMatchObject({
			status: "query_miss",
			totalVisible: 60,
			totalAvailable: 60,
			totalMatched: 0,
			offset: 55,
			documents: [],
			availableOffset: 55,
			availableHasMore: false,
		});
		expect(result.availableDocuments.map((document) => document.id)).toEqual(
			documents
				.slice(0, 5)
				.reverse()
				.map((document) => document.id),
		);
		await expect(
			service.listDocuments(undefined, {
				query: "does-not-exist",
				limit: 5,
				offset: 55,
			}),
		).resolves.toEqual([]);
	});

	it("uses id as the keyset tiebreaker when timestamps are equal", async () => {
		const { runtime, service } = await makeHarness();
		const documents = Array.from({ length: 151 }, (_, index) =>
			documentMemory(index),
		);
		await seedDocuments(runtime, documents);

		const seen: UUID[] = [];
		let cursor: Awaited<
			ReturnType<DocumentService["listDocumentsDetailed"]>
		>["nextCursor"];
		do {
			const page = await service.listDocumentsDetailed(undefined, {
				limit: 37,
				...(cursor ? { cursor } : {}),
			});
			seen.push(
				...page.documents
					.map((document) => document.id)
					.filter((id): id is UUID => typeof id === "string"),
			);
			cursor = page.nextCursor;
			if (!page.hasMore) break;
			expect(cursor).toBeDefined();
		} while (cursor);

		expect(seen).toHaveLength(151);
		expect(new Set(seen).size).toBe(151);
		expect(seen).toEqual(
			documents
				.map((document) => document.id)
				.filter((id): id is UUID => typeof id === "string")
				.sort((a, b) => b.localeCompare(a)),
		);
	});

	it("keeps large-corpus work inside one adapter query and resolves role once", async () => {
		const { adapter, runtime, service } = await makeHarness();
		await seedDocuments(
			runtime,
			Array.from({ length: 1_000 }, (_, index) => documentMemory(index)),
		);
		const getMemories = vi.spyOn(adapter, "getMemories");
		const queryDocuments = vi.spyOn(adapter, "queryDocuments");
		const getRoom = vi.spyOn(runtime, "getRoom").mockResolvedValue({
			id: ROOM_A,
			agentId: AGENT_ID,
			worldId: WORLD_ID,
		} as Room);
		const getWorld = vi.spyOn(runtime, "getWorld").mockResolvedValue({
			id: WORLD_ID,
			agentId: AGENT_ID,
			metadata: { roles: { [USER_ID]: "USER" } },
		} as World);

		const result = await service.listDocumentsDetailed(userMessage(), {
			limit: 25,
		});

		expect(result.documents).toHaveLength(25);
		expect(result.totalVisible).toBe(1_000);
		expect(queryDocuments).toHaveBeenCalledTimes(1);
		expect(getMemories).not.toHaveBeenCalled();
		expect(getRoom).toHaveBeenCalledTimes(1);
		expect(getWorld).toHaveBeenCalledTimes(1);
	});

	it("composes visible pinned documents beyond the recent page without leaking private pins", async () => {
		const { runtime, service } = await makeHarness();
		const documents = Array.from({ length: 126 }, (_, index) =>
			documentMemory(index, { metadata: { pinned: index === 0 } }),
		);
		const privatePinned = documentMemory(999, {
			roomId: ROOM_A,
			metadata: { pinned: true, scope: "owner-private" },
		});
		await seedDocuments(runtime, [...documents, privatePinned]);

		const composed = await service.composeProviderDocuments(userMessage(), {
			limit: 25,
		});

		expect(composed.documents).toHaveLength(25);
		expect(composed.documents).not.toContainEqual(documents[0]);
		expect(composed.pinnedDocuments.map((document) => document.id)).toEqual([
			documents[0]?.id,
		]);
		expect(composed.pinnedDocuments).not.toContainEqual(privatePinned);
	});

	it("fails fast for adapters without the exact native capability", async () => {
		const { adapter, runtime, service } = await makeHarness();
		await seedDocuments(
			runtime,
			Array.from({ length: 125 }, (_, index) => documentMemory(index)),
		);
		Object.defineProperty(adapter, "documentListQueryCapability", {
			configurable: true,
			value: undefined,
		});
		const nativeQuery = vi.spyOn(adapter, "queryDocuments");
		const getMemories = vi.spyOn(adapter, "getMemories");

		await expect(
			service.listDocumentsDetailed(undefined, {
				limit: 25,
				offset: 100,
			}),
		).rejects.toMatchObject({
			code: "DOCUMENT_STORE_CAPABILITY_REQUIRED",
		});
		expect(nativeQuery).not.toHaveBeenCalled();
		expect(getMemories).not.toHaveBeenCalled();
	});

	it("keeps privileged roles global while USER remains room-limited", async () => {
		const { adapter, runtime, service } = await makeHarness();
		await adapter.deleteParticipants([{ entityId: USER_ID, roomId: ROOM_B }]);
		const roomADocument = documentMemory(2);
		const roomBDocument = documentMemory(3);
		await seedDocuments(runtime, [roomADocument, roomBDocument]);
		const getRoomsForParticipants = vi.spyOn(
			runtime,
			"getRoomsForParticipants",
		);
		vi.spyOn(runtime, "getRoom").mockResolvedValue({
			id: ROOM_A,
			agentId: AGENT_ID,
			worldId: WORLD_ID,
		} as Room);
		const getWorld = vi.spyOn(runtime, "getWorld");

		getWorld.mockResolvedValue({
			id: WORLD_ID,
			agentId: AGENT_ID,
			metadata: { roles: { [USER_ID]: "USER" } },
		} as World);
		const userResult = await service.listDocumentsDetailed(userMessage());

		getWorld.mockResolvedValue({
			id: WORLD_ID,
			agentId: AGENT_ID,
			metadata: {
				roles: { [USER_ID]: "OWNER" },
				roleSources: { [USER_ID]: "manual" },
			},
		} as World);
		const ownerResult = await service.listDocumentsDetailed(userMessage());
		const runtimeResult = await service.listDocumentsDetailed();
		const agentResult = await service.listDocumentsDetailed({
			...userMessage(),
			entityId: AGENT_ID,
		});

		expect(userResult.documents.map((memory) => memory.id)).toEqual([
			roomADocument.id,
		]);
		for (const result of [ownerResult, runtimeResult, agentResult]) {
			expect(new Set(result.documents.map((memory) => memory.id))).toEqual(
				new Set([roomADocument.id, roomBDocument.id]),
			);
			expect(result.totalVisible).toBe(2);
		}
		expect(getRoomsForParticipants).toHaveBeenCalledTimes(1);
	});

	it("matches room-scoped RLS semantics and ignores non-document rows", async () => {
		const { adapter, runtime, service } = await makeHarness();
		await adapter.deleteParticipants([{ entityId: USER_ID, roomId: ROOM_B }]);
		const roomADocument = documentMemory(2);
		const roomBDocument = documentMemory(3);
		const fragment = documentMemory(4, {
			metadata: {
				type: MemoryType.FRAGMENT,
				documentId: roomADocument.id,
				position: 0,
			},
		});
		await seedDocuments(runtime, [roomADocument, roomBDocument, fragment]);
		vi.spyOn(runtime, "getRoom").mockResolvedValue({
			id: ROOM_A,
			agentId: AGENT_ID,
			worldId: WORLD_ID,
		} as Room);
		vi.spyOn(runtime, "getWorld").mockResolvedValue({
			id: WORLD_ID,
			agentId: AGENT_ID,
			metadata: { roles: { [USER_ID]: "USER" } },
		} as World);

		const userResult = await service.listDocumentsDetailed(userMessage());
		const runtimeResult = await service.listDocumentsDetailed();

		expect(userResult.totalVisible).toBe(1);
		expect(userResult.documents.map((document) => document.id)).toEqual([
			roomADocument.id,
		]);
		expect(runtimeResult.totalVisible).toBe(2);
		expect(runtimeResult.documents.map((document) => document.id)).toEqual([
			roomBDocument.id,
			roomADocument.id,
		]);
	});

	it("does not expose foreign-agent or non-document rows through delete errors", async () => {
		const { runtime, service } = await makeHarness();
		const hiddenDocument = documentMemory(20, {
			entityId: OTHER_USER_ID,
			metadata: { scope: "owner-private" },
		});
		const foreignDocument = documentMemory(21, {
			agentId: OTHER_AGENT_ID,
		});
		const nonDocument = documentMemory(22, {
			metadata: {
				type: MemoryType.FRAGMENT,
				documentId: hiddenDocument.id,
				position: 0,
			},
		});
		await seedDocuments(runtime, [
			hiddenDocument,
			foreignDocument,
			nonDocument,
		]);
		vi.spyOn(runtime, "getRoom").mockResolvedValue({
			id: ROOM_A,
			agentId: AGENT_ID,
			worldId: WORLD_ID,
		} as Room);
		vi.spyOn(runtime, "getWorld").mockResolvedValue({
			id: WORLD_ID,
			agentId: AGENT_ID,
			metadata: { roles: { [USER_ID]: "USER" } },
		} as World);

		await expect(
			service.deleteDocument(hiddenDocument.id as UUID, userMessage()),
		).rejects.toMatchObject({ code: "DOCUMENT_MUTATION_FORBIDDEN" });
		for (const memory of [foreignDocument, nonDocument]) {
			await expect(
				service.deleteDocument(memory.id as UUID, userMessage()),
			).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
		}
	});

	it("rejects offsets and query inputs outside the bounded contract", async () => {
		const { service } = await makeHarness();

		await expect(
			service.listDocumentsDetailed(undefined, { offset: 10_001 }),
		).rejects.toMatchObject({
			code: "DOCUMENT_LIST_INVALID_PAGINATION",
		});
		await expect(
			service.listDocumentsDetailed(undefined, { offset: 1.5 }),
		).rejects.toMatchObject({
			code: "DOCUMENT_LIST_INVALID_PAGINATION",
		});
		await expect(
			service.listDocumentsDetailed(undefined, { query: "x".repeat(513) }),
		).rejects.toMatchObject({
			code: "DOCUMENT_LIST_INVALID_PAGINATION",
		});
	});

	it("reports and throws a typed role lookup failure", async () => {
		const { runtime, service } = await makeHarness();
		vi.spyOn(runtime, "getRoom").mockRejectedValue(
			new Error("role storage unavailable"),
		);

		await expect(
			service.listDocumentsDetailed(userMessage()),
		).rejects.toMatchObject({
			name: "ElizaError",
			code: "DOCUMENT_ROLE_LOOKUP_FAILED",
			cause: expect.any(Error),
		});
		expect(runtime.getRecentReportedErrors()).toContainEqual(
			expect.objectContaining({
				scope: "DocumentService.resolveRequesterRole",
				code: "DOCUMENT_ROLE_LOOKUP_FAILED",
			}),
		);
	});

	it("reports and throws a typed participant-room lookup failure", async () => {
		const { runtime, service } = await makeHarness();
		vi.spyOn(runtime, "getRoomsForParticipants").mockRejectedValue(
			new Error("participant storage unavailable"),
		);

		vi.spyOn(runtime, "getRoom").mockResolvedValue({
			id: ROOM_A,
			agentId: AGENT_ID,
			worldId: WORLD_ID,
		} as Room);
		vi.spyOn(runtime, "getWorld").mockResolvedValue({
			id: WORLD_ID,
			agentId: AGENT_ID,
			metadata: { roles: { [USER_ID]: "USER" } },
		} as World);

		await expect(
			service.listDocumentsDetailed(userMessage()),
		).rejects.toMatchObject({
			name: "ElizaError",
			code: "DOCUMENT_ROOM_LOOKUP_FAILED",
			cause: expect.any(Error),
		});
		expect(runtime.getRecentReportedErrors()).toContainEqual(
			expect.objectContaining({
				scope: "DocumentService.resolveRequesterRooms",
				code: "DOCUMENT_ROOM_LOOKUP_FAILED",
			}),
		);
	});

	it("applies visibility before classifying filter misses", async () => {
		const { runtime, service } = await makeHarness();
		const hiddenDocuments = Array.from({ length: 55 }, (_, index) =>
			documentMemory(index + 10, {
				entityId: OTHER_USER_ID,
				metadata: { scope: "owner-private" },
			}),
		);
		await seedDocuments(runtime, [
			...hiddenDocuments,
			documentMemory(1),
			documentMemory(3, {
				entityId: USER_ID,
				metadata: {
					scope: "user-private",
					scopedToEntityId: USER_ID,
				},
			}),
			documentMemory(4, {
				entityId: OTHER_USER_ID,
				metadata: {
					scope: "user-private",
					scopedToEntityId: OTHER_USER_ID,
				},
			}),
		]);

		const result = await service.listDocumentsDetailed(userMessage(), {
			tags: ["missing-tag"],
		});
		expect(result).toMatchObject({
			status: "filter_miss",
			totalVisible: 2,
			totalAvailable: 0,
			totalMatched: 0,
			documents: [],
			availableDocuments: [],
		});
	});

	it("reports an empty store only when no documents are visible", async () => {
		const { service } = await makeHarness();

		await expect(
			service.listDocumentsDetailed(userMessage(), { query: "anything" }),
		).resolves.toMatchObject({
			status: "empty_store",
			totalVisible: 0,
			totalAvailable: 0,
			totalMatched: 0,
			documents: [],
			availableDocuments: [],
		});
	});
});
