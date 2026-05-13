// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Unit tests for `parseTimezone` — the function that turns whatever the
 * user types ("Los Angeles", "I'm in london", "PT") into a canonical
 * IANA timezone string suitable for `timedatectl set-timezone`.
 *
 * Regression motivation: a real user typed something like "Los Angeles"
 * and the parser fell through to dispatcher.ts:freeformAccept which
 * stored a garbled `america/lo_sangeles` in `~/.eliza/calibration.toml`,
 * and `timedatectl` then failed on every subsequent boot. These tests
 * lock in the natural-language phrasings we accept so that fallback path
 * is never hit for any reasonable input.
 */

import { describe, expect, test } from "bun:test";

import { parseTimezone } from "../src/onboarding/questions.ts";

describe("parseTimezone", () => {
    test("city name with space → IANA underscore form", () => {
        expect(parseTimezone("Los Angeles")).toBe("America/Los_Angeles");
    });

    test("IANA-shaped with space after slash → canonical underscore", () => {
        expect(parseTimezone("America/Los Angeles")).toBe("America/Los_Angeles");
    });

    test("city name lowercase → IANA underscore form", () => {
        expect(parseTimezone("los angeles")).toBe("America/Los_Angeles");
    });

    test("\"Pacific Time\" phrasing → Los Angeles IANA", () => {
        expect(parseTimezone("Pacific Time")).toBe("America/Los_Angeles");
    });

    test("\"I'm in london\" natural prefix → London IANA", () => {
        expect(parseTimezone("I'm in london")).toBe("Europe/London");
    });

    test("\"im in nyc\" prefix + abbreviation → New York IANA", () => {
        expect(parseTimezone("im in nyc")).toBe("America/New_York");
    });

    test("\"PT\" zone abbreviation → Los Angeles IANA", () => {
        expect(parseTimezone("PT")).toBe("America/Los_Angeles");
    });

    test("\"UTC\" remains UTC", () => {
        expect(parseTimezone("UTC")).toBe("UTC");
    });

    test("nonsense input → undefined", () => {
        expect(parseTimezone("garbage 123")).toBeUndefined();
    });

    test("canonical IANA already → pass through", () => {
        expect(parseTimezone("America/Los_Angeles")).toBe("America/Los_Angeles");
    });

    test("empty string → undefined", () => {
        expect(parseTimezone("")).toBeUndefined();
    });

    // ── Extra cases that the bug report implied but didn't list ──────────

    test("\"i live in tokyo\" → Tokyo IANA", () => {
        expect(parseTimezone("i live in tokyo")).toBe("Asia/Tokyo");
    });

    test("\"Tokyo\" city alone → Tokyo IANA", () => {
        expect(parseTimezone("Tokyo")).toBe("Asia/Tokyo");
    });

    test("\"Berlin\" city alone → Berlin IANA", () => {
        expect(parseTimezone("Berlin")).toBe("Europe/Berlin");
    });

    test("\"Paris\" city alone → Paris IANA", () => {
        expect(parseTimezone("Paris")).toBe("Europe/Paris");
    });

    test("\"Sydney\" city alone → Sydney IANA", () => {
        expect(parseTimezone("Sydney")).toBe("Australia/Sydney");
    });

    test("\"Mumbai\" → Kolkata IANA (India shares one zone)", () => {
        expect(parseTimezone("Mumbai")).toBe("Asia/Kolkata");
    });

    test("\"Eastern\" zone name → New York IANA", () => {
        expect(parseTimezone("Eastern")).toBe("America/New_York");
    });

    test("\"ET\" abbreviation → New York IANA", () => {
        expect(parseTimezone("ET")).toBe("America/New_York");
    });

    test("\"Mountain Time\" phrasing → Denver IANA", () => {
        expect(parseTimezone("Mountain Time")).toBe("America/Denver");
    });

    test("\"CT\" abbreviation → Chicago IANA", () => {
        expect(parseTimezone("CT")).toBe("America/Chicago");
    });

    test("\"GMT\" → UTC", () => {
        expect(parseTimezone("GMT")).toBe("UTC");
    });

    test("\"Z\" military zulu → UTC", () => {
        expect(parseTimezone("Z")).toBe("UTC");
    });

    // ── Trailing affirmation/filler words (regression: user typed
    //    "los angeles yeah" and the parser fell through to undefined,
    //    triggering an unnecessary clarify) ─────────────────────────────

    test("\"los angeles yeah\" → Los Angeles IANA (trailing affirmation stripped)", () => {
        expect(parseTimezone("los angeles yeah")).toBe("America/Los_Angeles");
    });

    test("\"tokyo please\" → Tokyo IANA (trailing filler stripped)", () => {
        expect(parseTimezone("tokyo please")).toBe("Asia/Tokyo");
    });

    test("\"nyc thanks\" → New York IANA (trailing thanks stripped)", () => {
        expect(parseTimezone("nyc thanks")).toBe("America/New_York");
    });

    test("\"i'm in london yes\" → London IANA (prefix + trailing yes stripped)", () => {
        expect(parseTimezone("i'm in london yes")).toBe("Europe/London");
    });

    test("\"PT yeah\" → Los Angeles IANA (zone abbrev + trailing yeah stripped)", () => {
        expect(parseTimezone("PT yeah")).toBe("America/Los_Angeles");
    });
});
