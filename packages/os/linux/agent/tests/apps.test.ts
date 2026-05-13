// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * LIST_APPS + DELETE_APP unit tests.
 *
 * The handlers touch `~/.eliza/apps` via `appsRoot()`. We point that at a
 * temp dir via `USBELIZA_APPS_ROOT` so the tests don't depend on (or
 * pollute) the host's real home.
 *
 * Selection coverage lives below alongside the handler tests — both
 * "list my apps" and "delete my calendar" must route through `matchAction`
 * to the right Action so the dispatcher actually fires them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IAgentRuntime, Memory } from "@elizaos/core";

import {
    DELETE_APP_ACTION,
    LIST_APPS_ACTION,
    formatRelativeTime,
    listInstalledApps,
} from "../src/runtime/actions/apps.ts";
import { matchAction } from "../src/runtime/match.ts";
import { USBELIZA_ACTIONS } from "../src/runtime/plugin.ts";

const previousAppsRoot = process.env.USBELIZA_APPS_ROOT;
let tempRoot = "";

beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "usbeliza-apps-"));
    process.env.USBELIZA_APPS_ROOT = tempRoot;
});

afterEach(() => {
    if (tempRoot !== "") {
        rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = "";
    }
    if (previousAppsRoot === undefined) {
        delete process.env.USBELIZA_APPS_ROOT;
    } else {
        process.env.USBELIZA_APPS_ROOT = previousAppsRoot;
    }
});

function writeApp(slug: string, manifest: Record<string, unknown> | null): string {
    const dir = join(tempRoot, slug);
    mkdirSync(dir, { recursive: true });
    if (manifest !== null) {
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    }
    return dir;
}

function memoryOf(text: string): Memory {
    // Cast through unknown — handlers only read content.text. The runtime
    // shape requires UUIDs and createdAt; we don't exercise those.
    return { content: { text } } as unknown as Memory;
}

const fakeRuntime = {} as unknown as IAgentRuntime;

describe("formatRelativeTime", () => {
    const now = new Date("2026-05-11T12:00:00Z");

    test("under 1 hour → minutes", () => {
        expect(formatRelativeTime(new Date("2026-05-11T11:30:00Z"), now)).toBe("30 min ago");
        expect(formatRelativeTime(new Date("2026-05-11T11:59:00Z"), now)).toBe("1 min ago");
    });

    test("under 1 day → hours", () => {
        expect(formatRelativeTime(new Date("2026-05-11T10:00:00Z"), now)).toBe("2 hours ago");
        expect(formatRelativeTime(new Date("2026-05-11T11:00:00Z"), now)).toBe("1 hour ago");
    });

    test("under 7 days → days", () => {
        expect(formatRelativeTime(new Date("2026-05-10T12:00:00Z"), now)).toBe("1 day ago");
        expect(formatRelativeTime(new Date("2026-05-08T12:00:00Z"), now)).toBe("3 days ago");
    });

    test("older than 7 days → absolute YYYY-MM-DD", () => {
        expect(formatRelativeTime(new Date("2026-04-01T12:00:00Z"), now)).toBe("on 2026-04-01");
    });

    test("future timestamps fall through to absolute (clock skew)", () => {
        expect(formatRelativeTime(new Date("2026-06-01T12:00:00Z"), now)).toBe("on 2026-06-01");
    });
});

describe("listInstalledApps", () => {
    test("returns empty array when root is missing", async () => {
        const missing = join(tempRoot, "does-not-exist");
        expect(await listInstalledApps(missing)).toEqual([]);
    });

    test("reads manifest fields and falls back to mtime", async () => {
        writeApp("calendar", {
            last_built_by: "claude",
            last_built_at: "2026-05-11T10:00:00Z",
        });
        writeApp("notes", null);

        const apps = await listInstalledApps(tempRoot);
        expect(apps).toHaveLength(2);
        const calendar = apps.find((a) => a.slug === "calendar");
        expect(calendar?.builtBy).toBe("claude");
        expect(calendar?.builtAt?.toISOString()).toBe("2026-05-11T10:00:00.000Z");
        const notes = apps.find((a) => a.slug === "notes");
        expect(notes?.builtBy).toBeNull();
        expect(notes?.builtAt).not.toBeNull();
    });

    test("ignores plain files at the root (only directories count as apps)", async () => {
        writeApp("calendar", { last_built_by: "claude" });
        writeFileSync(join(tempRoot, "stray.txt"), "not an app");
        const apps = await listInstalledApps(tempRoot);
        expect(apps).toHaveLength(1);
        expect(apps[0]?.slug).toBe("calendar");
    });

    test("survives a malformed manifest.json", async () => {
        const dir = writeApp("broken", null);
        writeFileSync(join(dir, "manifest.json"), "{ not valid json");
        const apps = await listInstalledApps(tempRoot);
        expect(apps).toHaveLength(1);
        expect(apps[0]?.slug).toBe("broken");
        expect(apps[0]?.builtBy).toBeNull();
    });
});

describe("LIST_APPS handler", () => {
    test("empty state coaches the user to build something", async () => {
        const result = await LIST_APPS_ACTION.handler(
            fakeRuntime,
            memoryOf("list my apps"),
            undefined,
            undefined,
        );
        expect(result?.success).toBe(true);
        expect(result?.text).toContain("haven't built any apps yet");
    });

    test("populated state lists each app with builder + time", async () => {
        writeApp("calendar", {
            last_built_by: "claude",
            last_built_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        });
        const result = await LIST_APPS_ACTION.handler(
            fakeRuntime,
            memoryOf("list my apps"),
            undefined,
            undefined,
        );
        expect(result?.success).toBe(true);
        expect(result?.text).toContain("You have 1 app");
        expect(result?.text).toContain("calendar");
        expect(result?.text).toContain("via claude");
    });

    test("fires callback with the same text it returns", async () => {
        writeApp("notes", { last_built_by: "claude" });
        let captured = "";
        await LIST_APPS_ACTION.handler(
            fakeRuntime,
            memoryOf("list my apps"),
            undefined,
            undefined,
            async (response) => {
                if (typeof response.text === "string") captured = response.text;
                return [];
            },
        );
        expect(captured).toContain("notes");
    });
});

describe("DELETE_APP handler", () => {
    test("validate rejects messages without a delete verb", async () => {
        const ok = await DELETE_APP_ACTION.validate(fakeRuntime, memoryOf("hello there"));
        expect(ok).toBe(false);
    });

    test("validate accepts 'delete my calendar'", async () => {
        const ok = await DELETE_APP_ACTION.validate(fakeRuntime, memoryOf("delete my calendar"));
        expect(ok).toBe(true);
    });

    test("removes the directory and confirms", async () => {
        const dir = writeApp("calendar", { last_built_by: "claude" });
        expect(existsSync(dir)).toBe(true);
        const result = await DELETE_APP_ACTION.handler(
            fakeRuntime,
            memoryOf("delete my calendar"),
            undefined,
            undefined,
        );
        expect(result?.success).toBe(true);
        expect(result?.text).toBe("Removed your calendar.");
        expect(existsSync(dir)).toBe(false);
    });

    test("missing slug → friendly hint, no error", async () => {
        const result = await DELETE_APP_ACTION.handler(
            fakeRuntime,
            memoryOf("delete my calendar"),
            undefined,
            undefined,
        );
        expect(result?.success).toBe(false);
        expect(result?.text).toContain("I don't see a 'calendar'");
        expect(result?.text).toContain("list my apps");
    });
});

describe("Action selection (similes)", () => {
    test("'list my apps' picks LIST_APPS", () => {
        const m = matchAction("list my apps", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("LIST_APPS");
    });

    test("'show my apps' picks LIST_APPS", () => {
        const m = matchAction("show my apps", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("LIST_APPS");
    });

    test("'delete my calendar' picks DELETE_APP, not BUILD_APP", () => {
        const m = matchAction("delete my calendar", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("DELETE_APP");
    });

    test("'remove my notes' picks DELETE_APP", () => {
        const m = matchAction("remove my notes", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("DELETE_APP");
    });
});
