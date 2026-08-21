/**
 * Unit contract for the egress glue that joins the attested delivery audience
 * with the min-over-members policy core. Covers the evidence-derived per-viewer
 * resolver (owner → full, non-owner → scope-ladder/grant), the fail-closed
 * subject parser, and the composed `resolveEgressAudienceAdmission`. The parity
 * against REAL attested audiences lives in the policy-core suite
 * (audience-disclosure.test.ts); here the audience is a structurally-valid cast
 * because the brand is module-private.
 */
import { describe, expect, it } from "vitest";
import type { TrustedDeliveryAudience } from "../security/trusted-delivery-audience";
import type { UUID } from "../types";
import type { DisclosureSubject } from "./audience-disclosure";
import {
	parseEgressDisclosureSubject,
	resolveEgressAudienceAdmission,
	viewerResolverFromAudience,
} from "./audience-egress";

const OWNER = "11111111-1111-1111-1111-111111111111" as UUID;
const AGENT = "22222222-2222-2222-2222-222222222222" as UUID;
const GUEST = "33333333-3333-3333-3333-333333333333" as UUID;
const GUEST_TWO = "44444444-4444-4444-4444-444444444444" as UUID;
const ROOM = "55555555-5555-5555-5555-555555555555" as UUID;

function census(
	participants: readonly UUID[],
	overrides: Partial<TrustedDeliveryAudience> = {},
): TrustedDeliveryAudience {
	return {
		kind: "group",
		provenance: "canonical_room",
		actorEntityId: OWNER,
		canonicalOwnerEntityId: OWNER,
		agentEntityId: AGENT,
		roomId: ROOM,
		participantEntityIds: participants,
		membershipVersion: JSON.stringify([...participants].sort()),
		issuedAtMs: 1_000,
		expiresAtMs: 301_000,
		...overrides,
	} as TrustedDeliveryAudience;
}

const OWNER_PRIVATE_SUBJECT: DisclosureSubject = {
	scope: "owner-private",
	scopedEntityId: OWNER,
};

describe("viewerResolverFromAudience", () => {
	it("resolves the canonical owner to full on an owner-private subject", () => {
		const resolve = viewerResolverFromAudience(
			OWNER_PRIVATE_SUBJECT,
			census([OWNER, AGENT, GUEST]),
		);
		expect(resolve(OWNER)).toBe("full");
	});

	it("resolves a non-owner participant to none on an owner-private subject (fail-closed floor)", () => {
		const resolve = viewerResolverFromAudience(
			OWNER_PRIVATE_SUBJECT,
			census([OWNER, AGENT, GUEST]),
		);
		expect(resolve(GUEST)).toBe("none");
	});

	it("honors a full grant for a non-owner (grant beats the ladder up)", () => {
		const subject: DisclosureSubject = {
			...OWNER_PRIVATE_SUBJECT,
			grants: [{ entityId: GUEST, mode: "full" }],
		};
		const resolve = viewerResolverFromAudience(
			subject,
			census([OWNER, AGENT, GUEST]),
		);
		expect(resolve(GUEST)).toBe("full");
	});

	it("honors a redacted grant narrowing a member the ladder would allow (grant beats the ladder down)", () => {
		const subject: DisclosureSubject = {
			scope: "global",
			grants: [{ entityId: GUEST, mode: "redacted" }],
		};
		const resolve = viewerResolverFromAudience(
			subject,
			census([OWNER, AGENT, GUEST]),
		);
		expect(resolve(GUEST)).toBe("redacted");
	});

	it("treats a null canonical owner as no elevated member (all non-agent → ladder)", () => {
		const resolve = viewerResolverFromAudience(
			OWNER_PRIVATE_SUBJECT,
			census([OWNER, AGENT, GUEST], { canonicalOwnerEntityId: null }),
		);
		// With no owner, even the actor gets the bare USER tier and fails closed
		// on owner-private.
		expect(resolve(OWNER)).toBe("none");
		expect(resolve(GUEST)).toBe("none");
	});
});

describe("resolveEgressAudienceAdmission", () => {
	it("owner-only DM census admits full for an owner-private subject", () => {
		const admission = resolveEgressAudienceAdmission(
			OWNER_PRIVATE_SUBJECT,
			census([OWNER, AGENT]),
		);
		expect(admission.level).toBe("full");
		expect(admission.blockingEntityIds).toEqual([]);
	});

	it("one ungranted stranger caps the room to none and blocks", () => {
		const admission = resolveEgressAudienceAdmission(
			OWNER_PRIVATE_SUBJECT,
			census([OWNER, AGENT, GUEST]),
		);
		expect(admission.level).toBe("none");
		expect(admission.blockingEntityIds).toEqual([GUEST]);
	});

	it("every member granted full → full, nothing blocking", () => {
		const subject: DisclosureSubject = {
			...OWNER_PRIVATE_SUBJECT,
			grants: [
				{ entityId: GUEST, mode: "full" },
				{ entityId: GUEST_TWO, mode: "full" },
			],
		};
		const admission = resolveEgressAudienceAdmission(
			subject,
			census([OWNER, AGENT, GUEST, GUEST_TWO]),
		);
		expect(admission.level).toBe("full");
		expect(admission.blockingEntityIds).toEqual([]);
	});

	it("a redacted grant in the mix caps the room to redacted and blocks full", () => {
		const subject: DisclosureSubject = {
			...OWNER_PRIVATE_SUBJECT,
			grants: [{ entityId: GUEST, mode: "redacted" }],
		};
		const admission = resolveEgressAudienceAdmission(
			subject,
			census([OWNER, AGENT, GUEST]),
		);
		expect(admission.level).toBe("redacted");
		expect(admission.blockingEntityIds).toEqual([GUEST]);
	});

	it("empty (agent-only) census fails closed to none", () => {
		const admission = resolveEgressAudienceAdmission(
			OWNER_PRIVATE_SUBJECT,
			census([AGENT]),
		);
		expect(admission.level).toBe("none");
	});
});

describe("parseEgressDisclosureSubject", () => {
	it("returns undefined for an absent marker (unscoped response)", () => {
		expect(parseEgressDisclosureSubject(undefined)).toBeUndefined();
		expect(parseEgressDisclosureSubject(null)).toBeUndefined();
	});

	it("parses a well-formed subject with scope, scoped entity, and grants", () => {
		const subject = parseEgressDisclosureSubject({
			scope: "owner-private",
			scopedEntityId: OWNER,
			grants: [{ entityId: GUEST, mode: "full" }],
		});
		expect(subject).toEqual({
			scope: "owner-private",
			scopedEntityId: OWNER,
			grants: [{ entityId: GUEST, mode: "full" }],
		});
	});

	it("fails closed to owner-private on an unknown scope", () => {
		const subject = parseEgressDisclosureSubject({ scope: "banana" });
		expect(subject).toEqual({ scope: "owner-private" });
	});

	it("fails closed to owner-private on a present-but-non-object marker", () => {
		expect(parseEgressDisclosureSubject("owner-private")).toEqual({
			scope: "owner-private",
		});
		expect(parseEgressDisclosureSubject(42)).toEqual({
			scope: "owner-private",
		});
	});

	it("drops malformed grant entries (fail closed, never a fabricated grant)", () => {
		const subject = parseEgressDisclosureSubject({
			scope: "global",
			grants: [
				{ entityId: GUEST, mode: "full" },
				{ entityId: "not-a-uuid", mode: "full" },
				{ entityId: GUEST_TWO, mode: "sideways" },
				{ mode: "full" },
				null,
			],
		});
		expect(subject).toEqual({
			scope: "global",
			grants: [{ entityId: GUEST, mode: "full" }],
		});
	});

	it("omits an empty grants array from the parsed subject", () => {
		expect(
			parseEgressDisclosureSubject({ scope: "global", grants: [] }),
		).toEqual({ scope: "global" });
	});
});
