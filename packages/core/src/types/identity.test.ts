/**
 * Verifies the public identity-authority vocabulary and runtime service key
 * through deterministic contract assertions.
 */

import { describe, expect, it } from "vitest";
import * as identityContracts from "./identity";
import {
	IDENTITY_AUTHORITY_CONTRACT_VERSION,
	IDENTITY_CLAIM_STATUSES,
	IDENTITY_CLAIM_VERIFICATIONS,
	IDENTITY_MERGE_OPERATIONS,
	IDENTITY_MERGE_STATUSES,
	IDENTITY_REDIRECT_STATUSES,
	PrincipalService,
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
		expect(ServiceType.PRINCIPAL).toBe("principal");
		expect(PrincipalService.serviceType).toBe(ServiceType.PRINCIPAL);

		const retiredKey = ["IDENTITY", "RESOLUTION"].join("_");
		const retiredValue = ["identity", "resolution"].join("_");
		const retiredExport = ["Identity", "Resolution", "Service"].join("");
		expect(Object.hasOwn(ServiceType, retiredKey)).toBe(false);
		expect(Object.values(ServiceType)).not.toContain(retiredValue);
		expect(Object.hasOwn(identityContracts, retiredExport)).toBe(false);
	});
});
