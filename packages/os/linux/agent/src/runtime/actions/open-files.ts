// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * OPEN_FILES — Eliza pops a GTK file manager as a floating sway window
 * when the user asks for "their files" / "a file manager". Sister
 * action to OPEN_TERMINAL: an escape hatch from the chat UI for the
 * moments when point-and-click is genuinely faster than describing the
 * file you want to the agent.
 *
 * Same lifecycle shape as OPEN_TERMINAL / OPEN_URL: detached spawn, sway
 * picks the window up by its app-id (Thunar / pcmanfm / Nautilus) and
 * applies the floating + centered rule from /etc/sway/config. The user
 * closes the window when they're done — no IPC, no tracking; chat stays
 * the primary surface.
 *
 * Why three binaries?
 *   - `thunar` is the documented default (added to the chroot package
 *     list alongside this action). Lightweight, fast, GTK3.
 *   - `pcmanfm` is the LXDE-flavored fallback — even smaller, ships on
 *     many minimal Debian images already.
 *   - `nautilus` is the universal last resort for dev machines that
 *     already have a GNOME-flavored manager installed.
 *
 * None of the three binaries accept an app-id override flag the way the
 * terminal emulators do; they always advertise their built-in app_id
 * (`Thunar`, `pcmanfm`, `org.gnome.Nautilus`). The sway `for_window`
 * rules match those defaults directly — no class tagging needed here.
 * We open the user's $HOME by default so the window lands somewhere
 * useful instead of the file-manager's cached last directory.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Action, IAgentRuntime, Memory } from "@elizaos/core";

/**
 * Probe order: thunar (preferred), pcmanfm (lightweight fallback),
 * nautilus (universal). First hit wins.
 */
const FILE_MANAGER_BINARIES = [
    "/usr/bin/thunar",
    "/usr/bin/pcmanfm",
    "/usr/bin/nautilus",
] as const;

function defaultFindBinary(): string | null {
    for (const abs of FILE_MANAGER_BINARIES) {
        if (existsSync(abs)) return abs;
    }
    return null;
}

/**
 * Each manager takes the directory-to-open as a positional argument with
 * subtly different conventions. thunar/pcmanfm accept plain paths;
 * nautilus prefers a URI but happily resolves a path too.
 */
function argsForBinary(binary: string, target: string): string[] {
    if (binary.endsWith("/nautilus")) {
        return ["--new-window", target];
    }
    // thunar + pcmanfm: just the path.
    return [target];
}

export interface SpawnOptions {
    /** Tests inject a fake binary resolver. */
    readonly findBinary?: () => string | null;
    /** Tests inject a fake spawn — same shape as node:child_process.spawn. */
    readonly spawnFn?: (cmd: string, args: readonly string[]) => ChildProcess;
    /** Path to open. Defaults to the current user's $HOME. */
    readonly path?: string;
}

export interface SpawnResult {
    readonly status: "spawned" | "no-binary";
    readonly pid?: number | undefined;
    readonly binary?: string | undefined;
    readonly path?: string | undefined;
}

/**
 * Programmatic entry point. Spawns a detached file manager opened to
 * the requested path (defaults to $HOME). Returns "no-binary" when no
 * manager is installed.
 */
export function openFiles(opts: SpawnOptions = {}): SpawnResult {
    const findBin = opts.findBinary ?? defaultFindBinary;
    const spawnFn = opts.spawnFn ?? ((cmd, args) =>
        spawn(cmd, [...args], { detached: true, stdio: "ignore" }));
    const target = opts.path ?? homedir();

    const binary = findBin();
    if (binary === null) return { status: "no-binary" };

    const args = argsForBinary(binary, target);
    const child = spawnFn(binary, args);
    try {
        child.unref?.();
    } catch {
        // Some test stubs return objects without unref; harmless.
    }
    child.on?.("error", () => {});
    return {
        status: "spawned",
        pid: child.pid ?? undefined,
        binary,
        path: target,
    };
}

function readSpawnOptions(options: unknown): SpawnOptions {
    if (typeof options !== "object" || options === null) return {};
    const o = options as Record<string, unknown>;
    const findBinary =
        typeof o["findBinary"] === "function" ? (o["findBinary"] as () => string | null) : undefined;
    const spawnFn =
        typeof o["spawnFn"] === "function"
            ? (o["spawnFn"] as (cmd: string, args: readonly string[]) => ChildProcess)
            : undefined;
    const path = typeof o["path"] === "string" ? (o["path"] as string) : undefined;
    return {
        ...(findBinary !== undefined ? { findBinary } : {}),
        ...(spawnFn !== undefined ? { spawnFn } : {}),
        ...(path !== undefined ? { path } : {}),
    };
}

export const OPEN_FILES_ACTION: Action = {
    name: "OPEN_FILES",
    similes: [
        "open files",
        "show my files",
        "open file manager",
        "browse files",
        "show files",
        "i need a file manager",
    ],
    description:
        "Pop a GTK file manager as a floating sway window so the user can " +
        "browse, drag, and rename files directly. The chat is still the " +
        "primary UI; this is the point-and-click escape hatch — Eliza " +
        "spawns thunar (or pcmanfm / nautilus if thunar isn't present), " +
        "opens it to the user's home directory, and sway floats + centers " +
        "it via the matching app-id rule. The user closes the window when " +
        "they're done.",

    validate: async (_runtime: IAgentRuntime, _message: Memory) => true,

    handler: async (_runtime, _message, _state, options, callback) => {
        const result = openFiles(readSpawnOptions(options));
        if (result.status === "no-binary") {
            const reply =
                "I couldn't find a file manager on this machine — " +
                "thunar, pcmanfm, and nautilus are all missing.";
            if (callback) await callback({ text: reply, actions: ["OPEN_FILES"] });
            return { success: false, text: reply };
        }
        const reply = "Opened a file manager — close the window when you're done.";
        if (callback) await callback({ text: reply, actions: ["OPEN_FILES"] });
        return {
            success: true,
            text: reply,
            data: {
                actionName: "OPEN_FILES",
                pid: result.pid ?? null,
                binary: result.binary ?? null,
            },
        };
    },

    examples: [
        [
            { name: "{{user}}", content: { text: "open my files" } },
            {
                name: "Eliza",
                content: { text: "Opened a file manager — close the window when you're done." },
            },
        ],
        [
            { name: "{{user}}", content: { text: "show me a file manager" } },
            {
                name: "Eliza",
                content: { text: "Opened a file manager — close the window when you're done." },
            },
        ],
    ],
};
