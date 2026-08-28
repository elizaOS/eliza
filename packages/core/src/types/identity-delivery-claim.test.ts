/**
 * Exercises the shared PrincipalService delivery-claim resolution pipeline —
 * the concrete logic in core that every backend inherits: refusal reasons for
 * missing/filtered claims, the connector-account eligibility hook (including
 * the base-owned `connector_account_ineligible` refusal), deterministic
 * ambiguous ordering, and the fail-closed flag parser. Deterministic in-memory
 * subclass; no runtime, DB, or model.
 */

import { describe, expect, it } from "vitest";
import {
	type IdentityClaim,
	type IdentityCluster,
	identityDeliveryClaimsAuthoritative,
	orderIdentityDeliveryClaims,
	PrincipalService,
} from "./identity";
import type { UUID } from "./primitives";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const PRINCIPAL_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const ACCOUNT_A = "00000000-0000-0000-0000-0000000000d1" as UUID;
const ACCOUNT_B = "00000000-0000-0000-0000-0000000000d2" as UUID;

function makeClaim(
	overrides: Partial<IdentityClaim> & { id: UUID },
): IdentityClaim {
	return {
		contractVersion: 1,
		agentId: AGENT_ID,
		principalEntityId: PRINCIPAL_ID,
		namespace: "default",
		connectorId: "google",
		connectorAccountId: ACCOUNT_A,
		externalSubjectId: "subject-1",
		handle: "person@example.com",
		displayName: null,
		verification: "verified",
		status: "active",
		confidence: 1,
		ownerBindingId: null,
		provenance: {},
		evidence: {},
		firstSeenAt: "2026-01-01T00:00:00.000Z",
		lastSeenAt: "2026-01-01T00:00:00.000Z",
		verifiedAt: "2026-01-01T00:00:00.000Z",
		revokedAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function makeCluster(claims: IdentityClaim[]): IdentityCluster {
	return {
		contractVersion: 1,
		agentId: AGENT_ID,
		canonicalPrincipalId: PRINCIPAL_ID,
		principalIds: [PRINCIPAL_ID],
		claims,
		generation: 7,
		readAt: "2026-01-01T00:00:00.000Z",
	};
}

/**
 * Minimal in-memory PrincipalService: only the members the shared delivery
 * pipeline touches are real (cluster read + eligibility hook); everything
 * else throws so an unexpected call fails the test loudly.
 */
class FakePrincipalService extends PrincipalService {
	constructor(
		private readonly cluster: IdentityCluster | null,
		private readonly eligibleAccountIds: readonly UUID[] | "all" = "all",
	) {
		super();
	}
	readonly eligibilityCalls: Array<readonly IdentityClaim[]> = [];

	async getCluster(): Promise<IdentityCluster | null> {
		return this.cluster;
	}
	protected async filterConnectorAccountEligibleClaims(
		_agentId: UUID,
		claims: readonly IdentityClaim[],
	): Promise<readonly IdentityClaim[]> {
		this.eligibilityCalls.push(claims);
		if (this.eligibleAccountIds === "all") return claims;
		return claims.filter((claim) =>
			this.eligibleAccountIds.includes(claim.connectorAccountId),
		);
	}
	async stop(): Promise<void> {}

	private unexercised(): never {
		throw new Error(
			"FakePrincipalService: member not exercised by the delivery pipeline",
		);
	}
	resolveCanonicalPrincipal(): never {
		return this.unexercised();
	}
	resolveForDisplay(): never {
		return this.unexercised();
	}
	resolveForDataAccess(): never {
		return this.unexercised();
	}
	resolveClaim(): never {
		return this.unexercised();
	}
	resolveVerifiedDeliveryClaims(): never {
		return this.unexercised();
	}
	evaluateOwnerBinding(): never {
		return this.unexercised();
	}
	attestPersonLink(): never {
		return this.unexercised();
	}
	verifyPersonLink(): never {
		return this.unexercised();
	}
	proposeMerge(): never {
		return this.unexercised();
	}
	confirmMerge(): never {
		return this.unexercised();
	}
	commitMerge(): never {
		return this.unexercised();
	}
	split(): never {
		return this.unexercised();
	}
	getJournal(): never {
		return this.unexercised();
	}
	listRedirects(): never {
		return this.unexercised();
	}
	listJournal(): never {
		return this.unexercised();
	}
}

const baseRequest = {
	agentId: AGENT_ID,
	principalId: PRINCIPAL_ID,
	connectorId: "google",
	connectorAccountId: ACCOUNT_A,
};

describe("PrincipalService.resolveIdentityDeliveryClaim (shared pipeline)", () => {
	it("refuses an unknown principal before any claim filtering", async () => {
		const service = new FakePrincipalService(null);
		const resolution = await service.resolveIdentityDeliveryClaim(baseRequest);
		expect(resolution).toMatchObject({
			decision: "no_claim",
			reason: "principal_not_found",
			canonicalPrincipalId: null,
		});
		expect(service.eligibilityCalls).toHaveLength(0);
	});

	it("refuses when only unverified or inactive claims exist", async () => {
		const service = new FakePrincipalService(
			makeCluster([
				makeClaim({
					id: "00000000-0000-0000-0000-0000000000f1" as UUID,
					verification: "observed",
				}),
				makeClaim({
					id: "00000000-0000-0000-0000-0000000000f2" as UUID,
					status: "revoked",
				}),
			]),
		);
		const resolution = await service.resolveIdentityDeliveryClaim(baseRequest);
		expect(resolution).toMatchObject({
			decision: "no_claim",
			reason: "no_active_verified_claim",
		});
	});

	it("scopes to the requested connector and account", async () => {
		const service = new FakePrincipalService(
			makeCluster([
				makeClaim({
					id: "00000000-0000-0000-0000-0000000000f1" as UUID,
					connectorId: "discord",
				}),
			]),
		);
		expect(
			await service.resolveIdentityDeliveryClaim(baseRequest),
		).toMatchObject({ decision: "no_claim", reason: "no_connector_claim" });

		const accountScoped = new FakePrincipalService(
			makeCluster([
				makeClaim({
					id: "00000000-0000-0000-0000-0000000000f1" as UUID,
					connectorAccountId: ACCOUNT_B,
				}),
			]),
		);
		expect(
			await accountScoped.resolveIdentityDeliveryClaim(baseRequest),
		).toMatchObject({ decision: "no_claim", reason: "no_account_claim" });
	});

	it("returns connector_account_ineligible when the eligibility hook rejects every claim", async () => {
		const service = new FakePrincipalService(
			makeCluster([
				makeClaim({ id: "00000000-0000-0000-0000-0000000000f1" as UUID }),
			]),
			[],
		);
		const resolution = await service.resolveIdentityDeliveryClaim(baseRequest);
		expect(resolution).toMatchObject({
			decision: "no_claim",
			reason: "connector_account_ineligible",
			canonicalPrincipalId: PRINCIPAL_ID,
			generation: 7,
		});
		expect(service.eligibilityCalls).toHaveLength(1);
	});

	it("resolves the sole eligible claim after the hook filters the rest", async () => {
		const eligible = makeClaim({
			id: "00000000-0000-0000-0000-0000000000f1" as UUID,
		});
		const ineligible = makeClaim({
			id: "00000000-0000-0000-0000-0000000000f2" as UUID,
			connectorAccountId: ACCOUNT_B,
		});
		const service = new FakePrincipalService(
			makeCluster([ineligible, eligible]),
			[ACCOUNT_A],
		);
		const resolution = await service.resolveIdentityDeliveryClaim({
			...baseRequest,
			connectorAccountId: undefined,
		});
		expect(resolution).toMatchObject({
			decision: "resolved",
			claim: { id: eligible.id },
			generation: 7,
		});
	});

	it("orders ambiguous claims by the canonical multi-key comparator, not raw id order", async () => {
		// Ids are chosen so id-only ordering would reverse the expected result:
		// the claim with the LOWER handle carries the HIGHER id.
		const later = makeClaim({
			id: "00000000-0000-0000-0000-00000000000a" as UUID,
			handle: "zed@example.com",
			externalSubjectId: "subject-z",
		});
		const earlier = makeClaim({
			id: "00000000-0000-0000-0000-00000000000b" as UUID,
			handle: "alice@example.com",
			externalSubjectId: "subject-a",
		});
		const service = new FakePrincipalService(makeCluster([later, earlier]));
		const resolution = await service.resolveIdentityDeliveryClaim(baseRequest);
		if (resolution.decision !== "ambiguous") {
			throw new Error(`expected ambiguous, got ${resolution.decision}`);
		}
		expect(resolution.claims.map((claim) => claim.id)).toEqual([
			earlier.id,
			later.id,
		]);
		expect(resolution.claims).toEqual(
			orderIdentityDeliveryClaims([later, earlier]),
		);
	});

	it("ignores namespace for eligibility: claims differing only by namespace both survive scoping", async () => {
		const a = makeClaim({
			id: "00000000-0000-0000-0000-0000000000f1" as UUID,
			namespace: "workspace-a",
		});
		const b = makeClaim({
			id: "00000000-0000-0000-0000-0000000000f2" as UUID,
			namespace: "workspace-b",
		});
		const service = new FakePrincipalService(makeCluster([a, b]));
		const resolution = await service.resolveIdentityDeliveryClaim(baseRequest);
		expect(resolution.decision).toBe("ambiguous");
		if (resolution.decision === "ambiguous") {
			expect(resolution.claims).toHaveLength(2);
		}
	});
});

describe("identityDeliveryClaimsAuthoritative flag parsing", () => {
	it("opts in only on explicit affirmative values and fails closed otherwise", () => {
		expect(identityDeliveryClaimsAuthoritative(true)).toBe(true);
		expect(identityDeliveryClaimsAuthoritative("true")).toBe(true);
		expect(identityDeliveryClaimsAuthoritative(" ON ")).toBe(true);
		expect(identityDeliveryClaimsAuthoritative("1")).toBe(true);
		expect(identityDeliveryClaimsAuthoritative(undefined)).toBe(false);
		expect(identityDeliveryClaimsAuthoritative(null)).toBe(false);
		expect(identityDeliveryClaimsAuthoritative(false)).toBe(false);
		expect(identityDeliveryClaimsAuthoritative("false")).toBe(false);
		expect(identityDeliveryClaimsAuthoritative("enabled?")).toBe(false);
		expect(identityDeliveryClaimsAuthoritative(1)).toBe(false);
	});
});
