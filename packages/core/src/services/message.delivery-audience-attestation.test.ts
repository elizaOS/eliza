/**
 * Central delivery-audience attestation through the real
 * DefaultMessageService.handleMessage: connectors that never attest
 * (telegram-shaped ingress) must still get canonical-room evidence at the
 * shared seam, an existing connector attestation must stay authoritative, and
 * an attestation failure must deny observably (reportError) without killing
 * the turn. Fake runtime over real state maps; rooms are MUTED so each turn
 * ends deterministically right after the seam under test.
 */
import { describe, expect, it, vi } from "vitest";
import { canActionRun } from "../runtime/action-gate";
import { TurnControllerRegistry } from "../runtime/turn-controller";
import {
	attestDeliveryAudienceFromCanonicalRoom,
	evaluateOwnerExclusiveDisclosure,
	getTrustedDeliveryAudience,
	OWNER_EXCLUSIVE_DISCLOSURE_GATE,
	ownerExclusiveSuppressionNote,
	registerRuntimeManagedInternalActor,
} from "../security/trusted-delivery-audience";
import type { Room, World } from "../types/environment";
import type { IAgentRuntime, Memory, UUID } from "../types/index";
import { ChannelType } from "../types/primitives";
import { DefaultMessageService } from "./message";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const GUEST_ID = "00000000-0000-0000-0000-0000000000c2" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000d1" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-0000000000e1" as UUID;
const RUN_ID = "00000000-0000-0000-0000-0000000000f1" as UUID;

const OWNER_GATED_ACTION = {
	name: "LIFEOPS_PRIVATE_ACTION",
	disclosureGate: OWNER_EXCLUSIVE_DISCLOSURE_GATE,
} as const;

function makeRuntime(seed: {
	room: Room;
	participants: UUID[];
	getRoomError?: Error;
}) {
	const reportError = vi.fn();
	const noop = () => {};
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza", username: "eliza" },
		logger: { debug: noop, info: noop, warn: noop, error: noop },
		stateCache: new Map(),
		turnControllers: new TurnControllerRegistry(),
		emitEvent: vi.fn(async () => undefined),
		reportError,
		useModel: vi.fn(async () => {
			throw new Error("useModel must not be reached in this harness");
		}),
		getService: () => null,
		getSetting: (key: string) =>
			key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ID : undefined,
		startRun: () => RUN_ID,
		runActionsByMode: async () => undefined,
		getMemoryById: async () => null,
		createMemory: async (memory: Memory) => memory.id,
		queueEmbeddingGeneration: async () => undefined,
		// Muting the agent ends every turn right after the attestation seam.
		getParticipantUserState: async () => "MUTED",
		updateParticipantUserState: async () => undefined,
		getRoom: async (roomId: UUID) => {
			if (seed.getRoomError) throw seed.getRoomError;
			return roomId === seed.room.id ? seed.room : null;
		},
		getParticipantsForRoom: async () => [...seed.participants],
		getWorld: async (worldId: UUID) =>
			worldId === WORLD_ID
				? ({ id: WORLD_ID, agentId: AGENT_ID, name: "World" } as World)
				: null,
		updateWorld: async () => undefined,
		updateRoom: async () => undefined,
	} as unknown as IAgentRuntime;
	return { runtime, reportError };
}

function room(type: ChannelType): Room {
	return {
		id: ROOM_ID,
		source: "telegram",
		type,
		worldId: WORLD_ID,
	} as Room;
}

function inbound(overrides: Partial<Memory> = {}): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000b1" as UUID,
		entityId: OWNER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text: "what is on my private calendar?", source: "telegram" },
		...overrides,
	} as Memory;
}

async function handle(runtime: IAgentRuntime, message: Memory): Promise<void> {
	// The deliberately-minimal fake cannot run the full pipeline; the seam
	// under test executes before the turn can fail deeper.
	await new DefaultMessageService()
		.handleMessage(runtime, message)
		.catch(() => {});
}

describe("DefaultMessageService — central delivery-audience attestation", () => {
	it("attests an unattested telegram-shaped owner DM and the gate allows", async () => {
		const { runtime } = makeRuntime({
			room: room(ChannelType.DM),
			participants: [OWNER_ID, AGENT_ID],
		});
		const message = inbound();
		expect(getTrustedDeliveryAudience(message)).toBeUndefined();

		await handle(runtime, message);

		expect(getTrustedDeliveryAudience(message)).toMatchObject({
			kind: "direct",
			provenance: "canonical_room",
		});
		expect(evaluateOwnerExclusiveDisclosure(message)).toMatchObject({
			allowed: true,
			basis: "owner_private_destination",
		});
		expect(canActionRun(OWNER_GATED_ACTION, { message })).toBe(true);
	});

	it("still denies a group-room turn and records a model-visible note", async () => {
		// Two-party GROUP room: membership alone looks owner-only, so the denial
		// must come from the canonical room type, not the participant set.
		const { runtime } = makeRuntime({
			room: room(ChannelType.GROUP),
			participants: [OWNER_ID, AGENT_ID],
		});
		const message = inbound();

		await handle(runtime, message);

		expect(evaluateOwnerExclusiveDisclosure(message)).toMatchObject({
			allowed: false,
			reason: "destination_not_private",
		});
		expect(canActionRun(OWNER_GATED_ACTION, { message })).toBe(false);
		expect(ownerExclusiveSuppressionNote(message)).toContain(
			"destination_not_private",
		);
	});

	it("allows an autonomous SELF-room turn as an internal agent turn", async () => {
		// Real autonomy-service shape: the turn is posted under a dedicated
		// synthetic entity (not agentId) that the runtime registered as a
		// participant of its own SELF room.
		const AUTONOMY_ENTITY = "00000000-0000-0000-0000-0000000000c3" as UUID;
		const { runtime } = makeRuntime({
			room: room(ChannelType.SELF),
			participants: [AGENT_ID, AUTONOMY_ENTITY],
		});
		const message = inbound({
			entityId: AUTONOMY_ENTITY,
			content: { text: "plan the owner's day", source: "autonomous" },
		});

		const release = registerRuntimeManagedInternalActor(
			runtime,
			AUTONOMY_ENTITY,
		);
		try {
			await handle(runtime, message);
			expect(evaluateOwnerExclusiveDisclosure(message)).toMatchObject({
				allowed: true,
				basis: "internal_agent_turn",
			});
			expect(canActionRun(OWNER_GATED_ACTION, { message })).toBe(true);
		} finally {
			release();
		}
	});

	it("denies observably when canonical attestation fails, without killing the turn", async () => {
		const { runtime, reportError } = makeRuntime({
			room: room(ChannelType.DM),
			participants: [OWNER_ID, AGENT_ID],
			getRoomError: new Error("database unavailable"),
		});
		const message = inbound();

		await handle(runtime, message);

		expect(reportError).toHaveBeenCalledWith(
			"MessageService.deliveryAudience",
			expect.any(Error),
			expect.objectContaining({ roomId: ROOM_ID }),
		);
		expect(getTrustedDeliveryAudience(message)).toBeUndefined();
		expect(evaluateOwnerExclusiveDisclosure(message)).toMatchObject({
			allowed: false,
			reason: "missing_attestation",
		});
		expect(canActionRun(OWNER_GATED_ACTION, { message })).toBe(false);
	});

	it("re-attests connector evidence when a Memory crosses runtimes", async () => {
		const dmHarness = makeRuntime({
			room: room(ChannelType.DM),
			participants: [OWNER_ID, AGENT_ID],
		});
		const message = inbound({ content: { text: "hi", source: "discord" } });
		await attestDeliveryAudienceFromCanonicalRoom(dmHarness.runtime, message);
		const connectorAttestationId =
			getTrustedDeliveryAudience(message)?.attestationId;
		expect(connectorAttestationId).toBeDefined();

		const groupHarness = makeRuntime({
			room: room(ChannelType.GROUP),
			participants: [OWNER_ID, AGENT_ID, GUEST_ID],
		});
		await handle(groupHarness.runtime, message);

		expect(getTrustedDeliveryAudience(message)?.attestationId).not.toBe(
			connectorAttestationId,
		);
		expect(getTrustedDeliveryAudience(message)?.kind).toBe("group");
		expect(evaluateOwnerExclusiveDisclosure(message)).toMatchObject({
			allowed: false,
			reason: "participant_mismatch",
		});
	});
});
