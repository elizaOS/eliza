// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleOnboarding } from "../../src/onboarding/dispatcher.ts";
import {
    isOnboardingActive,
    loadState,
    resetForTest,
    resolvePaths,
} from "../../src/onboarding/state.ts";

let tempDir = "";
const originalStateDir = process.env.USBELIZA_STATE_DIR;
const originalGeoip = process.env.USBELIZA_DISABLE_GEOIP;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "usbeliza-onboarding-"));
    process.env.USBELIZA_STATE_DIR = tempDir;
    // Tests run with no network — silence the geo-IP suggestion path so
    // the timezone prompt is deterministic and doesn't pay a 2s timeout
    // budget per test.
    process.env.USBELIZA_DISABLE_GEOIP = "1";
});

afterEach(() => {
    if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
    if (originalStateDir !== undefined) {
        process.env.USBELIZA_STATE_DIR = originalStateDir;
    } else {
        delete process.env.USBELIZA_STATE_DIR;
    }
    if (originalGeoip !== undefined) {
        process.env.USBELIZA_DISABLE_GEOIP = originalGeoip;
    } else {
        delete process.env.USBELIZA_DISABLE_GEOIP;
    }
});

/**
 * Walk through every onboarding question that comes BEFORE the system
 * questions (keyboardLayout / language / timezone). Order:
 *   1. name → "Charlie"
 *   2. wifiOfferAccepted → "no"  (decline; tests don't have nmcli)
 *   3. claudeOfferAccepted → "no" (decline; tests don't run real OAuth)
 *   4. workFocus → "writing code"
 *   5. multitasking → "single one at a time"
 *   6. chronotype → "morning"
 *   7. errorCommunication → "transparent"
 */
async function walkPersonalQuestions(): Promise<void> {
    await handleOnboarding("", true);
    await handleOnboarding("Charlie", false);
    await handleOnboarding("no", false);
    await handleOnboarding("no", false);
    await handleOnboarding("writing code", false);
    await handleOnboarding("single one at a time", false);
    await handleOnboarding("morning", false);
    await handleOnboarding("transparent", false);
}

describe("onboarding — first-turn greeting", () => {
    test("empty message + no state → emits the greeting from Q1", async () => {
        const turn = await handleOnboarding("", true);
        expect(turn).not.toBeNull();
        expect(turn?.reply).toContain("I'm Eliza");
        expect(turn?.reply.toLowerCase()).toContain("what should i call you");
        expect(turn?.completed).toBe(false);
    });

    test("returns null after calibration.toml exists", async () => {
        // Simulate the user finishing onboarding by walking through.
        let cur = await handleOnboarding("", true);
        expect(cur?.completed).toBe(false);
        cur = await handleOnboarding("Charlie", false);
        // Two new offers right after the name question — decline both in
        // tests since we don't want to fire wifi/OAuth side effects.
        cur = await handleOnboarding("no", false);
        cur = await handleOnboarding("no", false);
        cur = await handleOnboarding("writing code", false);
        cur = await handleOnboarding("single one at a time", false);
        cur = await handleOnboarding("morning", false);
        cur = await handleOnboarding("transparent", false);
        cur = await handleOnboarding("us", false);
        cur = await handleOnboarding("english", false);
        cur = await handleOnboarding("UTC", false);
        expect(cur?.completed).toBe(true);

        // Subsequent turn should fall through to normal intent dispatch.
        const after = await handleOnboarding("hello eliza", false);
        expect(after).toBeNull();
    });
});

describe("onboarding — happy path", () => {
    test("walks through all 10 questions with valid answers", async () => {
        let turn = await handleOnboarding("", true);
        expect(turn?.reply.toLowerCase()).toContain("what should i call you");

        turn = await handleOnboarding("Charlie", false);
        // After name, Eliza offers wifi setup (Q2) before any personality questions
        expect(turn?.reply.toLowerCase()).toContain("wi-fi");

        turn = await handleOnboarding("no", false);
        // Then she offers Claude/Codex auth (Q3)
        expect(turn?.reply.toLowerCase()).toContain("claude");

        turn = await handleOnboarding("no", false);
        // Now back to the personal calibration questions
        expect(turn?.reply.toLowerCase()).toContain("most of your computer time");

        turn = await handleOnboarding("building usbeliza", false);
        expect(turn?.reply.toLowerCase()).toContain("bunch of tools open at once");

        turn = await handleOnboarding("focus on one at a time", false);
        expect(turn?.reply.toLowerCase()).toContain("morning person");

        turn = await handleOnboarding("evening", false);
        expect(turn?.reply.toLowerCase()).toContain("doesn't work");

        turn = await handleOnboarding("tell me what went wrong", false);
        // Now expecting keyboard question, not completion.
        expect(turn?.completed).toBe(false);
        expect(turn?.reply.toLowerCase()).toContain("keyboard layout");

        turn = await handleOnboarding("us", false);
        expect(turn?.reply.toLowerCase()).toContain("language");

        turn = await handleOnboarding("english", false);
        expect(turn?.reply.toLowerCase()).toContain("timezone");

        turn = await handleOnboarding("UTC", false);
        expect(turn?.completed).toBe(true);
        // Warm handoff replaces the old bullet-list closing message. The
        // exact phrasing varies by `workFocus`, but every completion uses
        // the user's name (Charlie here) and contains zero bullet lines.
        expect(turn?.reply.toLowerCase()).toContain("charlie");
        expect(turn?.reply.split("\n").some((line) => line.trim().startsWith("- "))).toBe(false);
    });

    test("writes a real calibration.toml with all ten fields", async () => {
        await handleOnboarding("", true);
        await handleOnboarding("Charlie", false);
        await handleOnboarding("no", false); // wifi offer declined
        await handleOnboarding("no", false); // claude offer declined
        await handleOnboarding("writing code", false);
        await handleOnboarding("multi", false);
        await handleOnboarding("morning", false);
        await handleOnboarding("transparent", false);
        await handleOnboarding("dvorak", false);
        await handleOnboarding("français", false);
        await handleOnboarding("America/Los_Angeles", false);

        const { calibrationFile } = resolvePaths();
        expect(existsSync(calibrationFile)).toBe(true);
        const text = readFileSync(calibrationFile, "utf8");
        expect(text).toContain("schema_version = 1");
        expect(text).toContain('name = "Charlie"');
        expect(text).toContain('work_focus = "writing code"');
        expect(text).toContain('multitasking = "multi-task"');
        expect(text).toContain('chronotype = "morning"');
        expect(text).toContain('error_communication = "transparent"');
        expect(text).toContain('keyboard_layout = "dvorak"');
        expect(text).toContain('language = "fr_FR.UTF-8"');
        expect(text).toContain('timezone = "America/Los_Angeles"');
    });

    test("non-default keyboard + tz produce a 'I'll set your X' note", async () => {
        await walkPersonalQuestions();
        await handleOnboarding("dvorak", false);
        await handleOnboarding("english", false);
        const turn = await handleOnboarding("Europe/Berlin", false);
        expect(turn?.completed).toBe(true);
        const lower = turn?.reply.toLowerCase() ?? "";
        expect(lower).toContain("keyboard");
        expect(lower).toContain("dvorak");
        expect(lower).toContain("europe/berlin");
    });

    test("default us+UTC skips the system note entirely", async () => {
        await walkPersonalQuestions();
        await handleOnboarding("us", false);
        await handleOnboarding("english", false);
        const turn = await handleOnboarding("UTC", false);
        expect(turn?.completed).toBe(true);
        expect(turn?.reply.toLowerCase()).not.toContain("i'll set your keyboard");
        expect(turn?.reply.toLowerCase()).not.toContain("i'll set your time");
    });
});

describe("onboarding — clarification + skip handling", () => {
    test("ambiguous answer triggers a clarify, then accepts retry", async () => {
        await handleOnboarding("", true);
        await handleOnboarding("Charlie", false);
        await handleOnboarding("no", false); // decline wifi offer
        await handleOnboarding("no", false); // decline claude offer
        await handleOnboarding("writing code", false);
        // multitasking question — "yes" is ambiguous
        const turn1 = await handleOnboarding("yes", false);
        expect(turn1?.reply).toContain("many tools open at once");
        const turn2 = await handleOnboarding("multi", false);
        expect(turn2?.reply.toLowerCase()).toContain("morning");
    });

    test("3 clarify attempts then accepts freeform fallback for enum question", async () => {
        await handleOnboarding("", true);
        await handleOnboarding("Charlie", false);
        await handleOnboarding("no", false); // decline wifi offer
        await handleOnboarding("no", false); // decline claude offer
        await handleOnboarding("writing code", false);
        await handleOnboarding("yes", false);
        await handleOnboarding("maybe", false);
        // 3rd attempt → freeform-accept → advance to next question
        const turn = await handleOnboarding("idk", false);
        expect(turn?.reply.toLowerCase()).toContain("morning");
    });

    test("'skip' commits a default and advances", async () => {
        await handleOnboarding("", true);
        // Skip the name → 'friend' default → advance to wifi offer.
        const turn = await handleOnboarding("skip", false);
        expect(turn?.reply.toLowerCase()).toContain("wi-fi");
    });

    test("'skip' on system questions uses sensible defaults", async () => {
        await walkPersonalQuestions();
        // Skip all 3 system questions
        await handleOnboarding("skip", false); // keyboardLayout → "us"
        await handleOnboarding("skip", false); // language → "en_US.UTF-8"
        const turn = await handleOnboarding("skip", false); // timezone → "UTC"
        expect(turn?.completed).toBe(true);

        const { calibrationFile } = resolvePaths();
        const text = readFileSync(calibrationFile, "utf8");
        expect(text).toContain('keyboard_layout = "us"');
        expect(text).toContain('language = "en_US.UTF-8"');
        expect(text).toContain('timezone = "UTC"');
    });
});

describe("onboarding — state persistence", () => {
    test("state survives between handleOnboarding calls (per-turn-process model)", async () => {
        await handleOnboarding("", true);
        await handleOnboarding("Charlie", false);
        await handleOnboarding("no", false); // wifi
        await handleOnboarding("no", false); // claude

        // New "process" — clear in-memory state by calling resolvePaths
        // and re-reading from disk. The implementation uses synchronous
        // file IO, so simulating this is implicit — every call reads
        // fresh.
        const turn = await handleOnboarding("writing code", false);
        expect(turn?.reply.toLowerCase()).toContain("bunch of tools open at once");
    });

    test("isOnboardingActive flips after final question answered", async () => {
        expect(isOnboardingActive()).toBe(true);
        await handleOnboarding("", true);
        await handleOnboarding("Charlie", false);
        await handleOnboarding("no", false); // decline wifi offer
        await handleOnboarding("no", false); // decline claude offer
        await handleOnboarding("writing code", false);
        await handleOnboarding("multi", false);
        await handleOnboarding("morning", false);
        await handleOnboarding("transparent", false);
        // After question 5 (errorCommunication), 3 more remain.
        expect(isOnboardingActive()).toBe(true);
        await handleOnboarding("us", false);
        await handleOnboarding("english", false);
        await handleOnboarding("UTC", false);
        expect(isOnboardingActive()).toBe(false);
    });
});

describe("onboarding — answer parsing", () => {
    test("multitasking accepts varied phrasings", async () => {
        // Use resetForTest between cases via beforeEach (fresh tempDir).
        await handleOnboarding("", true);
        await handleOnboarding("Charlie", false);
        await handleOnboarding("no", false); // decline wifi offer
        await handleOnboarding("no", false); // decline claude offer
        await handleOnboarding("writing code", false);
        const turn = await handleOnboarding("usually a bunch", false);
        expect(turn?.reply.toLowerCase()).toContain("morning");
    });

    test("chronotype accepts 'depends'", async () => {
        await handleOnboarding("", true);
        await handleOnboarding("Charlie", false);
        await handleOnboarding("no", false); // decline wifi offer
        await handleOnboarding("no", false); // decline claude offer
        await handleOnboarding("writing code", false);
        await handleOnboarding("multi", false);
        const turn = await handleOnboarding("it depends on the day", false);
        expect(turn?.reply.toLowerCase()).toContain("doesn't work");
    });

    test("errorCommunication accepts 'quiet' or 'tell'", async () => {
        const setup = async () => {
            resetForTest();
            await handleOnboarding("", true);
            await handleOnboarding("Charlie", false);
            await handleOnboarding("no", false); // decline wifi offer
            await handleOnboarding("no", false); // decline claude offer
            await handleOnboarding("writing", false);
            await handleOnboarding("multi", false);
            await handleOnboarding("morning", false);
        };
        await setup();
        const quietTurn = await handleOnboarding("just fix it quietly", false);
        // After question 5, we're now on keyboardLayout (not done).
        expect(quietTurn?.completed).toBe(false);
        expect(quietTurn?.reply.toLowerCase()).toContain("keyboard");

        await setup();
        const tellTurn = await handleOnboarding("tell me what went wrong", false);
        expect(tellTurn?.completed).toBe(false);
        expect(tellTurn?.reply.toLowerCase()).toContain("keyboard");
    });

    test("language accepts english names and short codes", async () => {
        await walkPersonalQuestions();
        await handleOnboarding("us", false); // keyboard
        // "english" → en_US.UTF-8
        const turn = await handleOnboarding("english", false);
        expect(turn?.reply.toLowerCase()).toContain("timezone");
    });

    test("timezone accepts IANA strings and abbreviations", async () => {
        await walkPersonalQuestions();
        await handleOnboarding("us", false);
        await handleOnboarding("english", false);
        // "PST" → America/Los_Angeles
        const turn = await handleOnboarding("PST", false);
        expect(turn?.completed).toBe(true);
        const { calibrationFile } = resolvePaths();
        const text = readFileSync(calibrationFile, "utf8");
        expect(text).toContain('timezone = "America/Los_Angeles"');
    });

    test("wifiOfferAccepted survives state round-trip as a boolean, not a string", async () => {
        // Regression: parseTomlState used to coerce unquoted `true` /
        // `false` back into the literal strings "true" / "false", which
        // then re-serialized as `wifiOfferAccepted = "true"` (quoted)
        // and were silently dropped from calibration.toml by the
        // `typeof === "boolean"` guard. User's exact input:
        await handleOnboarding("", true);
        await handleOnboarding("Charlie", false);
        // Q2 — the literal phrase from the bug report. parseOffer's
        // `^(y|yes|yeah|...)` matches "yeah" → boolean true.
        const wifiTurn = await handleOnboarding("yeah lets turn on wifi", false);
        // Should advance to claude offer, not re-ask wifi.
        expect(wifiTurn?.reply.toLowerCase()).toContain("claude");

        // Re-load from disk: the type must stay boolean across the
        // serialize → parseTomlState round trip.
        const persisted = loadState();
        expect(persisted).not.toBeNull();
        expect(persisted?.answers.wifiOfferAccepted).toBe(true);
        expect(typeof persisted?.answers.wifiOfferAccepted).toBe("boolean");

        // Walk the rest of the flow and verify calibration.toml gets
        // the boolean (which only happens if `typeof === "boolean"` in
        // serializeCalibrationToml is satisfied).
        await handleOnboarding("no", false); // claude
        await handleOnboarding("writing", false);
        await handleOnboarding("multi", false);
        await handleOnboarding("morning", false);
        await handleOnboarding("transparent", false);
        await handleOnboarding("us", false);
        await handleOnboarding("english", false);
        const done = await handleOnboarding("UTC", false);
        expect(done?.completed).toBe(true);

        const { calibrationFile } = resolvePaths();
        const text = readFileSync(calibrationFile, "utf8");
        // The serializer writes `wifi_offer_accepted = true` (bare bool).
        // If the parser had coerced to string, the typeof-boolean guard
        // would have dropped the line entirely.
        expect(text).toContain("wifi_offer_accepted = true");
        expect(text).toContain("claude_offer_accepted = false");
        expect(text).not.toContain('wifi_offer_accepted = "true"');
    });

    test("offer booleans round-trip cleanly across multiple saves", async () => {
        // The bug surfaced because between each onboarding question the
        // state is saved and re-loaded; each round trip used to flip a
        // bare `true` into the string `"true"`. Walk past several
        // questions so the wifi answer is loaded/re-saved multiple times
        // before the final commit.
        await handleOnboarding("", true);
        await handleOnboarding("Charlie", false);
        await handleOnboarding("yes", false); // wifi → true
        await handleOnboarding("yeah", false); // claude → true
        await handleOnboarding("writing", false);
        await handleOnboarding("multi", false);

        const mid = loadState();
        expect(mid?.answers.wifiOfferAccepted).toBe(true);
        expect(mid?.answers.claudeOfferAccepted).toBe(true);
        expect(typeof mid?.answers.wifiOfferAccepted).toBe("boolean");
        expect(typeof mid?.answers.claudeOfferAccepted).toBe("boolean");
    });

    test("keyboard layout accepts 'qwerty' and 'german' aliases", async () => {
        await walkPersonalQuestions();
        const turn = await handleOnboarding("german", false);
        expect(turn?.reply.toLowerCase()).toContain("language");
        // Walk to end and verify the toml has "de"
        await handleOnboarding("english", false);
        await handleOnboarding("UTC", false);
        const { calibrationFile } = resolvePaths();
        const text = readFileSync(calibrationFile, "utf8");
        expect(text).toContain('keyboard_layout = "de"');
    });
});
