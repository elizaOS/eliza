/**
 * Exercises PII retrieval through a real AgentRuntime and verifies complete
 * retrieval survives model projection or reaches typed wire-size preflight.
 */

import { describe, expect, it, vi } from "vitest";
import {
	createStableRetrievalPage,
	stableRetrievalQueryFingerprint,
} from "../database/stable-retrieval";
import { DocumentService } from "../features/documents/service";
import { AgentRuntime } from "../runtime";
import { projectToolResultForModel } from "../runtime/planner-rendering";
import type { PlannerToolResult } from "../runtime/planner-types";
import type { IAgentRuntime, IDatabaseAdapter, Memory, UUID } from "../types";
import { MemoryType, ModelType } from "../types";
import { sourcesFromRuntime } from "./pii-context-pack";

const AGENT_ID = "40000000-0000-4000-8000-000000000001" as UUID;
const memoryId = (index: number): UUID =>
	`41000000-0000-4000-8000-${String(index).padStart(12, "0")}` as UUID;

describe("issue #25150 real-runtime PII retrieval", () => {
	it("does not rerank incompatible growing prefixes", async () => {
		const raw = [
			{ id: memoryId(1), agentId: AGENT_ID, content: { text: "alpha" } },
			{ id: memoryId(2), agentId: AGENT_ID, content: { text: "beta" } },
			...Array.from({ length: 62 }, (_, index) => ({
				id: memoryId(index + 3),
				agentId: AGENT_ID,
				content: { text: `neutral ${index}` },
			})),
			...Array.from({ length: 66 }, (_, index) => ({
				id: memoryId(index + 65),
				agentId: AGENT_ID,
				content: { text: `alpha ${index}` },
			})),
		];
		const memories: Memory[] = raw.map((memory, index) => ({
			...memory,
			entityId: AGENT_ID,
			roomId: AGENT_ID,
			createdAt: 1_000 - index,
			similarity: 1 - index / 1_000,
		}));
		const adapter = {
			stableRetrievalCapability: 1,
			searchMemories: vi.fn(
				async (params: { limit?: number; count?: number; offset?: number }) => {
					const offset = params.offset ?? 0;
					return memories.slice(
						offset,
						offset + (params.limit ?? params.count ?? 10),
					);
				},
			),
			searchMemoriesPage: vi.fn(async (params) =>
				createStableRetrievalPage(memories, {
					limit: params.limit,
					cursor: params.cursor,
					rankBySimilarity: true,
					queryFingerprint: stableRetrievalQueryFingerprint({
						kind: "issue-25150-memory-vector",
						embedding: params.embedding,
						tableName: params.tableName,
					}),
				}),
			),
		} as unknown as IDatabaseAdapter;
		const runtime = new AgentRuntime({
			agentId: AGENT_ID,
			adapter,
			disableBasicCapabilities: true,
		});
		vi.spyOn(runtime, "getModel").mockImplementation((type) =>
			type === ModelType.TEXT_EMBEDDING ? vi.fn() : undefined,
		);
		vi.spyOn(runtime, "useModel").mockResolvedValue([1, 0]);

		const fragments =
			await sourcesFromRuntime(runtime).searchMemories?.("alpha beta");
		expect(fragments).toHaveLength(130);
		expect(fragments?.[0]?.ref).toBe(memoryId(2));
		expect(fragments?.map((fragment) => fragment.ref)).toEqual(
			expect.arrayContaining([memoryId(1), memoryId(64), memoryId(130)]),
		);
	});

	it("keeps legacy prefixes unranked and reranks only after completion", async () => {
		const memories: Memory[] = Array.from({ length: 130 }, (_, index) => ({
			id: memoryId(index + 4_000),
			agentId: AGENT_ID,
			entityId: AGENT_ID,
			roomId: AGENT_ID,
			createdAt: 5_000 - index,
			content: { text: index % 2 === 0 ? `alpha ${index}` : `beta ${index}` },
			similarity: 1 - index / 1_000,
		}));
		const searchMemories = vi.fn(
			async (params: { count?: number; offset?: number; query?: string }) => {
				const offset = params.offset ?? 0;
				return memories.slice(offset, offset + (params.count ?? 10));
			},
		);
		const runtime = new AgentRuntime({
			agentId: AGENT_ID,
			adapter: { searchMemories } as unknown as IDatabaseAdapter,
			disableBasicCapabilities: true,
		});
		vi.spyOn(runtime, "getModel").mockImplementation((type) =>
			type === ModelType.TEXT_EMBEDDING ? vi.fn() : undefined,
		);
		vi.spyOn(runtime, "useModel").mockResolvedValue([1, 0]);

		const fragments =
			await sourcesFromRuntime(runtime).searchMemories?.("alpha beta");
		expect(fragments).toHaveLength(130);
		expect(searchMemories).toHaveBeenCalled();
		for (const [params] of searchMemories.mock.calls) {
			expect(params.query).toBeUndefined();
		}
	});

	it("retains every retrieved row through the final prepared model request", async () => {
		const fragments: Memory[] = Array.from({ length: 1_205 }, (_, index) => ({
			id: memoryId(index + 1_000),
			agentId: AGENT_ID,
			entityId: AGENT_ID,
			roomId: AGENT_ID,
			createdAt: 10_000 - index,
			content: { text: `retrieved document ${index} ${"x".repeat(500)}` },
			metadata: {
				type: MemoryType.FRAGMENT,
				documentId: memoryId(999),
				position: index,
				timestamp: 10_000 - index,
			},
		}));
		const retrievalRuntime = {
			agentId: AGENT_ID,
			adapter: {
				stableRetrievalCapability: 1 as const,
				queryDocumentFragments: vi.fn(async () => fragments),
				queryDocumentFragmentsPage: vi.fn(async (params) =>
					createStableRetrievalPage(fragments, {
						limit: params.limit,
						cursor: params.cursor,
						rankBySimilarity: false,
						queryFingerprint: stableRetrievalQueryFingerprint({
							kind: "issue-25150-projection",
						}),
					}),
				),
			},
			getModel: vi.fn(() => undefined),
			getRoomsForParticipants: vi.fn(async () => [AGENT_ID]),
			getRoom: vi.fn(async () => ({
				id: AGENT_ID,
				agentId: AGENT_ID,
				worldId: AGENT_ID,
			})),
			getWorld: vi.fn(async () => ({
				id: AGENT_ID,
				agentId: AGENT_ID,
				metadata: { roles: { [AGENT_ID]: "USER" } },
			})),
			reportError: vi.fn(),
		};
		const documentService = new (
			DocumentService as new (
				runtime: unknown,
			) => DocumentService
		)(retrievalRuntime);
		const documents = await documentService.searchDocuments(
			{
				id: memoryId(998),
				agentId: AGENT_ID,
				entityId: AGENT_ID,
				roomId: AGENT_ID,
				createdAt: 1,
				content: { text: "retrieved document" },
			},
			undefined,
			"keyword",
		);
		expect(documents).toHaveLength(1_205);
		const result = {
			success: true,
			data: { documents },
		} as unknown as PlannerToolResult;
		const projected = projectToolResultForModel(result);
		expect((projected.data as { documents: unknown[] }).documents).toHaveLength(
			1_205,
		);

		const runtime = new AgentRuntime({
			agentId: AGENT_ID,
			adapter: {
				createLogs: vi.fn(async () => undefined),
			} as unknown as IDatabaseAdapter,
			disableBasicCapabilities: true,
		});
		let providerPrompt = "";
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async (_runtime, params: { prompt?: string }) => {
				providerPrompt = params.prompt ?? "";
				return "provider accepted complete input";
			},
			"issue-25150-provider",
			100,
		);
		await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt: JSON.stringify(projected),
			maxTokens: 16,
		});
		const prepared = JSON.parse(providerPrompt) as {
			data: { documents: Array<{ id: UUID }> };
		};
		expect(prepared.data.documents).toHaveLength(1_205);
		expect(prepared.data.documents[0]?.id).toBe(memoryId(1_000));
		expect(prepared.data.documents[602]?.id).toBe(memoryId(1_602));
		expect(prepared.data.documents[1_204]?.id).toBe(memoryId(2_204));
	});

	it("returns an actionable conflict instead of partial message context on append", async () => {
		const original: Memory = {
			id: memoryId(3_000),
			agentId: AGENT_ID,
			entityId: AGENT_ID,
			roomId: AGENT_ID,
			createdAt: 10,
			content: { text: "original message" },
		};
		const appended: Memory = {
			...original,
			id: memoryId(3_001),
			createdAt: 11,
			content: { text: "concurrent message" },
		};
		let reads = 0;
		const runtime = {
			agentId: AGENT_ID,
			getModel: vi.fn(() => undefined),
			getService: vi.fn(() => null),
			adapter: {
				searchMessages: vi.fn(async (params: { offset?: number }) => {
					reads += 1;
					const rows = reads <= 2 ? [original] : [appended, original];
					return rows.slice(params.offset ?? 0).map((memory) => ({
						memory,
						ftsRank: 1,
						trigramSimilarity: 1,
					}));
				}),
			},
		} as unknown as IAgentRuntime;

		await expect(
			sourcesFromRuntime(runtime, { roomIds: [AGENT_ID] }).searchMessages?.(
				"message",
			),
		).rejects.toMatchObject({
			code: "PII_CONTEXT_SOURCE_UNSTABLE",
			context: { action: "retry-from-first-page" },
		});
	});
});
