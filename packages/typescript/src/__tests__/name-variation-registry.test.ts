import { describe, expect, it } from "vitest";
import type { UUID } from "../types/primitives.ts";
import {
	detectAddressees,
	NameVariationRegistry,
} from "../utils/name-variation-registry.ts";

describe("NameVariationRegistry", () => {
	const alice = "11111111-1111-4111-8111-111111111111" as UUID;
	const bob = "22222222-2222-4222-8222-222222222222" as UUID;

	it("checkAddressedTo resolves @mention to a unique entity", () => {
		const r = new NameVariationRegistry();
		r.registerEntity(alice, ["Alice"]);
		r.registerEntity(bob, ["Bob"]);
		expect(r.checkAddressedTo("@Alice help", {})).toBe(alice);
		expect(r.checkAddressedTo("@Bob hi", {})).toBe(bob);
	});

	it("isAddressedToOther when metadata replyToEntityId points elsewhere", () => {
		const r = new NameVariationRegistry();
		r.registerEntity(alice, ["Alice"]);
		r.registerEntity(bob, ["Bob"]);
		expect(
			r.isAddressedToOther("anything", alice, { replyToEntityId: bob }),
		).toBe(true);
		expect(
			r.isAddressedToOther("anything", alice, { replyToEntityId: alice }),
		).toBe(false);
	});

	it("detectAddressees finds @handles among known names", () => {
		const d = detectAddressees("Hey @Alice and @Bob", ["alice", "carol"]);
		expect(d.explicitMentions).toContain("Alice");
		expect(d.explicitMentions).not.toContain("Bob");
	});
});
