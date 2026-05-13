// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * LIST_APPS + DELETE_APP — manage the user's previously built apps from chat.
 *
 * These are the "what do I have / clean up" counterparts to BUILD_APP and
 * OPEN_APP. They operate on `~/.eliza/apps/<slug>/` (path from
 * `paths.ts::appsRoot()`). Each app directory may contain a `manifest.json`
 * written by the codegen pipeline; LIST_APPS reads them best-effort and
 * shows a human summary, DELETE_APP rm-rf's a single slug.
 *
 * Same Action shape as the other runtime actions: similes drive selection
 * via `runtime/match.ts`, the handler is async, returns `{ success, text,
 * data? }`. No regex front-end.
 */

import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Action, IAgentRuntime, Memory } from "@elizaos/core";

import { extractSlot, slugify } from "../match.ts";
import { appsRoot } from "../paths.ts";

interface AppEntry {
    /** Directory slug — also what the user types ("calendar"). */
    slug: string;
    /** Best-effort builder field from manifest.json ("claude", "codex", "stub"). */
    builtBy: string | null;
    /** Manifest `last_built_at` if present, otherwise the dir's mtime. */
    builtAt: Date | null;
}

interface ManifestLike {
    last_built_by?: unknown;
    last_built_at?: unknown;
}

/**
 * Format a Date relative to "now". The buckets match the spec:
 *   < 1h → "X min ago"
 *   < 1d → "X hours ago"
 *   < 7d → "X days ago"
 *   else → ISO-style absolute date ("on 2026-05-01")
 *
 * `now` is injected for testability — production callers pass nothing.
 */
export function formatRelativeTime(then: Date, now: Date = new Date()): string {
    const diffMs = now.getTime() - then.getTime();
    if (diffMs < 0) {
        // Future timestamp — manifest clock skew. Fall through to absolute.
        return `on ${then.toISOString().slice(0, 10)}`;
    }
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diffMs < hour) {
        const mins = Math.max(1, Math.floor(diffMs / minute));
        return `${mins} min ago`;
    }
    if (diffMs < day) {
        const hours = Math.max(1, Math.floor(diffMs / hour));
        return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    }
    if (diffMs < 7 * day) {
        const days = Math.max(1, Math.floor(diffMs / day));
        return `${days} day${days === 1 ? "" : "s"} ago`;
    }
    return `on ${then.toISOString().slice(0, 10)}`;
}

/**
 * Read one app entry from disk. Best-effort — a missing or malformed
 * manifest doesn't poison the listing; we still surface the slug with
 * `null` builder/time so the user knows it's there.
 *
 * Exported for tests; callers should prefer {@link listInstalledApps}.
 */
export async function readAppEntry(root: string, slug: string): Promise<AppEntry | null> {
    const dir = join(root, slug);
    let dirStat: Awaited<ReturnType<typeof stat>>;
    try {
        dirStat = await stat(dir);
    } catch {
        return null;
    }
    if (!dirStat.isDirectory()) return null;

    let builtBy: string | null = null;
    let builtAt: Date | null = null;
    try {
        const raw = await readFile(join(dir, "manifest.json"), "utf8");
        const parsed = JSON.parse(raw) as ManifestLike;
        if (typeof parsed.last_built_by === "string" && parsed.last_built_by.length > 0) {
            builtBy = parsed.last_built_by;
        }
        if (typeof parsed.last_built_at === "string" && parsed.last_built_at.length > 0) {
            const d = new Date(parsed.last_built_at);
            if (!Number.isNaN(d.getTime())) builtAt = d;
        }
    } catch {
        // No manifest, unreadable, or invalid JSON — fall back to dir mtime.
    }
    if (builtAt === null) builtAt = dirStat.mtime;
    return { slug, builtBy, builtAt };
}

/**
 * Enumerate `<root>/*` as app entries, newest-first.
 */
export async function listInstalledApps(root: string): Promise<AppEntry[]> {
    let names: string[];
    try {
        names = await readdir(root);
    } catch {
        return [];
    }
    const entries: AppEntry[] = [];
    for (const name of names) {
        const entry = await readAppEntry(root, name);
        if (entry !== null) entries.push(entry);
    }
    entries.sort((a, b) => {
        const at = a.builtAt?.getTime() ?? 0;
        const bt = b.builtAt?.getTime() ?? 0;
        return bt - at;
    });
    return entries;
}

function describeApp(entry: AppEntry, now: Date): string {
    const parts: string[] = [];
    if (entry.builtAt !== null) {
        parts.push(`built ${formatRelativeTime(entry.builtAt, now)}`);
    }
    if (entry.builtBy !== null) {
        parts.push(`via ${entry.builtBy}`);
    }
    const suffix = parts.length > 0 ? ` (${parts.join(" ")})` : "";
    return `- ${entry.slug}${suffix}`;
}

const EMPTY_LIST_REPLY =
    "You haven't built any apps yet. Try 'build me a calendar' to start.";

export const LIST_APPS_ACTION: Action = {
    name: "LIST_APPS",
    similes: [
        "list my apps",
        "show my apps",
        "what apps do i have",
        "list apps",
        "my apps",
        "show built apps",
    ],
    description:
        "Show the user every app previously generated into ~/.eliza/apps, with " +
        "relative build time and the codegen backend that built it.",

    validate: async () => true,

    handler: async (_runtime, _message, _state, _options, callback) => {
        const apps = await listInstalledApps(appsRoot());
        if (apps.length === 0) {
            if (callback) await callback({ text: EMPTY_LIST_REPLY, actions: ["LIST_APPS"] });
            return { success: true, text: EMPTY_LIST_REPLY };
        }
        const now = new Date();
        const header =
            apps.length === 1
                ? "You have 1 app:"
                : `You have ${apps.length} apps:`;
        const lines = apps.map((a) => describeApp(a, now));
        const first = apps[0]?.slug ?? "calendar";
        const tail =
            apps.length > 1
                ? `Say "open my ${first}" to launch one, or "delete my ${first}" to remove.`
                : `Say "open my ${first}" to launch it, or "delete my ${first}" to remove.`;
        const text = `${header}\n${lines.join("\n")}\n${tail}`;
        if (callback) await callback({ text, actions: ["LIST_APPS"] });
        return {
            success: true,
            text,
            data: {
                actionName: "LIST_APPS",
                apps: apps.map((a) => ({
                    slug: a.slug,
                    builtBy: a.builtBy,
                    builtAt: a.builtAt?.toISOString() ?? null,
                })),
            },
        };
    },

    examples: [
        [
            { name: "{{user}}", content: { text: "list my apps" } },
            {
                name: "Eliza",
                content: {
                    text: "You have 2 apps:\n- calendar (built 2 hours ago via claude)\n- notes (built yesterday via claude)",
                },
            },
        ],
        [
            { name: "{{user}}", content: { text: "what apps do i have" } },
            {
                name: "Eliza",
                content: { text: "You haven't built any apps yet. Try 'build me a calendar' to start." },
            },
        ],
    ],
};

const DELETE_VERBS = ["delete", "remove", "uninstall"] as const;

export const DELETE_APP_ACTION: Action = {
    name: "DELETE_APP",
    similes: [
        "delete my calendar",
        "remove my calendar",
        "uninstall calendar",
        "delete app",
        "remove app",
    ],
    description:
        "Delete a previously built app from ~/.eliza/apps. Used when the user " +
        "says 'delete my <thing>', 'remove my <thing>', 'uninstall <thing>'.",

    validate: async (_runtime: IAgentRuntime, message: Memory) => {
        const text = typeof message.content?.text === "string" ? message.content.text : "";
        return extractSlot(text, DELETE_VERBS) !== null;
    },

    handler: async (_runtime, message, _state, _options, callback) => {
        const text = typeof message.content?.text === "string" ? message.content.text : "";
        const target = extractSlot(text, DELETE_VERBS);
        if (target === null) {
            return { success: false, text: "I couldn't tell what to remove." };
        }
        const slug = slugify(target);
        if (slug === "") {
            return { success: false, text: "That doesn't look like an app I can remove." };
        }

        const root = appsRoot();
        const dir = join(root, slug);
        let dirStat: Awaited<ReturnType<typeof stat>> | null = null;
        try {
            dirStat = await stat(dir);
        } catch {
            dirStat = null;
        }
        if (dirStat === null || !dirStat.isDirectory()) {
            const reply =
                `I don't see a '${target}' in your apps. ` +
                `Say "list my apps" to see what's there.`;
            if (callback) await callback({ text: reply, actions: ["DELETE_APP"] });
            return { success: false, text: reply };
        }

        try {
            await rm(dir, { recursive: true, force: true });
        } catch (err) {
            const reply = `I couldn't remove ${target}: ${(err as Error).message}.`;
            if (callback) await callback({ text: reply, actions: ["DELETE_APP"] });
            return { success: false, text: reply };
        }
        const reply = `Removed your ${target}.`;
        if (callback) await callback({ text: reply, actions: ["DELETE_APP"] });
        return {
            success: true,
            text: reply,
            data: { actionName: "DELETE_APP", slug },
        };
    },

    examples: [
        [
            { name: "{{user}}", content: { text: "delete my calendar" } },
            { name: "Eliza", content: { text: "Removed your calendar." } },
        ],
        [
            { name: "{{user}}", content: { text: "uninstall notes" } },
            { name: "Eliza", content: { text: "Removed your notes." } },
        ],
    ],
};
