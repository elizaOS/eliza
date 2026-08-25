/**
 * Egress-seam wiring for min-over-members audience admission (split-disclosure
 * PR3). A response that declares the disclosure subject it requires of its
 * recipients (`content.data.disclosureSubject`) is joined at the egress seam
 * with the REAL attested delivery audience through the pure policy core; a
 * subject the room does not admit in FULL is withheld before any visible or
 * durable egress.
 *
 * Bidirectional proof:
 *  - PASS direction: an owner-only DM whose census admits full delivers the
 *    scoped response untouched.
 *  - FAIL-WITHOUT direction: a group room with an ungranted stranger caps the
 *    subject to `none`; the egress seam replaces the scoped response with the
 *    privacy-denied shape. Before this PR the egress seam only revalidated the
 *    owner-EXCLUSIVE binary (it early-returned unless `ownerExclusiveDisclosure
 *    WasUsed`), so a scoped-but-not-owner-exclusive response shipped in full —
 *    this assertion is inexpressible on the pre-wiring path.
 *
 * Real AgentRuntime + InMemoryDatabaseAdapter with REAL attested audiences
 * (`attestDeliveryAudienceFromCanonicalRoom`), never a cast — the audience
 * brand is module-private and the whole point is proving the seam consumes
 * genuine attestation evidence.
 */
import { v4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { createCharacter } from "../character";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import {
	attestDeliveryAudienceFromCanonicalRoom,
	getTrustedDeliveryAudience,
	ownerExclusiveDisclosureWasUsed,
	PRIVACY_DENIED_TEXT,
} from "../security";
import type { Content, Memory, UUID } from "../types";
import { asUUID, ChannelType } from "../types/primitives";
import { enforceTrustedDeliveryAudienceOnResult } from "./message";

const activeRuntimes: AgentRuntime[] = [];

afterEach(async () => {
	await Promise.all(
		activeRuntimes.splice(0).map(async (runtime) => {
			await runtime.stop();
			await runtime.close();
		}),
	);
});

async function makeRuntime(): Promise<AgentRuntime> {
	const runtime = new AgentRuntime({
		character: createCharacter({ name: `EgressAdmission${v4().slice(0, 8)}` }),
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
		enableAutonomy: false,
	});
	activeRuntimes.push(runtime);
	await runtime.initialize();
	return runtime;
}

/**
 * Attest a canonical-room audience the way the message service does at ingress:
 * a real room + participant set the attestor reads back from state.
 */
async function attestRoom(
	runtime: AgentRuntime,
	kind: ChannelType,
	ownerId: UUID,
	extraParticipants: UUID[],
): Promise<{ roomId: UUID; turn: Memory }> {
	const roomId = asUUID(v4());
	const worldId = asUUID(v4());
	await runtime.ensureConnection({
		entityId: ownerId,
		roomId,
		worldId,
		userName: "owner",
		name: "owner",
		source: "test",
		type: kind,
	});
	for (const participant of extraParticipants) {
		await runtime.addParticipant(participant, roomId);
	}
	runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", ownerId);
	const turn: Memory = {
		id: asUUID(v4()),
		entityId: ownerId,
		agentId: runtime.agentId,
		roomId,
		content: { text: "share the scoped thing", source: "test" },
		createdAt: Date.now(),
	};
	await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);
	return { roomId, turn };
}

function scopedResponse(ownerId: UUID, canary: string): Content {
	return {
		text: canary,
		data: {
			disclosureSubject: { scope: "owner-private", scopedEntityId: ownerId },
		},
	};
}

describe("egress audience-admission wiring", () => {
	it("delivers a scoped response untouched when the owner-only DM admits full", async () => {
		const runtime = await makeRuntime();
		const ownerId = asUUID(v4());
		const { turn } = await attestRoom(runtime, ChannelType.DM, ownerId, []);
		const canary = `SCOPED_OK_${v4()}`;

		// The turn never consumed owner-EXCLUSIVE context; the ONLY thing gating
		// egress here is the new audience-admission check.
		expect(ownerExclusiveDisclosureWasUsed(turn)).toBe(false);
		const audience = getTrustedDeliveryAudience(turn);
		expect(audience?.participantEntityIds).toContain(ownerId);

		const result = await enforceTrustedDeliveryAudienceOnResult(
			runtime,
			turn,
			scopedResponse(ownerId, canary),
			[
				{
					id: asUUID(v4()),
					entityId: runtime.agentId,
					agentId: runtime.agentId,
					roomId: turn.roomId,
					createdAt: Date.now(),
					content: scopedResponse(ownerId, canary),
				},
			],
		);

		expect(result.responseContent?.text).toBe(canary);
		expect(JSON.stringify(result)).not.toContain(PRIVACY_DENIED_TEXT);
	});

	it("withholds a scoped response when a group room has an ungranted stranger", async () => {
		const runtime = await makeRuntime();
		const ownerId = asUUID(v4());
		const strangerId = asUUID(v4());
		const { turn } = await attestRoom(runtime, ChannelType.GROUP, ownerId, [
			strangerId,
		]);
		const canary = `SCOPED_LEAK_${v4()}`;

		// Pre-wiring, the egress seam early-returned here (no owner-exclusive
		// use), so this scoped response would have shipped in full.
		expect(ownerExclusiveDisclosureWasUsed(turn)).toBe(false);
		const audience = getTrustedDeliveryAudience(turn);
		expect(audience?.participantEntityIds).toContain(strangerId);

		const responseMessages: Memory[] = ["first", "second"].map(
			(label, index) => ({
				id: asUUID(v4()),
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				roomId: turn.roomId,
				createdAt: Date.now() + index,
				content: scopedResponse(ownerId, `${label}:${canary}`),
			}),
		);

		const result = await enforceTrustedDeliveryAudienceOnResult(
			runtime,
			turn,
			scopedResponse(ownerId, canary),
			responseMessages,
		);

		// The scoped payload never survives, and EVERY response memory is
		// rewritten to the denial (actions mode can accumulate several).
		expect(JSON.stringify(result)).not.toContain(canary);
		expect(result.responseContent?.text).toBe(PRIVACY_DENIED_TEXT);
		expect(
			(result.responseContent?.data as { privacyReason?: string } | undefined)
				?.privacyReason,
		).toBe("audience_admission:none");
		expect(result.responseMessages).toHaveLength(2);
		expect(
			result.responseMessages.every(
				(memory) => memory.content.text === PRIVACY_DENIED_TEXT,
			),
		).toBe(true);
	});

	it("withholds a scoped response that declares a subject but has no attested audience (fail closed)", async () => {
		const runtime = await makeRuntime();
		const ownerId = asUUID(v4());
		// A turn with NO attestation at all — a scoped reply must not ship.
		const turn: Memory = {
			id: asUUID(v4()),
			entityId: ownerId,
			agentId: runtime.agentId,
			roomId: asUUID(v4()),
			content: { text: "x", source: "test" },
			createdAt: Date.now(),
		};
		expect(getTrustedDeliveryAudience(turn)).toBeUndefined();
		const canary = `SCOPED_NOAUD_${v4()}`;

		const result = await enforceTrustedDeliveryAudienceOnResult(
			runtime,
			turn,
			scopedResponse(ownerId, canary),
			[],
		);

		expect(result.responseContent?.text).toBe(PRIVACY_DENIED_TEXT);
		expect(JSON.stringify(result)).not.toContain(canary);
	});

	it("leaves an unscoped response (no declared subject) untouched", async () => {
		const runtime = await makeRuntime();
		const ownerId = asUUID(v4());
		const strangerId = asUUID(v4());
		const { turn } = await attestRoom(runtime, ChannelType.GROUP, ownerId, [
			strangerId,
		]);
		const canary = `UNSCOPED_${v4()}`;

		// No disclosureSubject marker → the audience-admission seam does not
		// narrow, and no owner-exclusive use → nothing withholds. Unchanged.
		const result = await enforceTrustedDeliveryAudienceOnResult(
			runtime,
			turn,
			{ text: canary },
			[],
		);

		expect(result.responseContent?.text).toBe(canary);
		expect(JSON.stringify(result)).not.toContain(PRIVACY_DENIED_TEXT);
	});
});
