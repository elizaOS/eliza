/**
 * Pins analyzeRelationship to the source/target pair, not any row that
 * merely mentions the target entity.
 */
import { describe, expect, it } from "vitest";
import type { UUID } from "../types/primitives";
import { RelationshipsService } from "./relationships";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;
const X = "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx" as UUID;

describe("RelationshipsService.analyzeRelationship pair predicate", () => {
	it("does not adopt a relationship that only shares the target entity", async () => {
		const writes: Array<Record<string, unknown>> = [];
		const runtime = {
			agentId: "11111111-1111-4111-8111-111111111111" as UUID,
			async getRelationships() {
				return [
					{
						id: "rel-bc",
						sourceEntityId: B,
						targetEntityId: C,
						strength: 0,
					},
					{
						id: "rel-xb",
						sourceEntityId: X,
						targetEntityId: B,
						strength: 0,
					},
					{
						id: "rel-ab",
						sourceEntityId: A,
						targetEntityId: B,
						strength: 0,
					},
				];
			},
			async getRoomsForParticipant() {
				return [];
			},
			async getMemoriesByRoomIds() {
				return [];
			},
			async createComponent(component: { data?: Record<string, unknown> }) {
				writes.push(component.data ?? {});
				return true;
			},
		};

		const service = new RelationshipsService(runtime as never);
		const analytics = await service.analyzeRelationship(A, B);

		expect(analytics).not.toBeNull();
		expect(writes).toEqual([
			expect.objectContaining({
				targetEntityId: B,
			}),
		]);
		expect(writes[0]?.targetEntityId).not.toBe(C);
	});
});
