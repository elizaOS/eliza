/**
 * Exercises document-list filtering and pagination through a real AgentRuntime,
 * DocumentService, and InMemoryDatabaseAdapter with persisted memory records.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import {
	type Character,
	type Memory,
	MemoryType,
	type UUID,
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
	it("filters the complete adapter result before paginating more than 50 records", async () => {
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
		await seedDocuments(
			runtime,
			Array.from({ length: 60 }, (_, index) => documentMemory(index)),
		);

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
		});
		expect(result.availableDocuments).toHaveLength(5);
		await expect(
			service.listDocuments(undefined, {
				query: "does-not-exist",
				limit: 5,
				offset: 55,
			}),
		).resolves.toEqual([]);
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
