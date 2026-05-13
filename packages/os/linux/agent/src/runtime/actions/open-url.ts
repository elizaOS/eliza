// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * OPEN_URL — a system-level affordance Eliza uses to pop a Chromium window
 * on the user's local display.
 *
 * The flow is intentionally one-shot:
 *
 *   user says "open https://..."  →  Eliza spawns a floating Chromium
 *   window on the user's local display  →  user does whatever (OAuth,
 *   captcha, watch a video)  →  user closes the window or Eliza closes it
 *   programmatically when the back-end work (e.g. OAuth completion) is
 *   detected.
 *
 * This is the same primitive that LOGIN_CLAUDE / LOGIN_CODEX call to land
 * the OAuth device-code page directly on the user's machine instead of
 * forcing them to copy a URL to a phone.
 *
 * Why floating, not fullscreen?
 *   - The chat box IS the desktop — fullscreening the browser hides it
 *     and the user thinks Eliza froze. A tagged floating window lets sway
 *     place the OAuth page on top of the chat without obscuring it, and
 *     when it closes the user is back in Eliza without a transition.
 *   - Detached: Eliza's chat loop must keep responding while the user is
 *     interacting with the popped window.
 *
 * Why Wayland-forced + GPU-disabled?
 *   - Sway is Wayland-only. Without `--ozone-platform=wayland` chromium
 *     happily picks the X11/XWayland path, grabs focus, and then fails to
 *     allocate a surface — the user sees the chat lose focus but the
 *     browser never paints (the "invisible blocker" symptom).
 *   - `--disable-gpu`: QEMU virtio-vga has no real GPU; software rendering
 *     is plenty for an OAuth page and avoids GPU-init crashes.
 *
 * Why two binary names?
 *   - Debian's chromium package installs `chromium` (the live ISO).
 *   - Ubuntu's snap installs `chromium-browser`. Dev machines vary.
 *
 * Why optional bwrap?
 *   - PLAN line 360: OAuth WebView is sandboxed. bwrap is the future
 *     hardening seam — present today on the live ISO, often absent on dev
 *     machines. We use it when available and fall through cleanly when
 *     not. We can tighten the bwrap profile in a later pass.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Action, IAgentRuntime, Memory } from "@elizaos/core";

/** Extracts the first URL from a free-text message. Stops at whitespace or
 * punctuation that's never valid mid-URL — keeps query strings intact. */
const URL_RE = /(https?:\/\/[^\s)>'"\\]+)/;

/**
 * Module-level registry of spawned browser windows keyed by URL. Other
 * actions (notably LOGIN_CLAUDE) call `closeUrl(url)` to kill the window
 * once the back-end work is done. Multiple opens of the same URL replace
 * the entry — we always track the latest spawn.
 */
const OPEN_WINDOWS = new Map<string, ChildProcess>();

/** Binary names probed in order. First hit wins. */
const CHROMIUM_BINARIES = ["chromium", "chromium-browser"] as const;

/** Resolved binary cache so we don't re-probe every call. Refreshed when
 * the cached path no longer resolves (e.g. the user upgraded chromium and
 * the symlink shifted). */
let cachedBinary: string | null = null;

function findChromium(): string | null {
    if (cachedBinary !== null && existsSync(cachedBinary)) return cachedBinary;
    for (const name of CHROMIUM_BINARIES) {
        // Absolute path probe first — the live ISO installs at /usr/bin.
        for (const prefix of ["/usr/bin/", "/usr/local/bin/"]) {
            const abs = `${prefix}${name}`;
            if (existsSync(abs)) {
                cachedBinary = abs;
                return abs;
            }
        }
        // Fall through to PATH lookup. `spawn` will resolve at exec time;
        // we return the bare name and trust it.
    }
    // PATH fallback — we can't existsSync without a directory, so return
    // the first name and let spawn ENOENT if absent. The caller probes via
    // `child.on("error")` and surfaces a friendly message.
    cachedBinary = null;
    return null;
}

const BWRAP_PATH = "/usr/bin/bwrap";

function bwrapAvailable(): boolean {
    return existsSync(BWRAP_PATH);
}

/**
 * Build the chromium argv for a tagged floating window in app/PWA mode.
 *
 * `--app=URL` collapses chromium into a chrome-less webview: no tab bar,
 * no URL bar, no menu — just the page. Same surface a PWA gets when
 * installed. Critical for the OAuth flow because the user shouldn't see
 * tabs/bookmarks/settings just to click "verify you are human" and sign
 * in.
 *
 * `--use-gl=swiftshader` enables software GL — chromium under
 * `--ozone-platform=wayland` requires *some* GL backend to allocate the
 * window surface, but the QEMU virtio-vga lacks a real GPU. swiftshader
 * is in-process software rasterization that's fast enough for an OAuth
 * page (and importantly: produces opaque pixels, fixing the "Eliza chat
 * leaking through" rendering glitch we saw with `--disable-gpu`).
 *
 * The `--class` flag maps to Wayland's `app_id` under recent chromium; sway
 * matches on it via the `for_window [app_id="^usbeliza\.browser\..*"]` rule
 * to float + center + size the window so the chat behind stays visible.
 * Chromium 148+ ignores `--class` for the Wayland app_id (reports null);
 * the `[class="Chromium"]` fallback in sway/config catches that case.
 */
function chromiumArgs(url: string, appIdSuffix: string = "window"): string[] {
    return [
        `--app=${url}`,
        "--ozone-platform=wayland",
        "--enable-features=UseOzonePlatform",
        "--use-gl=swiftshader",
        "--window-size=1280,720",
        `--class=usbeliza.browser.${appIdSuffix}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-crash-restore-bubble",
    ];
}

/**
 * Build the bwrap argv that wraps a chromium invocation. We keep the
 * sandbox profile permissive on purpose — chromium has its own sandbox
 * inside; bwrap here is the outer ring that limits filesystem visibility
 * to the user's session bits chromium genuinely needs (HOME, /tmp, /run/user).
 * Tightening is a follow-up; this is the seam.
 */
function bwrapArgs(chromiumPath: string, url: string, appIdSuffix: string = "window"): string[] {
    const home = process.env["HOME"] ?? "/tmp";
    const xdg = process.env["XDG_RUNTIME_DIR"] ?? "/run/user/1000";
    return [
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind", "/lib64", "/lib64",
        "--ro-bind", "/etc", "/etc",
        "--proc", "/proc",
        "--dev", "/dev",
        "--bind", home, home,
        "--bind", "/tmp", "/tmp",
        "--bind", xdg, xdg,
        "--unshare-pid",
        "--die-with-parent",
        "--share-net",
        chromiumPath,
        ...chromiumArgs(url, appIdSuffix),
    ];
}

export interface SpawnOptions {
    /** Tests inject a fake binary resolver. */
    readonly findBinary?: () => string | null;
    /** Tests inject a fake bwrap probe. */
    readonly hasBwrap?: () => boolean;
    /** Tests inject a fake spawn — same shape as node:child_process.spawn. */
    readonly spawnFn?: (cmd: string, args: readonly string[]) => ChildProcess;
    /**
     * Suffix appended to the window's `app_id` (e.g. "oauth-claude"). Sway
     * matches `usbeliza.browser.<suffix>` to apply the floating/center/size
     * rule. Defaults to "window" for ad-hoc browsing — distinct suffixes
     * let LOGIN_CLAUDE / LOGIN_CODEX tag their OAuth windows so a future
     * layout pass can place them differently per-provider.
     */
    readonly appIdSuffix?: string;
}

export interface SpawnResult {
    readonly status: "spawned" | "no-binary";
    readonly pid?: number | undefined;
}

/**
 * Programmatic entry point. Spawns a tagged floating Chromium window
 * pointed at `url` and registers the process so `closeUrl(url)` can kill
 * it later. Returns "no-binary" if chromium isn't present (dev machines).
 */
export function openUrl(url: string, opts: SpawnOptions = {}): SpawnResult {
    const findBin = opts.findBinary ?? findChromium;
    const hasBwrapFn = opts.hasBwrap ?? bwrapAvailable;
    const spawnFn = opts.spawnFn ?? ((cmd, args) =>
        spawn(cmd, [...args], { detached: true, stdio: "ignore" }));

    const chromium = findBin();
    if (chromium === null) return { status: "no-binary" };

    const appIdSuffix = opts.appIdSuffix ?? "window";
    let cmd: string;
    let args: string[];
    if (hasBwrapFn()) {
        cmd = BWRAP_PATH;
        args = bwrapArgs(chromium, url, appIdSuffix);
    } else {
        cmd = chromium;
        args = chromiumArgs(url, appIdSuffix);
    }

    const child = spawnFn(cmd, args);
    // Detach so child survives if Eliza restarts and so wait() doesn't
    // block us on shutdown. The kill path uses `child.kill` directly.
    try {
        child.unref?.();
    } catch {
        // Some test stubs return objects without unref; harmless.
    }
    // Don't crash the agent if chromium dies / never starts.
    child.on?.("error", () => {});
    OPEN_WINDOWS.set(url, child);
    return { status: "spawned", pid: child.pid ?? undefined };
}

/**
 * Kill the Chromium window we previously opened for `url`. No-op if we
 * didn't open one (e.g. the user closed it manually). Returns true if we
 * actually signaled a process.
 */
export function closeUrl(url: string): boolean {
    const child = OPEN_WINDOWS.get(url);
    if (child === undefined) return false;
    OPEN_WINDOWS.delete(url);
    try {
        child.kill?.("SIGTERM");
    } catch {
        // Already dead — fine.
    }
    return true;
}

/** Test-only: clear the registry between tests. */
export function __clearOpenWindows(): void {
    OPEN_WINDOWS.clear();
}

/** Test-only: introspect the registry. */
export function __getOpenWindows(): ReadonlyMap<string, ChildProcess> {
    return OPEN_WINDOWS;
}

function readSpawnOptions(options: unknown): SpawnOptions {
    if (typeof options !== "object" || options === null) return {};
    const o = options as Record<string, unknown>;
    const findBinary =
        typeof o["findBinary"] === "function" ? (o["findBinary"] as () => string | null) : undefined;
    const hasBwrap =
        typeof o["hasBwrap"] === "function" ? (o["hasBwrap"] as () => boolean) : undefined;
    const spawnFn =
        typeof o["spawnFn"] === "function"
            ? (o["spawnFn"] as (cmd: string, args: readonly string[]) => ChildProcess)
            : undefined;
    const appIdSuffix =
        typeof o["appIdSuffix"] === "string" ? (o["appIdSuffix"] as string) : undefined;
    return {
        ...(findBinary !== undefined ? { findBinary } : {}),
        ...(hasBwrap !== undefined ? { hasBwrap } : {}),
        ...(spawnFn !== undefined ? { spawnFn } : {}),
        ...(appIdSuffix !== undefined ? { appIdSuffix } : {}),
    };
}

export const OPEN_URL_ACTION: Action = {
    name: "OPEN_URL",
    similes: [
        "open url",
        "open this url",
        "open in browser",
        "browse to",
        "visit",
    ],
    description:
        "Open a URL in a floating Chromium window on the local display. " +
        "Used for OAuth flows and ad-hoc browsing — chat IS the desktop, so " +
        "the browser floats above the chat (which stays visible) and the " +
        "user closes it when done.",

    validate: async (_runtime: IAgentRuntime, message: Memory) => {
        const text = typeof message.content?.text === "string" ? message.content.text : "";
        return URL_RE.test(text);
    },

    handler: async (_runtime, message, _state, options, callback) => {
        const text = typeof message.content?.text === "string" ? message.content.text : "";
        const match = URL_RE.exec(text);
        if (match === null) {
            const reply =
                "I didn't see a link in that — paste a URL starting with http:// or https:// and I'll open it.";
            if (callback) await callback({ text: reply, actions: ["OPEN_URL"] });
            return { success: false, text: reply };
        }
        const url = match[1] ?? match[0];
        const result = openUrl(url, readSpawnOptions(options));
        if (result.status === "no-binary") {
            const reply =
                "I couldn't find a browser on this machine — chromium isn't installed.";
            if (callback) await callback({ text: reply, actions: ["OPEN_URL"] });
            return { success: false, text: reply };
        }
        const reply = "Opening it now — close the window when you're done.";
        if (callback) await callback({ text: reply, actions: ["OPEN_URL"] });
        return {
            success: true,
            text: reply,
            data: { actionName: "OPEN_URL", url, pid: result.pid ?? null },
        };
    },

    examples: [
        [
            { name: "{{user}}", content: { text: "open https://anthropic.com" } },
            {
                name: "Eliza",
                content: { text: "Opening it now — close the window when you're done." },
            },
        ],
        [
            { name: "{{user}}", content: { text: "visit https://example.com" } },
            {
                name: "Eliza",
                content: { text: "Opening it now — close the window when you're done." },
            },
        ],
    ],
};
