// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * LOGIN_CLAUDE + LOGIN_CODEX unit tests.
 *
 * Both actions wrap an external CLI. The spawn boundary is the only
 * thing worth mocking — once we control what the child writes to
 * stdout/exits with, every code path can be exercised without
 * installing claude/codex on the test host.
 *
 * Mocks plug in via the runtime `options` field (the dispatcher
 * doesn't forward this in production, but our test harness calls the
 * handler directly).
 */

import { describe, expect, test } from "bun:test";
import type { IAgentRuntime, Memory } from "@elizaos/core";

import {
    CLAUDE_PROVIDER,
    CODEX_PROVIDER,
    LOGIN_CLAUDE_ACTION,
    LOGIN_CODEX_ACTION,
    extractLoginPrompt,
    type SpawnFn,
    type SpawnHandle,
} from "../src/runtime/actions/login-claude.ts";
import { matchAction } from "../src/runtime/match.ts";
import { USBELIZA_ACTIONS } from "../src/runtime/plugin.ts";

const fakeRuntime = {} as unknown as IAgentRuntime;
const memoryOf = (text: string) =>
    ({ content: { text } } as unknown as Memory);

/**
 * Build a `SpawnFn` that returns canned responses per (cmd, argsJoined)
 * lookup. Each canned response specifies stdout + exit code; the handle
 * exits asynchronously on the next macrotask so the production code
 * gets a chance to await `handle.exit`.
 *
 * The fast `sleepFn` below also drains pending microtasks so we don't
 * waste real wall-clock time in the test.
 */
function buildSpawn(
    table: ReadonlyArray<{ argsContains: string; stdout?: string; stderr?: string; exitCode?: number; exitDelayMs?: number }>,
): SpawnFn {
    return (_cmd, args) => {
        const argsJoined = args.join(" ");
        const matched = table.find((row) => argsJoined.includes(row.argsContains));
        const stdoutBuf = { value: matched?.stdout ?? "" };
        const stderrBuf = { value: matched?.stderr ?? "" };
        const exitCode = matched?.exitCode ?? 0;
        const delay = matched?.exitDelayMs ?? 0;
        let killed = false;
        const exit = new Promise<number | null>((resolve) => {
            setTimeout(() => {
                if (!killed) resolve(exitCode);
            }, delay);
        });
        return {
            exit,
            stdoutBuf,
            stderrBuf,
            kill: () => {
                killed = true;
            },
        } satisfies SpawnHandle;
    };
}

const instantSleep = (_ms: number): Promise<void> => Promise.resolve();

/**
 * Stub the new side-effect boundaries so tests stay hermetic — the real
 * implementations spawn chromium, write files into ~/.eliza/auth/, and
 * read ~/.config/claude/.credentials.json. None of that should leak into
 * test runs.
 */
const noBrowser = (_url: string, _opts?: { appIdSuffix?: string }) =>
    ({ status: "no-binary" as const });
const noClose = (_url: string) => false;
const noToken = (_path: string) => false;
const noopSignedIn = (_provider: unknown) => {};
const stubBoundaries = {
    openUrlFn: noBrowser,
    closeUrlFn: noClose,
    tokenExists: noToken,
    onSignedIn: noopSignedIn,
};

describe("extractLoginPrompt", () => {
    test("pulls the OAuth URL out of mixed CLI output", () => {
        const buf =
            "Opening your browser...\n" +
            "If it doesn't open, visit https://claude.ai/oauth/authorize?client=abc#code=def\n" +
            "Code: ABCD-1234\n";
        const out = extractLoginPrompt(buf);
        expect(out.url).toBe("https://claude.ai/oauth/authorize?client=abc#code=def");
        expect(out.code).toBe("ABCD-1234");
    });

    test("returns nulls when neither URL nor code present", () => {
        const out = extractLoginPrompt("hello world");
        expect(out.url).toBeNull();
        expect(out.code).toBeNull();
    });
});

describe("LOGIN_CLAUDE handler", () => {
    test("short-circuits when claude is already logged in", async () => {
        const spawnFn = buildSpawn([
            {
                argsContains: "auth status",
                stdout: JSON.stringify({ loggedIn: true, email: "nubs@nubs.site" }),
                exitCode: 0,
            },
        ]);
        const result = await LOGIN_CLAUDE_ACTION.handler(
            fakeRuntime,
            memoryOf("claude login"),
            undefined,
            { spawnFn, sleepFn: instantSleep, urlTimeoutMs: 50, timeoutMs: 1000, pollIntervalMs: 1, ...stubBoundaries },
        );
        expect(result?.success).toBe(true);
        expect(result?.text).toContain("already signed into Claude");
    });

    test("returns early with the OAuth URL once the prompt fires (background poll continues)", async () => {
        let statusCalls = 0;
        const spawnFn: SpawnFn = (_cmd, args) => {
            const argsJoined = args.join(" ");
            if (argsJoined.includes("auth status")) {
                statusCalls += 1;
                // First probe: not logged in. Subsequent probes: logged in.
                const stdout =
                    statusCalls === 1
                        ? JSON.stringify({ loggedIn: false })
                        : JSON.stringify({ loggedIn: true });
                return {
                    exit: Promise.resolve(0),
                    stdoutBuf: { value: stdout },
                    stderrBuf: { value: "" },
                    kill: () => {},
                };
            }
            // login spawn: writes URL + code, then hangs until killed
            return {
                exit: new Promise<number | null>(() => {}),
                stdoutBuf: {
                    value:
                        "Visit https://claude.ai/oauth/authorize?code=XYZ to sign in.\n" +
                        "Enter code: ABCD-1234\n",
                },
                stderrBuf: { value: "" },
                kill: () => {},
            };
        };

        let captured: string[] = [];
        const callback = async (response: { text?: string }) => {
            if (typeof response.text === "string") captured.push(response.text);
            return [];
        };

        const result = await LOGIN_CLAUDE_ACTION.handler(
            fakeRuntime,
            memoryOf("log into claude"),
            undefined,
            { spawnFn, sleepFn: instantSleep, urlTimeoutMs: 50, timeoutMs: 5000, pollIntervalMs: 1, ...stubBoundaries },
            callback,
        );

        // The handler returns as soon as onPrompt fires so the chat isn't
        // blocked for minutes while the user signs in. The background poll
        // continues — `onSignedIn` writes the marker when the token lands.
        expect(result?.success).toBe(true);
        expect(result?.text).toContain("opened the sign-in page");
        expect((result?.data as { status?: string } | undefined)?.status).toBe("prompted");
        expect(captured.some((t) => t.includes("https://claude.ai/oauth/"))).toBe(true);
        expect(captured.some((t) => t.includes("ABCD-1234"))).toBe(true);
    });

    test("reports no-url when login CLI prints nothing useful", async () => {
        const spawnFn: SpawnFn = (_cmd, args) => {
            const argsJoined = args.join(" ");
            if (argsJoined.includes("auth status")) {
                return {
                    exit: Promise.resolve(0),
                    stdoutBuf: { value: JSON.stringify({ loggedIn: false }) },
                    stderrBuf: { value: "" },
                    kill: () => {},
                };
            }
            return {
                exit: new Promise<number | null>(() => {}),
                stdoutBuf: { value: "loading...\n" },
                stderrBuf: { value: "" },
                kill: () => {},
            };
        };
        const result = await LOGIN_CLAUDE_ACTION.handler(
            fakeRuntime,
            memoryOf("log into claude"),
            undefined,
            { spawnFn, sleepFn: instantSleep, urlTimeoutMs: 20, timeoutMs: 1000, pollIntervalMs: 1, ...stubBoundaries },
        );
        expect(result?.success).toBe(false);
        expect(result?.text).toContain("couldn't drive the Claude login flow");
    });

    test("returns prompt-text immediately even when the background poll will eventually time out", async () => {
        const spawnFn: SpawnFn = (_cmd, args) => {
            const argsJoined = args.join(" ");
            if (argsJoined.includes("auth status")) {
                return {
                    exit: Promise.resolve(0),
                    stdoutBuf: { value: JSON.stringify({ loggedIn: false }) },
                    stderrBuf: { value: "" },
                    kill: () => {},
                };
            }
            return {
                exit: new Promise<number | null>(() => {}),
                stdoutBuf: {
                    value: "Visit https://claude.ai/oauth/x and enter ABCD-1234\n",
                },
                stderrBuf: { value: "" },
                kill: () => {},
            };
        };
        // Under the early-return contract: as long as the OAuth URL hits
        // stdout, the handler returns success with the prompt text — even
        // if the background poll will later time out. The "timeout" case
        // is only visible to the chat when the URL never appeared.
        const result = await LOGIN_CLAUDE_ACTION.handler(
            fakeRuntime,
            memoryOf("claude login"),
            undefined,
            { spawnFn, sleepFn: instantSleep, urlTimeoutMs: 50, timeoutMs: 0, pollIntervalMs: 1, ...stubBoundaries },
        );
        expect(result?.success).toBe(true);
        expect(result?.text).toContain("opened the sign-in page");
    });
});

describe("LOGIN_CLAUDE — browser + token detection", () => {
    test("opens chromium with the OAuth URL once scraped", async () => {
        const opened: string[] = [];
        const spawnFn: SpawnFn = (_cmd, args) => {
            if (args.join(" ").includes("auth status")) {
                return {
                    exit: Promise.resolve(0),
                    stdoutBuf: { value: JSON.stringify({ loggedIn: false }) },
                    stderrBuf: { value: "" },
                    kill: () => {},
                };
            }
            return {
                exit: new Promise<number | null>(() => {}),
                stdoutBuf: {
                    value: "Visit https://claude.ai/oauth/authorize?x=1\nCode: ABCD-1234\n",
                },
                stderrBuf: { value: "" },
                kill: () => {},
            };
        };
        const tokenAppearsOnSecondCheck = (() => {
            let checks = 0;
            return (_path: string) => {
                checks += 1;
                return checks >= 2;
            };
        })();
        const closes: string[] = [];
        const signedIn: string[] = [];
        const openedSuffixes: (string | undefined)[] = [];
        const result = await LOGIN_CLAUDE_ACTION.handler(
            fakeRuntime,
            memoryOf("log into claude"),
            undefined,
            {
                spawnFn,
                sleepFn: instantSleep,
                urlTimeoutMs: 50,
                timeoutMs: 5000,
                pollIntervalMs: 1,
                openUrlFn: (url: string, opts?: { appIdSuffix?: string }) => {
                    opened.push(url);
                    openedSuffixes.push(opts?.appIdSuffix);
                    return { status: "spawned" as const };
                },
                closeUrlFn: (url: string) => {
                    closes.push(url);
                    return true;
                },
                tokenExists: tokenAppearsOnSecondCheck,
                onSignedIn: (p: { authKey: string }) => {
                    signedIn.push(p.authKey);
                },
            },
        );
        // The chat reply returns as soon as onPrompt fires (the prompt text).
        // The background flow proceeds to detect the token, close the browser,
        // and write the auth marker — all observable via opened/closes/signedIn.
        expect(result?.success).toBe(true);
        expect(result?.text).toContain("opened the sign-in page");
        expect(opened).toContain("https://claude.ai/oauth/authorize?x=1");
        // OAuth windows must be tagged per-provider so sway matches
        // `usbeliza.browser.oauth-claude` for placement.
        expect(openedSuffixes).toContain("oauth-claude");
        // The background poll finishes on a microtask after the handler
        // returns; wait a tick so the close + onSignedIn side-effects land.
        await new Promise((r) => setTimeout(r, 5));
        expect(closes).toContain("https://claude.ai/oauth/authorize?x=1");
        expect(signedIn).toContain("claude");
    });

    test("fast-path: pre-existing token file short-circuits to already-logged-in", async () => {
        const spawnFn: SpawnFn = (_cmd, _args) => ({
            // Should never be called — the token check runs first.
            exit: Promise.resolve(0),
            stdoutBuf: { value: "" },
            stderrBuf: { value: "" },
            kill: () => {},
        });
        const result = await LOGIN_CLAUDE_ACTION.handler(
            fakeRuntime,
            memoryOf("claude login"),
            undefined,
            {
                spawnFn,
                sleepFn: instantSleep,
                urlTimeoutMs: 50,
                timeoutMs: 1000,
                pollIntervalMs: 1,
                openUrlFn: noBrowser,
                closeUrlFn: noClose,
                tokenExists: () => true,
                onSignedIn: noopSignedIn,
            },
        );
        expect(result?.success).toBe(true);
        expect(result?.text).toContain("already signed into Claude");
    });
});

describe("LOGIN_CODEX handler", () => {
    test("already-logged-in path for codex's text-mode status", async () => {
        const spawnFn = buildSpawn([
            {
                argsContains: "login status",
                stdout: "You are logged in as nubs@nubs.site\n",
                exitCode: 0,
            },
        ]);
        const result = await LOGIN_CODEX_ACTION.handler(
            fakeRuntime,
            memoryOf("codex login"),
            undefined,
            { spawnFn, sleepFn: instantSleep, urlTimeoutMs: 20, timeoutMs: 1000, pollIntervalMs: 1, ...stubBoundaries },
        );
        expect(result?.success).toBe(true);
        expect(result?.text).toContain("already signed into Codex");
    });
});

describe("Provider config sanity", () => {
    test("CLAUDE_PROVIDER.isLoggedIn handles known shapes", () => {
        expect(
            CLAUDE_PROVIDER.isLoggedIn(0, JSON.stringify({ loggedIn: true }), ""),
        ).toBe(true);
        expect(
            CLAUDE_PROVIDER.isLoggedIn(0, JSON.stringify({ loggedIn: false }), ""),
        ).toBe(false);
        expect(CLAUDE_PROVIDER.isLoggedIn(1, "{}", "")).toBe(false);
        expect(CLAUDE_PROVIDER.isLoggedIn(0, "not json", "")).toBe(false);
    });

    test("CODEX_PROVIDER.isLoggedIn matches case-insensitive marker", () => {
        expect(CODEX_PROVIDER.isLoggedIn(0, "You are LOGGED IN.", "")).toBe(true);
        expect(CODEX_PROVIDER.isLoggedIn(0, "Signed in.", "")).toBe(true);
        expect(CODEX_PROVIDER.isLoggedIn(0, "Please login first.", "")).toBe(false);
        expect(CODEX_PROVIDER.isLoggedIn(1, "logged in", "")).toBe(false);
    });
});

describe("Action selection (similes)", () => {
    test("'log into claude' picks LOGIN_CLAUDE", () => {
        const m = matchAction("log into claude", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("LOGIN_CLAUDE");
    });

    test("'claude login' picks LOGIN_CLAUDE", () => {
        const m = matchAction("claude login", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("LOGIN_CLAUDE");
    });

    test("'log into codex' picks LOGIN_CODEX", () => {
        const m = matchAction("log into codex", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("LOGIN_CODEX");
    });

    test("'codex login' picks LOGIN_CODEX, not LOGIN_CLAUDE", () => {
        const m = matchAction("codex login", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("LOGIN_CODEX");
    });
});
