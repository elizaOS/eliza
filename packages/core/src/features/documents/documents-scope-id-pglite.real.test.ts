/**
 * Proves the worldId/roomId/entityId scope-id validation added to
 * DocumentService.addDocument (see requireDocumentScopeUuid in service.ts)
 * against a real PGLite-backed AgentRuntime, not just InMemoryDatabaseAdapter.
 * worldId/roomId/entityId are UUID-typed Postgres columns
 * (plugins/plugin-sql/src/schema/memory.ts); an in-memory-only test can't
 * prove a rejected write never reaches that column. This one can.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../../runtime.ts";
import { createTestRuntime } from "../../testing/pglite-runtime.ts";
import { ChannelType, type UUID } from "../../types/index.ts";
import { DocumentService } from "./service.ts";
import type { AddDocumentOptions } from "./types.ts";

const USER_ID = "f4310000-0000-4000-8000-000000000001" as UUID;
const WORLD_ID = "f4310000-0000-4000-8000-000000000002" as UUID;
const ROOM_ID = "f4310000-0000-4000-8000-000000000003" as UUID;

let runtime: AgentRuntime;
let cleanup: (() => Promise<void>) | undefined;
let service: DocumentService;

beforeAll(async () => {
	const created = await createTestRuntime({
		characterName: "DocumentScopeIdPgliteTest",
	});
	runtime = created.runtime;
	cleanup = created.cleanup;
	await runtime.ensureConnection({
		entityId: USER_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		worldName: "Document scope id PGLite test",
		userName: "Document owner",
		name: "Document owner",
		source: "test",
		type: ChannelType.DM,
	});
	service = new DocumentService(runtime);
}, 120_000);

afterAll(async () => {
	await cleanup?.();
}, 120_000);

async function rowCounts(): Promise<{ documents: number; fragments: number }> {
	const [documents, fragments] = await Promise.all([
		runtime.getMemories({
			tableName: "documents",
			agentId: runtime.agentId,
			count: 100,
		}),
		runtime.getMemories({
			tableName: "document_fragments",
			agentId: runtime.agentId,
			count: 100,
		}),
	]);
	return { documents: documents.length, fragments: fragments.length };
}

function baseOptions(
	overrides: Partial<AddDocumentOptions>,
): AddDocumentOptions {
	return {
		agentId: runtime.agentId,
		worldId: WORLD_ID,
		roomId: ROOM_ID,
		entityId: USER_ID,
		clientDocumentId: "" as UUID,
		contentType: "text/plain",
		originalFilename: "pglite-scope-validation.txt",
		content: "PGLite-backed document scope id validation coverage.",
		addedBy: USER_ID,
		addedByRole: "USER",
		addedFrom: "runtime-internal",
		...overrides,
	};
}

describe("DocumentService.addDocument scope id validation against real PGLite", () => {
	it("persists a document with valid worldId/roomId/entityId", async () => {
		const { storedDocumentMemoryId } = await service.addDocument(
			baseOptions({}),
		);
		const persisted = await runtime.getMemoryById(storedDocumentMemoryId);
		expect(persisted?.worldId).toBe(WORLD_ID);
		expect(persisted?.roomId).toBe(ROOM_ID);
	});

	it.each(["worldId", "roomId", "entityId"] as const)(
		"rejects an explicit empty %s before it ever reaches the real uuid column",
		async (field) => {
			const before = await rowCounts();

			await expect(
				service.addDocument(
					baseOptions({
						[field]: "" as UUID,
						originalFilename: `pglite-reject-${field}.txt`,
					}),
				),
			).rejects.toMatchObject({
				code: "DOCUMENT_SCOPE_ID_INVALID",
				context: { field },
			});

			expect(await rowCounts()).toEqual(before);
		},
	);
});
