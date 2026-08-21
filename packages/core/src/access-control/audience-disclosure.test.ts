/**
 * Unit contract for min-over-members audience admission: the pure join between
 * the attested delivery-audience census and the per-viewer artifact-disclosure
 * vocabulary. Includes the owner-DM parity suite proving `owner_exclusive`
 * stays the degenerate case of the generalized policy — admission over a
 * two-party owner DM agrees with what `decisionFromAudience` (via
 * `evaluateOwnerExclusiveDisclosure`) allows for the participant-census cases.
 */
import { describe, expect, it, vi } from "vitest";
import {
	attestDeliveryAudienceFromCanonicalRoom,
	evaluateOwnerExclusiveDisclosure,
	getTrustedDeliveryAudience,
	type TrustedDeliveryAudience,
} from "../security/trusted-delivery-audience";
import type {
	AccessContext,
	IAgentRuntime,
	Memory,
	Room,
	UUID,
} from "../types";
import { ChannelType } from "../types";
import { resolveArtifactDisclosure } from "./artifact-disclosure";
import {
	type DisclosureLevel,
	type DisclosureSubject,
	disclosureSubjectRecord,
	minDisclosureLevel,
	resolveAudienceAdmission,
} from "./audience-disclosure";

const OWNER = "11111111-1111-1111-1111-111111111111" as UUID;
const AGENT = "22222222-2222-2222-2222-222222222222" as UUID;
const GUEST = "33333333-3333-3333-3333-333333333333" as UUID;
const GUEST_TWO = "44444444-4444-4444-4444-444444444444" as UUID;
const ROOM = "55555555-5555-5555-5555-555555555555" as UUID;

/** Minimal structurally-valid audience for pure-policy cases. The brand is a
 * module-private symbol, so tests (like any non-attestor code) can only cast;
 * the parity suite below uses REAL attested audiences instead. */
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

/**
 * Per-viewer resolver built EXACTLY the way production callers must build it:
 * `resolveArtifactDisclosure` over `disclosureSubjectRecord`, so admission
 * inherits the artifact tier order (agent/OWNER/ADMIN full → grant beats
 * ladder both directions → owner-private fails closed).
 */
function viewerResolver(
	subject: DisclosureSubject,
	contexts: Partial<Record<UUID, Partial<AccessContext>>> = {},
): (entityId: UUID) => DisclosureLevel {
	return (entityId) =>
		resolveArtifactDisclosure(
			disclosureSubjectRecord(subject),
			{ requesterEntityId: entityId, ...contexts[entityId] },
			AGENT,
		);
}

describe("minDisclosureLevel", () => {
	it("orders none < redacted < full", () => {
		expect(minDisclosureLevel("full", "full")).toBe("full");
		expect(minDisclosureLevel("full", "redacted")).toBe("redacted");
		expect(minDisclosureLevel("redacted", "none")).toBe("none");
		expect(minDisclosureLevel("none", "full")).toBe("none");
	});
});

describe("resolveAudienceAdmission", () => {
	it("group census with one ungranted member → none, that member blocking", () => {
		const subject: DisclosureSubject = {
			...OWNER_PRIVATE_SUBJECT,
			grants: [{ entityId: GUEST, mode: "full" }],
		};
		const admission = resolveAudienceAdmission(
			subject,
			census([OWNER, AGENT, GUEST, GUEST_TWO]),
			viewerResolver(subject, { [OWNER]: { isOwner: true, role: "OWNER" } }),
		);
		expect(admission.level).toBe("none");
		expect(admission.blockingEntityIds).toEqual([GUEST_TWO]);
		expect(admission.perEntity.get(OWNER)).toBe("full");
		expect(admission.perEntity.get(GUEST)).toBe("full");
		expect(admission.perEntity.get(GUEST_TWO)).toBe("none");
		// The agent is excluded from the census evaluation entirely.
		expect(admission.perEntity.has(AGENT)).toBe(false);
	});

	it("same census where every member holds a full grant → full, none blocking", () => {
		const subject: DisclosureSubject = {
			...OWNER_PRIVATE_SUBJECT,
			grants: [
				{ entityId: GUEST, mode: "full" },
				{ entityId: GUEST_TWO, mode: "full" },
			],
		};
		const admission = resolveAudienceAdmission(
			subject,
			census([OWNER, AGENT, GUEST, GUEST_TWO]),
			viewerResolver(subject, { [OWNER]: { isOwner: true, role: "OWNER" } }),
		);
		expect(admission.level).toBe("full");
		expect(admission.blockingEntityIds).toEqual([]);
		expect(admission.perEntity.size).toBe(3);
	});

	it("redacted grant in the mix → min lands on redacted, member blocks full", () => {
		const subject: DisclosureSubject = {
			...OWNER_PRIVATE_SUBJECT,
			grants: [{ entityId: GUEST, mode: "redacted" }],
		};
		const admission = resolveAudienceAdmission(
			subject,
			census([OWNER, AGENT, GUEST]),
			viewerResolver(subject, { [OWNER]: { isOwner: true, role: "OWNER" } }),
		);
		expect(admission.level).toBe("redacted");
		expect(admission.perEntity.get(GUEST)).toBe("redacted");
		// Redacted admits the redacted variant but still blocks full delivery.
		expect(admission.blockingEntityIds).toEqual([GUEST]);
	});

	it("a redacted grant narrows even a member the ladder would allow (grant beats ladder both directions)", () => {
		const subject: DisclosureSubject = {
			scope: "global",
			grants: [{ entityId: GUEST, mode: "redacted" }],
		};
		const admission = resolveAudienceAdmission(
			subject,
			census([GUEST, GUEST_TWO, AGENT]),
			viewerResolver(subject),
		);
		// GUEST_TWO reads global in full via the ladder; GUEST's explicit
		// redacted grant caps the room.
		expect(admission.perEntity.get(GUEST_TWO)).toBe("full");
		expect(admission.perEntity.get(GUEST)).toBe("redacted");
		expect(admission.level).toBe("redacted");
	});

	it("empty audience (agent-only census) → none, fail closed", () => {
		const admission = resolveAudienceAdmission(
			OWNER_PRIVATE_SUBJECT,
			census([AGENT]),
			() => "full",
		);
		expect(admission.level).toBe("none");
		expect(admission.perEntity.size).toBe(0);
		expect(admission.blockingEntityIds).toEqual([]);
	});

	it("unattested/malformed audience evidence → none, fail closed", () => {
		for (const bad of [
			undefined,
			null,
			{},
			{ participantEntityIds: "not-an-array", agentEntityId: AGENT },
			{ participantEntityIds: [OWNER, 7], agentEntityId: AGENT },
			{ participantEntityIds: [OWNER], agentEntityId: "" },
		]) {
			const admission = resolveAudienceAdmission(
				OWNER_PRIVATE_SUBJECT,
				bad as unknown as TrustedDeliveryAudience,
				() => "full",
			);
			expect(admission.level).toBe("none");
			expect(admission.perEntity.size).toBe(0);
		}
	});

	it("resolver that throws → that member none, fail closed", () => {
		const resolver = vi.fn((entityId: UUID): DisclosureLevel => {
			if (entityId === GUEST) throw new Error("entity lookup failed");
			return "full";
		});
		const admission = resolveAudienceAdmission(
			OWNER_PRIVATE_SUBJECT,
			census([OWNER, AGENT, GUEST]),
			resolver,
		);
		expect(admission.perEntity.get(OWNER)).toBe("full");
		expect(admission.perEntity.get(GUEST)).toBe("none");
		expect(admission.level).toBe("none");
		expect(admission.blockingEntityIds).toEqual([GUEST]);
	});

	it("resolver returning a non-level value → none, fail closed", () => {
		const admission = resolveAudienceAdmission(
			OWNER_PRIVATE_SUBJECT,
			census([OWNER, AGENT]),
			(() => "everything") as unknown as (id: UUID) => DisclosureLevel,
		);
		expect(admission.perEntity.get(OWNER)).toBe("none");
		expect(admission.level).toBe("none");
	});

	it("malformed subject scope → every member none, fail closed", () => {
		const admission = resolveAudienceAdmission(
			{ scope: "everything" as never },
			census([OWNER, AGENT]),
			() => "full",
		);
		expect(admission.level).toBe("none");
		expect(admission.perEntity.get(OWNER)).toBe("none");
	});

	it("duplicate census entries evaluate once", () => {
		const resolver = vi.fn((): DisclosureLevel => "full");
		const admission = resolveAudienceAdmission(
			{ scope: "global" },
			census([GUEST, GUEST, AGENT]),
			resolver,
		);
		expect(resolver).toHaveBeenCalledTimes(1);
		expect(admission.level).toBe("full");
	});
});

/**
 * Owner-DM parity: `owner_exclusive` must remain the degenerate case of
 * min-over-members. For the participant-census cases decided at
 * `decisionFromAudience` (owner check + exactly {owner, agent} membership),
 * admission over a REAL attested audience agrees with
 * `evaluateOwnerExclusiveDisclosure`: allowed ⇔ every non-agent member of an
 * owner-private, grant-free subject resolves full (i.e. the owner alone).
 */
describe("owner-DM parity with decisionFromAudience", () => {
	function harness(type: ChannelType, participants: UUID[]) {
		const runtime = {
			agentId: AGENT,
			getRoom: vi.fn(async (roomId: UUID) =>
				roomId === ROOM
					? ({ id: ROOM, agentId: AGENT, type, source: "test" } as Room)
					: null,
			),
			getParticipantsForRoom: vi.fn(async () => [...participants]),
			getSetting: vi.fn((key: string) =>
				key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER : undefined,
			),
			reportError: vi.fn(),
			logger: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
		} as unknown as IAgentRuntime;
		return runtime;
	}

	function turn(actor: UUID): Memory {
		return {
			id: "66666666-6666-6666-6666-666666666666" as UUID,
			entityId: actor,
			agentId: AGENT,
			roomId: ROOM,
			content: { text: "show my private plan", source: "discord" },
		} as Memory;
	}

	async function attested(
		type: ChannelType,
		participants: UUID[],
		actor: UUID,
	): Promise<{ message: Memory; audience: TrustedDeliveryAudience }> {
		const runtime = harness(type, participants);
		const message = turn(actor);
		await attestDeliveryAudienceFromCanonicalRoom(runtime, message, {
			nowMs: 1_000,
		});
		const audience = getTrustedDeliveryAudience(message);
		if (!audience) throw new Error("attestation did not bind");
		return { message, audience };
	}

	function admissionFor(audience: TrustedDeliveryAudience) {
		return resolveAudienceAdmission(
			OWNER_PRIVATE_SUBJECT,
			audience,
			viewerResolver(OWNER_PRIVATE_SUBJECT, {
				[OWNER]: { isOwner: true, role: "OWNER" },
			}),
		);
	}

	it("two-party owner DM: gate allows AND admission is full", async () => {
		const { message, audience } = await attested(
			ChannelType.DM,
			[OWNER, AGENT],
			OWNER,
		);
		const decision = evaluateOwnerExclusiveDisclosure(message, 2_000);
		expect(decision.allowed).toBe(true);
		const admission = admissionFor(audience);
		expect(admission.level).toBe("full");
		expect(admission.blockingEntityIds).toEqual([]);
	});

	it("third participant in the DM: gate denies participant_mismatch AND admission is none", async () => {
		const { message, audience } = await attested(
			ChannelType.DM,
			[OWNER, AGENT, GUEST],
			OWNER,
		);
		const decision = evaluateOwnerExclusiveDisclosure(message, 2_000);
		expect(decision).toMatchObject({
			allowed: false,
			reason: "participant_mismatch",
		});
		const admission = admissionFor(audience);
		expect(admission.level).toBe("none");
		expect(admission.blockingEntityIds).toEqual([GUEST]);
	});

	it("non-owner DM (guest + agent): gate denies owner_mismatch AND admission is none", async () => {
		const { message, audience } = await attested(
			ChannelType.DM,
			[GUEST, AGENT],
			GUEST,
		);
		const decision = evaluateOwnerExclusiveDisclosure(message, 2_000);
		expect(decision).toMatchObject({
			allowed: false,
			reason: "owner_mismatch",
		});
		const admission = admissionFor(audience);
		expect(admission.level).toBe("none");
		expect(admission.blockingEntityIds).toEqual([GUEST]);
	});

	it("group room with ungranted members: gate denies AND admission is none", async () => {
		const { message, audience } = await attested(
			ChannelType.GROUP,
			[OWNER, AGENT, GUEST, GUEST_TWO],
			OWNER,
		);
		const decision = evaluateOwnerExclusiveDisclosure(message, 2_000);
		expect(decision.allowed).toBe(false);
		const admission = admissionFor(audience);
		expect(admission.level).toBe("none");
		expect([...admission.blockingEntityIds].sort()).toEqual(
			[GUEST, GUEST_TWO].sort(),
		);
	});
});

// A resolver that throws denies the member, which is correct — but it must not
// be indistinguishable from a deliberate deny, or a broken viewer lookup reads
// as a policy decision forever. This module is pure, so it records the fault
// instead of reporting it, and the gate caller surfaces it.
describe("resolver failures are distinguishable from denials", () => {
	it("records the member and still admits nothing", () => {
		const audience = {
			agentEntityId: "00000000-0000-0000-0000-0000000000a0",
			participantEntityIds: ["00000000-0000-0000-0000-0000000000b1"],
		} as never;

		const admission = resolveAudienceAdmission(
			{ scope: "room" } as never,
			audience,
			() => {
				throw new Error("viewer lookup exploded");
			},
		);

		expect(admission.level).toBe("none");
		expect(admission.resolverFailureEntityIds).toEqual([
			"00000000-0000-0000-0000-0000000000b1",
		]);
	});

	it("reports no failures when every resolver answers", () => {
		const audience = {
			agentEntityId: "00000000-0000-0000-0000-0000000000a0",
			participantEntityIds: ["00000000-0000-0000-0000-0000000000b1"],
		} as never;

		const admission = resolveAudienceAdmission(
			{ scope: "room" } as never,
			audience,
			() => "none",
		);

		expect(admission.level).toBe("none");
		expect(admission.resolverFailureEntityIds).toEqual([]);
	});
});
