// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Token-state markers at `~/.eliza/auth/<provider>.json`.
 *
 * The upstream CLIs (`claude`, `codex`) own their own token storage —
 * we don't move it. But spawning the CLI just to check "are we signed
 * in?" is slow (~hundreds of ms) and brittle (the CLI's `--json` flag
 * is unstable). So we also write a tiny marker file when LOGIN_CLAUDE
 * / LOGIN_CODEX confirm a fresh sign-in. Anything else in the agent —
 * status providers, the chat router, future "what providers are wired
 * up" affordances — reads the marker, not the CLI.
 *
 * The marker file is intentionally minimal:
 *
 *   {
 *     "provider": "claude",
 *     "status": "signed-in",
 *     "detectedAt": "2026-05-11T10:00:00.000Z"
 *   }
 *
 * Mode 0600. The directory itself is 0700. On the live USB the user is
 * always `eliza` (uid 1000) and `~/.eliza/` already lives on the LUKS
 * partition, so the markers travel with persistence the same way the
 * upstream tokens do.
 *
 * Sign-OUT path: `markSignedOut(provider)` overwrites the marker with
 * `status: "signed-out"` rather than deleting it. We keep `detectedAt`
 * so a "you were last signed in on X" reply is possible later. If the
 * marker file is missing, `isSignedIn` returns false — there's no third
 * state (we don't distinguish "never" from "signed out").
 */

import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";

export type AuthProvider = "claude" | "codex";

export interface AuthMarker {
    readonly provider: AuthProvider;
    readonly status: "signed-in" | "signed-out";
    /** ISO-8601 timestamp of the detection. */
    readonly detectedAt: string;
}

function authDir(): string {
    // Honor an explicit override so tests can write to a tmp dir.
    const explicit = (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun?.env?.[
        "USBELIZA_AUTH_ROOT"
    ];
    if (typeof explicit === "string" && explicit !== "") return explicit;
    const home =
        (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun?.env?.["HOME"] ??
        process.env["HOME"] ??
        "/tmp";
    return `${home}/.eliza/auth`;
}

function markerPath(provider: AuthProvider): string {
    return `${authDir()}/${provider}.json`;
}

function ensureDir(): void {
    const dir = authDir();
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
}

function writeMarker(marker: AuthMarker): void {
    ensureDir();
    const path = markerPath(marker.provider);
    // JSON.stringify with 2-space indent makes the file readable when the
    // user opens a TTY and `cat`s it — the same shape that future "tell me
    // what's signed in" affordances will read.
    writeFileSync(path, JSON.stringify(marker, null, 2) + "\n", {
        mode: 0o600,
    });
    // Some umasks would strip mode bits — force a chmod after write so the
    // file ends up 0600 even if the user's umask is permissive.
    try {
        chmodSync(path, 0o600);
    } catch {
        // Best-effort. On exotic filesystems chmod can fail; the data is
        // still on disk.
    }
}

/** Record that `provider` is signed in as of now. */
export function markSignedIn(provider: AuthProvider): void {
    writeMarker({
        provider,
        status: "signed-in",
        detectedAt: new Date().toISOString(),
    });
}

/** Record that `provider` is signed out as of now. */
export function markSignedOut(provider: AuthProvider): void {
    writeMarker({
        provider,
        status: "signed-out",
        detectedAt: new Date().toISOString(),
    });
}

/**
 * Read the marker. Returns false on any error (file missing, malformed
 * JSON, wrong status). Callers that want to distinguish "missing" from
 * "signed out" should call `readMarker` directly.
 */
export function isSignedIn(provider: AuthProvider): boolean {
    const marker = readMarker(provider);
    return marker !== null && marker.status === "signed-in";
}

/** Read the raw marker. Returns null if missing or malformed. */
export function readMarker(provider: AuthProvider): AuthMarker | null {
    const path = markerPath(provider);
    if (!existsSync(path)) return null;
    try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as Partial<AuthMarker>;
        if (parsed.provider !== provider) return null;
        if (parsed.status !== "signed-in" && parsed.status !== "signed-out") return null;
        if (typeof parsed.detectedAt !== "string") return null;
        return {
            provider,
            status: parsed.status,
            detectedAt: parsed.detectedAt,
        };
    } catch {
        return null;
    }
}

/** Test-only: expose the resolved path for assertion. */
export function __markerPathFor(provider: AuthProvider): string {
    return markerPath(provider);
}
