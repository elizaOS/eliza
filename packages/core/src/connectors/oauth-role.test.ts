/**
 * Unit tests for `readRequestedConnectorRole` — mapping connector `requestedRole`
 * metadata to the canonical OWNER / AGENT / TEAM role, its OWNER fallbacks, and
 * when it emits the misconfiguration debug log (logger spied, fully deterministic).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger";
import { readRequestedConnectorRole } from "./oauth-role";

describe("readRequestedConnectorRole", () => {
	const src = "plugin:test:connector";

	afterEach(() => {
		vi.restoreAllMocks();
	});

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
		// development logs. Pin both halves of the contract (return value and
		// log suppression) so the no-log behavior can't silently regress.
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		expect(readRequestedConnectorRole({ requestedRole: "" }, src)).toBe(
			"OWNER",
		);
		expect(debugSpy).not.toHaveBeenCalled();
	});

	it("emits a debug log when a non-empty unrecognised requestedRole is supplied", () => {
		// Contrast case: an unrecognised value that IS meaningful (e.g. typoed
		// "admin") should fire the debug log so the misconfiguration surfaces.
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		expect(readRequestedConnectorRole({ requestedRole: "admin" }, src)).toBe(
			"OWNER",
		);
		expect(debugSpy).toHaveBeenCalledTimes(1);
		expect(debugSpy).toHaveBeenCalledWith(
			expect.objectContaining({ src, requestedRoleRaw: "admin" }),
			expect.stringContaining("Unrecognised requestedRole"),
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
