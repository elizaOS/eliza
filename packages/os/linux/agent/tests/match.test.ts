// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Action-selection tests.
 *
 * Phase 0 used a regex front-end in `src/intent.ts`; that file is gone.
 * Selection now flows through `runtime/match.ts` which ranks the same
 * @elizaos/core Actions' `similes` against the user message — no regex.
 * This test pins the natural-language behavior (slug extraction +
 * verb-leading wins) so a refactor of `match.ts` doesn't silently break
 * the "build me a calendar" path.
 */

import { describe, expect, test } from "bun:test";

import { USBELIZA_ACTIONS } from "../src/runtime/plugin.ts";
import { extractSlot, matchAction, slugify } from "../src/runtime/match.ts";

const VERBS_BUILD = ["build", "make", "create", "generate", "write", "draw"];
const VERBS_OPEN = ["open", "launch", "show", "run"];

describe("slugify", () => {
    test("collapses whitespace and lowercases", () => {
        expect(slugify("Calendar")).toBe("calendar");
        expect(slugify("Text Editor")).toBe("text-editor");
        expect(slugify("My Notes")).toBe("my-notes");
    });

    test("strips characters outside [a-z0-9-]", () => {
        expect(slugify("Cale!nd@ar?")).toBe("calendar");
        expect(slugify("a/b/c")).toBe("abc");
    });

    test("trims leading/trailing dashes", () => {
        expect(slugify("--foo--")).toBe("foo");
    });
});

describe("extractSlot — build verbs", () => {
    test("strips verb + article + me", () => {
        expect(extractSlot("build me a calendar", VERBS_BUILD)).toBe("calendar");
        expect(extractSlot("build a calendar", VERBS_BUILD)).toBe("calendar");
        expect(extractSlot("build calendar", VERBS_BUILD)).toBe("calendar");
        expect(extractSlot("make me a notes app", VERBS_BUILD)).toBe("notes");
        expect(extractSlot("create a clock", VERBS_BUILD)).toBe("clock");
        expect(extractSlot("generate a calendar", VERBS_BUILD)).toBe("calendar");
    });

    test("longest article first — 'an ide' stays as ide, not n ide", () => {
        // The historical regex bug: matching `a` before `an` ate just `a`,
        // leaving "n ide". The token-based extractor's article list is
        // ["an", "a", "my", "the"] in that order, so `an` wins.
        expect(extractSlot("build me an ide", VERBS_BUILD)).toBe("ide");
        expect(extractSlot("make an editor", VERBS_BUILD)).toBe("editor");
    });

    test("returns null when verb doesn't match", () => {
        expect(extractSlot("hello there", VERBS_BUILD)).toBe(null);
        expect(extractSlot("open my calendar", VERBS_BUILD)).toBe(null);
    });

    test("strips trailing 'app'/'application'", () => {
        expect(extractSlot("build me a calendar app", VERBS_BUILD)).toBe("calendar");
        expect(extractSlot("build a notes application", VERBS_BUILD)).toBe("notes");
    });
});

describe("extractSlot — open verbs", () => {
    test("'open my calendar' → 'calendar'", () => {
        expect(extractSlot("open my calendar", VERBS_OPEN)).toBe("calendar");
        expect(extractSlot("launch the notes", VERBS_OPEN)).toBe("notes");
        expect(extractSlot("show my todo", VERBS_OPEN)).toBe("todo");
    });
});

describe("matchAction — selects the right Action via similes", () => {
    test("'build me a calendar' picks BUILD_APP", () => {
        const m = matchAction("build me a calendar", USBELIZA_ACTIONS);
        expect(m).not.toBe(null);
        expect(m?.action.name).toBe("BUILD_APP");
    });

    test("'open my calendar' picks OPEN_APP (not BUILD_APP)", () => {
        const m = matchAction("open my calendar", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("OPEN_APP");
    });

    test("'list wifi' picks LIST_WIFI", () => {
        const m = matchAction("list wifi", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("LIST_WIFI");
    });

    test("'connect to wifi MyHome password hunter2' picks CONNECT_WIFI", () => {
        const m = matchAction("connect to wifi MyHome password hunter2", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("CONNECT_WIFI");
    });

    test("'am i online' picks NETWORK_STATUS", () => {
        const m = matchAction("am i online", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("NETWORK_STATUS");
    });

    test("'list models' picks LIST_MODELS", () => {
        const m = matchAction("list models", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("LIST_MODELS");
    });

    test("'set up persistence' picks SETUP_PERSISTENCE", () => {
        const m = matchAction("set up persistence", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("SETUP_PERSISTENCE");
    });

    test("'help' picks HELP", () => {
        const m = matchAction("help", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("HELP");
    });

    test("plain chat ('hello there') does not match any action", () => {
        const m = matchAction("hello there", USBELIZA_ACTIONS);
        expect(m).toBe(null);
    });
});
