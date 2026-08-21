/**
 * Exercises document authorization against a real AgentRuntime and PGLite store,
 * including same-turn membership revocation and knowledge-context provider
 * composition across user and agent-tenant boundaries.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { filterByContextGate } from "../../runtime/context-gates.ts";
import type { AgentRuntime } from "../../runtime.ts";
import { createTestRuntime } from "../../testing/pglite-runtime.ts";
import { runWithTrajectoryContext } from "../../trajectory-context.ts";
import {
	type Agent,
	ChannelType,
	type Memory,
	MemoryType,
	ModelType,
	type State,
	type UUID,
} from "../../types/index.ts";
import { documentsProvider } from "./provider.ts";
import { DocumentService } from "./service.ts";

const USER_ID = "f4300000-0000-4000-8000-000000000001" as UUID;
const OTHER_USER_ID = "f4300000-0000-4000-8000-000000000007" as UUID;
const OTHER_AGENT_ID = "f4300000-0000-4000-8000-000000000008" as UUID;
const WORLD_ID = "f4300000-0000-4000-8000-000000000002" as UUID;
const ROOM_ID = "f4300000-0000-4000-8000-000000000003" as UUID;
const UPDATE_DOCUMENT_ID = "f4300000-0000-4000-8000-000000000004" as UUID;
const DELETE_DOCUMENT_ID = "f4300000-0000-4000-8000-000000000005" as UUID;
const VISIBLE_DOCUMENT_ID = "f4300000-0000-4000-8000-000000000009" as UUID;
const HIDDEN_USER_DOCUMENT_ID = "f4300000-0000-4000-8000-000000000010" as UUID;
const FOREIGN_DOCUMENT_ID = "f4300000-0000-4000-8000-000000000011" as UUID;
const ATOMIC_UPDATE_DOCUMENT_ID =
	"f4300000-0000-4000-8000-000000000016" as UUID;
const FAILED_UPDATE_DOCUMENT_ID =
	"f4300000-0000-4000-8000-000000000018" as UUID;

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;
let failEmbedding = false;

function message(): Memory {
	return {
		id: "f4300000-0000-4000-8000-000000000006" as UUID,
		agentId: runtime.agentId,
		entityId: USER_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		content: {
			text: "Update my private documents",
			source: "test",
			channelType: ChannelType.DM,
		},
	};
}

function userPrivateDocument(
	id: UUID,
	text: string,
	options: {
		agentId?: UUID;
		entityId?: UUID;
		title?: string;
	} = {},
): Memory {
	const agentId = options.agentId ?? runtime.agentId;
	const entityId = options.entityId ?? USER_ID;
	const filename = `${id}.txt`;
	return {
		id,
		agentId,
		entityId,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		createdAt: 1_000,
		content: { text },
		metadata: {
			type: MemoryType.DOCUMENT,
			documentId: id,
			documentRevision: 0,
			scope: "user-private",
			scopedToEntityId: entityId,
			addedBy: entityId,
			addedByRole: "USER",
			addedFrom: "upload",
			addedAt: 1_000,
			source: "test",
			title: options.title ?? "Private document",
			filename,
			originalFilename: filename,
			fileExt: "txt",
			fileType: "text/plain",
			contentType: "text/plain",
			fileSize: Buffer.byteLength(text, "utf8"),
			textBacked: true,
			timestamp: 1_000,
		},
	};
}

function documentFragment(document: Memory, text: string, id: UUID): Memory {
	return {
		...document,
		id,
		content: { text },
		metadata: {
			...document.metadata,
			type: MemoryType.FRAGMENT,
			documentId: document.id,
			position: 0,
		},
	};
}

beforeAll(async () => {
	({ runtime, cleanup } = await createTestRuntime({
		characterName: "DocumentAuthorizationTest",
	}));
	await runtime.ensureConnection({
		entityId: USER_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		worldName: "Document authorization",
		userName: "Document owner",
		name: "Document owner",
		source: "test",
		type: ChannelType.DM,
	});
	await runtime.ensureConnection({
		entityId: OTHER_USER_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		worldName: "Document authorization",
		userName: "Other document owner",
		name: "Other document owner",
		source: "test",
		type: ChannelType.DM,
	});
	await runtime.ensureWorldExists({
		id: WORLD_ID,
		name: "Document authorization",
		agentId: runtime.agentId,
		metadata: {
			roles: { [USER_ID]: "USER", [OTHER_USER_ID]: "USER" },
			roleSources: { [USER_ID]: "manual", [OTHER_USER_ID]: "manual" },
		},
	});
	await runtime.adapter.createAgent({
		id: OTHER_AGENT_ID,
		name: "Foreign document tenant",
		createdAt: 1_000,
		updatedAt: 1_000,
	} as Agent);
	const visibleDocument = userPrivateDocument(
		VISIBLE_DOCUMENT_ID,
		"visible owner launch knowledge",
		{
			entityId: OTHER_USER_ID,
			title: "VISIBLE_OWNER_DOCUMENT",
		},
	);
	const hiddenUserDocument = userPrivateDocument(
		HIDDEN_USER_DOCUMENT_ID,
		"hidden other-user launch knowledge",
		{ title: "HIDDEN_OTHER_USER_DOCUMENT" },
	);
	const foreignDocument = userPrivateDocument(
		FOREIGN_DOCUMENT_ID,
		"hidden foreign-tenant launch knowledge",
		{
			agentId: OTHER_AGENT_ID,
			entityId: OTHER_USER_ID,
			title: "HIDDEN_FOREIGN_TENANT_DOCUMENT",
		},
	);
	await runtime.createMemories([
		{
			memory: userPrivateDocument(UPDATE_DOCUMENT_ID, "Original update body"),
			tableName: "documents",
		},
		{
			memory: userPrivateDocument(DELETE_DOCUMENT_ID, "Original delete body"),
			tableName: "documents",
		},
		{ memory: visibleDocument, tableName: "documents" },
		{ memory: hiddenUserDocument, tableName: "documents" },
		{ memory: foreignDocument, tableName: "documents" },
		{
			memory: documentFragment(
				visibleDocument,
				"VISIBLE_OWNER_FRAGMENT launch knowledge",
				"f4300000-0000-4000-8000-000000000012" as UUID,
			),
			tableName: "document_fragments",
		},
		{
			memory: documentFragment(
				hiddenUserDocument,
				"HIDDEN_OTHER_USER_FRAGMENT launch knowledge",
				"f4300000-0000-4000-8000-000000000013" as UUID,
			),
			tableName: "document_fragments",
		},
		{
			memory: documentFragment(
				foreignDocument,
				"HIDDEN_FOREIGN_TENANT_FRAGMENT launch knowledge",
				"f4300000-0000-4000-8000-000000000014" as UUID,
			),
			tableName: "document_fragments",
		},
	]);
}, 120_000);

afterAll(async () => {
	await cleanup();
}, 120_000);

describe("DocumentService requester authorization", () => {
	it("composes knowledge context with requester-scoped user and tenant visibility", async () => {
		const selected = filterByContextGate(
			[documentsProvider],
			["knowledge"],
			["USER"],
		);
		expect(selected).toEqual([documentsProvider]);

		const service = new DocumentService(runtime);
		const getService = vi
			.spyOn(runtime, "getService")
			.mockImplementation((serviceType) =>
				serviceType === DocumentService.serviceType ? service : null,
			);
		const request: Memory = {
			...message(),
			id: "f4300000-0000-4000-8000-000000000015" as UUID,
			entityId: OTHER_USER_ID,
			content: {
				text: "launch knowledge",
				source: "test",
				channelType: ChannelType.DM,
			},
		};

		try {
			const result = await documentsProvider.get(runtime, request, {} as State);
			expect(result.text).toContain("VISIBLE_OWNER_FRAGMENT");
			expect(result.text).toContain("VISIBLE_OWNER_DOCUMENT");
			expect(result.text).not.toContain("HIDDEN_OTHER_USER");
			expect(result.text).not.toContain("HIDDEN_FOREIGN_TENANT");
			expect(result.values?.documents).toEqual([
				expect.objectContaining({ id: VISIBLE_DOCUMENT_ID }),
			]);
		} finally {
			getService.mockRestore();
		}
	});

	it("keeps the complete old revision when replacement embedding fails", async () => {
		const embed = async () => {
			if (failEmbedding) throw new Error("injected update embedding failure");
			return Array.from({ length: 384 }, (_, index) => (index % 11) / 10);
		};
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async () => embed(),
			"atomic-update-test",
			1_000,
		);
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING_BATCH,
			async (_runtime, params: { texts?: string[] }) =>
				Promise.all((params.texts ?? []).map(() => embed())),
			"atomic-update-test",
			1_000,
		);
		const original = userPrivateDocument(
			FAILED_UPDATE_DOCUMENT_ID,
			"Failure original body",
		);
		const oldFragmentId = "f4300000-0000-4000-8000-000000000019" as UUID;
		await runtime.createMemories([
			{ memory: original, tableName: "documents" },
			{
				memory: documentFragment(
					original,
					"Failure old fragment",
					oldFragmentId,
				),
				tableName: "document_fragments",
			},
		]);
		failEmbedding = true;
		try {
			await expect(
				new DocumentService(runtime).updateDocument({
					documentId: FAILED_UPDATE_DOCUMENT_ID,
					content: "Replacement that must not become visible",
					message: message(),
				}),
			).rejects.toThrow("injected update embedding failure");
		} finally {
			failEmbedding = false;
		}
		await expect(
			runtime.adapter.getMemoryById(FAILED_UPDATE_DOCUMENT_ID),
		).resolves.toMatchObject({
			content: { text: "Failure original body" },
			metadata: { documentRevision: 0 },
		});
		await expect(
			runtime.adapter.getMemoryById(oldFragmentId),
		).resolves.toMatchObject({ content: { text: "Failure old fragment" } });
	});

	it("commits a parent and its replacement fragments as one revision", async () => {
		const original = userPrivateDocument(
			ATOMIC_UPDATE_DOCUMENT_ID,
			"Atomic original body",
		);
		const oldFragmentId = "f4300000-0000-4000-8000-000000000017" as UUID;
		await runtime.createMemories([
			{ memory: original, tableName: "documents" },
			{
				memory: documentFragment(
					original,
					"Atomic old fragment",
					oldFragmentId,
				),
				tableName: "document_fragments",
			},
		]);
		const service = new DocumentService(runtime);
		await expect(
			service.updateDocument({
				documentId: ATOMIC_UPDATE_DOCUMENT_ID,
				content: "Atomic replacement body",
				message: message(),
			}),
		).resolves.toMatchObject({ fragmentCount: 1 });

		const context = {
			agentId: runtime.agentId,
			requesterEntityId: USER_ID,
			requesterRoomIds: [ROOM_ID],
			requesterRole: "USER" as const,
		};
		const parent = await runtime.adapter.getDocument({
			...context,
			documentId: ATOMIC_UPDATE_DOCUMENT_ID,
		});
		const fragments = await runtime.adapter.queryDocumentFragments({
			...context,
			limit: 100,
		});
		const replacementFragments = fragments.filter(
			(fragment) => fragment.metadata?.documentId === ATOMIC_UPDATE_DOCUMENT_ID,
		);
		expect(parent).toMatchObject({
			content: { text: "Atomic replacement body" },
			metadata: { documentRevision: 1 },
		});
		expect(replacementFragments).toHaveLength(1);
		expect(replacementFragments[0]).toMatchObject({
			content: { text: "Atomic replacement body" },
			metadata: { documentRevision: 1, position: 0 },
		});
		await expect(
			runtime.adapter.getMemoryById(oldFragmentId),
		).resolves.toBeNull();
	});

	it("denies same-turn update and delete after room membership is revoked", async () => {
		const service = new DocumentService(runtime);
		const membershipReads = vi.spyOn(
			runtime.adapter,
			"getRoomsForParticipants",
		);
		const request = message();

		await runWithTrajectoryContext(
			{ turnMemo: new Map<string, Promise<unknown>>() },
			async () => {
				await expect(
					service.getDocumentById(UPDATE_DOCUMENT_ID, request),
				).resolves.toMatchObject({ id: UPDATE_DOCUMENT_ID });

				await expect(runtime.removeParticipant(USER_ID, ROOM_ID)).resolves.toBe(
					true,
				);

				await expect(
					service.updateDocument({
						documentId: UPDATE_DOCUMENT_ID,
						content: "Unauthorized replacement",
						message: request,
					}),
				).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
				await expect(
					service.deleteDocument(DELETE_DOCUMENT_ID, request),
				).rejects.toMatchObject({ code: "DOCUMENT_MUTATION_FORBIDDEN" });
			},
		);

		expect(membershipReads).toHaveBeenCalledTimes(3);
		const stored = await runtime.adapter.getMemoriesByIds(
			[UPDATE_DOCUMENT_ID, DELETE_DOCUMENT_ID],
			"documents",
		);
		expect(stored).toHaveLength(2);
		expect(
			stored.find((document) => document.id === UPDATE_DOCUMENT_ID)?.content,
		).toMatchObject({ text: "Original update body" });
		expect(
			stored.find((document) => document.id === DELETE_DOCUMENT_ID)?.content,
		).toMatchObject({ text: "Original delete body" });
	});
});
