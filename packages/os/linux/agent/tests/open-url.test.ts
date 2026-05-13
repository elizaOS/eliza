// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * OPEN_URL unit tests.
 *
 * The spawn boundary is the only thing worth mocking — once we control
 * what `spawn` returns we can exercise both code paths (chromium present
 * vs. missing) without touching the user's display.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import type { ChildProcess } from "node:child_process";
import type { IAgentRuntime, Memory } from "@elizaos/core";

import {
    OPEN_URL_ACTION,
    closeUrl,
    openUrl,
    __clearOpenWindows,
    __getOpenWindows,
} from "../src/runtime/actions/open-url.ts";
import { matchAction } from "../src/runtime/match.ts";
import { USBELIZA_ACTIONS } from "../src/runtime/plugin.ts";

const fakeRuntime = {} as unknown as IAgentRuntime;
const memoryOf = (text: string) => ({ content: { text } } as unknown as Memory);

/** Build a stub ChildProcess with the minimum surface the implementation uses. */
function stubChild(pid = 4242): ChildProcess {
    let killed = false;
    const events = new Map<string, ((...args: unknown[]) => void)[]>();
    const child = {
        pid,
        get killed() { return killed; },
        kill: (_signal?: NodeJS.Signals) => {
            killed = true;
            return true;
        },
        unref: () => {},
        on: (event: string, listener: (...args: unknown[]) => void) => {
            const list = events.get(event) ?? [];
            list.push(listener);
            events.set(event, list);
            return child;
        },
    } as unknown as ChildProcess;
    return child;
}

beforeEach(() => {
    __clearOpenWindows();
});

describe("openUrl()", () => {
    test("spawns chromium with Wayland/floating flags and registers the PID under the URL", () => {
        const calls: { cmd: string; args: readonly string[] }[] = [];
        const spawnFn = (cmd: string, args: readonly string[]) => {
            calls.push({ cmd, args });
            return stubChild(1234);
        };
        const result = openUrl("https://example.com/oauth?x=1", {
            findBinary: () => "/usr/bin/chromium",
            hasBwrap: () => false,
            spawnFn,
        });
        expect(result.status).toBe("spawned");
        expect(result.pid).toBe(1234);
        expect(calls.length).toBe(1);
        const call = calls[0];
        expect(call).toBeDefined();
        if (call) {
            expect(call.cmd).toBe("/usr/bin/chromium");
            // Wayland/Ozone flags — fixes the "invisible blocker" bug
            // where chromium grabbed focus but never painted because it
            // tried to use X11/XWayland on a Wayland-only compositor.
            expect(call.args).toContain("--ozone-platform=wayland");
            expect(call.args).toContain("--enable-features=UseOzonePlatform");
            // QEMU virtio-vga has no real GPU; software-rasterize via
            // swiftshader (opaque pixels, fixes the "Eliza chat leaks
            // through" rendering glitch we saw with --disable-gpu).
            expect(call.args).toContain("--use-gl=swiftshader");
            // Tagged for sway's `usbeliza.browser.*` floating rule.
            expect(call.args).toContain("--class=usbeliza.browser.window");
            // Old kiosk-style flags must be gone — chat box has to stay
            // visible behind the OAuth window.
            expect(call.args).not.toContain("--kiosk");
            expect(call.args).not.toContain("--start-fullscreen");
            // URL is embedded in `--app=URL` to strip the tab/URL bar/
            // browser chrome — the OAuth window is webview-style.
            expect(call.args).toContain("--app=https://example.com/oauth?x=1");
        }
        expect(__getOpenWindows().has("https://example.com/oauth?x=1")).toBe(true);
    });

    test("appIdSuffix tags the window for sway placement", () => {
        let argsSeen: readonly string[] = [];
        const result = openUrl("https://claude.ai/oauth", {
            findBinary: () => "/usr/bin/chromium",
            hasBwrap: () => false,
            spawnFn: (_cmd, args) => {
                argsSeen = args;
                return stubChild();
            },
            appIdSuffix: "oauth-claude",
        });
        expect(result.status).toBe("spawned");
        expect(argsSeen).toContain("--class=usbeliza.browser.oauth-claude");
        // Default suffix must NOT leak through when a custom one was supplied.
        expect(argsSeen).not.toContain("--class=usbeliza.browser.window");
    });

    test("wraps in bwrap when available", () => {
        let cmdSeen = "";
        let argsSeen: readonly string[] = [];
        const result = openUrl("https://example.com", {
            findBinary: () => "/usr/bin/chromium",
            hasBwrap: () => true,
            spawnFn: (cmd, args) => {
                cmdSeen = cmd;
                argsSeen = args;
                return stubChild();
            },
        });
        expect(result.status).toBe("spawned");
        expect(cmdSeen).toBe("/usr/bin/bwrap");
        expect(argsSeen).toContain("/usr/bin/chromium");
        expect(argsSeen).toContain("--app=https://example.com");
        // The sandbox profile should mount HOME and /tmp.
        expect(argsSeen).toContain("--bind");
        // die-with-parent so an Eliza crash doesn't strand the browser.
        expect(argsSeen).toContain("--die-with-parent");
        // Chromium flags should pass through the bwrap wrapper unchanged.
        expect(argsSeen).toContain("--ozone-platform=wayland");
        expect(argsSeen).toContain("--use-gl=swiftshader");
        expect(argsSeen).toContain("--class=usbeliza.browser.window");
        expect(argsSeen).not.toContain("--kiosk");
    });

    test("returns no-binary when chromium isn't found", () => {
        const result = openUrl("https://example.com", {
            findBinary: () => null,
            hasBwrap: () => false,
            spawnFn: () => {
                throw new Error("should not spawn");
            },
        });
        expect(result.status).toBe("no-binary");
        expect(__getOpenWindows().size).toBe(0);
    });
});

describe("closeUrl()", () => {
    test("kills the registered process and removes it from the map", () => {
        let killed = false;
        const child = stubChild();
        // Override kill to capture the call.
        (child as unknown as { kill: (signal?: string) => boolean }).kill = (signal?: string) => {
            killed = signal === "SIGTERM";
            return true;
        };
        openUrl("https://example.com/x", {
            findBinary: () => "/usr/bin/chromium",
            hasBwrap: () => false,
            spawnFn: () => child,
        });
        expect(__getOpenWindows().has("https://example.com/x")).toBe(true);
        const result = closeUrl("https://example.com/x");
        expect(result).toBe(true);
        expect(killed).toBe(true);
        expect(__getOpenWindows().has("https://example.com/x")).toBe(false);
    });

    test("returns false when nothing is registered", () => {
        expect(closeUrl("https://nothing-here")).toBe(false);
    });
});

describe("OPEN_URL_ACTION", () => {
    test("validate rejects messages without a URL", async () => {
        const ok = await OPEN_URL_ACTION.validate?.(
            fakeRuntime,
            memoryOf("open url"),
        );
        expect(ok).toBe(false);
    });

    test("validate accepts messages with a URL", async () => {
        const ok = await OPEN_URL_ACTION.validate?.(
            fakeRuntime,
            memoryOf("open https://example.com"),
        );
        expect(ok).toBe(true);
    });

    test("handler spawns chromium and replies warmly", async () => {
        let spawned = 0;
        const result = await OPEN_URL_ACTION.handler(
            fakeRuntime,
            memoryOf("visit https://example.com/page"),
            undefined,
            {
                findBinary: () => "/usr/bin/chromium",
                hasBwrap: () => false,
                spawnFn: () => {
                    spawned += 1;
                    return stubChild();
                },
            },
        );
        expect(spawned).toBe(1);
        expect(result?.success).toBe(true);
        expect(result?.text).toContain("Opening it now");
    });

    test("handler surfaces a clear reply when chromium is missing", async () => {
        const result = await OPEN_URL_ACTION.handler(
            fakeRuntime,
            memoryOf("open https://example.com"),
            undefined,
            {
                findBinary: () => null,
                hasBwrap: () => false,
                spawnFn: () => {
                    throw new Error("should not spawn");
                },
            },
        );
        expect(result?.success).toBe(false);
        expect(result?.text).toContain("chromium isn't installed");
    });
});

describe("Action selection (similes)", () => {
    // The matcher tokenizes URLs into noise tokens that drag jaccard
    // overlap below threshold. OPEN_URL is also called programmatically
    // from LOGIN_CLAUDE/CODEX, so we only require it to match on the
    // explicit similes — not arbitrary "open <url>" shapes.
    test("'open url https://x' picks OPEN_URL", () => {
        const m = matchAction("open url https://example.com", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("OPEN_URL");
    });

    test("'open this url https://x' picks OPEN_URL", () => {
        const m = matchAction("open this url https://example.com", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("OPEN_URL");
    });

    test("'open in browser' picks OPEN_URL", () => {
        const m = matchAction("open in browser", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("OPEN_URL");
    });
});
