/**
 * Unit tests for identity-clusters: validates entity expansion,
 * verified identity authority validation, cache invalidation, and fallbacks.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "./errors.ts";
import {
	getRelatedEntityIds,
	getVerifiedRelatedEntityIds,
	invalidateRelatedEntityIds,
	resolvePrimaryEntityId,
} from "./identity-clusters.ts";
import { type IAgentRuntime, ServiceType, type UUID } from "./types/index.ts";

describe("identity-clusters", () => {
	const mockAgentId = "00000000-0000-0000-0000-000000000000" as UUID;
	const entity1 = "11111111-1111-1111-1111-111111111111" as UUID;
	const entity2 = "22222222-2222-2222-2222-222222222222" as UUID;

	function createRuntime(services: Record<string, any> = {}) {
		return {
			agentId: mockAgentId,
			getService: (type: string) => services[type] ?? null,
		} as unknown as IAgentRuntime;
	}

	describe("getRelatedEntityIds", () => {
		it("returns [entityId] when relationships service is absent", async () => {
			const runtime = createRuntime();
			const result = await getRelatedEntityIds(runtime, entity1);
			expect(result).toEqual([entity1]);
		});

		it("expands entity cluster via relationships service", async () => {
			const runtime = createRuntime({
				relationships: {
					getMemberEntityIds: async (id: UUID) => [id, entity2],
				},
			});
			const result = await getRelatedEntityIds(runtime, entity1);
			expect(result).toEqual([entity1, entity2]);
		});
	});

	describe("getVerifiedRelatedEntityIds", () => {
		it("uses PrincipalService when available and validates cluster shape", async () => {
			const runtime = createRuntime({
				[ServiceType.PRINCIPAL]: {
					getCluster: async () => ({
						agentId: mockAgentId,
						generation: 1,
						canonicalPrincipalId: entity1,
						principalIds: [entity1, entity2],
					}),
				},
			});

			const result = await getVerifiedRelatedEntityIds(runtime, entity1);
			expect(result).toEqual([entity1, entity2]);
		});

		it("throws ElizaError on invalid cluster generation or mismatch", async () => {
			const runtime = createRuntime({
				[ServiceType.PRINCIPAL]: {
					getCluster: async () => ({
						agentId: mockAgentId,
						generation: -1, // invalid generation
						canonicalPrincipalId: entity1,
						principalIds: [entity1],
					}),
				},
			});

			await expect(
				getVerifiedRelatedEntityIds(runtime, entity1),
			).rejects.toThrow(ElizaError);
		});
	});

	describe("resolvePrimaryEntityId", () => {
		it("returns original entityId when resolver is absent", async () => {
			const runtime = createRuntime();
			expect(await resolvePrimaryEntityId(runtime, entity1)).toBe(entity1);
		});

		it("resolves primary entity id when service provides it", async () => {
			const runtime = createRuntime({
				relationships: {
					resolvePrimaryEntityId: async () => entity2,
				},
			});
			expect(await resolvePrimaryEntityId(runtime, entity1)).toBe(entity2);
		});
	});

	describe("invalidateRelatedEntityIds", () => {
		it("runs without throwing for specific entity or all entities", () => {
			const runtime = createRuntime();
			expect(() => invalidateRelatedEntityIds(runtime, entity1)).not.toThrow();
			expect(() => invalidateRelatedEntityIds(runtime)).not.toThrow();
		});
	});
});
