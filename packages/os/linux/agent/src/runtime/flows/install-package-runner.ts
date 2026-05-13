// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Spawn + apt-cache helpers for INSTALL_PACKAGE.
 *
 * Lives in its own module so the install-package action can hand the
 * test-injected boundaries straight through to the install-package
 * flow without dragging the flow's full dependency tree into the
 * action's import graph (would create a cycle).
 */

import { spawn } from "node:child_process";

export interface AptCacheInfo {
    /** Installed-Size in KB as reported by `apt-cache show`. */
    readonly sizeKb: number;
    /** Version string from madison. Mostly diagnostic. */
    readonly version: string;
}

export type AptCacheFn = (pkg: string) => Promise<AptCacheInfo | null>;

export interface SpawnStream {
    readonly stderr: AsyncIterable<string>;
    readonly stdout: AsyncIterable<string>;
    readonly exit: Promise<number | null>;
    kill(): void;
}

export type SpawnStreamFn = (cmd: string, args: readonly string[]) => SpawnStream;

/**
 * Production apt-cache lookup. Runs `apt-cache show <pkg>` and grabs
 * the `Installed-Size:` field (KB). Returns null when the package
 * doesn't exist in any configured repo. Wrapped in try/catch — a
 * missing apt-cache binary just returns null too so the chroot-less
 * test environment still works.
 */
export const DEFAULT_APT_CACHE: AptCacheFn = async (pkg) => {
    return await new Promise<AptCacheInfo | null>((resolve) => {
        let proc: ReturnType<typeof spawn>;
        try {
            proc = spawn("apt-cache", ["show", pkg], {
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch {
            resolve(null);
            return;
        }
        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        proc.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        proc.on("error", () => resolve(null));
        proc.on("close", (code) => {
            if (code !== 0) {
                resolve(null);
                return;
            }
            const info = parseAptCacheShow(stdout);
            if (info === null && stderr.length > 0) {
                resolve(null);
                return;
            }
            resolve(info);
        });
    });
};

/**
 * Parse `apt-cache show` output. Looks for `Installed-Size:` (KB) and
 * `Version:`. Multiple stanzas (versions) may appear; we take the
 * first stanza's values.
 */
export function parseAptCacheShow(text: string): AptCacheInfo | null {
    let sizeKb: number | null = null;
    let version: string | null = null;
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (line === "") {
            if (sizeKb !== null && version !== null) break;
            continue;
        }
        const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line);
        if (m === null || m[1] === undefined || m[2] === undefined) continue;
        const key = m[1];
        const value = m[2].trim();
        if (key === "Installed-Size" && sizeKb === null) {
            const n = parseInt(value, 10);
            if (!Number.isNaN(n)) sizeKb = n;
        } else if (key === "Version" && version === null) {
            version = value;
        }
    }
    if (sizeKb === null) return null;
    return { sizeKb, version: version ?? "" };
}

/**
 * Production spawn for `apt-get install`. Streams both stdout (where
 * `Setting up <pkg>` lines appear) and stderr (where dpkg's progress
 * fd writes when `--progress-fd=2` is used). Same shape as
 * download-model's defaultSpawn.
 */
export const DEFAULT_SPAWN: SpawnStreamFn = (cmd, args) => {
    let proc: ReturnType<typeof spawn> | null = null;
    try {
        proc = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
        return {
            stderr: (async function* () {})(),
            stdout: (async function* () {})(),
            exit: Promise.resolve(null),
            kill: () => {},
        };
    }
    const child = proc;

    function streamLines(stream: NodeJS.ReadableStream | null | undefined): AsyncIterable<string> {
        if (stream === null || stream === undefined) {
            return (async function* () {})();
        }
        const queue: string[] = [];
        let buffer = "";
        let resolveWaiter: (() => void) | null = null;
        let done = false;
        stream.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            const parts = buffer.split(/[\r\n]/);
            buffer = parts.pop() ?? "";
            for (const part of parts) {
                if (part.length > 0) queue.push(part);
            }
            if (resolveWaiter !== null) {
                const r = resolveWaiter;
                resolveWaiter = null;
                r();
            }
        });
        stream.on("end", () => {
            if (buffer.length > 0) queue.push(buffer);
            done = true;
            if (resolveWaiter !== null) {
                const r = resolveWaiter;
                resolveWaiter = null;
                r();
            }
        });
        return (async function* () {
            for (;;) {
                while (queue.length > 0) {
                    const line = queue.shift();
                    if (line !== undefined) yield line;
                }
                if (done) return;
                await new Promise<void>((res) => {
                    resolveWaiter = res;
                });
            }
        })();
    }

    return {
        stdout: streamLines(child.stdout),
        stderr: streamLines(child.stderr),
        exit: new Promise<number | null>((resolve) => {
            child.on("close", (code) => resolve(typeof code === "number" ? code : null));
            child.on("error", () => resolve(null));
        }),
        kill: () => {
            try {
                child.kill();
            } catch {
                // Already exited.
            }
        },
    };
};
