/**
 * Verifies membership evidence validation and the real in-memory adapter's
 * generation-fenced, fail-closed entitlement behavior without transport mocks.
 */

import { describe, expect, it } from "vitest";
import type { Memory, RoomMembershipEvidence, UUID } from "../types";
import { MemoryType } from "../types";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";
import {
	isCurrentRoomMembershipEvidence,
	validateRoomMembershipEvidence,
} from "./room-membership-evidence";

const ENTITY_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-000000000002" as UUID;

function transportEvidence(
	overrides: Partial<RoomMembershipEvidence> = {},
): RoomMembershipEvidence {
	return {
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		source: "transport:discord",
		state: "member",
		observedAt: 1_000,
		expiresAt: 2_000,
		generation: 1,
		...overrides,
	};
}

describe("room membership evidence", () => {
	it("requires expiring transport evidence and rejects timeless external membership", () => {
		expect(() =>
			validateRoomMembershipEvidence(
				transportEvidence({ expiresAt: undefined }),
			),
		).toThrow(/must expire/);
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
	});
});
