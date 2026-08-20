/**
 * Verifies the public identity-authority vocabulary and runtime service key
 * through deterministic contract assertions.
 */

import { describe, expect, it } from "vitest";
import {
	IDENTITY_AUTHORITY_CONTRACT_VERSION,
	IDENTITY_CLAIM_STATUSES,
	IDENTITY_CLAIM_VERIFICATIONS,
	IDENTITY_MERGE_OPERATIONS,
	IDENTITY_MERGE_STATUSES,
	IDENTITY_REDIRECT_STATUSES,
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
});
