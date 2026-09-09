import { describe, expect, it } from "vitest";
import type { Memory } from "../types/index.ts";
import { previousEvidencePage } from "./evaluator-evidence-page.ts";

const rows = Array.from({ length: 40 }, (_, i) => ({
	id: `source-${i}`,
	entityId: "speaker",
	roomId: "room",
	createdAt: i,
	content: {
		text: `${i}: violet notebook\n🍊 ${"complete source ".repeat(i + 1)}`,
	},
})) as Array<Memory & { id: NonNullable<Memory["id"]> }>;
describe("historical evidence continuation", () => {
	it("reassembles ordered Unicode records exactly through every explicit cursor page", () => {
		const budget = Math.max(
			...rows.map(
				(row) => new TextEncoder().encode(JSON.stringify(row)).byteLength,
			),
		);
		let before = rows[39].id;
		const restored: Memory[] = [];
		for (;;) {
			const page = previousEvidencePage(rows, before, budget);
			restored.unshift(...page.messages);
			if (!page.hasEarlier) break;
			const cursor = page.messages[0]?.id;
			if (!cursor) throw new Error("Continuation lost its source cursor");
			before = cursor;
		}
		expect(restored).toEqual(rows.slice(0, -1));
	});
	it("rejects missing/foreign cursors and oversized complete records instead of clipping", () => {
		expect(() => previousEvidencePage(rows, "foreign-source", 1000)).toThrow(
			expect.objectContaining({ code: "EVALUATOR_REFERENCE_CURSOR_INVALID" }),
		);
		expect(() => previousEvidencePage(rows, rows[1].id, 4)).toThrow(
			expect.objectContaining({ code: "EVALUATOR_SOURCE_TOO_LARGE" }),
		);
		expect(previousEvidencePage(rows, rows[0].id, 1000)).toEqual({
			messages: [],
			hasEarlier: false,
		});
	});
});
