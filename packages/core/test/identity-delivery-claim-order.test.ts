import { describe, expect, it } from "vitest";
import {
	IDENTITY_AUTHORITY_CONTRACT_VERSION,
	type IdentityClaim,
	orderIdentityDeliveryClaims,
} from "../src/types/identity";
import type { UUID } from "../src/types/primitives";

const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000aa" as UUID;

function claim(handle: string, idSuffix: string): IdentityClaim {
	return {
		contractVersion: IDENTITY_AUTHORITY_CONTRACT_VERSION,
		id: `00000000-0000-4000-8000-0000000000${idSuffix}` as UUID,
		agentId: "00000000-0000-4000-8000-000000000001" as UUID,
		principalEntityId: "00000000-0000-4000-8000-000000000002" as UUID,
		namespace: "discord",
		connectorId: "discord",
		connectorAccountId: ACCOUNT_ID,
		externalSubjectId: "subject-1",
		handle,
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
	};
}

const handles = (claims: readonly IdentityClaim[]) =>
	orderIdentityDeliveryClaims(claims).map((entry) => entry.handle);

describe("orderIdentityDeliveryClaims", () => {
	it("orders mixed-case handles in code-unit order, not host-locale collation order", () => {
		// ICU collation (the default localeCompare) compares case-insensitively
		// at primary strength, so it puts "a" before "B" and "a" before "Z".
		// The canonical ordering contract requires the code-unit order every
		// implementation computes identically: "B" (U+0042) and "Z" (U+005A)
		// both precede "a" (U+0061).
		expect(handles([claim("a", "a1"), claim("B", "b1")])).toEqual(["B", "a"]);
		expect(handles([claim("a", "a1"), claim("Z", "c1")])).toEqual(["Z", "a"]);
	});

	it("returns the same order for a reversed input", () => {
		const forward = handles([claim("a", "a1"), claim("B", "b1")]);
		const reversed = handles([claim("B", "b1"), claim("a", "a1")]);
		expect(reversed).toEqual(forward);
	});

	it("keeps the code-unit order for handle pairs other locales reorder", () => {
		// Under da_DK collation "aa" sorts after "b0"; code-unit order does not.
		expect(handles([claim("b0", "b1"), claim("aa", "a1")])).toEqual([
			"aa",
			"b0",
		]);
	});

	it("leaves a single claim untouched", () => {
		const only = claim("solo", "a1");
		expect(orderIdentityDeliveryClaims([only])).toEqual([only]);
	});
});
