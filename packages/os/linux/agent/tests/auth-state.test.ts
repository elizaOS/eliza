// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Auth marker tests. We point `USBELIZA_AUTH_ROOT` at a per-test tmp
 * directory so the real `~/.eliza/auth/` is never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    rmSync,
    statSync,
} from "node:fs";
import { tmpdir } from "node:os";

import {
    isSignedIn,
    markSignedIn,
    markSignedOut,
    readMarker,
    __markerPathFor,
} from "../src/runtime/auth/state.ts";

let tmp = "";

beforeEach(() => {
    tmp = mkdtempSync(`${tmpdir()}/usbeliza-auth-`);
    Bun.env["USBELIZA_AUTH_ROOT"] = tmp;
});

afterEach(() => {
    delete Bun.env["USBELIZA_AUTH_ROOT"];
    rmSync(tmp, { recursive: true, force: true });
});

describe("markSignedIn / isSignedIn", () => {
    test("writes a marker file with mode 0600 and returns true on read", () => {
        expect(isSignedIn("claude")).toBe(false);
        markSignedIn("claude");
        expect(isSignedIn("claude")).toBe(true);
        const path = __markerPathFor("claude");
        expect(existsSync(path)).toBe(true);
        const mode = statSync(path).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    test("each provider tracks independently", () => {
        markSignedIn("claude");
        expect(isSignedIn("claude")).toBe(true);
        expect(isSignedIn("codex")).toBe(false);
        markSignedIn("codex");
        expect(isSignedIn("codex")).toBe(true);
    });

    test("marker payload is structured JSON with detectedAt timestamp", () => {
        markSignedIn("claude");
        const marker = readMarker("claude");
        expect(marker).not.toBeNull();
        expect(marker?.provider).toBe("claude");
        expect(marker?.status).toBe("signed-in");
        // ISO-8601: "2026-..." or "20..."  — just sanity-check parseability.
        expect(typeof marker?.detectedAt).toBe("string");
        expect(Number.isFinite(Date.parse(marker?.detectedAt ?? ""))).toBe(true);
    });
});

describe("markSignedOut", () => {
    test("flips isSignedIn to false without deleting the file", () => {
        markSignedIn("claude");
        expect(isSignedIn("claude")).toBe(true);
        markSignedOut("claude");
        expect(isSignedIn("claude")).toBe(false);
        // File should still exist with the new status.
        expect(existsSync(__markerPathFor("claude"))).toBe(true);
        const marker = readMarker("claude");
        expect(marker?.status).toBe("signed-out");
    });
});

describe("readMarker", () => {
    test("returns null when the file is missing", () => {
        expect(readMarker("claude")).toBeNull();
    });

    test("returns null when JSON is malformed", () => {
        markSignedIn("claude");
        const path = __markerPathFor("claude");
        Bun.write(path, "not valid json");
        // Bun.write is async — wait for the write to land.
        return Bun.file(path).text().then(() => {
            expect(readMarker("claude")).toBeNull();
        });
    });
});
