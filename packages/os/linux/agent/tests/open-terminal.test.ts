// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * OPEN_TERMINAL unit tests.
 *
 * Mocks the binary-resolver + spawn boundary so we exercise the
 * preferred → fallback chain without touching the user's display.
 */

import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import type { IAgentRuntime, Memory } from "@elizaos/core";

import {
    OPEN_TERMINAL_ACTION,
    openTerminal,
} from "../src/runtime/actions/open-terminal.ts";

const fakeRuntime = {} as unknown as IAgentRuntime;
const memoryOf = (text: string) => ({ content: { text } } as unknown as Memory);

function stubChild(pid = 5151): ChildProcess {
    const child = {
        pid,
        kill: () => true,
        unref: () => {},
        on: () => child,
    } as unknown as ChildProcess;
    return child;
}

describe("openTerminal()", () => {
    test("spawns alacritty when present and tags with --class", () => {
        let cmdSeen = "";
        let argsSeen: readonly string[] = [];
        const result = openTerminal({
            findBinary: () => "/usr/bin/alacritty",
            spawnFn: (cmd, args) => {
                cmdSeen = cmd;
                argsSeen = args;
                return stubChild(1111);
            },
        });
        expect(result.status).toBe("spawned");
        expect(result.pid).toBe(1111);
        expect(result.binary).toBe("/usr/bin/alacritty");
        expect(cmdSeen).toBe("/usr/bin/alacritty");
        expect(argsSeen).toContain("--class");
        // The class argument should match the usbeliza.terminal.* convention.
        const classIdx = argsSeen.indexOf("--class");
        expect(classIdx).toBeGreaterThanOrEqual(0);
        const klass = argsSeen[classIdx + 1];
        expect(klass).toMatch(/^usbeliza\.terminal\.[0-9a-f]{6}$/);
        expect(result.class).toBe(klass);
        // Login shell is invoked.
        expect(argsSeen).toContain("bash");
    });

    test("falls through to foot when alacritty missing — uses --app-id syntax", () => {
        let argsSeen: readonly string[] = [];
        const result = openTerminal({
            findBinary: () => "/usr/bin/foot",
            spawnFn: (_cmd, args) => {
                argsSeen = args;
                return stubChild(2222);
            },
        });
        expect(result.status).toBe("spawned");
        expect(result.binary).toBe("/usr/bin/foot");
        // foot uses --app-id=CLASS, not --class CLASS.
        const appIdArg = argsSeen.find((a) => a.startsWith("--app-id="));
        expect(appIdArg).toBeDefined();
        expect(appIdArg).toMatch(/^--app-id=usbeliza\.terminal\.[0-9a-f]{6}$/);
        expect(argsSeen).toContain("bash");
    });

    test("falls through to xterm when both missing — uses -class syntax", () => {
        let argsSeen: readonly string[] = [];
        const result = openTerminal({
            findBinary: () => "/usr/bin/xterm",
            spawnFn: (_cmd, args) => {
                argsSeen = args;
                return stubChild(3333);
            },
        });
        expect(result.status).toBe("spawned");
        expect(result.binary).toBe("/usr/bin/xterm");
        const classIdx = argsSeen.indexOf("-class");
        expect(classIdx).toBeGreaterThanOrEqual(0);
        const klass = argsSeen[classIdx + 1];
        expect(klass).toMatch(/^usbeliza\.terminal\.[0-9a-f]{6}$/);
    });

    test("returns no-binary when nothing installed", () => {
        const result = openTerminal({
            findBinary: () => null,
            spawnFn: () => {
                throw new Error("should not spawn");
            },
        });
        expect(result.status).toBe("no-binary");
        expect(result.pid).toBeUndefined();
        expect(result.class).toBeUndefined();
    });
});

describe("OPEN_TERMINAL_ACTION", () => {
    test("validate is always true", async () => {
        const ok = await OPEN_TERMINAL_ACTION.validate?.(fakeRuntime, memoryOf("anything"));
        expect(ok).toBe(true);
    });

    test("handler spawns and surfaces the class + pid on result.data", async () => {
        const result = await OPEN_TERMINAL_ACTION.handler(
            fakeRuntime,
            memoryOf("open a terminal"),
            undefined,
            {
                findBinary: () => "/usr/bin/alacritty",
                spawnFn: () => stubChild(4242),
            },
        );
        expect(result?.success).toBe(true);
        expect(result?.text).toContain("Opened a terminal");
        const data = result?.data as { pid: number | null; class: string | null } | undefined;
        expect(data?.pid).toBe(4242);
        expect(data?.class).toMatch(/^usbeliza\.terminal\.[0-9a-f]{6}$/);
    });

    test("handler surfaces a clear reply when no terminal emulator is installed", async () => {
        const result = await OPEN_TERMINAL_ACTION.handler(
            fakeRuntime,
            memoryOf("open a terminal"),
            undefined,
            {
                findBinary: () => null,
                spawnFn: () => {
                    throw new Error("should not spawn");
                },
            },
        );
        expect(result?.success).toBe(false);
        expect(result?.text).toContain("couldn't find a terminal emulator");
    });
});
