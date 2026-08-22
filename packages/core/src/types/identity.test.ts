/**
 * Verifies the public identity-authority vocabulary and runtime service key
 * through deterministic contract assertions.
 */

import { describe, expect, it } from "vitest";
import {
	IDENTITY_AUTHORITY_CONTRACT_VERSION,
	IDENTITY_CLAIM_EVENT_KINDS,
	IDENTITY_CLAIM_STATUSES,
	IDENTITY_CLAIM_VERIFICATIONS,
	IDENTITY_MERGE_OPERATIONS,
	IDENTITY_MERGE_STATUSES,
	IDENTITY_REDIRECT_STATUSES,
	type IdentityClaim,
	IdentityResolutionService,
} from "./identity";
import { ServiceType } from "./service";

describe("identity authority contract", () => {
	it("keeps the mutation vocabulary closed and versioned", () => {
		expect(IDENTITY_AUTHORITY_CONTRACT_VERSION).toBe(1);
		expect(IDENTITY_CLAIM_VERIFICATIONS).toEqual([
			"unverified",
			"observed",
			"verified",
			"owner_bound",
		]);
		expect(IDENTITY_CLAIM_STATUSES).toEqual([
			"active",
			"revoked",
			"superseded",
			"disputed",
		]);
		expect(IDENTITY_CLAIM_EVENT_KINDS).toEqual([
			"observed",
			"refreshed",
			"verified",
			"disputed",
			"revoked",
		]);
		expect(IDENTITY_MERGE_OPERATIONS).toEqual(["merge", "split"]);
		expect(IDENTITY_MERGE_STATUSES).toEqual([
			"planned",
			"committed",
			"completed",
			"reverted",
			"failed",
		]);
		expect(IDENTITY_REDIRECT_STATUSES).toEqual([
			"active",
			"superseded",
			"reverted",
		]);
	});

	it("registers one canonical runtime service name", () => {
		expect(ServiceType.IDENTITY_RESOLUTION).toBe("identity_resolution");
		expect(IdentityResolutionService.serviceType).toBe(
			ServiceType.IDENTITY_RESOLUTION,
		);
	});

	it("keeps contract-v1 claim versions additive for existing consumers", () => {
		const legacyClaim: IdentityClaim = {
			contractVersion: 1,
			id: crypto.randomUUID() as IdentityClaim["id"],
			agentId: crypto.randomUUID() as IdentityClaim["agentId"],
			principalEntityId:
				crypto.randomUUID() as IdentityClaim["principalEntityId"],
			namespace: "legacy",
			connectorId: "discord",
			connectorAccountId:
				crypto.randomUUID() as IdentityClaim["connectorAccountId"],
			externalSubjectId: "subject",
			handle: null,
			displayName: null,
			verification: "observed",
			status: "active",
			confidence: 0.5,
			ownerBindingId: null,
			provenance: {},
			evidence: {},
			firstSeenAt: "2026-08-21T00:00:00.000Z",
			lastSeenAt: "2026-08-21T00:00:00.000Z",
			verifiedAt: null,
			revokedAt: null,
			createdAt: "2026-08-21T00:00:00.000Z",
			updatedAt: "2026-08-21T00:00:00.000Z",
		};
		expect(legacyClaim.version).toBeUndefined();
		expect(IdentityResolutionService.prototype.observeClaim).toBeTypeOf(
			"function",
		);
	});
});
