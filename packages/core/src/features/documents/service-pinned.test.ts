/**
 * Exercises document pin/unpin authorization through a real AgentRuntime,
 * DocumentService, and InMemoryDatabaseAdapter with persisted memory records:
 * mutation policy (owner vs non-mutator), CAS conflict on concurrent revision
 * change, and no-access-grant semantics (a pinned document stays invisible to
 * a requester without visibility).
 */
import { describe, expect, it } from "vitest";
import { DatabaseAdapter } from "../../database";
import { readDocumentMutationSnapshot } from "../../database/document-list-query";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import {
	type AccessContext,
	type Character,
	type Memory,
	MemoryType,
	type UUID,
} from "../../types";
import { DocumentService } from "./service";

const AGENT_ID = "10000000-0000-4000-8000-0000000000a1" as UUID;
const OWNER_ID = "10000000-0000-4000-8000-0000000000b2" as UUID;
const OTHER_USER_ID = "10000000-0000-4000-8000-0000000000c3" as UUID;
const ROOM_A = "10000000-0000-4000-8000-0000000000e5" as UUID;
const WORLD_ID = "10000000-0000-4000-8000-0000000000f6" as UUID;
const PINNED_DOC_ID = "10000000-0000-4000-8000-000000001111" as UUID;
const OWNER_DOC_ID = "10000000-0000-4000-8000-000000002222" as UUID;
const GLOBAL_DOC_ID = "10000000-0000-4000-8000-000000003333" as UUID;

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
			name: "DocumentPinIntegrationAgent",
			bio: "Exercises document pin storage semantics.",
			settings: {},
		} as Character,
		adapter,
		logLevel: "fatal",
	});
	await adapter.createRoomParticipants(
		[AGENT_ID, OWNER_ID, OTHER_USER_ID],
		ROOM_A,
	);
	await adapter.createEntities([
		{ id: AGENT_ID, names: ["agent"], agentId: AGENT_ID } as never,
		{ id: OWNER_ID, names: ["owner"], agentId: AGENT_ID } as never,
		{ id: OTHER_USER_ID, names: ["other"], agentId: AGENT_ID } as never,
	]);
	return { adapter, runtime, service: new DocumentService(runtime) };
}

function documentMemory(
	id: UUID,
	text: string,
	options: {
		entityId?: UUID;
		scope?: "global" | "owner-private" | "user-private";
	} = {},
): Memory {
	const entityId = options.entityId ?? OWNER_ID;
	const scope = options.scope ?? "user-private";
	const filename = `${id}.txt`;
	return {
		id,
		agentId: AGENT_ID,
		entityId,
		roomId: ROOM_A,
		worldId: WORLD_ID,
		createdAt: 1_000,
		content: { text },
		metadata: {
			type: MemoryType.DOCUMENT,
			documentId: id,
			documentRevision: 0,
			scope,
			scopedToEntityId: entityId,
			addedBy: entityId,
			addedByRole: "OWNER",
			addedFrom: "upload",
			addedAt: 1_000,
			source: "test",
			title: `Title ${id}`,
			filename,
			originalFilename: filename,
			fileExt: "txt",
			fileType: "text/plain",
			contentType: "text/plain",
			fileSize: Buffer.byteLength(text, "utf8"),
			textBacked: true,
			timestamp: 1_000,
		},
	} as Memory;
}

async function seedDocuments(
	runtime: AgentRuntime,
	adapter: InMemoryDatabaseAdapter,
) {
	await runtime.createMemories([
		{
			memory: documentMemory(PINNED_DOC_ID, "PINNED BODY SENTINEL"),
			tableName: "documents",
		},
		{
			memory: documentMemory(OWNER_DOC_ID, "OWNER DOC BODY"),
			tableName: "documents",
		},
		{
			// Global + visible in ROOM_A to OTHER_USER, but USER cannot mutate
			// non-user-private scopes (canRequesterMutateDocument).
			memory: documentMemory(GLOBAL_DOC_ID, "GLOBAL DOC BODY", {
				scope: "global",
			}),
			tableName: "documents",
		},
	]);
	// Room participants gate requester room ids at the service layer; the
	// adapter's in-memory participants set matches the service expectations.
	void adapter;
}

const ownerContext: AccessContext = {
	requesterEntityId: OWNER_ID,
	role: "OWNER",
	isOwner: true,
};
const otherUserContext: AccessContext = {
	requesterEntityId: OTHER_USER_ID,
	role: "USER",
	isOwner: false,
};

async function getStoredDocument(
	adapter: InMemoryDatabaseAdapter,
	documentId: UUID,
): Promise<Memory | null> {
	return adapter.getDocument({
		agentId: AGENT_ID,
		documentId,
		requesterEntityId: OWNER_ID,
		requesterRoomIds: [ROOM_A],
		requesterRole: "OWNER",
	});
}

describe("DocumentService pin management", () => {
	it("pins and unpins a document through the service + adapter CAS path", async () => {
		const { adapter, runtime, service } = await makeHarness();
		await seedDocuments(runtime, adapter);

		await expect(
			service.setDocumentPinnedWithAccessContext(
				PINNED_DOC_ID,
				true,
				ownerContext,
			),
		).resolves.toMatchObject({
			id: PINNED_DOC_ID,
			metadata: expect.objectContaining({ pinned: true }),
		});

		const pinned = await getStoredDocument(adapter, PINNED_DOC_ID);
		expect(pinned?.metadata).toMatchObject({ pinned: true });

		await expect(
			service.setDocumentPinnedWithAccessContext(
				PINNED_DOC_ID,
				false,
				ownerContext,
			),
		).resolves.toMatchObject({
			id: PINNED_DOC_ID,
		});
		const unpinned = await getStoredDocument(adapter, PINNED_DOC_ID);
		expect(
			unpinned?.metadata && "pinned" in unpinned.metadata
				? unpinned.metadata.pinned
				: undefined,
		).not.toBe(true);
	});

	it("rejects with DOCUMENT_PIN_UNSUPPORTED when a legacy adapter inherits the base method", async () => {
		// Real legacy-adapter regression (#23103 r3): an adapter that never
		// overrode updateDocumentPinned still carries the method (so the
		// presence check passes) but resolves to the DatabaseAdapter base —
		// the service must surface the typed unsupported capability, never
		// a fabricated not_found. Simulate by installing the base method as
		// an own property, matching a pre-pin subclass's inherited shape.
		const { adapter, runtime, service } = await makeHarness();
		Object.defineProperty(adapter, "updateDocumentPinned", {
			value: DatabaseAdapter.prototype.updateDocumentPinned,
			writable: true,
			enumerable: false,
			configurable: true,
		});
		await seedDocuments(runtime, adapter);

		await expect(
			service.setDocumentPinnedWithAccessContext(
				PINNED_DOC_ID,
				true,
				ownerContext,
			),
		).rejects.toMatchObject({ code: "DOCUMENT_PIN_UNSUPPORTED" });
	});

	it("rejects a pin from a requester who can see but not mutate the document", async () => {
		const { adapter, runtime, service } = await makeHarness();
		await seedDocuments(runtime, adapter);

		// Sanity: the global doc IS visible to the USER requester (same room).
		await expect(
			adapter.getDocument({
				agentId: AGENT_ID,
				documentId: GLOBAL_DOC_ID,
				requesterEntityId: OTHER_USER_ID,
				requesterRoomIds: [ROOM_A],
				requesterRole: "USER",
			}),
		).resolves.toMatchObject({ id: GLOBAL_DOC_ID });

		await expect(
			service.setDocumentPinnedWithAccessContext(
				GLOBAL_DOC_ID,
				true,
				otherUserContext,
			),
		).rejects.toMatchObject({ code: "DOCUMENT_MUTATION_FORBIDDEN" });

		const stored = await getStoredDocument(adapter, GLOBAL_DOC_ID);
		expect(stored?.metadata).not.toMatchObject({ pinned: true });
	});

	it("maps a missing document to DOCUMENT_NOT_FOUND", async () => {
		const { adapter, runtime, service } = await makeHarness();
		await seedDocuments(runtime, adapter);
		const unknown = "10000000-0000-4000-8000-000000009999" as UUID;

		await expect(
			service.setDocumentPinnedWithAccessContext(unknown, true, ownerContext),
		).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
	});

	it("rejects with conflict when an authorization field moves between read and write", async () => {
		const { adapter, runtime, service } = await makeHarness();
		await seedDocuments(runtime, adapter);

		// Take the mutation snapshot (revision N, no grants), then change a
		// snapshotted authorization field (direct grants) before the pin CAS
		// write lands — the stale snapshot must no longer match.
		const beforePin = await getStoredDocument(adapter, PINNED_DOC_ID);
		const staleSnapshot = readDocumentMutationSnapshot(beforePin as Memory);
		expect(staleSnapshot).not.toBeNull();

		await service.setDocumentDirectGrantsWithAccessContext(
			PINNED_DOC_ID,
			[OTHER_USER_ID],
			ownerContext,
		);

		const raced = await adapter.updateDocumentPinned({
			agentId: AGENT_ID,
			requesterEntityId: OWNER_ID,
			requesterRoomIds: [ROOM_A],
			requesterRole: "OWNER",
			documentId: PINNED_DOC_ID,
			expected: staleSnapshot as never,
			expectedPinned: false,
			pinned: true,
		});
		expect(raced.status).toBe("conflict");
	});

	it("never grants access: a pinned document stays invisible to an unauthorized requester", async () => {
		const { adapter, runtime, service } = await makeHarness();
		await seedDocuments(runtime, adapter);
		await service.setDocumentPinnedWithAccessContext(
			PINNED_DOC_ID,
			true,
			ownerContext,
		);

		const visible = await adapter.getDocument({
			agentId: AGENT_ID,
			documentId: PINNED_DOC_ID,
			requesterEntityId: OTHER_USER_ID,
			requesterRoomIds: [],
			requesterRole: "USER",
		});
		expect(visible).toBeNull();
	});

	it("loses a pin race at the adapter CAS layer: conflicting expectedPinned yields conflict, matching observed state succeeds", async () => {
		// Reviewer-requested two-writer semantics (#23103) at the core
		// adapter: a writer whose observed pin bit no longer matches the
		// stored bit gets a typed conflict even with a CURRENT
		// authorization snapshot — the pin bit is its own CAS dimension.
		const { adapter, runtime, service } = await makeHarness();
		await seedDocuments(runtime, adapter);

		// First writer pins successfully.
		await service.setDocumentPinnedWithAccessContext(
			PINNED_DOC_ID,
			true,
			ownerContext,
		);

		// Second writer observed the PRE-pin state (authorization snapshot
		// still current — revision did not move) but its observed pin bit
		// (false) is now stale: the fence must reject the write.
		const stored = await getStoredDocument(adapter, PINNED_DOC_ID);
		const currentSnapshot = readDocumentMutationSnapshot(stored as Memory);
		expect(currentSnapshot).not.toBeNull();
		const raced = await adapter.updateDocumentPinned({
			agentId: AGENT_ID,
			requesterEntityId: OWNER_ID,
			requesterRoomIds: [ROOM_A],
			requesterRole: "OWNER",
			documentId: PINNED_DOC_ID,
			expected: currentSnapshot as never,
			expectedPinned: false,
			pinned: true,
		});
		expect(raced.status).toBe("conflict");
	});

	it("service retry converges when a concurrent writer moves the pin bit between read and write", async () => {
		// The losing writer of a pin race re-reads fresh state inside the
		// bounded CAS budget and converges instead of surfacing a spurious
		// typed conflict (#23103).
		const { adapter, runtime, service } = await makeHarness();
		await seedDocuments(runtime, adapter);

		let pinCalls = 0;
		const originalUpdate = adapter.updateDocumentPinned.bind(adapter);
		adapter.updateDocumentPinned = (async (params: {
			agentId: UUID;
			documentId: UUID;
			requesterEntityId: UUID;
			requesterRoomIds: UUID[];
			requesterRole: string;
			expected: unknown;
			expectedPinned: boolean;
			pinned: boolean;
		}) => {
			pinCalls++;
			if (pinCalls === 1) {
				// A concurrent writer wins the race between our service's
				// read and write: move the pin bit out from under attempt 1.
				await originalUpdate({
					...params,
					expectedPinned: false,
					pinned: true,
				});
			}
			// Attempt 1 now conflicts on the moved pin bit; attempt 2 runs
			// against the fresh state the concurrent writer produced.
			return originalUpdate(params);
		}) as typeof adapter.updateDocumentPinned;

		await service.setDocumentPinnedWithAccessContext(
			PINNED_DOC_ID,
			true,
			ownerContext,
		);

		expect(pinCalls).toBe(2);
		const stored = await getStoredDocument(adapter, PINNED_DOC_ID);
		expect(stored?.metadata).toMatchObject({ pinned: true });
	});

	it("hides document existence from an invisible requester at the adapter CAS layer", async () => {
		// RP review round-1 must-fix: the core adapter's pin path returned
		// forbidden/conflict to requesters who cannot see the document,
		// leaking its existence. Visibility must fail closed before any
		// snapshot or mutation-policy result.
		const { adapter, runtime } = await makeHarness();
		await seedDocuments(runtime, adapter);
		const stored = await adapter.getDocument({
			agentId: AGENT_ID,
			documentId: OWNER_DOC_ID,
			requesterEntityId: OWNER_ID,
			requesterRoomIds: [ROOM_A],
			requesterRole: "OWNER",
		});
		const current = readDocumentMutationSnapshot(stored as Memory);
		expect(current).not.toBeNull();
		const stale = { ...current, revision: (current?.revision ?? 0) + 99 };

		for (const expected of [current, stale]) {
			await expect(
				adapter.updateDocumentPinned({
					agentId: AGENT_ID,
					documentId: OWNER_DOC_ID,
					requesterEntityId: OTHER_USER_ID,
					requesterRoomIds: [],
					requesterRole: "USER",
					expected: expected as never,
					expectedPinned: false,
					pinned: true,
				}),
			).resolves.toMatchObject({ status: "not_found" });
		}
	});
});
