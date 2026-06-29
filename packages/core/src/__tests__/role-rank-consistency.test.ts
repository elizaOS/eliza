import { describe, expect, it } from "vitest";
// Explicit .ts extensions dodge the stale compiled `*.js` shadows in src/ that
// vite would otherwise resolve ahead of the TypeScript sources.
import { normalizeToRoleName, ROLE_RANK, type RoleName } from "../roles.ts";
import { roleRank } from "../runtime/context-gates.ts";
import type { Role } from "../types/environment.ts";

/**
 * The runtime context-gate rank table (NONE<GUEST<USER/MEMBER<ADMIN<OWNER) must
 * stay consistent with the canonical 4-tier ROLE_RANK in roles.ts. These tests
 * pin that invariant so the two tables can never silently diverge.
 */
describe("role rank consistency", () => {
	const shared: RoleName[] = ["GUEST", "USER", "ADMIN", "OWNER"];

	it("gate ordering matches canonical ROLE_RANK for every shared member", () => {
		for (const a of shared) {
			for (const b of shared) {
				expect(Math.sign(roleRank(a) - roleRank(b))).toBe(
					Math.sign(ROLE_RANK[a] - ROLE_RANK[b]),
				);
			}
		}
	});

	it("preserves strict ascending order GUEST < USER < ADMIN < OWNER", () => {
		expect(roleRank("GUEST")).toBeLessThan(roleRank("USER"));
		expect(roleRank("USER")).toBeLessThan(roleRank("ADMIN"));
		expect(roleRank("ADMIN")).toBeLessThan(roleRank("OWNER"));
	});

	it("treats MEMBER as the gate alias for USER", () => {
		expect(roleRank("MEMBER")).toBe(roleRank("USER"));
	});

	it("ranks NONE below GUEST", () => {
		expect(roleRank("NONE")).toBeLessThan(roleRank("GUEST"));
	});

	it("makes OWNER the maximum rank", () => {
		const allRanks = [
			...shared.map((role) => roleRank(role)),
			roleRank("MEMBER"),
			roleRank("NONE"),
		];
		expect(roleRank("OWNER")).toBe(Math.max(...allRanks));
	});
});

describe("normalizeToRoleName", () => {
	it("maps the 5-tier Role vocabulary onto the canonical RoleName", () => {
		const cases: Array<[Role, RoleName]> = [
			["OWNER", "OWNER"],
			["ADMIN", "ADMIN"],
			["MEMBER", "USER"],
			["GUEST", "GUEST"],
			["NONE", "GUEST"],
		];
		for (const [input, expected] of cases) {
			expect(normalizeToRoleName(input)).toBe(expected);
		}
	});
});
