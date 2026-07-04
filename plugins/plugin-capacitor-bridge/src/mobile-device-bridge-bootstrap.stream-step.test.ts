/**
 * Unit coverage for the bionic streaming step-size environment knob.
 *
 * The agent side forwards `ELIZA_LOCAL_STREAM_TOKENS_PER_STEP` only when it is
 * a positive integer; unset or invalid values let the native host apply its
 * decode-step default.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBionicStreamStep } from "./mobile-device-bridge-bootstrap";

const KEY = "ELIZA_LOCAL_STREAM_TOKENS_PER_STEP";
let saved: string | undefined;

describe("resolveBionicStreamStep (#11913)", () => {
	beforeEach(() => {
		saved = process.env[KEY];
		delete process.env[KEY];
	});
	afterEach(() => {
		if (saved === undefined) delete process.env[KEY];
		else process.env[KEY] = saved;
	});

	it("returns undefined when the knob is unset (host default applies)", () => {
		expect(resolveBionicStreamStep()).toBeUndefined();
	});

	it("parses a positive integer", () => {
		process.env[KEY] = "4";
		expect(resolveBionicStreamStep()).toBe(4);
	});

	it("ignores zero, negatives, and junk", () => {
		process.env[KEY] = "0";
		expect(resolveBionicStreamStep()).toBeUndefined();
		process.env[KEY] = "-8";
		expect(resolveBionicStreamStep()).toBeUndefined();
		process.env[KEY] = "fast";
		expect(resolveBionicStreamStep()).toBeUndefined();
		process.env[KEY] = "  ";
		expect(resolveBionicStreamStep()).toBeUndefined();
	});
});
