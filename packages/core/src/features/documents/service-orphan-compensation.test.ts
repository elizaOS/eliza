/**
 * Proves addDocument leaves no orphaned zero-fragment DOCUMENT row behind
 * when fragment embedding fails after the parent row is written (#16021).
 * Integration-backed: a real AgentRuntime over a real PGLite SQL adapter
 * (plugin-sql); only the embedding model handler is injected, once failing
 * and once succeeding.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../../runtime.ts";
import { createTestRuntime } from "../../testing/pglite-runtime.ts";
import type { Memory, UUID } from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";
import { DocumentService } from "./service.ts";
import { generateContentBasedId } from "./utils.ts";

const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";

const DOC_TEXT = [
	"Alpha paragraph: refund policy details for the orphan-compensation test.",
	"Bravo paragraph: service level agreements and uptime commitments listed.",
	"Charlie paragraph: data retention windows and deletion guarantees noted.",
].join("\n\n");

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;
let service: DocumentService;
let embedShouldFail = false;
let embedGate: Promise<void> | undefined;
let notifyEmbed: (() => void) | undefined;

async function fragmentsFor(documentId: string): Promise<number> {
	const memories = await runtime.getMemories({
		tableName: DOCUMENT_FRAGMENTS_TABLE,
		agentId: runtime.agentId,
		count: 10_000,
	});
	return memories.filter(
		(memory) =>
			(memory.metadata as { documentId?: string } | undefined)?.documentId ===
			documentId,
	).length;
}

beforeAll(async () => {
	({ runtime, cleanup } = await createTestRuntime({
		characterName: "OrphanCompensationAgent",
		embeddingDimensions: 384,
	}));
	// One switchable handler for both embedding routes so the failure mode is
	// exactly an embed-time provider outage, not a missing model.
	const embed = async () => {
		notifyEmbed?.();
		await embedGate;
		if (embedShouldFail) {
			throw new Error("injected embedding provider outage");
		}
		return Array.from({ length: 384 }, (_, i) => ((i % 7) + 1) / 10);
	};
	runtime.registerModel(
		ModelType.TEXT_EMBEDDING,
		async () => embed(),
		"orphan-compensation-test",
		1_000,
	);
	runtime.registerModel(
		ModelType.TEXT_EMBEDDING_BATCH,
		async (_runtime, params: { texts?: string[] }) => {
			const texts = Array.isArray(params.texts) ? params.texts : [];
			return Promise.all(texts.map(() => embed()));
		},
		"orphan-compensation-test",
		1_000,
	);
	service = new DocumentService(runtime);
}, 180_000);

afterAll(async () => {
	await cleanup();
});

describe("addDocument orphan compensation (#16021)", () => {
	it("removes the parent DOCUMENT row when every fragment fails to embed", async () => {
		embedShouldFail = true;
		await expect(
			service.addDocument({
				agentId: runtime.agentId,
				clientDocumentId: "f1600000-0000-4000-8000-000000000001" as UUID,
				content: DOC_TEXT,
				contentType: "text/plain",
				originalFilename: "orphan-fail.txt",
				worldId: runtime.agentId as UUID,
				roomId: runtime.agentId as UUID,
				entityId: runtime.agentId as UUID,
			}),
		).rejects.toThrow(/orphan-fail\.txt/);

		// No orphaned zero-fragment DOCUMENT row may survive the failure: the
		// list surface reads DOCUMENTS_TABLE, so a leftover row is the bug.
		const documents = await runtime.getMemories({
			tableName: "documents",
			agentId: runtime.agentId,
			count: 10_000,
		});
		const orphan = documents.find(
			(memory) =>
				(memory.metadata as { title?: string } | undefined)?.title?.includes(
					"orphan-fail",
				) ||
				(typeof memory.content?.text === "string" &&
					memory.content.text.includes("orphan-compensation test")),
		);
		expect(orphan).toBeUndefined();
	}, 120_000);

	it("keeps the happy path intact: fragments embed and the document persists", async () => {
		embedShouldFail = false;
		const result = await service.addDocument({
			agentId: runtime.agentId,
			clientDocumentId: "f1600000-0000-4000-8000-000000000002" as UUID,
			content: DOC_TEXT,
			contentType: "text/plain",
			originalFilename: "orphan-success.txt",
			worldId: runtime.agentId as UUID,
			roomId: runtime.agentId as UUID,
			entityId: runtime.agentId as UUID,
		});
		expect(result.fragmentCount).toBeGreaterThan(0);
		const stored = await runtime.getMemoryById(result.clientDocumentId as UUID);
		expect(stored).not.toBeNull();
		expect(await fragmentsFor(result.clientDocumentId)).toBe(
			result.fragmentCount,
		);
	}, 120_000);

	it("a retry after the compensated failure succeeds instead of hitting a stale stub", async () => {
		embedShouldFail = true;
		await expect(
			service.addDocument({
				agentId: runtime.agentId,
				clientDocumentId: "f1600000-0000-4000-8000-000000000003" as UUID,
				content: `retry lane ${DOC_TEXT}`,
				contentType: "text/plain",
				originalFilename: "orphan-retry.txt",
				worldId: runtime.agentId as UUID,
				roomId: runtime.agentId as UUID,
				entityId: runtime.agentId as UUID,
			}),
		).rejects.toThrow();

		embedShouldFail = false;
		const retried = await service.addDocument({
			agentId: runtime.agentId,
			clientDocumentId: "f1600000-0000-4000-8000-000000000003" as UUID,
			content: `retry lane ${DOC_TEXT}`,
			contentType: "text/plain",
			originalFilename: "orphan-retry.txt",
			worldId: runtime.agentId as UUID,
			roomId: runtime.agentId as UUID,
			entityId: runtime.agentId as UUID,
		});
		expect(retried.fragmentCount).toBeGreaterThan(0);
		expect(
			await runtime.getMemoryById(retried.clientDocumentId as UUID),
		).not.toBeNull();
	}, 120_000);

	it("does not let a concurrent loser process or roll back the winning ingestion", async () => {
		embedShouldFail = false;
		let releaseEmbed!: () => void;
		embedGate = new Promise<void>((resolve) => {
			releaseEmbed = resolve;
		});
		let enteredEmbed!: () => void;
		const embeddingStarted = new Promise<void>((resolve) => {
			enteredEmbed = resolve;
		});
		notifyEmbed = enteredEmbed;
		const options = {
			agentId: runtime.agentId,
			clientDocumentId: "f1600000-0000-4000-8000-000000000004" as UUID,
			content: `concurrent winner ${DOC_TEXT}`,
			contentType: "text/plain",
			originalFilename: "orphan-concurrent.txt",
			worldId: runtime.agentId as UUID,
			roomId: runtime.agentId as UUID,
			entityId: runtime.agentId as UUID,
		};

		const winner = service.addDocument(options);
		await embeddingStarted;
		notifyEmbed = undefined;
		await expect(service.addDocument(options)).rejects.toThrow(
			/already in progress|owned by another attempt/,
		);
		releaseEmbed();
		embedGate = undefined;
		const stored = await winner;
		expect(stored.fragmentCount).toBeGreaterThan(0);
		expect(
			await runtime.getMemoryById(stored.clientDocumentId as UUID),
		).not.toBeNull();
		expect(await fragmentsFor(stored.clientDocumentId)).toBe(
			stored.fragmentCount,
		);
	}, 120_000);

	it("preserves failed state and the original cause when cleanup is unavailable, then retries", async () => {
		embedShouldFail = true;
		const adapter = runtime.adapter as typeof runtime.adapter & {
			deleteDocumentWithSnapshot: typeof runtime.adapter.deleteDocumentWithSnapshot;
		};
		const realDelete = adapter.deleteDocumentWithSnapshot.bind(adapter);
		adapter.deleteDocumentWithSnapshot = async () => {
			throw new Error("injected transactional cleanup outage");
		};
		const options = {
			agentId: runtime.agentId,
			clientDocumentId: "f1600000-0000-4000-8000-000000000005" as UUID,
			content: `cleanup outage ${DOC_TEXT}`,
			contentType: "text/plain",
			originalFilename: "orphan-cleanup-outage.txt",
			worldId: runtime.agentId as UUID,
			roomId: runtime.agentId as UUID,
			entityId: runtime.agentId as UUID,
		};
		let caught: unknown;
		try {
			await service.addDocument(options);
		} catch (error) {
			caught = error;
		} finally {
			adapter.deleteDocumentWithSnapshot = realDelete;
		}
		const causeMessages: string[] = [];
		let cause = caught;
		while (cause instanceof Error) {
			causeMessages.push(cause.message);
			cause = cause.cause;
		}
		expect(causeMessages.join(" | ")).toContain(
			"All fragments failed processing",
		);

		const documents = await runtime.getMemories({
			tableName: "documents",
			agentId: runtime.agentId,
			count: 100,
		});
		const failed = documents.find(
			(memory) =>
				(memory.metadata as { originalFilename?: string } | undefined)
					?.originalFilename === options.originalFilename,
		);
		const failedMetadata = failed?.metadata as
			| { ingestionState?: string; ingestionAttemptId?: string }
			| undefined;
		expect(failedMetadata?.ingestionState).toBe("failed");
		expect(typeof failedMetadata?.ingestionAttemptId).toBe("string");
		expect(failed?.id).toBeDefined();
		const listed = await runtime.adapter.queryDocuments({
			agentId: runtime.agentId,
			requesterEntityId: runtime.agentId,
			requesterRoomIds: [runtime.agentId as UUID],
			requesterRole: "OWNER",
			limit: 25,
			offset: 0,
		});
		expect(listed.documents.map((memory) => memory.id)).not.toContain(
			failed?.id,
		);

		embedShouldFail = false;
		const retried = await service.addDocument(options);
		expect(retried.fragmentCount).toBeGreaterThan(0);
		const retriedMetadata = (
			await runtime.getMemoryById(retried.clientDocumentId as UUID)
		)?.metadata as { ingestionState?: string } | undefined;
		expect(retriedMetadata?.ingestionState).toBe("ready");
	}, 120_000);

	it("compensates fragments when the final ready-state CAS fails", async () => {
		embedShouldFail = false;
		const adapter = runtime.adapter;
		const realCompareAndSwap = adapter.compareAndSwapDocument.bind(adapter);
		adapter.compareAndSwapDocument = async (params) => {
			if (params.replacement.metadata?.ingestionState === "ready") {
				return { status: "conflict" };
			}
			return realCompareAndSwap(params);
		};
		const options = {
			agentId: runtime.agentId,
			content: `finalization conflict ${DOC_TEXT}`,
			contentType: "text/plain",
			originalFilename: "orphan-finalization-conflict.txt",
			worldId: runtime.agentId as UUID,
			roomId: runtime.agentId as UUID,
			entityId: runtime.agentId as UUID,
		};
		const documentId = generateContentBasedId(
			options.content,
			runtime.agentId,
			{
				includeFilename: options.originalFilename,
				contentType: options.contentType,
			},
		) as UUID;

		try {
			await expect(service.addDocument(options)).rejects.toThrow(
				/orphan-finalization-conflict/,
			);
		} finally {
			adapter.compareAndSwapDocument = realCompareAndSwap;
		}

		expect(await runtime.getMemoryById(documentId)).toBeNull();
		expect(await fragmentsFor(documentId)).toBe(0);
	}, 120_000);

	it("reclaims an expired pending ingestion snapshot before retrying", async () => {
		embedShouldFail = false;
		const options = {
			agentId: runtime.agentId,
			content: `expired pending ${DOC_TEXT}`,
			contentType: "text/plain",
			originalFilename: "orphan-expired-pending.txt",
			worldId: runtime.agentId as UUID,
			roomId: runtime.agentId as UUID,
			entityId: runtime.agentId as UUID,
		};
		const documentId = generateContentBasedId(
			options.content,
			runtime.agentId,
			{
				includeFilename: options.originalFilename,
				contentType: options.contentType,
			},
		) as UUID;
		await runtime.createMemory(
			{
				id: documentId,
				agentId: runtime.agentId,
				roomId: runtime.agentId,
				entityId: runtime.agentId,
				content: { text: options.content },
				metadata: {
					type: "document",
					documentId,
					source: "test",
					timestamp: Date.now() - 600_000,
					scope: "agent-private",
					documentRevision: 0,
					addedAt: Date.now() - 600_000,
					ingestionAttemptId: runtime.createRunId(),
					ingestionState: "pending",
				} as unknown as Memory["metadata"],
			},
			"documents",
		);

		const retried = await service.addDocument(options);
		expect(retried.clientDocumentId).toBe(documentId);
		expect(retried.fragmentCount).toBeGreaterThan(0);
		expect(
			(await runtime.getMemoryById(documentId))?.metadata?.ingestionState,
		).toBe("ready");
	}, 120_000);

	it("transactionally removes 10,001 target fragments and preserves unrelated rows", async () => {
		const documentId = runtime.createRunId();
		const unrelatedDocumentId = runtime.createRunId();
		const attemptId = runtime.createRunId();
		await runtime.createMemory(
			{
				id: documentId,
				agentId: runtime.agentId,
				roomId: runtime.agentId,
				entityId: runtime.agentId,
				content: { text: "failed bulk ingestion" },
				metadata: {
					type: "document",
					documentId,
					source: "test",
					timestamp: Date.now(),
					scope: "agent-private",
					documentRevision: 0,
					ingestionAttemptId: attemptId,
					ingestionState: "failed",
				} as unknown as Memory["metadata"],
			},
			"documents",
		);
		const fragment = (fragmentDocumentId: UUID, position: number): Memory => ({
			id: runtime.createRunId(),
			agentId: runtime.agentId,
			roomId: runtime.agentId,
			entityId: runtime.agentId,
			content: { text: `fragment ${position}` },
			metadata: {
				type: "fragment",
				documentId: fragmentDocumentId,
				position,
			},
		});
		const entries = Array.from({ length: 10_001 }, (_, position) => ({
			memory: fragment(documentId, position),
			tableName: DOCUMENT_FRAGMENTS_TABLE,
		}));
		entries.push(
			{
				memory: fragment(unrelatedDocumentId, 0),
				tableName: DOCUMENT_FRAGMENTS_TABLE,
			},
			{
				memory: fragment(unrelatedDocumentId, 1),
				tableName: DOCUMENT_FRAGMENTS_TABLE,
			},
		);
		await runtime.createMemories(entries);
		expect(
			await runtime.countMemories({
				tableName: DOCUMENT_FRAGMENTS_TABLE,
				agentId: runtime.agentId,
				metadata: { documentId },
			}),
		).toBe(10_001);
		expect(
			await runtime.countMemories({
				tableName: DOCUMENT_FRAGMENTS_TABLE,
				agentId: runtime.agentId,
				metadata: { documentId: unrelatedDocumentId },
			}),
		).toBe(2);

		await expect(service.checkExistingDocument(documentId)).resolves.toBe(
			false,
		);
		expect(await runtime.getMemoryById(documentId)).toBeNull();
		expect(
			await runtime.countMemories({
				tableName: DOCUMENT_FRAGMENTS_TABLE,
				agentId: runtime.agentId,
				metadata: { documentId },
			}),
		).toBe(0);
		expect(
			await runtime.countMemories({
				tableName: DOCUMENT_FRAGMENTS_TABLE,
				agentId: runtime.agentId,
				metadata: { documentId: unrelatedDocumentId },
			}),
		).toBe(2);
	}, 180_000);
});
