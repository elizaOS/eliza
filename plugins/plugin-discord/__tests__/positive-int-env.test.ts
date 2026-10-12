/** positiveIntEnv — non-canonical env values fall back to the default. */

import { afterEach, describe, expect, it } from "vitest";
import { positiveIntEnv } from "../utils.ts";

const NAME = "DISCORD_ATTACHMENT_FETCH_MAX_BYTES_TEST_SEAM";
const FALLBACK = 25 * 1024 * 1024;

afterEach(() => {
	delete process.env[NAME];
});

describe("positiveIntEnv", () => {
	it("accepts a canonical positive decimal integer", () => {
		process.env[NAME] = " 5242880 ";
		expect(positiveIntEnv(NAME, FALLBACK)).toBe(5242880);
	});

	it("rejects hex, exponent, and fractional spellings", () => {
		for (const raw of ["0x10", "1e3", "12.9", "+12junk", "2junk"]) {
			process.env[NAME] = raw;
			expect(positiveIntEnv(NAME, FALLBACK), raw).toBe(FALLBACK);
		}
	});

	it("rejects non-positive and unsafe values", () => {
		for (const raw of ["0", "-5", "9007199254740993", "", "abc"]) {
			process.env[NAME] = raw;
			expect(positiveIntEnv(NAME, FALLBACK), raw).toBe(FALLBACK);
		}
		process.env[NAME] = undefined as unknown as string;
		expect(positiveIntEnv(NAME, FALLBACK)).toBe(FALLBACK);
		delete process.env[NAME];
		expect(positiveIntEnv(NAME, FALLBACK)).toBe(FALLBACK);
	});
});
