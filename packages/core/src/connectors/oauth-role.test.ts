import { describe, expect, it } from "vitest";
import { readRequestedConnectorRole } from "./oauth-role";

describe("readRequestedConnectorRole", () => {
	const src = "plugin:test:connector";

	it("returns OWNER when metadata is undefined", () => {
		expect(readRequestedConnectorRole(undefined, src)).toBe("OWNER");
	});

	it("returns OWNER when metadata is null", () => {
		expect(readRequestedConnectorRole(null, src)).toBe("OWNER");
	});

	it("returns OWNER when requestedRole is absent", () => {
		expect(readRequestedConnectorRole({}, src)).toBe("OWNER");
	});

	it("returns OWNER when requestedRole is explicitly OWNER", () => {
		expect(readRequestedConnectorRole({ requestedRole: "OWNER" }, src)).toBe(
			"OWNER",
		);
	});

	it("returns AGENT when requestedRole is AGENT", () => {
		expect(readRequestedConnectorRole({ requestedRole: "AGENT" }, src)).toBe(
			"AGENT",
		);
	});

	it("returns TEAM when requestedRole is TEAM", () => {
		expect(readRequestedConnectorRole({ requestedRole: "TEAM" }, src)).toBe(
			"TEAM",
		);
	});

	it("falls back to OWNER for unrecognised role strings (case-sensitive)", () => {
		expect(readRequestedConnectorRole({ requestedRole: "agent" }, src)).toBe(
			"OWNER",
		);
		expect(readRequestedConnectorRole({ requestedRole: "admin" }, src)).toBe(
			"OWNER",
		);
	});

	it("returns OWNER for empty string and does NOT trigger the debug log", () => {
		// Empty string is an absent-but-valid state, not a misconfiguration —
		// the helper treats it the same as `undefined` to avoid noise in
		// development logs.
		expect(readRequestedConnectorRole({ requestedRole: "" }, src)).toBe(
			"OWNER",
		);
	});

	it("falls back to OWNER for non-string requestedRole values", () => {
		expect(readRequestedConnectorRole({ requestedRole: 42 }, src)).toBe(
			"OWNER",
		);
		expect(readRequestedConnectorRole({ requestedRole: true }, src)).toBe(
			"OWNER",
		);
		expect(readRequestedConnectorRole({ requestedRole: null }, src)).toBe(
			"OWNER",
		);
	});
});
