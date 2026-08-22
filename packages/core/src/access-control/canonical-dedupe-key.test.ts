/**
 * Canonical connector-memory dedupe-key tests exercise the real recall
 * evaluator with deterministic in-memory records. They prove delimiter-bearing
 * connector identifiers cannot collapse distinct records while exact
 * redeliveries and the legacy separator-free key corpus retain their contract.
 */
import { describe, expect, it } from "vitest";
import type { AccessContext, Memory, UUID } from "../types";
import {
	buildCanonicalRecall,
	type CanonicalProvenance,
	canonicalDedupeKey,
} from "./provenance-envelope";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const SENDER_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const REQUESTER: AccessContext = {
	requesterEntityId: SENDER_ID,
	role: "USER",
};

function provenance(
	accountId: string,
	platformMessageId: string,
): CanonicalProvenance {
	return {
		source: "discord",
		accountId,
		roomId: ROOM_ID,
		senderId: SENDER_ID,
		timestampMs: 1,
		trust: "sender-stamped",
		platformMessageId,
		scope: "shared",
	};
}

function memory(
	id: UUID,
	accountId: string,
	platformMessageId: string,
	createdAt: number,
): Memory {
	return {
		id,
		agentId: AGENT_ID,
		entityId: SENDER_ID,
		roomId: ROOM_ID,
		createdAt,
		content: { source: "discord", text: platformMessageId },
		metadata: {
			provider: "discord",
			accountId,
			platformMessageId,
			scope: "shared",
			discord: { userId: "user-123" },
		},
	} as Memory;
}

describe("canonicalDedupeKey", () => {
	it("keeps a separator-free legacy corpus byte-identical", () => {
		const corpus = Array.from({ length: 100 }, (_, index) =>
			provenance(
				`account-${index}@example.com`,
				`message_${index}/with?query=${index}`,
			),
		);
		for (const item of corpus) {
			expect(canonicalDedupeKey(item)).toBe(
				`${item.source}:${item.accountId}:${item.roomId}:${item.platformMessageId}`,
			);
		}
	});

	it("keeps distinct delimiter-bearing tuples distinct through recall", () => {
		const firstAccount = "acct";
		const firstMessage = `part:${ROOM_ID}:tail`;
		const secondAccount = `acct:${ROOM_ID}:part`;
		const secondMessage = "tail";
		expect(canonicalDedupeKey(provenance(firstAccount, firstMessage))).not.toBe(
			canonicalDedupeKey(provenance(secondAccount, secondMessage)),
		);

		const result = buildCanonicalRecall({
			candidates: [
				memory(
					"00000000-0000-0000-0000-000000000010" as UUID,
					firstAccount,
					firstMessage,
					1,
				),
				memory(
					"00000000-0000-0000-0000-000000000011" as UUID,
					secondAccount,
					secondMessage,
					2,
				),
			],
			agentId: AGENT_ID,
			requester: REQUESTER,
			destinationRoomId: ROOM_ID,
		});

		expect(result.items).toHaveLength(2);
		expect(result.items.map((item) => item.memory.content.text)).toEqual([
			firstMessage,
			secondMessage,
		]);
	});

	it("still collapses an exact redelivery", () => {
		const original = memory(
			"00000000-0000-0000-0000-000000000020" as UUID,
			"account:with:delimiter",
			"message:with:delimiter",
			1,
		);
		const redelivery = {
			...original,
			id: "00000000-0000-0000-0000-000000000021" as UUID,
			createdAt: 2,
		};
		const result = buildCanonicalRecall({
			candidates: [redelivery, original],
			agentId: AGENT_ID,
			requester: REQUESTER,
			destinationRoomId: ROOM_ID,
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.memory.id).toBe(original.id);
	});
});
