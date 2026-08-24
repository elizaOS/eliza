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
import { runWithTrajectoryContext } from "./trajectory-context.ts";
import {
	IDENTITY_AUTHORITY_CONTRACT_VERSION,
	type IdentityCluster,
	type PrincipalService,
} from "./types/identity.ts";
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

const AUTHORITY_AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const AUTHORITY_ENTITY_ID = "22222222-2222-2222-2222-222222222222" as UUID;
const OTHER_AUTHORITY_ENTITY_ID =
	"22222222-2222-2222-2222-222222222223" as UUID;
const AUTHORITY_ALIAS_ID = "33333333-3333-3333-3333-333333333331" as UUID;
const AUTHORITY_PRIMARY_ID = "44444444-4444-4444-4444-444444444441" as UUID;

function makeAuthorityRuntime(
	services: Record<string, unknown>,
): IAgentRuntime {
	return {
		agentId: AUTHORITY_AGENT_ID,
		getService: (type: string) => services[type] ?? null,
	} as unknown as IAgentRuntime;
}

function makeCluster(
	overrides: Partial<IdentityCluster> = {},
): IdentityCluster {
	return {
		contractVersion: IDENTITY_AUTHORITY_CONTRACT_VERSION,
		agentId: AUTHORITY_AGENT_ID,
		canonicalPrincipalId: AUTHORITY_PRIMARY_ID,
		principalIds: [AUTHORITY_ENTITY_ID, AUTHORITY_PRIMARY_ID],
		claims: [],
		generation: 3,
		readAt: new Date(0).toISOString(),
		...overrides,
	};
}

describe("getVerifiedRelatedEntityIds authority validation", () => {
	it("returns the requester alone when the authority reports no cluster", async () => {
		const authority = {
			getCluster: async () => null,
		} as unknown as PrincipalService;

		await expect(
			getVerifiedRelatedEntityIds(
				makeAuthorityRuntime({ principal: authority }),
				AUTHORITY_ENTITY_ID,
			),
		).resolves.toEqual([AUTHORITY_ENTITY_ID]);
	});

	it("places the requester and canonical principal before other verified members", async () => {
		const authority = {
			getCluster: async () =>
				makeCluster({
					principalIds: [
						AUTHORITY_ALIAS_ID,
						AUTHORITY_ENTITY_ID,
						AUTHORITY_PRIMARY_ID,
						AUTHORITY_ALIAS_ID,
					],
				}),
		} as unknown as PrincipalService;

		await expect(
			getVerifiedRelatedEntityIds(
				makeAuthorityRuntime({ principal: authority }),
				AUTHORITY_ENTITY_ID,
			),
		).resolves.toEqual([
			AUTHORITY_ENTITY_ID,
			AUTHORITY_PRIMARY_ID,
			AUTHORITY_ALIAS_ID,
		]);
	});

	it.each([
		{
			name: "the cluster belongs to another agent",
			override: { agentId: OTHER_AUTHORITY_ENTITY_ID },
		},
		{ name: "the generation is negative", override: { generation: -1 } },
		{
			name: "the generation is not a safe integer",
			override: { generation: Number.NaN },
		},
		{
			name: "the canonical principal is not a member",
			override: {
				principalIds: [AUTHORITY_ENTITY_ID],
				canonicalPrincipalId: AUTHORITY_ALIAS_ID,
			},
		},
		{
			name: "a principal id is empty",
			override: {
				principalIds: [AUTHORITY_ENTITY_ID, AUTHORITY_PRIMARY_ID, "" as UUID],
			},
		},
	])("fails closed when $name", async ({ override }) => {
		const authority = {
			getCluster: async () => makeCluster(override),
		} as unknown as PrincipalService;

		await expect(
			getVerifiedRelatedEntityIds(
				makeAuthorityRuntime({ principal: authority }),
				AUTHORITY_ENTITY_ID,
			),
		).rejects.toMatchObject({
			code: "IDENTITY_CLUSTER_INVALID",
			context: {
				entityId: AUTHORITY_ENTITY_ID,
				runtimeAgentId: AUTHORITY_AGENT_ID,
			},
		});
	});
});

describe("verified identity-cluster invalidation", () => {
	it("supports targeted and agent-wide prefix invalidation", async () => {
		const callsByEntity = new Map<UUID, number>();
		const authority = {
			getCluster: async (_agentId: UUID, entityId: UUID) => {
				callsByEntity.set(entityId, (callsByEntity.get(entityId) ?? 0) + 1);
				return makeCluster({
					canonicalPrincipalId: entityId,
					principalIds: [entityId],
				});
			},
		} as unknown as PrincipalService;
		const runtime = makeAuthorityRuntime({ principal: authority });

		await runWithTrajectoryContext({ turnMemo: new Map() }, async () => {
			await getVerifiedRelatedEntityIds(runtime, AUTHORITY_ENTITY_ID);
			await getVerifiedRelatedEntityIds(runtime, OTHER_AUTHORITY_ENTITY_ID);
			await getVerifiedRelatedEntityIds(runtime, AUTHORITY_ENTITY_ID);
			await getVerifiedRelatedEntityIds(runtime, OTHER_AUTHORITY_ENTITY_ID);
			expect(callsByEntity.get(AUTHORITY_ENTITY_ID)).toBe(1);
			expect(callsByEntity.get(OTHER_AUTHORITY_ENTITY_ID)).toBe(1);

			invalidateRelatedEntityIds(runtime, AUTHORITY_ENTITY_ID);
			await getVerifiedRelatedEntityIds(runtime, AUTHORITY_ENTITY_ID);
			await getVerifiedRelatedEntityIds(runtime, OTHER_AUTHORITY_ENTITY_ID);
			expect(callsByEntity.get(AUTHORITY_ENTITY_ID)).toBe(2);
			expect(callsByEntity.get(OTHER_AUTHORITY_ENTITY_ID)).toBe(1);

			invalidateRelatedEntityIds(runtime);
			await getVerifiedRelatedEntityIds(runtime, AUTHORITY_ENTITY_ID);
			await getVerifiedRelatedEntityIds(runtime, OTHER_AUTHORITY_ENTITY_ID);
			expect(callsByEntity.get(AUTHORITY_ENTITY_ID)).toBe(3);
			expect(callsByEntity.get(OTHER_AUTHORITY_ENTITY_ID)).toBe(2);
		});
	});
});
