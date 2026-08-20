/**
 * Coverage for document scope id validation (worldId/roomId/entityId).
 *
 * worldId/roomId/entityId are UUID-typed Postgres columns
 * (`plugins/plugin-sql/src/schema/memory.ts`), so an explicit "" is never a
 * representable value; only a truly omitted (undefined) value legitimately
 * defaults to agentId. `DocumentService.addDocument` rejects an explicitly
 * provided empty or malformed value with a typed `DOCUMENT_SCOPE_ID_INVALID`
 * error before any memory write, for all three fields alike, verified below
 * against a real `addDocument` call.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../database/inMemoryAdapter";
import { AgentRuntime } from "../../../runtime";
import type { Character, Memory, UUID } from "../../../types";
import { addDocumentFromFilePath } from "../docs-loader";
import { DocumentService } from "../service";
import type { AddDocumentOptions } from "../types";

const AGENT_ID = "00000000-0000-0000-0000-00000000f00d" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000d00d" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-00000000c0de" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-00000000abcd" as UUID;

async function makeHarness(): Promise<{
	runtime: AgentRuntime;
	service: DocumentService;
}> {
	const adapter = new InMemoryDatabaseAdapter();
	await adapter.initialize();
	const runtime = new AgentRuntime({
		agentId: AGENT_ID,
		character: {
			name: "DocumentScopeIntegrationAgent",
			bio: "Exercises document/fragment scope-id validation semantics.",
			settings: {},
		} as Character,
		adapter,
		logLevel: "fatal",
	});
	return { runtime, service: new DocumentService(runtime) };
}

function baseOptions(
	overrides: Partial<AddDocumentOptions>,
): AddDocumentOptions {
	return {
		agentId: AGENT_ID,
		worldId: WORLD_ID,
		roomId: ROOM_ID,
		entityId: ENTITY_ID,
		clientDocumentId: "" as UUID,
		contentType: "text/plain",
		originalFilename: "scope-validation.txt",
		content: "Document scope id validation coverage.",
		addedBy: AGENT_ID,
		addedByRole: "RUNTIME",
		addedFrom: "runtime-internal",
		...overrides,
	};
}

async function fragmentsFor(
	runtime: AgentRuntime,
	documentId: UUID,
): Promise<Memory[]> {
	const fragments = await runtime.getMemories({
		tableName: "document_fragments",
		agentId: AGENT_ID,
		count: 50,
	});
	return fragments.filter(
		(fragment) =>
			(fragment.metadata as { documentId?: string } | undefined)?.documentId ===
			documentId,
	);
}

async function rowCounts(
	runtime: AgentRuntime,
): Promise<{ documents: number; fragments: number }> {
	const [documents, fragments] = await Promise.all([
		runtime.getMemories({
			tableName: "documents",
			agentId: AGENT_ID,
			count: 50,
		}),
		runtime.getMemories({
			tableName: "document_fragments",
			agentId: AGENT_ID,
			count: 50,
		}),
	]);
	return { documents: documents.length, fragments: fragments.length };
}

describe("DocumentService.addDocument scope id validation", () => {
	it("valid worldId/roomId/entityId survive persistence unchanged", async () => {
		const { runtime, service } = await makeHarness();
		const { storedDocumentMemoryId } = await service.addDocument(
			baseOptions({}),
		);

		const fragments = await fragmentsFor(runtime, storedDocumentMemoryId);
		expect(fragments.length).toBeGreaterThan(0);
		for (const fragment of fragments) {
			expect(fragment.worldId).toBe(WORLD_ID);
			expect(fragment.roomId).toBe(ROOM_ID);
		}
	});

	it.each(["worldId", "roomId", "entityId"] as const)(
		"rejects an explicit empty %s with a typed error before any write",
		async (field) => {
			const { runtime, service } = await makeHarness();
			await expect(
				service.addDocument(baseOptions({ [field]: "" as UUID })),
			).rejects.toMatchObject({
				code: "DOCUMENT_SCOPE_ID_INVALID",
				context: { field },
			});

			expect(await rowCounts(runtime)).toEqual({ documents: 0, fragments: 0 });
		},
	);

	it.each(["worldId", "roomId", "entityId"] as const)(
		"rejects a malformed %s with a typed error before any write",
		async (field) => {
			const { runtime, service } = await makeHarness();
			await expect(
				service.addDocument(baseOptions({ [field]: "not-a-uuid" as UUID })),
			).rejects.toMatchObject({
				code: "DOCUMENT_SCOPE_ID_INVALID",
				context: { field },
			});

			expect(await rowCounts(runtime)).toEqual({ documents: 0, fragments: 0 });
		},
	);
});

describe("addDocumentFromFilePath omission vs. invalid-input handling", () => {
	function withStubService() {
		const calls: AddDocumentOptions[] = [];
		const stubService = {
			reportError: () => undefined,
			addDocument: async (options: AddDocumentOptions) => {
				calls.push(options);
				return {
					clientDocumentId: options.clientDocumentId,
					storedDocumentMemoryId: "doc-1" as UUID,
					fragmentCount: 1,
				};
			},
		};
		return { calls, stubService };
	}

	async function withFixtureFile<T>(run: (filePath: string) => Promise<T>) {
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const filePath = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "eliza-docs-loader-")),
			"scope-sentinel.txt",
		);
		fs.writeFileSync(filePath, "fixture body");
		try {
			return await run(filePath);
		} finally {
			fs.rmSync(filePath, { force: true });
		}
	}

	it("omitted worldId/roomId/entityId default to agentId", async () => {
		const { calls, stubService } = withStubService();
		await withFixtureFile((filePath) =>
			addDocumentFromFilePath({
				service: stubService,
				agentId: AGENT_ID,
				filePath,
			}),
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			worldId: AGENT_ID,
			roomId: AGENT_ID,
			entityId: AGENT_ID,
		});
	});

	it("forwards an explicit empty worldId/roomId/entityId unchanged instead of masking it", async () => {
		const { calls, stubService } = withStubService();
		await withFixtureFile((filePath) =>
			addDocumentFromFilePath({
				service: stubService,
				agentId: AGENT_ID,
				worldId: "" as UUID,
				roomId: "" as UUID,
				entityId: "" as UUID,
				filePath,
			}),
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ worldId: "", roomId: "", entityId: "" });
	});
});
