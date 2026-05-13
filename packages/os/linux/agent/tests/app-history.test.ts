// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Tests for `app-history.ts` — the atomic-swap + rolling-history machinery
 * behind PLAN.md locked decision #16. Uses a temp dir per test so the
 * promoteVersion / rollbackTo dance is exercised against real filesystem
 * operations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    listVersions,
    promoteVersion,
    rollbackTo,
} from "../src/plugins/usbeliza-codegen/actions/app-history.ts";

let appDir = "";

beforeEach(() => {
    appDir = mkdtempSync(join(tmpdir(), "usbeliza-history-"));
});

afterEach(() => {
    rmSync(appDir, { recursive: true, force: true });
});

function seedCurrentSrc(version: number, htmlBody: string): void {
    mkdirSync(join(appDir, "src"), { recursive: true });
    writeFileSync(join(appDir, "src/index.html"), htmlBody);
    writeFileSync(
        join(appDir, "manifest.json"),
        JSON.stringify({
            schema_version: 1,
            slug: "calendar",
            title: "Calendar",
            intent: "show me my calendar",
            runtime: "webview",
            entry: "src/index.html",
            capabilities: [],
            version,
            last_built_by: "test",
            last_built_at: new Date(2026, 4, 11).toISOString(),
        }),
    );
}

function seedNextSrc(version: number, htmlBody: string): void {
    mkdirSync(join(appDir, "src.next"), { recursive: true });
    writeFileSync(join(appDir, "src.next/index.html"), htmlBody);
    writeFileSync(
        join(appDir, "manifest.next.json"),
        JSON.stringify({
            schema_version: 1,
            slug: "calendar",
            title: "Calendar",
            intent: "show me my calendar",
            runtime: "webview",
            entry: "src/index.html",
            capabilities: [],
            version,
            last_built_by: "test",
            last_built_at: new Date().toISOString(),
        }),
    );
}

describe("app-history — listVersions", () => {
    test("returns empty when .history/ doesn't exist", async () => {
        const versions = await listVersions(appDir);
        expect(versions).toEqual([]);
    });

    test("returns historical snapshots newest-first", async () => {
        for (const v of [1, 3, 2]) {
            const snapshotDir = join(appDir, ".history", `v${v}`);
            mkdirSync(join(snapshotDir, "src"), { recursive: true });
            writeFileSync(join(snapshotDir, "src/index.html"), `v${v}`);
            writeFileSync(
                join(snapshotDir, "manifest.json"),
                JSON.stringify({
                    version: v,
                    last_built_at: `2026-05-${10 + v}T00:00:00Z`,
                    last_built_by: `claude-code-${v}`,
                }),
            );
        }
        const versions = await listVersions(appDir);
        expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
        expect(versions[0]?.lastBuiltBy).toBe("claude-code-3");
    });

    test("ignores non-v* directories under .history/", async () => {
        mkdirSync(join(appDir, ".history", "v1", "src"), { recursive: true });
        mkdirSync(join(appDir, ".history", "scratch"), { recursive: true });
        mkdirSync(join(appDir, ".history", "broken-name"), { recursive: true });
        const versions = await listVersions(appDir);
        expect(versions.map((v) => v.version)).toEqual([1]);
    });
});

describe("app-history — promoteVersion", () => {
    test("first build: promotes src.next/ to src/ with no rotation", async () => {
        seedNextSrc(1, "<h1>v1</h1>");
        await promoteVersion(appDir, 0);
        expect(existsSync(join(appDir, "src/index.html"))).toBe(true);
        expect(existsSync(join(appDir, "src.next"))).toBe(false);
        expect(existsSync(join(appDir, ".history"))).toBe(false);
        expect(readFileSync(join(appDir, "src/index.html"), "utf8")).toBe("<h1>v1</h1>");
    });

    test("subsequent build: rotates old src into .history/v<N>/", async () => {
        seedCurrentSrc(1, "<h1>v1</h1>");
        seedNextSrc(2, "<h1>v2</h1>");
        await promoteVersion(appDir, 1);
        expect(readFileSync(join(appDir, "src/index.html"), "utf8")).toBe("<h1>v2</h1>");
        expect(readFileSync(join(appDir, ".history/v1/src/index.html"), "utf8")).toBe(
            "<h1>v1</h1>",
        );
        const historicalManifest = JSON.parse(
            readFileSync(join(appDir, ".history/v1/manifest.json"), "utf8"),
        ) as { version: number };
        expect(historicalManifest.version).toBe(1);
    });

    test("prunes oldest when history grows past 5 entries", async () => {
        // Seed an existing app + 5 historical versions
        seedCurrentSrc(6, "<h1>current v6</h1>");
        for (let v = 1; v <= 5; v++) {
            const snapshotDir = join(appDir, ".history", `v${v}`);
            mkdirSync(join(snapshotDir, "src"), { recursive: true });
            writeFileSync(join(snapshotDir, "src/index.html"), `<h1>v${v}</h1>`);
            writeFileSync(
                join(snapshotDir, "manifest.json"),
                JSON.stringify({ version: v }),
            );
        }
        // Build v7 — promoting should rotate v6 into history and prune v1
        seedNextSrc(7, "<h1>v7</h1>");
        await promoteVersion(appDir, 6);

        const versions = await listVersions(appDir);
        // After pruning, .history holds at most 5 entries
        expect(versions.length).toBeLessThanOrEqual(5);
        // v1 is the oldest and should be gone
        expect(versions.map((v) => v.version)).not.toContain(1);
        // v6 was the most-recent-before-this-build and should still be there
        expect(versions.map((v) => v.version)).toContain(6);
    });
});

describe("app-history — rollbackTo", () => {
    test("restores a historical version into src/", async () => {
        // Seed current v3 + historical v1, v2
        seedCurrentSrc(3, "<h1>v3</h1>");
        for (const v of [1, 2]) {
            const snapshotDir = join(appDir, ".history", `v${v}`);
            mkdirSync(join(snapshotDir, "src"), { recursive: true });
            writeFileSync(join(snapshotDir, "src/index.html"), `<h1>v${v}</h1>`);
            writeFileSync(
                join(snapshotDir, "manifest.json"),
                JSON.stringify({ version: v }),
            );
        }

        await rollbackTo(appDir, 1);

        // v1 now lives in src/
        expect(readFileSync(join(appDir, "src/index.html"), "utf8")).toBe("<h1>v1</h1>");
        // v3 was archived under .history (rotated as the new historical entry)
        const versions = await listVersions(appDir);
        expect(versions.map((v) => v.version)).toContain(3);
        // The v1 history slot is gone (it's been promoted out)
        expect(versions.map((v) => v.version)).not.toContain(1);
    });

    test("throws on missing target version", async () => {
        seedCurrentSrc(1, "<h1>v1</h1>");
        await expect(rollbackTo(appDir, 99)).rejects.toThrow();
    });
});
