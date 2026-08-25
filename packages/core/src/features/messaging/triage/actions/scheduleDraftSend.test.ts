/**
 * Unit tests for scheduleDraftSend: validates formatSendAtIso and parameter validation.
 */
import { describe, expect, it } from "vitest";
import {
	formatSendAtIso,
	scheduleDraftSendAction,
} from "./scheduleDraftSend.ts";

describe("scheduleDraftSend", () => {
	describe("formatSendAtIso", () => {
		it("formats valid timestamp to ISO 8601 string", () => {
			const ms = 1700000000000;
			const iso = formatSendAtIso(ms);
			expect(iso).toBe(new Date(ms).toISOString());
		});

		it("throws ElizaError when sendAtMs is not finite or NaN", () => {
			expect(() => formatSendAtIso(Number.NaN)).toThrow();
			expect(() => formatSendAtIso(Number.POSITIVE_INFINITY)).toThrow();
		});
	});

	describe("scheduleDraftSendAction", () => {
		it("exports action metadata with required properties", () => {
			expect(scheduleDraftSendAction.name).toBe("MESSAGE");
			expect(scheduleDraftSendAction.contexts).toContain("messaging");
			expect(scheduleDraftSendAction.roleGate?.minRole).toBe("ADMIN");
			expect(scheduleDraftSendAction.description).toBeDefined();
		});
	});
});
