/**
 * Coverage for action-names.
 */
import { describe, expect, it } from "vitest";
import {
	isReservedNonToolActionName,
	NON_EXECUTABLE_RESPONSE_ACTION_NAMES,
	STOP_ACTION_NAME,
} from "./action-names.js";

describe("action-names", () => {
	it("classifies every non-executable name as reserved", () => {
		for (const name of NON_EXECUTABLE_RESPONSE_ACTION_NAMES) {
			expect(isReservedNonToolActionName(name)).toBe(true);
		}
		expect(isReservedNonToolActionName(STOP_ACTION_NAME)).toBe(true);
	});

	it("normalizes case and underscores before matching", () => {
		expect(isReservedNonToolActionName("reply")).toBe(true);
		expect(isReservedNonToolActionName("RePlY")).toBe(true);
		expect(isReservedNonToolActionName("R_E_P_L_Y")).toBe(true);
		expect(isReservedNonToolActionName("stop")).toBe(true);
		expect(isReservedNonToolActionName("none")).toBe(true);
	});

	it("rejects tool-like action names", () => {
		expect(isReservedNonToolActionName("SEND_MESSAGE")).toBe(false);
		expect(isReservedNonToolActionName("foo")).toBe(false);
		expect(isReservedNonToolActionName("")).toBe(false);
	});
});
