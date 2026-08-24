/**
 * Coverage for pairing.
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_PAIRING_CONFIG,
	DEFAULT_PAIRING_PAGE_LIMIT,
	getPairingIdLabel,
	MAX_PAIRING_PAGE_LIMIT,
	normalizePairingPageOptions,
	PAIRING_CODE_ALPHABET,
} from "./pairing.js";

describe("pairing", () => {
	describe("normalizePairingPageOptions", () => {
		it("defaults to the page limit at offset 0 when called without options", () => {
			expect(normalizePairingPageOptions()).toEqual({
				limit: DEFAULT_PAIRING_PAGE_LIMIT,
				offset: 0,
			});
			expect(normalizePairingPageOptions({})).toEqual({
				limit: DEFAULT_PAIRING_PAGE_LIMIT,
				offset: 0,
			});
		});

		it("passes explicit options through unchanged", () => {
			expect(normalizePairingPageOptions({ limit: 25, offset: 75 })).toEqual({
				limit: 25,
				offset: 75,
			});
		});

		it("defaults each field independently", () => {
			expect(normalizePairingPageOptions({ offset: 40 })).toEqual({
				limit: DEFAULT_PAIRING_PAGE_LIMIT,
				offset: 40,
			});
			expect(normalizePairingPageOptions({ limit: 10 })).toEqual({
				limit: 10,
				offset: 0,
			});
		});

		it("accepts the inclusive limit boundaries 1 and MAX_PAIRING_PAGE_LIMIT", () => {
			expect(normalizePairingPageOptions({ limit: 1 })).toEqual({
				limit: 1,
				offset: 0,
			});
			expect(
				normalizePairingPageOptions({ limit: MAX_PAIRING_PAGE_LIMIT }),
			).toEqual({ limit: MAX_PAIRING_PAGE_LIMIT, offset: 0 });
		});

		it("rejects limits outside 1..MAX_PAIRING_PAGE_LIMIT", () => {
			expect(() =>
				normalizePairingPageOptions({ limit: MAX_PAIRING_PAGE_LIMIT + 1 }),
			).toThrow(RangeError);
			expect(() => normalizePairingPageOptions({ limit: 0 })).toThrow(
				RangeError,
			);
			expect(() => normalizePairingPageOptions({ limit: -5 })).toThrow(
				RangeError,
			);
		});

		it("rejects non-integer and non-safe limits", () => {
			expect(() => normalizePairingPageOptions({ limit: 2.5 })).toThrow(
				RangeError,
			);
			expect(() => normalizePairingPageOptions({ limit: Number.NaN })).toThrow(
				RangeError,
			);
			expect(() =>
				normalizePairingPageOptions({ limit: Number.POSITIVE_INFINITY }),
			).toThrow(RangeError);
		});

		it("accepts zero and maximum safe offsets", () => {
			expect(normalizePairingPageOptions({ offset: 0 })).toEqual({
				limit: DEFAULT_PAIRING_PAGE_LIMIT,
				offset: 0,
			});
			expect(
				normalizePairingPageOptions({ offset: Number.MAX_SAFE_INTEGER }),
			).toEqual({
				limit: DEFAULT_PAIRING_PAGE_LIMIT,
				offset: Number.MAX_SAFE_INTEGER,
			});
		});

		it("rejects negative, non-integer, and non-safe offsets", () => {
			expect(() => normalizePairingPageOptions({ offset: -1 })).toThrow(
				RangeError,
			);
			expect(() => normalizePairingPageOptions({ offset: 0.5 })).toThrow(
				RangeError,
			);
			expect(() =>
				normalizePairingPageOptions({ offset: Number.MAX_SAFE_INTEGER + 1 }),
			).toThrow(RangeError);
		});

		it("validates the limit before the offset", () => {
			expect(() =>
				normalizePairingPageOptions({ limit: 0, offset: -1 }),
			).toThrowError(/limit/);
		});
	});

	describe("getPairingIdLabel", () => {
		it("returns the configured label for known channels", () => {
			expect(getPairingIdLabel("telegram")).toBe("userId");
			expect(getPairingIdLabel("whatsapp")).toBe("phoneNumber");
			expect(getPairingIdLabel("googlechat")).toBe("email");
		});

		it("falls back to userId for unknown and extension channels", () => {
			expect(getPairingIdLabel("farcaster")).toBe("userId");
			expect(getPairingIdLabel("")).toBe("userId");
		});
	});

	describe("pairing code contract", () => {
		it("draws codes from an unambiguous duplicate-free alphabet", () => {
			const characters = [...PAIRING_CODE_ALPHABET];
			expect(new Set(characters).size).toBe(characters.length);
			for (const ambiguous of ["0", "O", "1", "I", "l"]) {
				expect(characters).not.toContain(ambiguous);
			}
		});

		it("defaults support generation within the alphabet", () => {
			expect(DEFAULT_PAIRING_CONFIG.codeLength).toBeLessThanOrEqual(
				PAIRING_CODE_ALPHABET.length,
			);
			expect(DEFAULT_PAIRING_CONFIG.maxPendingRequests).toBeGreaterThanOrEqual(
				1,
			);
			expect(DEFAULT_PAIRING_CONFIG.requestTtlMs).toBe(60 * 60 * 1000);
		});
	});
});
