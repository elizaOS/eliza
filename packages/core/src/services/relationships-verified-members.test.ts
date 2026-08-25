/**
 * Confirmed identity membership uses the real RelationshipsService graph walk
 * with a deterministic relationship store. It follows transitive confirmed
 * links while excluding proposed, rejected, and ordinary social edges.
 */
import { describe, expect, it, vi } from "vitest";
import type { Relationship, UUID } from "../types/index.ts";
import { RelationshipsService } from "./relationships.ts";

const AGENT = "00000000-0000-0000-0000-000000000001" as UUID;
const A = "00000000-0000-0000-0000-000000000011" as UUID;
const B = "00000000-0000-0000-0000-000000000012" as UUID;
const C = "00000000-0000-0000-0000-000000000013" as UUID;
const INFERRED = "00000000-0000-0000-0000-000000000014" as UUID;
const SOCIAL = "00000000-0000-0000-0000-000000000015" as UUID;

function relationship(
	id: UUID,
	sourceEntityId: UUID,
	targetEntityId: UUID,
	tags: string[],
	status?: string,
): Relationship {
	return {
		id,
		sourceEntityId,
		targetEntityId,
		agentId: AGENT,
		tags,
		metadata: status ? { status } : {},
	};
}

describe("RelationshipsService.getVerifiedMemberEntityIds", () => {
	it("walks only transitive confirmed identity links", async () => {
		const relationships = [
			relationship(
				"00000000-0000-0000-0000-000000000101" as UUID,
				A,
				B,
				["identity_link"],
				"confirmed",
			),
			relationship(
				"00000000-0000-0000-0000-000000000102" as UUID,
				B,
				C,
				["identity_link"],
				"confirmed",
			),
			relationship(
				"00000000-0000-0000-0000-000000000103" as UUID,
				A,
				INFERRED,
				["identity_link"],
				"proposed",
			),
			relationship(
				"00000000-0000-0000-0000-000000000104" as UUID,
				A,
				SOCIAL,
				["friend"],
				"confirmed",
			),
		];
		const getRelationships = vi.fn(
			async ({ entityIds }: { entityIds: UUID[] }) =>
				relationships.filter(
					(item) =>
						entityIds.includes(item.sourceEntityId) ||
						entityIds.includes(item.targetEntityId),
				),
		);
		const service = new RelationshipsService({
			agentId: AGENT,
			getRelationships,
		} as never);

		expect(new Set(await service.getVerifiedMemberEntityIds(A))).toEqual(
			new Set([A, B, C]),
		);
		expect(getRelationships).toHaveBeenCalledTimes(3);
	});
});
