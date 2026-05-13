// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * OPEN_FILES unit tests.
 *
 * Mocks the binary-resolver + spawn boundary so we exercise the
 * preferred → fallback chain without touching the user's display.
 */

import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import type { IAgentRuntime, Memory } from "@elizaos/core";

import {
    OPEN_FILES_ACTION,
    openFiles,
} from "../src/runtime/actions/open-files.ts";

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

describe("openFiles()", () => {
    test("spawns thunar when present and opens $HOME by default", () => {
        let cmdSeen = "";
        let argsSeen: readonly string[] = [];
        const result = openFiles({
            findBinary: () => "/usr/bin/thunar",
            spawnFn: (cmd, args) => {
                cmdSeen = cmd;
                argsSeen = args;
                return stubChild(1111);
            },
        });
        expect(result.status).toBe("spawned");
        expect(result.pid).toBe(1111);
        expect(result.binary).toBe("/usr/bin/thunar");
        expect(cmdSeen).toBe("/usr/bin/thunar");
        // Path defaults to $HOME and is passed as the sole positional arg.
        expect(result.path).toBe(homedir());
        expect(argsSeen).toEqual([homedir()]);
    });

    test("falls through to pcmanfm when thunar missing", () => {
        let argsSeen: readonly string[] = [];
        const result = openFiles({
            findBinary: () => "/usr/bin/pcmanfm",
            spawnFn: (_cmd, args) => {
                argsSeen = args;
                return stubChild(2222);
            },
        });
        expect(result.status).toBe("spawned");
        expect(result.binary).toBe("/usr/bin/pcmanfm");
        expect(argsSeen).toEqual([homedir()]);
    });

    test("falls through to nautilus when both missing — uses --new-window", () => {
        let argsSeen: readonly string[] = [];
        const result = openFiles({
            findBinary: () => "/usr/bin/nautilus",
            spawnFn: (_cmd, args) => {
                argsSeen = args;
                return stubChild(3333);
            },
        });
        expect(result.status).toBe("spawned");
        expect(result.binary).toBe("/usr/bin/nautilus");
        expect(argsSeen).toContain("--new-window");
        expect(argsSeen).toContain(homedir());
    });

    test("returns no-binary when nothing installed", () => {
        const result = openFiles({
            findBinary: () => null,
            spawnFn: () => {
                throw new Error("should not spawn");
            },
        });
        expect(result.status).toBe("no-binary");
        expect(result.pid).toBeUndefined();
        expect(result.binary).toBeUndefined();
    });

    test("honors a caller-supplied path", () => {
        let argsSeen: readonly string[] = [];
        const result = openFiles({
            findBinary: () => "/usr/bin/thunar",
            spawnFn: (_cmd, args) => {
                argsSeen = args;
                return stubChild(4242);
            },
            path: "/tmp",
        });
        expect(result.status).toBe("spawned");
        expect(result.path).toBe("/tmp");
        expect(argsSeen).toEqual(["/tmp"]);
    });
});

describe("OPEN_FILES_ACTION", () => {
    test("validate is always true", async () => {
        const ok = await OPEN_FILES_ACTION.validate?.(fakeRuntime, memoryOf("anything"));
        expect(ok).toBe(true);
    });

    test("handler spawns and surfaces pid + binary on result.data", async () => {
        const result = await OPEN_FILES_ACTION.handler(
            fakeRuntime,
            memoryOf("open my files"),
            undefined,
            {
                findBinary: () => "/usr/bin/thunar",
                spawnFn: () => stubChild(4242),
            },
        );
        expect(result?.success).toBe(true);
        expect(result?.text).toContain("Opened a file manager");
        const data = result?.data as
            | { pid: number | null; binary: string | null }
            | undefined;
        expect(data?.pid).toBe(4242);
        expect(data?.binary).toBe("/usr/bin/thunar");
    });

    test("handler surfaces a clear reply when no file manager is installed", async () => {
        const result = await OPEN_FILES_ACTION.handler(
            fakeRuntime,
            memoryOf("open my files"),
            undefined,
            {
                findBinary: () => null,
                spawnFn: () => {
                    throw new Error("should not spawn");
                },
            },
        );
        expect(result?.success).toBe(false);
        expect(result?.text).toContain("couldn't find a file manager");
    });
});
