/**
 * Turn-scoped renewal of owner-private delivery-audience evidence. The clock
 * advances past the unchanged 5-minute TTL: an active, uncancelled turn renews
 * from current authority, and every invalidation boundary (completed turn,
 * cancellation, membership, ownership or destination change, lookup failure,
 * runtime mismatch, API principal revocation) stays denied. The runtime is a
 * minimal fake over mutable room/owner state.
 */
import { describe, expect, it, vi } from "vitest";
import type { Memory } from "../types/memory";
import { ChannelType, type UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import {
	attestAuthenticatedApiDeliveryAudience,
	attestDeliveryAudienceFromCanonicalRoom,
	beginTrustedDeliveryAudienceTurn,
	evaluateOwnerExclusiveDisclosure,
	markOwnerExclusiveDisclosureUsed,
	ownerExclusiveDisclosureWasUsed,
	renewExpiredTrustedDeliveryAudience,
	revalidateOwnerExclusiveDisclosure,
} from "./trusted-delivery-audience";

const AGENT_ID = "00000000-0000-4000-8000-0000000000a1" as UUID;
const OWNER_ID = "00000000-0000-4000-8000-0000000000c1" as UUID;
const OTHER_OWNER_ID = "00000000-0000-4000-8000-0000000000c3" as UUID;
const GUEST_ID = "00000000-0000-4000-8000-0000000000c2" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-0000000000d1" as UUID;
const T0 = 1_700_000_000_000;
const LATER = T0 + 10 * 60_000;

function world() {
	const state = {
		roomType: ChannelType.DM as ChannelType,
		participants: [OWNER_ID, AGENT_ID] as UUID[],
		ownerId: OWNER_ID as UUID,
		lookupError: null as Error | null,
	};
	const reportError = vi.fn();
	const runtime = {
		agentId: AGENT_ID,
		reportError,
		getSetting: (key: string) =>
			key === "ELIZA_ADMIN_ENTITY_ID" ? state.ownerId : undefined,
		getRoom: async (roomId: UUID) => {
			if (state.lookupError) throw state.lookupError;
			return roomId === ROOM_ID
				? { id: ROOM_ID, type: state.roomType, source: "test" }
				: null;
		},
		getParticipantsForRoom: async () => {
			if (state.lookupError) throw state.lookupError;
			return [...state.participants];
		},
		getEntityById: async () => null,
	} as unknown as IAgentRuntime;
	return { state, runtime, reportError };
}

function ownerMessage(): Memory {
	return {
		id: "00000000-0000-4000-8000-0000000000b1" as UUID,
		entityId: OWNER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text: "put this note on my calendar" },
	} as Memory;
}

async function attestedTurn() {
	const env = world();
	const message = ownerMessage();
	await attestDeliveryAudienceFromCanonicalRoom(env.runtime, message, {
		nowMs: T0,
	});
	return { ...env, message };
}

describe("owner-private audience renewal during an active turn", () => {
	it("renews an active turn from current authority after the TTL and keeps disclosure bookkeeping", async () => {
		const { runtime, message } = await attestedTurn();
		const end = beginTrustedDeliveryAudienceTurn(runtime, message, {
			nowMs: T0,
		});
		markOwnerExclusiveDisclosureUsed(message);

		expect(evaluateOwnerExclusiveDisclosure(message, LATER)).toMatchObject({
			allowed: false,
			reason: "expired_attestation",
		});
		const decision = await revalidateOwnerExclusiveDisclosure(
			runtime,
			message,
			LATER,
		);
		expect(decision.allowed).toBe(true);
		expect(evaluateOwnerExclusiveDisclosure(message, LATER).allowed).toBe(true);
		expect(ownerExclusiveDisclosureWasUsed(message)).toBe(true);
		end();
	});

	it("renews before a synchronous exposure gate", async () => {
		const { runtime, message } = await attestedTurn();
		const end = beginTrustedDeliveryAudienceTurn(runtime, message, {
			nowMs: T0,
		});
		await renewExpiredTrustedDeliveryAudience(runtime, message, LATER);
		expect(evaluateOwnerExclusiveDisclosure(message, LATER).allowed).toBe(true);
		end();
	});

	it("denies a completed turn", async () => {
		const { runtime, message } = await attestedTurn();
		beginTrustedDeliveryAudienceTurn(runtime, message, { nowMs: T0 })();
		expect(
			await revalidateOwnerExclusiveDisclosure(runtime, message, LATER),
		).toMatchObject({ allowed: false, reason: "expired_attestation" });
	});

	it("denies a turn that never began a lease", async () => {
		const { runtime, message } = await attestedTurn();
		expect(
			await revalidateOwnerExclusiveDisclosure(runtime, message, LATER),
		).toMatchObject({ allowed: false, reason: "expired_attestation" });
	});

	it("denies a cancelled turn", async () => {
		const { runtime, message } = await attestedTurn();
		const controller = new AbortController();
		beginTrustedDeliveryAudienceTurn(runtime, message, {
			nowMs: T0,
			signal: controller.signal,
		});
		controller.abort();
		expect(
			await revalidateOwnerExclusiveDisclosure(runtime, message, LATER),
		).toMatchObject({ allowed: false, reason: "expired_attestation" });
	});

	it("does not let a lease revive evidence that had already expired", async () => {
		const { runtime, message } = await attestedTurn();
		beginTrustedDeliveryAudienceTurn(runtime, message, { nowMs: LATER });
		expect(
			await revalidateOwnerExclusiveDisclosure(runtime, message, LATER),
		).toMatchObject({ allowed: false, reason: "expired_attestation" });
	});

	it("denies renewal after a membership change", async () => {
		const { runtime, message, state } = await attestedTurn();
		beginTrustedDeliveryAudienceTurn(runtime, message, { nowMs: T0 });
		state.participants.push(GUEST_ID);
		expect(
			await revalidateOwnerExclusiveDisclosure(runtime, message, LATER),
		).toMatchObject({ allowed: false, reason: "audience_changed" });
		expect(evaluateOwnerExclusiveDisclosure(message, LATER).allowed).toBe(
			false,
		);
	});

	it("denies renewal after an ownership change", async () => {
		const { runtime, message, state } = await attestedTurn();
		beginTrustedDeliveryAudienceTurn(runtime, message, { nowMs: T0 });
		state.ownerId = OTHER_OWNER_ID;
		expect(
			await revalidateOwnerExclusiveDisclosure(runtime, message, LATER),
		).toMatchObject({ allowed: false, reason: "audience_changed" });
	});

	it("denies renewal after the destination kind changes", async () => {
		const { runtime, message, state } = await attestedTurn();
		beginTrustedDeliveryAudienceTurn(runtime, message, { nowMs: T0 });
		state.roomType = ChannelType.GROUP;
		expect(
			await revalidateOwnerExclusiveDisclosure(runtime, message, LATER),
		).toMatchObject({ allowed: false, reason: "audience_changed" });
	});

	it("denies and reports when current authority cannot be read", async () => {
		const { runtime, message, state, reportError } = await attestedTurn();
		beginTrustedDeliveryAudienceTurn(runtime, message, { nowMs: T0 });
		state.lookupError = new Error("database unavailable");
		expect(
			await revalidateOwnerExclusiveDisclosure(runtime, message, LATER),
		).toMatchObject({ allowed: false, reason: "audience_lookup_failed" });
		expect(reportError).toHaveBeenCalled();
	});

	it("denies a different runtime and an actor mismatch", async () => {
		const { runtime, message } = await attestedTurn();
		beginTrustedDeliveryAudienceTurn(runtime, message, { nowMs: T0 });
		const other = world().runtime;
		expect(
			await revalidateOwnerExclusiveDisclosure(other, message, LATER),
		).toMatchObject({ allowed: false, reason: "runtime_mismatch" });
		const impostor = { ...message, entityId: GUEST_ID } as Memory;
		expect(
			await revalidateOwnerExclusiveDisclosure(runtime, impostor, LATER),
		).toMatchObject({ allowed: false });
		expect(evaluateOwnerExclusiveDisclosure(message, LATER).allowed).toBe(
			false,
		);
	});
});

describe("authenticated API audience renewal", () => {
	async function apiTurn(
		revalidatePrincipal?: () => Promise<{
			kind: "owner_session";
			principalId: string;
		} | null>,
	) {
		const env = world();
		const message = ownerMessage();
		await attestAuthenticatedApiDeliveryAudience(
			env.runtime,
			message,
			{ kind: "owner_session", principalId: "session-1" },
			{ nowMs: T0, revalidatePrincipal },
		);
		beginTrustedDeliveryAudienceTurn(env.runtime, message, { nowMs: T0 });
		return { ...env, message };
	}

	it("renews only through a fresh principal check", async () => {
		const revalidate = vi.fn(async () => ({
			kind: "owner_session" as const,
			principalId: "session-1",
		}));
		const { runtime, message } = await apiTurn(revalidate);
		expect(
			(await revalidateOwnerExclusiveDisclosure(runtime, message, LATER))
				.allowed,
		).toBe(true);
		expect(revalidate).toHaveBeenCalledTimes(1);
	});

	it("denies when the principal was revoked", async () => {
		const { runtime, message } = await apiTurn(async () => null);
		expect(
			await revalidateOwnerExclusiveDisclosure(runtime, message, LATER),
		).toMatchObject({ allowed: false, reason: "expired_attestation" });
	});

	it("denies when the host supplied no fresh verification", async () => {
		const { runtime, message } = await apiTurn();
		expect(
			await revalidateOwnerExclusiveDisclosure(runtime, message, LATER),
		).toMatchObject({ allowed: false, reason: "expired_attestation" });
	});
});
