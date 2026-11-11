import { describe, expect, it } from "vitest";
import { isReservedNonToolActionName } from "../src/action-names";

describe("isReservedNonToolActionName", () => {
	it("matches the reserved names exactly", () => {
		for (const name of ["REPLY", "NONE", "IGNORE", "STOP"]) {
			expect(isReservedNonToolActionName(name)).toBe(true);
		}
	});

	it("matches case-insensitively and across underscore spellings", () => {
		expect(isReservedNonToolActionName("reply")).toBe(true);
		expect(isReservedNonToolActionName("R_E_P_L_Y")).toBe(true);
		expect(isReservedNonToolActionName("stop")).toBe(true);
	});

	it("matches names with surrounding whitespace", () => {
		expect(isReservedNonToolActionName(" REPLY ")).toBe(true);
		expect(isReservedNonToolActionName("REPLY\n")).toBe(true);
		expect(isReservedNonToolActionName("\tSTOP\t")).toBe(true);
		expect(isReservedNonToolActionName(" none ")).toBe(true);
	});

	it("rejects non-reserved and empty names", () => {
		for (const name of ["SEND_TOKEN", "REPLY_NOW", "", "  "]) {
			expect(isReservedNonToolActionName(name)).toBe(false);
		}
	});
});
