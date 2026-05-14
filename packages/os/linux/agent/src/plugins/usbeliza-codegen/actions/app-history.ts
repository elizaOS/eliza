// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * App version history + atomic swap (PLAN.md locked decision #16).
 *
 * When `generateApp` produces a new version of an existing app we MUST:
 *  1. Write the new files to `<appDir>/src.next/` first (not over `src/`).
 *  2. Validate the smoke-launch in a hidden sandbox (caller's job).
 *  3. Atomically rotate: `src` -> `.history/v<old>/`, `src.next` -> `src`.
 *  4. Keep at most 5 historical versions under `.history/`; prune oldest.
 *  5. `data/` is never touched — user data survives across rebuilds.
 *
 * On generation failure after MAX_AUTO_RETRIES retries the caller can call
 * `listVersions(appDir)` to surface a version-picker UI line in chat
 * ("I couldn't build this one — want to roll back to the version from
 * Thursday?").
 */

import {
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const HISTORY_LIMIT = 5;

export interface VersionSnapshot {
    /** Numeric version pulled from manifest.json (or the directory name if missing). */
    version: number;
    /** Filesystem path to the historical src/ tree. */
    srcPath: string;
    /** Built-at timestamp from manifest.json, ISO 8601, or null if unreadable. */
    builtAt: string | null;
    /** Builder identifier (e.g., `claude-code-2.1.138`). */
    lastBuiltBy: string | null;
}

/**
 * List historical versions of an app under `<appDir>/.history/`, sorted
 * newest first. Returns an empty array if the dir doesn't exist or has
 * no `v*` subdirectories.
 */
export async function listVersions(appDir: string): Promise<VersionSnapshot[]> {
    const historyDir = join(appDir, ".history");
    let entries: string[];
    try {
        entries = await readdir(historyDir);
    } catch {
        return [];
    }
    const versions: VersionSnapshot[] = [];
    for (const name of entries) {
        if (!/^v\d+$/.test(name)) continue;
        const versionNum = Number.parseInt(name.slice(1), 10);
        const snapshotDir = join(historyDir, name);
        const manifestPath = join(snapshotDir, "manifest.json");
        let builtAt: string | null = null;
        let lastBuiltBy: string | null = null;
        try {
            const raw = await readFile(manifestPath, "utf8");
            const parsed = JSON.parse(raw) as {
                last_built_at?: string;
                last_built_by?: string;
            };
            builtAt = parsed.last_built_at ?? null;
            lastBuiltBy = parsed.last_built_by ?? null;
        } catch {
            // historical manifest missing or malformed — keep the slot but
            // leave the timestamp fields null
        }
        versions.push({
            version: versionNum,
            srcPath: join(snapshotDir, "src"),
            builtAt,
            lastBuiltBy,
        });
    }
    versions.sort((a, b) => b.version - a.version);
    return versions;
}

/**
 * Atomic-swap the current `<appDir>/src` aside into `.history/v<old>/`
 * and promote `<appDir>/src.next` into `src`. Same for `manifest.json`
 * (the historical version's manifest moves with its src so users
 * picking from history get a coherent snapshot).
 *
 * Caller is responsible for first writing the new files to `src.next/`
 * and `manifest.next.json`. This helper just does the rename dance.
 *
 * Pruning: after the rotation, history beyond `HISTORY_LIMIT` (oldest
 * `v*` directories first) is removed.
 *
 * If `<appDir>/src` doesn't exist yet (first build), there's nothing to
 * rotate; we only promote `src.next` -> `src`.
 */
export async function promoteVersion(appDir: string, oldVersion: number): Promise<void> {
    const srcDir = join(appDir, "src");
    const srcNextDir = join(appDir, "src.next");
    const manifestPath = join(appDir, "manifest.json");
    const manifestNextPath = join(appDir, "manifest.next.json");

    let hasCurrent = false;
    try {
        await stat(srcDir);
        hasCurrent = true;
    } catch {
        // first build — nothing to rotate
    }

    if (hasCurrent) {
        const historyDir = join(appDir, ".history", `v${oldVersion}`);
        // Need historyDir itself to exist before we can rename a child
        // src/ into it. mkdir on the parent only would leave us with
        // .history/ but no .history/v6/, and rename(src, .history/v6/src)
        // would ENOENT.
        await mkdir(historyDir, { recursive: true });
        await rename(srcDir, join(historyDir, "src"));
        try {
            await rename(manifestPath, join(historyDir, "manifest.json"));
        } catch {
            // missing manifest is unusual but not fatal — the snapshot still has src
        }
    }

    await rename(srcNextDir, srcDir);
    try {
        await rename(manifestNextPath, manifestPath);
    } catch {
        // manifest.next missing means the caller wrote it straight to
        // manifest.json — fine, accept either pattern
    }

    await pruneHistory(appDir);
}

/**
 * Remove `.history/v*` directories beyond HISTORY_LIMIT, oldest first.
 * Idempotent: safe to call even when history is empty or under limit.
 */
async function pruneHistory(appDir: string): Promise<void> {
    const versions = await listVersions(appDir);
    if (versions.length <= HISTORY_LIMIT) return;
    const toPrune = versions.slice(HISTORY_LIMIT); // already sorted newest-first
    for (const v of toPrune) {
        const snapshotDir = dirname(v.srcPath);
        await rm(snapshotDir, { recursive: true, force: true });
    }
}

/**
 * Roll the app back to a specific historical version. Used by the
 * version-picker chat flow when generation keeps failing. The current
 * src/manifest pair becomes a new history entry, and the chosen version
 * is promoted in its place — so rolling forward again is possible.
 *
 * Throws if `targetVersion` doesn't exist under `.history/`.
 */
export async function rollbackTo(appDir: string, targetVersion: number): Promise<void> {
    const historyDir = join(appDir, ".history", `v${targetVersion}`);
    try {
        await stat(historyDir);
    } catch {
        throw new Error(`no historical version v${targetVersion} under ${appDir}`);
    }
    const targetSrc = join(historyDir, "src");
    const targetManifest = join(historyDir, "manifest.json");

    // Move target -> src.next (then promote via the normal path so we
    // get pruning + the current version stashed into history for free).
    await rename(targetSrc, join(appDir, "src.next"));
    try {
        await rename(targetManifest, join(appDir, "manifest.next.json"));
    } catch {
        // historical entry missing its manifest — accept and proceed
    }
    // Remove the now-empty historical dir so we don't have a phantom
    // version slot.
    await rm(historyDir, { recursive: true, force: true });

    // Read the current manifest to pick the version number we're
    // archiving the current src under. Default to a high number so the
    // rotation never collides.
    const currentManifestPath = join(appDir, "manifest.json");
    let currentVersion = 0;
    try {
        const raw = await readFile(currentManifestPath, "utf8");
        const parsed = JSON.parse(raw) as { version?: number };
        if (typeof parsed.version === "number") currentVersion = parsed.version;
    } catch {
        // no current manifest — first-time scenario, leave 0
    }

    await promoteVersion(appDir, currentVersion);
}
