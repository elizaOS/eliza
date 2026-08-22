/**
 * Covers `ramHeadroomReserveMb` env parsing. The reserve is subtracted from host
 * RAM before a model's fit is judged, so a silently truncated value removes the
 * safety margin that refuses an oversized load.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ramHeadroomReserveMb } from "./ram-budget";

const KEY = "ELIZA_LOCAL_RAM_HEADROOM_MB";
const original = process.env[KEY];

afterEach(() => {
	if (original === undefined) delete process.env[KEY];
	else process.env[KEY] = original;
});

describe("ramHeadroomReserveMb", () => {
	it("ignores a trailing-garbage reserve instead of parsing its prefix", () => {
		// parseInt("1junk") is 1 — a 1MB reserve instead of 1536MB, overstating
		// usable RAM by ~1.5GB so a model that must be refused reports "fits".
		process.env[KEY] = "1junk";
		expect(ramHeadroomReserveMb()).toBe(1536);
	});

	it("still honours a clean reserve, including an explicit zero", () => {
		process.env[KEY] = "2048";
		expect(ramHeadroomReserveMb()).toBe(2048);
		process.env[KEY] = "0";
		expect(ramHeadroomReserveMb()).toBe(0);
	});

	it("still honours an explicitly signed positive reserve", () => {
		// `Number.parseInt` accepted "+2048"; rejecting it would be a regression.
		process.env[KEY] = "+2048";
		expect(ramHeadroomReserveMb()).toBe(2048);
	});

	it("falls back for a reserve beyond the safe integer range", () => {
		process.env[KEY] = "9007199254740993";
		expect(ramHeadroomReserveMb()).toBe(1536);
	});
});
