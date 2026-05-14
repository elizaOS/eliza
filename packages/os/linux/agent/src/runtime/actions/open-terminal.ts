// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * OPEN_TERMINAL — Eliza pops a terminal emulator as a floating sway window
 * when the user asks for a shell. Power-user escape hatch from the chat UI:
 * sometimes the fastest way to do a thing is to type the command yourself.
 *
 * Same lifecycle shape as OPEN_URL: detached spawn, sway picks the window
 * up via its `--class=usbeliza.terminal.*` app-id and applies the floating
 * + centered rule from /etc/sway/config. The user closes the window
 * (Ctrl+D / `exit`) when they're done — no IPC, no tracking; chat stays
 * the primary surface.
 *
 * Why three binaries?
 *   - `alacritty` is the documented default (added to the chroot package
 *     list alongside this action). GPU-accelerated, fast cold start.
 *   - `foot` is already on the live ISO for the Wayland session — graceful
 *     fallback if alacritty is missing for any reason.
 *   - `xterm` is the universal last resort for dev machines without either
 *     installed. xwayland is in the package list so it renders.
 *
 * Each emulator has its own flag for setting the Wayland app-id / X11
 * class — we pick the right one based on which binary resolved. The
 * randomized 6-char suffix lets multiple terminal windows coexist without
 * sway treating them as a single instance.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Action, IAgentRuntime, Memory } from "@elizaos/core";

/**
 * Probe order: alacritty (preferred), foot (already-installed Wayland
 * fallback), xterm (universal). First hit wins.
 */
const TERMINAL_BINARIES = [
    "/usr/bin/alacritty",
    "/usr/bin/foot",
    "/usr/bin/xterm",
] as const;

function defaultFindBinary(): string | null {
    for (const abs of TERMINAL_BINARIES) {
        if (existsSync(abs)) return abs;
    }
    return null;
}

function randomSuffix(): string {
    // 6 hex chars; sufficient to disambiguate concurrent windows without
    // pulling in crypto — `Math.random` collisions are fine for sway
    // app-id uniqueness.
    return Math.floor(Math.random() * 0xfffffff)
        .toString(16)
        .padStart(6, "0")
        .slice(0, 6);
}

/**
 * Each emulator has a different flag for tagging the window's app-id /
 * class so sway's `for_window` rule can match it.
 */
function argsForBinary(binary: string, klass: string): string[] {
    if (binary.endsWith("/alacritty")) {
        return ["--class", klass, "-e", "bash", "-l"];
    }
    if (binary.endsWith("/foot")) {
        return [`--app-id=${klass}`, "bash", "-l"];
    }
    // xterm
    return ["-class", klass, "-e", "bash", "-l"];
}

export interface SpawnOptions {
    /** Tests inject a fake binary resolver. */
    readonly findBinary?: () => string | null;
    /** Tests inject a fake spawn — same shape as node:child_process.spawn. */
    readonly spawnFn?: (cmd: string, args: readonly string[]) => ChildProcess;
}

export interface SpawnResult {
    readonly status: "spawned" | "no-binary";
    readonly pid?: number | undefined;
    readonly class?: string | undefined;
    readonly binary?: string | undefined;
}

/**
 * Programmatic entry point. Spawns a detached terminal emulator tagged
 * with a unique `usbeliza.terminal.<suffix>` class so sway floats and
 * centers it. Returns "no-binary" if no emulator is installed.
 */
export function openTerminal(opts: SpawnOptions = {}): SpawnResult {
    const findBin = opts.findBinary ?? defaultFindBinary;
    const spawnFn = opts.spawnFn ?? ((cmd, args) =>
        spawn(cmd, [...args], { detached: true, stdio: "ignore" }));

    const binary = findBin();
    if (binary === null) return { status: "no-binary" };

    const klass = `usbeliza.terminal.${randomSuffix()}`;
    const args = argsForBinary(binary, klass);
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
        class: klass,
        binary,
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
    return {
        ...(findBinary !== undefined ? { findBinary } : {}),
        ...(spawnFn !== undefined ? { spawnFn } : {}),
    };
}

export const OPEN_TERMINAL_ACTION: Action = {
    name: "OPEN_TERMINAL",
    similes: [
        "open terminal",
        "open a terminal",
        "give me a shell",
        "open shell",
        "drop me into a terminal",
        "i need a shell",
        "open a shell",
        "terminal please",
        "give me a terminal",
    ],
    description:
        "Pop a terminal emulator as a floating sway window so the user can " +
        "type shell commands directly. The chat is still the primary UI; this " +
        "is the power-user escape hatch — Eliza spawns alacritty (or foot / " +
        "xterm if alacritty isn't present), tags the window with " +
        "usbeliza.terminal.<suffix> so sway floats and centers it, and the " +
        "user closes it with Ctrl+D or `exit` when they're done.",

    validate: async (_runtime: IAgentRuntime, _message: Memory) => true,

    handler: async (_runtime, _message, _state, options, callback) => {
        const result = openTerminal(readSpawnOptions(options));
        if (result.status === "no-binary") {
            const reply =
                "I couldn't find a terminal emulator on this machine — " +
                "alacritty, foot, and xterm are all missing.";
            if (callback) await callback({ text: reply, actions: ["OPEN_TERMINAL"] });
            return { success: false, text: reply };
        }
        const reply = "Opened a terminal — Ctrl+D or `exit` when you're done.";
        if (callback) await callback({ text: reply, actions: ["OPEN_TERMINAL"] });
        return {
            success: true,
            text: reply,
            data: {
                actionName: "OPEN_TERMINAL",
                pid: result.pid ?? null,
                class: result.class ?? null,
            },
        };
    },

    examples: [
        [
            { name: "{{user}}", content: { text: "open a terminal" } },
            {
                name: "Eliza",
                content: { text: "Opened a terminal — Ctrl+D or `exit` when you're done." },
            },
        ],
        [
            { name: "{{user}}", content: { text: "give me a shell" } },
            {
                name: "Eliza",
                content: { text: "Opened a terminal — Ctrl+D or `exit` when you're done." },
            },
        ],
    ],
};
