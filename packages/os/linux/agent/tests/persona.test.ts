// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { describe, expect, test } from "bun:test";

import { ELIZA } from "../src/characters/eliza.ts";
import { buildSystemPrompt, type CalibrationBlock } from "../src/persona.ts";

const CALIBRATION_FIXTURE: CalibrationBlock = {
    name: "Charlie",
    workFocus: "writing code, mostly Rust and TypeScript",
    multitasking: "single-task",
    chronotype: "morning",
    errorCommunication: "transparent",
};

describe("ELIZA character", () => {
    test("validates against @elizaos/agent's CharacterSchema at module load", () => {
        // The import itself throws if validation fails, so reaching this
        // point means CharacterSchema accepted the character. Sanity-check
        // a few load-bearing fields to lock the public shape.
        expect(ELIZA.name).toBe("Eliza");
        expect(typeof ELIZA.system).toBe("string");
        expect((ELIZA.system as string).length).toBeGreaterThan(100);
    });

    test("system prompt includes the OS-context preamble", () => {
        expect(ELIZA.system).toContain("operating system");
        expect(ELIZA.system).toContain("/run/eliza/cap-");
    });

    test("style guidance is non-empty", () => {
        expect(ELIZA.style.all.length).toBeGreaterThan(0);
        expect(ELIZA.style.chat.length).toBeGreaterThan(0);
    });
});

describe("buildSystemPrompt", () => {
    test("emits the character's system prompt when no calibration is present", () => {
        const prompt = buildSystemPrompt(null);
        expect(prompt).toBe(ELIZA.system);
        expect(prompt).not.toContain("<calibration>");
    });

    test("appends the calibration block when present", () => {
        const prompt = buildSystemPrompt(CALIBRATION_FIXTURE);
        const personaIdx = prompt.indexOf("operating system");
        const calibrationIdx = prompt.indexOf("<calibration>");
        expect(personaIdx).toBeGreaterThanOrEqual(0);
        expect(calibrationIdx).toBeGreaterThan(personaIdx);
    });

    test("renders all five calibration fields with stable keys", () => {
        const prompt = buildSystemPrompt(CALIBRATION_FIXTURE);
        expect(prompt).toContain("name: Charlie");
        expect(prompt).toContain("work_focus: writing code, mostly Rust and TypeScript");
        expect(prompt).toContain("multitasking: single-task");
        expect(prompt).toContain("chronotype: morning");
        expect(prompt).toContain("error_communication: transparent");
        expect(prompt).toContain("</calibration>");
    });
});
