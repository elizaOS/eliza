/**
 * Adversarial tests for server-attested owner-only delivery audiences. The
 * harness mutates canonical room state directly; no request metadata is trusted.
 */
import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, Room, UUID } from "../types";
import { ChannelType } from "../types";
import {
	attestAuthenticatedApiDeliveryAudience,
	attestDeliveryAudienceFromCanonicalRoom,
	evaluateOwnerExclusiveDisclosure,
	revalidateOwnerExclusiveDisclosure,
} from "./trusted-delivery-audience";

const OWNER = "11111111-1111-1111-1111-111111111111" as UUID;
const AGENT = "22222222-2222-2222-2222-222222222222" as UUID;
const GUEST = "33333333-3333-3333-3333-333333333333" as UUID;
const ROOM = "44444444-4444-4444-4444-444444444444" as UUID;
const OTHER_ROOM = "55555555-5555-5555-5555-555555555555" as UUID;

function harness(type: ChannelType = ChannelType.DM): {
	runtime: IAgentRuntime;
	setType: (next: ChannelType) => void;
	setParticipants: (next: UUID[]) => void;
	reportError: ReturnType<typeof vi.fn>;
} {
	let roomType = type;
	let participants: UUID[] = [OWNER, AGENT];
	const reportError = vi.fn();
	const runtime = {
		agentId: AGENT,
		getRoom: vi.fn(async (roomId: UUID) =>
			roomId === ROOM
				? ({
						id: ROOM,
						agentId: AGENT,
						type: roomType,
						source: "test",
					} as Room)
				: null,
		),
		getParticipantsForRoom: vi.fn(async () => [...participants]),
		getSetting: vi.fn((key: string) =>
			key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER : undefined,
		),
		reportError,
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	} as unknown as IAgentRuntime;
	return {
		runtime,
		setType: (next) => {
			roomType = next;
		},
		setParticipants: (next) => {
			participants = next;
		},
		reportError,
	};
}

function message(overrides: Partial<Memory> = {}): Memory {
	return {
		id: "66666666-6666-6666-6666-666666666666" as UUID,
		entityId: OWNER,
		agentId: AGENT,
		roomId: ROOM,
		content: {
			text: "show my private plan",
			source: "discord",
			channelType: ChannelType.DM,
			metadata: {
				deliveryAudience: "owner_private",
				isOwner: true,
			},
		},
		...overrides,
	} as Memory;
}

describe("trusted delivery audience", () => {
	it("cannot be minted by body metadata or a JSON round trip", async () => {
		const { runtime } = harness();
		const original = message();
		expect(evaluateOwnerExclusiveDisclosure(original)).toEqual({
			allowed: false,
			reason: "missing_attestation",
		});

		await attestDeliveryAudienceFromCanonicalRoom(runtime, original);
		const fromJson = JSON.parse(JSON.stringify(original)) as Memory;
		expect(evaluateOwnerExclusiveDisclosure(fromJson)).toEqual({
			allowed: false,
			reason: "missing_attestation",
		});
	});

	it("preserves process-local evidence across ordinary message spreads", async () => {
		const { runtime } = harness();
		const original = message();
		await attestDeliveryAudienceFromCanonicalRoom(runtime, original);

		expect(evaluateOwnerExclusiveDisclosure({ ...original })).toMatchObject({
			allowed: true,
		});
	});

	it.each([
		{
			name: "group destination",
			type: ChannelType.GROUP,
			participants: [OWNER, AGENT],
			reason: "destination_not_private",
		},
		{
			name: "extra participant",
			type: ChannelType.DM,
			participants: [OWNER, AGENT, GUEST],
			reason: "participant_mismatch",
		},
		{
			name: "missing agent participant",
			type: ChannelType.DM,
			participants: [OWNER],
			reason: "participant_mismatch",
		},
	] as const)("denies $name", async ({ type, participants, reason }) => {
		const { runtime, setParticipants } = harness(type);
		setParticipants([...participants]);
		const turn = message();
		await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);
		expect(evaluateOwnerExclusiveDisclosure(turn)).toMatchObject({
			allowed: false,
			reason,
		});
	});

	it.each([
		{
			name: "actor mismatch",
			override: { entityId: GUEST },
			reason: "actor_mismatch",
		},
		{
			name: "agent mismatch",
			override: { agentId: GUEST },
			reason: "agent_mismatch",
		},
		{
			name: "room mismatch",
			override: { roomId: OTHER_ROOM },
			reason: "room_mismatch",
		},
	] as const)("binds the exact $name", async ({ override, reason }) => {
		const { runtime } = harness();
		const original = message();
		await attestDeliveryAudienceFromCanonicalRoom(runtime, original);
		expect(
			evaluateOwnerExclusiveDisclosure({ ...original, ...override } as Memory),
		).toMatchObject({ allowed: false, reason });
	});

	it("denies expired and future-dated evidence", async () => {
		const { runtime } = harness();
		const expired = message();
		await attestDeliveryAudienceFromCanonicalRoom(runtime, expired, {
			nowMs: 1_000,
			ttlMs: 10,
		});
		expect(evaluateOwnerExclusiveDisclosure(expired, 1_010)).toMatchObject({
			allowed: false,
			reason: "expired_attestation",
		});

		const future = message({
			id: "77777777-7777-7777-7777-777777777777" as UUID,
		});
		await attestDeliveryAudienceFromCanonicalRoom(runtime, future, {
			nowMs: 6_000,
		});
		expect(evaluateOwnerExclusiveDisclosure(future, 0)).toMatchObject({
			allowed: false,
			reason: "future_attestation",
		});
	});

	it("re-reads membership and room type before disclosure", async () => {
		const { runtime, setParticipants, setType } = harness();
		const turn = message();
		await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);

		setParticipants([OWNER, AGENT, GUEST]);
		expect(
			await revalidateOwnerExclusiveDisclosure(runtime, turn),
		).toMatchObject({
			allowed: false,
			reason: "audience_changed",
		});

		setParticipants([OWNER, AGENT]);
		setType(ChannelType.GROUP);
		expect(
			await revalidateOwnerExclusiveDisclosure(runtime, turn),
		).toMatchObject({
			allowed: false,
			reason: "audience_changed",
		});
	});

	it("ignores private-looking voice labels when the canonical room is shared", async () => {
		const { runtime } = harness(ChannelType.GROUP);
		const turn = message({
			content: {
				text: "private voice",
				source: "voice",
				channelType: ChannelType.VOICE_DM,
			},
		});
		await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);
		expect(evaluateOwnerExclusiveDisclosure(turn)).toMatchObject({
			allowed: false,
			reason: "destination_not_private",
		});
	});

	it("keeps service gateways external and rejects owner API calls into shared rooms", async () => {
		const externalHarness = harness(ChannelType.API);
		const external = message();
		await attestAuthenticatedApiDeliveryAudience(
			externalHarness.runtime,
			external,
			{ kind: "service_gateway", principalId: "gateway" },
		);
		expect(evaluateOwnerExclusiveDisclosure(external)).toMatchObject({
			allowed: false,
			reason: "destination_not_private",
		});

		const ownerHarness = harness(ChannelType.API);
		ownerHarness.setParticipants([OWNER, AGENT, GUEST]);
		const shared = message();
		await attestAuthenticatedApiDeliveryAudience(ownerHarness.runtime, shared, {
			kind: "owner_session",
			principalId: "session",
		});
		expect(evaluateOwnerExclusiveDisclosure(shared)).toMatchObject({
			allowed: false,
			reason: "participant_mismatch",
		});
	});

	it("fails closed and reports canonical lookup failures", async () => {
		const { runtime, reportError } = harness();
		const turn = message();
		await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);
		(
			runtime.getParticipantsForRoom as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(new Error("database unavailable"));

		expect(
			await revalidateOwnerExclusiveDisclosure(runtime, turn),
		).toMatchObject({
			allowed: false,
			reason: "audience_lookup_failed",
		});
		expect(reportError).toHaveBeenCalledWith(
			"TrustedDeliveryAudience.revalidate",
			expect.objectContaining({
				code: "DELIVERY_AUDIENCE_LOOKUP_FAILED",
			}),
		);
	});
});
