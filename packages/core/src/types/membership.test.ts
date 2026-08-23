/**
 * Coverage for membership.
 */
import { describe, expect, it } from "vitest";
import {
	MEMBERSHIP_AUTHORITY_CONTRACT_VERSION,
	MEMBERSHIP_STATES,
	Role,
} from "./membership.js";

describe("membership", () => {
	it("exposes version", () => {
		expect(MEMBERSHIP_AUTHORITY_CONTRACT_VERSION).toBe(1);
	});
	it("exposes states", () => {
		expect(MEMBERSHIP_STATES).toContain("active");
		expect(MEMBERSHIP_STATES).toContain("revoked");
	});
});
