import { describe, expect, it } from "vitest";
import { findEquivalentFact } from "../runtime/fact-write-dedupe";
import type { Memory } from "../types/memory";
import type { UUID } from "../types/primitives";

const roomId = "00000000-0000-0000-0000-000000000001" as UUID;
const entityId = "00000000-0000-0000-0000-000000000002" as UUID;
function fact(text: string, id: string): Memory {
	return { id: id as UUID, roomId, entityId, content: { text } };
}

describe("fact equality", () => {
	it.each([
		["Balance: -10 USD", "Balance: +10 USD"],
		["Value: 1.5", "Value: 1 5"],
		["Identifier: API_KEY", "Identifier: api_key"],
		["Expression: a+b", "Expression: a-b"],
	])("retains distinct claims: %s / %s", async (left, right) => {
		const existing = fact(left, "00000000-0000-0000-0000-000000000003");
		expect(
			await findEquivalentFact(
				{ getMemories: async () => [existing] },
				fact(right, "00000000-0000-0000-0000-000000000004"),
			),
		).toBeNull();
	});

	it("still finds an exact repeated claim", async () => {
		const existing = fact(
			"Balance: -10 USD",
			"00000000-0000-0000-0000-000000000003",
		);
		expect(
			await findEquivalentFact(
				{ getMemories: async () => [existing] },
				fact(" Balance: -10 USD ", "00000000-0000-0000-0000-000000000004"),
			),
		).toBe(existing);
	});
});
