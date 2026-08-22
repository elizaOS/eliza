/**
 * Verifies membership evidence validation and the real in-memory adapter's
 * generation-fenced, fail-closed entitlement behavior without transport mocks.
 */

import { describe, expect, it } from "vitest";
import type {
	Entity,
	Memory,
	Room,
	RoomMembershipEvidence,
	UUID,
} from "../types";
import { ChannelType, MemoryType } from "../types";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";
import {
	isCurrentRoomMembershipEvidence,
	ROOM_MEMBERSHIP_TRANSPORT_MAX_TTL_MS,
	validateRoomMembershipEvidence,
} from "./room-membership-evidence";

const ENTITY_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-000000000002" as UUID;
const AGENT_ID = "00000000-0000-4000-8000-000000000003" as UUID;
const WORLD_ID = "00000000-0000-4000-8000-000000000004" as UUID;

function transportEvidence(
	overrides: Partial<RoomMembershipEvidence> = {},
): RoomMembershipEvidence {
	return {
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		source: "transport:discord.00000000-0000-4000-8000-000000000999",
		state: "member",
		observedAt: 1_000,
		expiresAt: 2_000,
		generation: 1,
		...overrides,
	};
}

async function seedCurrentMembership(
	adapter: InMemoryDatabaseAdapter,
	worldId?: UUID,
): Promise<void> {
	await adapter.createEntities([
		{ id: ENTITY_ID, agentId: AGENT_ID, names: ["Member"] } as Entity,
	]);
	await adapter.createRooms([
		{
			id: ROOM_ID,
			agentId: AGENT_ID,
			source: "discord",
			type: ChannelType.GROUP,
			worldId,
		} as Room,
	]);
	await adapter.createRoomParticipants([ENTITY_ID], ROOM_ID);
	const observedAt = Date.now();
	await adapter.updateRoomMembershipEvidence({
		evidence: transportEvidence({
			observedAt,
			expiresAt: observedAt + 60_000,
		}),
		expectedGeneration: null,
	});
}

describe("room membership evidence", () => {
	it("requires expiring transport evidence and rejects timeless external membership", () => {
		expect(() =>
			validateRoomMembershipEvidence(
				transportEvidence({ source: "transport:discord" }),
			),
		).toThrow(/bounded transport identifier/);
		expect(() =>
			validateRoomMembershipEvidence(
				transportEvidence({ expiresAt: undefined }),
			),
		).toThrow(/must expire/);
		expect(() =>
			validateRoomMembershipEvidence(
				transportEvidence({
					expiresAt: 1_000 + ROOM_MEMBERSHIP_TRANSPORT_MAX_TTL_MS + 1,
				}),
			),
		).toThrow(/maximum TTL/);
	});

	it("grants only a fresh positive observation", () => {
		expect(isCurrentRoomMembershipEvidence(transportEvidence(), 1_500)).toBe(
			true,
		);
		expect(isCurrentRoomMembershipEvidence(transportEvidence(), 2_000)).toBe(
			false,
		);
		expect(
			isCurrentRoomMembershipEvidence(
				transportEvidence({ state: "unavailable" }),
				1_500,
			),
		).toBe(false);
	});

	it("does not treat participant presence as entitlement and fences generations", async () => {
		const now = Date.now();
		const currentEvidence = transportEvidence({
			observedAt: now - 500,
			expiresAt: now + 500,
		});
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.createRoomParticipants([ENTITY_ID], ROOM_ID);
		expect(await adapter.getCurrentRoomMemberships(ENTITY_ID)).toEqual([]);

		await expect(
			adapter.updateRoomMembershipEvidence({
				evidence: currentEvidence,
				expectedGeneration: null,
			}),
		).resolves.toMatchObject({ status: "updated" });
		expect(await adapter.getCurrentRoomMemberships(ENTITY_ID)).toEqual([
			currentEvidence,
		]);
		await expect(
			adapter.updateRoomMembershipEvidence({
				evidence: { ...currentEvidence, generation: 2, observedAt: now - 501 },
				expectedGeneration: 1,
			}),
		).rejects.toMatchObject({ code: "ROOM_MEMBERSHIP_EVIDENCE_INVALID" });

		await expect(
			adapter.updateRoomMembershipEvidence({
				evidence: { ...currentEvidence, generation: 3, state: "nonmember" },
				expectedGeneration: 1,
			}),
		).rejects.toMatchObject({ code: "ROOM_MEMBERSHIP_EVIDENCE_INVALID" });

		await expect(
			adapter.updateRoomMembershipEvidence({
				evidence: {
					...currentEvidence,
					generation: 2,
					state: "unavailable",
				},
				expectedGeneration: 1,
			}),
		).resolves.toMatchObject({ status: "updated" });
		expect(await adapter.getCurrentRoomMemberships(ENTITY_ID)).toEqual([]);

		await expect(
			adapter.updateRoomMembershipEvidence({
				evidence: { ...currentEvidence, generation: 2 },
				expectedGeneration: 1,
			}),
		).resolves.toMatchObject({
			status: "conflict",
			current: { generation: 2, state: "unavailable" },
		});
	});

	it("rejects evidence for an association that storage does not contain", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await expect(
			adapter.updateRoomMembershipEvidence({
				evidence: transportEvidence(),
				expectedGeneration: null,
			}),
		).resolves.toEqual({ status: "not_found", current: null });
	});

	it("cascades room deletion through participant state and membership evidence", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await seedCurrentMembership(adapter);
		await adapter.deleteRooms([ROOM_ID]);
		await expect(adapter.getCurrentRoomMemberships(ENTITY_ID)).resolves.toEqual(
			[],
		);
		await expect(
			adapter.areRoomParticipants([{ roomId: ROOM_ID, entityId: ENTITY_ID }]),
		).resolves.toEqual([false]);
	});

	it("cascades world room deletion under the authorization lock", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await seedCurrentMembership(adapter, WORLD_ID);
		await adapter.deleteRoomsByWorldIds([WORLD_ID]);
		await expect(adapter.getCurrentRoomMemberships(ENTITY_ID)).resolves.toEqual(
			[],
		);
		await expect(adapter.getRoomsForParticipants([ENTITY_ID])).resolves.toEqual(
			[],
		);
	});

	it("orders a room world move before a queued world deletion", async () => {
		let releaseLookup: (() => void) | undefined;
		const lookupGate = new Promise<void>((resolve) => {
			releaseLookup = resolve;
		});
		class GatedWorldLookupAdapter extends InMemoryDatabaseAdapter {
			override async getRoomsByWorlds(
				worldIds: UUID[],
				limit?: number,
				offset?: number,
			): Promise<Room[]> {
				await lookupGate;
				return super.getRoomsByWorlds(worldIds, limit, offset);
			}
		}
		const adapter = new GatedWorldLookupAdapter();
		const destinationWorldId = "00000000-0000-4000-8000-000000000005" as UUID;
		await seedCurrentMembership(adapter, WORLD_ID);
		const deletion = adapter.deleteRoomsByWorldIds([WORLD_ID]);
		const move = adapter.updateRooms([
			{
				id: ROOM_ID,
				agentId: AGENT_ID,
				source: "discord",
				type: ChannelType.GROUP,
				worldId: destinationWorldId,
			} as Room,
		]);
		await move;
		releaseLookup?.();
		await deletion;
		await expect(adapter.getRoomsByIds([ROOM_ID])).resolves.toMatchObject([
			{ worldId: destinationWorldId },
		]);
		await expect(adapter.getCurrentRoomMemberships(ENTITY_ID)).resolves.toEqual(
			[],
		);
	});

	it("cascades entity deletion through every room entitlement", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await seedCurrentMembership(adapter);
		await adapter.deleteEntities([ENTITY_ID]);
		await expect(adapter.getCurrentRoomMemberships(ENTITY_ID)).resolves.toEqual(
			[],
		);
		await expect(
			adapter.areRoomParticipants([{ roomId: ROOM_ID, entityId: ENTITY_ID }]),
		).resolves.toEqual([false]);
	});

	it("does not trust a caller-supplied room id at the document boundary", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const documentId = "00000000-0000-4000-8000-000000000003" as UUID;
		await adapter.createMemories([
			{
				tableName: "documents",
				memory: {
					id: documentId,
					agentId: ENTITY_ID,
					entityId: ENTITY_ID,
					roomId: ROOM_ID,
					content: { text: "private room document" },
					metadata: {
						type: MemoryType.DOCUMENT,
						documentId,
						scope: "global",
					},
				} as Memory,
			},
		]);

		await expect(
			adapter.queryDocuments({
				agentId: ENTITY_ID,
				requesterEntityId: ENTITY_ID,
				requesterRoomIds: [ROOM_ID],
				requesterRole: "USER",
				limit: 10,
				offset: 0,
			}),
		).resolves.toMatchObject({ documents: [], totalVisible: 0 });

		await adapter.createRoomParticipants([ENTITY_ID], ROOM_ID);
		const observedAt = Date.now();
		await expect(
			adapter.updateRoomMembershipEvidence({
				evidence: {
					entityId: ENTITY_ID,
					roomId: ROOM_ID,
					source: "transport:test.00000000-0000-4000-8000-000000000999",
					state: "member",
					observedAt,
					expiresAt: observedAt + 60_000,
					generation: 1,
				},
				expectedGeneration: null,
			}),
		).resolves.toMatchObject({ status: "updated" });
		const revoke = adapter.updateRoomMembershipEvidence({
			evidence: {
				entityId: ENTITY_ID,
				roomId: ROOM_ID,
				source: "transport:test.00000000-0000-4000-8000-000000000999",
				state: "nonmember",
				observedAt,
				generation: 2,
			},
			expectedGeneration: 1,
		});
		const readAfterRevoke = adapter.queryDocuments({
			agentId: ENTITY_ID,
			requesterEntityId: ENTITY_ID,
			requesterRoomIds: [ROOM_ID],
			requesterRole: "USER",
			limit: 10,
			offset: 0,
		});
		await expect(revoke).resolves.toMatchObject({ status: "updated" });
		await expect(readAfterRevoke).resolves.toMatchObject({
			documents: [],
			totalVisible: 0,
		});
	});
});
