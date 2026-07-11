/**
 * Verifies document ingestion prepares embeddings before atomically inserting
 * the parent and fragments through the database transaction boundary.
 */
import { describe, expect, test, vi } from "vitest";
import { isElizaError } from "../../errors";
import { createMockRuntime, MOCK_AGENT_ID } from "../../testing/mock-runtime";
import type { IAgentRuntime, Memory, UUID } from "../../types";
import { ModelType } from "../../types";
import { DocumentService } from "./service.ts";

const DOCUMENTS_TABLE = "documents";
const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";

function embeddingFor(text: string): number[] {
	return [text.length, 1, 0.5];
}

function addOptions() {
	return {
		agentId: MOCK_AGENT_ID,
		worldId: MOCK_AGENT_ID,
		roomId: MOCK_AGENT_ID,
		entityId: MOCK_AGENT_ID,
		content: "A document whose persistence must be all-or-nothing.",
		contentType: "text/plain",
		originalFilename: "atomic.txt",
	};
}

describe("DocumentService atomic document ingestion (#16021)", () => {
	test("an embedding failure performs no database transaction or write", async () => {
		const transaction = vi.fn();
		const reportError = vi.fn();
		const runtime = createMockRuntime({
			getSetting: () => undefined,
			getModel: (type: string) =>
				type === ModelType.TEXT_EMBEDDING
					? async () => {
							throw new Error("embedding model down");
						}
					: undefined,
			useModel: async () => {
				throw new Error("embedding model down");
			},
			transaction,
			reportError,
		});

		let thrown: unknown;
		try {
			await new DocumentService(runtime).addDocument(addOptions());
		} catch (error) {
			thrown = error;
		}

		expect(isElizaError(thrown)).toBe(true);
		expect(thrown).toMatchObject({ code: "DOCUMENT_EMBED_FAILED" });
		expect(transaction).not.toHaveBeenCalled();
		expect(reportError).toHaveBeenCalledWith(
			"DocumentService.addDocument",
			expect.anything(),
			expect.objectContaining({ stage: "fragment-processing" }),
		);
	});

	test("inserts the parent and every embedded fragment in one transaction", async () => {
		const persisted: Array<{ memory: Memory; tableName: string }> = [];
		let runtime: IAgentRuntime;
		const transaction = vi.fn(async (callback) => callback(runtime));
		runtime = createMockRuntime({
			getSetting: () => undefined,
			getModel: (type: string) =>
				type === ModelType.TEXT_EMBEDDING
					? async () => embeddingFor("ok")
					: undefined,
			useModel: async (_type: string, params: { text?: string }) =>
				embeddingFor(params.text ?? ""),
			createMemories: async (items): Promise<UUID[]> => {
				persisted.push(...items);
				return items.map(({ memory }) => memory.id as UUID);
			},
			transaction,
			reportError: vi.fn(),
		});

		const result = await new DocumentService(runtime).addDocument(addOptions());

		expect(transaction).toHaveBeenCalledOnce();
		expect(
			persisted.filter((item) => item.tableName === DOCUMENTS_TABLE),
		).toHaveLength(1);
		expect(
			persisted.filter((item) => item.tableName === DOCUMENT_FRAGMENTS_TABLE),
		).toHaveLength(result.fragmentCount);
		expect(result.fragmentCount).toBeGreaterThan(0);
	});

	test("a fragment insert failure leaves no committed parent or fragments", async () => {
		const committed: Array<{ memory: Memory; tableName: string }> = [];
		let runtime: IAgentRuntime;
		runtime = createMockRuntime({
			getSetting: () => undefined,
			getModel: () => async () => embeddingFor("ok"),
			useModel: async (_type: string, params: { text?: string }) =>
				embeddingFor(params.text ?? ""),
			createMemories: async (items): Promise<UUID[]> => {
				committed.push(items[0]);
				throw new Error("fragment insert failed");
			},
			transaction: async (callback) => {
				const before = committed.length;
				try {
					return await callback(runtime);
				} catch (error) {
					committed.splice(before);
					throw error;
				}
			},
			reportError: vi.fn(),
		});

		await expect(
			new DocumentService(runtime).addDocument(addOptions()),
		).rejects.toThrow("fragment insert failed");
		expect(committed).toEqual([]);
	});
});
