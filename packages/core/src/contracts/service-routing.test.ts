/**
 * Linked-account config normalization gates which provider accounts the router
 * may use. Provider-id validation must be an exact allowlist, and the
 * normalizers must drop unrecognized/empty entries rather than passing partial
 * or malformed account records downstream.
 */
import { describe, expect, it } from "vitest";
import {
	isLinkedAccountProviderId,
	normalizeLinkedAccountFlagConfig,
	normalizeLinkedAccountFlagsConfig,
} from "./service-routing.ts";

describe("isLinkedAccountProviderId", () => {
	it("accepts only known provider ids", () => {
		for (const id of [
			"anthropic-subscription",
			"openai-codex",
			"anthropic-api",
			"cerebras-api",
		]) {
			expect(isLinkedAccountProviderId(id)).toBe(true);
		}
		expect(isLinkedAccountProviderId("unknown-provider")).toBe(false);
		expect(isLinkedAccountProviderId(5)).toBe(false);
		expect(isLinkedAccountProviderId(null)).toBe(false);
	});
});

describe("normalizeLinkedAccountFlagConfig", () => {
	it("returns null for non-records and empty configs", () => {
		expect(normalizeLinkedAccountFlagConfig(null)).toBeNull();
		expect(normalizeLinkedAccountFlagConfig("x")).toBeNull();
		expect(normalizeLinkedAccountFlagConfig({})).toBeNull();
		expect(normalizeLinkedAccountFlagConfig({ status: "bogus" })).toBeNull();
	});

	it("keeps + trims recognized fields, drops invalid ones", () => {
		expect(normalizeLinkedAccountFlagConfig({ userId: "u1" })).toEqual({
			userId: "u1",
		});
		expect(
			normalizeLinkedAccountFlagConfig({ organizationId: "  org  " }),
		).toEqual({ organizationId: "org" });
		// invalid status is dropped but userId keeps the record alive.
		expect(
			normalizeLinkedAccountFlagConfig({ status: "bogus", userId: "u" }),
		).toEqual({ userId: "u" });
	});
});

describe("normalizeLinkedAccountFlagsConfig", () => {
	it("normalizes the map, skipping empty ids/configs, null when empty", () => {
		expect(normalizeLinkedAccountFlagsConfig(null)).toBeNull();
		expect(normalizeLinkedAccountFlagsConfig({})).toBeNull();
		expect(
			normalizeLinkedAccountFlagsConfig({
				acct1: { userId: "u" },
				"   ": { userId: "x" },
				acct2: {},
			}),
		).toEqual({ acct1: { userId: "u" } });
	});
});
