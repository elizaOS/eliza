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
import type { UUID } from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";
import { DocumentService } from "./service.ts";

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
});
