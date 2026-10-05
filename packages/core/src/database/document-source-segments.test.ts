/** Verifies real document projection creates independent random segment identities without changing source bytes. */
import { describe, expect, it } from "vitest";
import { buildDocumentSourceProjection } from "./document-source-segments";

describe("document source segment identities", () => {
	it("keeps independent projections collision-isolated with RFC v4 IDs", () => {
		const text = "source 🙂漢字\n".repeat(8000);
		const args = {
			text,
			documentId: "11111111-1111-4111-8111-111111111111",
			agentId: "22222222-2222-4222-8222-222222222222",
			roomId: "33333333-3333-4333-8333-333333333333",
			entityId: "44444444-4444-4444-8444-444444444444",
			documentMetadata: { source: "test" },
		};
		const first = buildDocumentSourceProjection(args);
		const second = buildDocumentSourceProjection(args);
		const ids = [...first.segments, ...second.segments].map(({ id }) => id);
		expect(first.segments.length).toBeGreaterThan(1);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			expect(id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
		}
		for (const projection of [first, second]) {
			expect(
				projection.segments.map(({ content }) => content.text).join(""),
			).toBe(text);
		}
	});
});
