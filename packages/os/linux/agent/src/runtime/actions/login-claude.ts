// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * LOGIN_CLAUDE + LOGIN_CODEX — drive the upstream CLI's OAuth device-code
 * flow from chat.
 *
 * Both upstream CLIs default to opening a browser for OAuth, which is
 * useless on a headless live USB. The pattern we implement here:
 *
 *   1. Probe current auth status. For claude that's
 *      `claude auth status --json` (exit 0 + `loggedIn: true`).
 *   2. If already authed, short-circuit with a friendly reply.
 *   3. Else spawn the CLI's login subcommand in a child process, scrape
 *      stdout for the device-code URL + the user code, and surface them
 *      to chat. The user opens the URL on their phone, enters the code,
 *      and the CLI process exits 0 when the OAuth completes.
 *   4. Poll status once a second up to a timeout so we can tell the user
 *      "signed in" without leaving the spawn'd CLI hung in the background
 *      if they bail.
 *
 * The CLIs are *not* designed for unattended invocation; this is a
 * best-effort wrapper. We capture every line of stdout/stderr so that
 * when the CLI inevitably evolves we get a useful debug trail in the
 * reply.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Action, ActionExample } from "@elizaos/core";

import { markSignedIn, type AuthProvider } from "../auth/state.ts";
import { closeUrl, openUrl } from "./open-url.ts";

/**
 * `https://claude.ai/oauth/...` or `https://console.anthropic.com/...`
 * style URLs. Captured greedily up to whitespace so query strings stay
 * intact.
 */
const URL_RE = /https?:\/\/[^\s)>'"]+/i;
/** OAuth user codes — claude prints "XXXX-XXXX", codex prints similar. */
const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/;

export interface SpawnHandle {
    /** Resolved when the child exits. Number is the exit code, null on signal. */
    readonly exit: Promise<number | null>;
    /** Cumulative captured stdout. Updated live; safe to read after exit. */
    readonly stdoutBuf: { value: string };
    /** Cumulative captured stderr. */
    readonly stderrBuf: { value: string };
    /** Kill the child. No-op if already exited. */
    kill(signal?: NodeJS.Signals): void;
}

export type SpawnFn = (cmd: string, args: readonly string[]) => SpawnHandle;

/**
 * Production spawn implementation. Tests inject a mock via the action's
 * `spawn` field (see below). We use `node:child_process` directly because
 * Bun.spawn's stream shape doesn't compose cleanly with the polling logic
 * (Bun streams expose ReadableStream while node.spawn exposes EventEmitter
 * which is more ergonomic for cumulative buffer capture).
 */
function defaultSpawn(cmd: string, args: readonly string[]): SpawnHandle {
    const stdoutBuf = { value: "" };
    const stderrBuf = { value: "" };
    // Set BROWSER=/bin/true so claude/codex CLI's xdg-open call no-ops.
    // We open the OAuth window ourselves via the openUrl helper which
    // routes through `--app=URL` (chrome-less webview) + a sway floating
    // rule; the CLI's xdg-open path would spawn ANOTHER chromium with
    // default Chrome chrome bar + tile beside Eliza, eating half the
    // screen. Without this env var we get TWO browser windows.
    const child = spawn(cmd, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, BROWSER: "/bin/true" },
    });
    const exit = new Promise<number | null>((resolve) => {
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf.value += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf.value += chunk.toString();
    });
    return {
        exit,
        stdoutBuf,
        stderrBuf,
        kill: (signal) => {
            if (!child.killed) child.kill(signal);
        },
    };
}

/**
 * Configuration object — pulled out so each provider (claude/codex)
 * customizes its commands but the orchestration is shared.
 */
export interface LoginProvider {
    /** Human label ("Claude", "Codex"). */
    readonly displayName: string;
    /** Path probed by `existsSync` before we bother spawning. */
    readonly binaryPath: string;
    /** Fallback PATH name when `binaryPath` doesn't exist (dev machines). */
    readonly binaryName: string;
    /** Args for the status probe — exit 0 + (stdout contains `loggedInMarker`) means authed. */
    readonly statusArgs: readonly string[];
    /**
     * Predicate over (exitCode, stdout, stderr) returning whether the
     * status probe should be treated as "logged in".
     */
    readonly isLoggedIn: (exitCode: number | null, stdout: string, stderr: string) => boolean;
    /** Args to launch the login flow. */
    readonly loginArgs: readonly string[];
    /**
     * Path the upstream CLI writes its credentials file to once the user
     * completes OAuth. We poll this with `existsSync` in addition to the
     * spawn-status probe so the round-trip is fast: a file showing up is
     * sub-second to detect, while spawning the CLI again costs ~hundreds
     * of ms.
     *
     * `~` is expanded via $HOME at module load.
     */
    readonly tokenFile: string;
    /** Key we hand to `markSignedIn` on success — kept narrow on purpose. */
    readonly authKey: AuthProvider;
}

// Resolve the user's HOME once. On the live USB this is `/home/eliza`;
// on dev machines it varies. Falls back to `/tmp` for sandboxed CI.
const HOME = process.env["HOME"] ?? "/tmp";

export const CLAUDE_PROVIDER: LoginProvider = {
    displayName: "Claude",
    binaryPath: "/usr/local/bin/claude",
    binaryName: "claude",
    statusArgs: ["auth", "status", "--json"],
    isLoggedIn: (code, stdout) => {
        if (code !== 0) return false;
        try {
            const parsed = JSON.parse(stdout) as { loggedIn?: unknown };
            return parsed.loggedIn === true;
        } catch {
            return false;
        }
    },
    loginArgs: ["auth", "login"],
    tokenFile: `${HOME}/.config/claude/.credentials.json`,
    authKey: "claude",
};

export const CODEX_PROVIDER: LoginProvider = {
    displayName: "Codex",
    binaryPath: "/usr/local/bin/codex",
    binaryName: "codex",
    statusArgs: ["login", "status"],
    // codex login status doesn't have a stable --json mode — we treat
    // exit 0 as authed and parse stdout for "logged in" / "signed in"
    // case-insensitively. False negatives bias toward asking the user to
    // re-login, which is safe.
    isLoggedIn: (code, stdout) => {
        if (code !== 0) return false;
        const lower = stdout.toLowerCase();
        return lower.includes("logged in") || lower.includes("signed in");
    },
    loginArgs: ["login"],
    tokenFile: `${HOME}/.config/codex/auth.json`,
    authKey: "codex",
};

function resolveBinary(provider: LoginProvider): string {
    return existsSync(provider.binaryPath) ? provider.binaryPath : provider.binaryName;
}

/**
 * Probe whether the CLI is already authenticated. Returns false on any
 * error (binary missing, ENOENT spawn, parse failure) — the caller's job
 * is to surface "log in please", not to distinguish missing-from-not-authed.
 */
export async function probeLoggedIn(
    provider: LoginProvider,
    spawnFn: SpawnFn = defaultSpawn,
): Promise<boolean> {
    const cmd = resolveBinary(provider);
    const handle = spawnFn(cmd, provider.statusArgs);
    const code = await handle.exit;
    return provider.isLoggedIn(code, handle.stdoutBuf.value, handle.stderrBuf.value);
}

/**
 * Extract the first OAuth URL + user code from a stdout/stderr buffer.
 * The CLIs print these prominently on separate lines; we don't depend on
 * exact format because Anthropic / OpenAI ship CLI cosmetic changes
 * weekly.
 */
export function extractLoginPrompt(
    buf: string,
): { url: string | null; code: string | null } {
    const url = URL_RE.exec(buf)?.[0] ?? null;
    const code = CODE_RE.exec(buf)?.[0] ?? null;
    return { url, code };
}

/** Sleep helper; exported for test stubbing. */
export const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

export interface RunLoginOptions {
    /** Override the spawn implementation (tests). */
    readonly spawnFn?: SpawnFn;
    /** Override the sleep implementation (tests). */
    readonly sleepFn?: (ms: number) => Promise<void>;
    /** Overall timeout for the login flow, ms. Default 5 minutes. */
    readonly timeoutMs?: number;
    /** How long to wait between status probes, ms. Default 2000. */
    readonly pollIntervalMs?: number;
    /** How long to wait between login-stdout scrapes, ms. Default 500. */
    readonly scrapeIntervalMs?: number;
    /**
     * Maximum time to wait for the login URL to appear in stdout before
     * giving up and reporting "I couldn't drive the login flow". Default
     * 10 seconds.
     */
    readonly urlTimeoutMs?: number;
    /** Callback invoked once when the OAuth URL is discovered. */
    readonly onPrompt?: (prompt: { url: string; code: string | null }) => void | Promise<void>;
    /**
     * Pop the OAuth URL in a floating Chromium window on the user's own
     * display. Defaults to `openUrl` from `open-url.ts` with the
     * provider-specific app_id suffix so sway tags the window
     * `usbeliza.browser.oauth-<provider>` for placement. Tests inject a
     * no-op. The result lets the action surface "I would have opened a
     * browser but chromium isn't installed — copy the URL yourself" when
     * degrading.
     */
    readonly openUrlFn?: (
        url: string,
        opts?: { appIdSuffix?: string },
    ) => { status: "spawned" | "no-binary" };
    /**
     * Close the OAuth URL window programmatically once token detection
     * succeeds. Defaults to `closeUrl` from `open-url.ts`. Tests inject a
     * counter.
     */
    readonly closeUrlFn?: (url: string) => boolean;
    /**
     * Predicate used to fast-detect token landing on disk. Defaults to
     * `existsSync(provider.tokenFile)`. Polling this in parallel with the
     * spawn-status probe makes detection sub-second for the common case.
     */
    readonly tokenExists?: (path: string) => boolean;
    /**
     * Called when sign-in is confirmed so callers can write the persistent
     * marker at `~/.eliza/auth/<provider>.json`. Defaults to `markSignedIn`
     * from `auth/state.ts`; tests inject a counter.
     */
    readonly onSignedIn?: (provider: LoginProvider) => void;
}

export interface RunLoginResult {
    readonly status: "already-logged-in" | "logged-in" | "no-binary" | "no-url" | "timeout";
    readonly stdout: string;
    readonly stderr: string;
}

/**
 * Drive the full login dance:
 *
 *   1. If already logged in (file marker or spawn-status), return
 *      "already-logged-in".
 *   2. Else spawn the login CLI and wait up to `urlTimeoutMs` for the
 *      OAuth URL to land in its stdout.
 *   3. Surface the URL + code via `onPrompt`, and pop the URL in a
 *      fullscreen Chromium window on the user's display via `openUrlFn`.
 *   4. Poll BOTH the token file and `claude auth status` every
 *      `pollIntervalMs` until either the user completes the flow
 *      (`logged-in`) or `timeoutMs` elapses (`timeout`). File-existence
 *      is cheap so it wins the race most of the time; spawn-status is
 *      the fallback for CLIs that haven't flushed the file yet.
 *   5. On success: close the Chromium window via `closeUrlFn` and call
 *      `onSignedIn` so the persistent `~/.eliza/auth/*.json` marker
 *      gets written.
 *   6. On timeout / failure: kill the child and the Chromium window.
 */
export async function runLoginFlow(
    provider: LoginProvider,
    options: RunLoginOptions = {},
): Promise<RunLoginResult> {
    const spawnFn = options.spawnFn ?? defaultSpawn;
    const sleepFn = options.sleepFn ?? sleep;
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const scrapeIntervalMs = options.scrapeIntervalMs ?? 500;
    const urlTimeoutMs = options.urlTimeoutMs ?? 10_000;
    // Tag the OAuth window per-provider so sway can match
    // `usbeliza.browser.oauth-<provider>` distinctly if we ever want
    // provider-specific placement. Today they share the
    // `usbeliza.browser.*` floating-center rule.
    const oauthSuffix = `oauth-${provider.authKey}`;
    const openUrlFn = options.openUrlFn ?? ((url: string, opts?: { appIdSuffix?: string }) =>
        openUrl(url, opts?.appIdSuffix !== undefined ? { appIdSuffix: opts.appIdSuffix } : {}));
    const closeUrlFn = options.closeUrlFn ?? ((url: string) => closeUrl(url));
    const tokenExists = options.tokenExists ?? ((path: string) => existsSync(path));
    const onSignedIn = options.onSignedIn ?? ((p: LoginProvider) => markSignedIn(p.authKey));

    // Fast path: token file already on disk. We do this BEFORE the
    // spawn-status probe because the file check is sub-millisecond and
    // covers the post-reboot "I already signed in last session" case
    // without round-tripping through the CLI.
    if (tokenExists(provider.tokenFile)) {
        return { status: "already-logged-in", stdout: "", stderr: "" };
    }
    if (await probeLoggedIn(provider, spawnFn)) {
        return { status: "already-logged-in", stdout: "", stderr: "" };
    }

    const cmd = resolveBinary(provider);
    const handle = spawnFn(cmd, provider.loginArgs);

    // If the binary is missing, defaultSpawn will fire 'error' and
    // resolve exit with null almost immediately. Race a short timer so
    // we can distinguish "binary missing" from "still booting".
    const earlyExit = await Promise.race([
        handle.exit.then((c) => ({ exited: true, code: c })),
        sleepFn(50).then(() => ({ exited: false, code: null })),
    ]);
    if (earlyExit.exited && handle.stdoutBuf.value === "" && handle.stderrBuf.value === "") {
        return { status: "no-binary", stdout: "", stderr: "" };
    }

    // Scrape stdout/stderr for the OAuth URL.
    let prompt: { url: string | null; code: string | null } = { url: null, code: null };
    const scrapeDeadline = Date.now() + urlTimeoutMs;
    while (Date.now() < scrapeDeadline) {
        const combined = handle.stdoutBuf.value + "\n" + handle.stderrBuf.value;
        prompt = extractLoginPrompt(combined);
        if (prompt.url !== null) break;
        // Bail early if the child exited without producing a URL.
        const exited = await Promise.race([
            handle.exit.then(() => true),
            sleepFn(scrapeIntervalMs).then(() => false),
        ]);
        if (exited) break;
    }
    if (prompt.url === null) {
        handle.kill();
        return {
            status: "no-url",
            stdout: handle.stdoutBuf.value,
            stderr: handle.stderrBuf.value,
        };
    }
    const promptedUrl = prompt.url;

    // Tell chat what's about to happen, then pop the OAuth page on the
    // user's local display. If chromium is missing the message still
    // mentions the URL so the user can copy it manually — that's the
    // graceful-degrade promise.
    const browser = openUrlFn(promptedUrl, { appIdSuffix: oauthSuffix });
    if (options.onPrompt !== undefined) {
        await options.onPrompt({ url: promptedUrl, code: prompt.code });
    }

    // Poll BOTH token file and spawn-status. File-existence is cheap and
    // wins the common case; we still poll the CLI in case the file shape
    // changes upstream (claude has shuffled token paths twice in 2025).
    const pollDeadline = Date.now() + timeoutMs;
    while (Date.now() < pollDeadline) {
        if (tokenExists(provider.tokenFile) || (await probeLoggedIn(provider, spawnFn))) {
            handle.kill();
            // Close the floating OAuth window if we successfully opened
            // one. If openUrlFn reported no-binary, closeUrl no-ops
            // gracefully.
            if (browser.status === "spawned") closeUrlFn(promptedUrl);
            onSignedIn(provider);
            return {
                status: "logged-in",
                stdout: handle.stdoutBuf.value,
                stderr: handle.stderrBuf.value,
            };
        }
        await sleepFn(pollIntervalMs);
    }
    handle.kill();
    if (browser.status === "spawned") closeUrlFn(promptedUrl);
    return {
        status: "timeout",
        stdout: handle.stdoutBuf.value,
        stderr: handle.stderrBuf.value,
    };
}

interface LoginRuntimeOptions {
    /** Tests can swap the spawn boundary by reading this from runtime options. */
    spawnFn?: SpawnFn;
    /** Tests can swap the sleep boundary. */
    sleepFn?: (ms: number) => Promise<void>;
    /** Tests can pass a tight URL timeout. */
    urlTimeoutMs?: number;
    /** Tests can pass a tight overall timeout. */
    timeoutMs?: number;
    /** Tests can pass a tight poll interval. */
    pollIntervalMs?: number;
    /** Tests can stub the browser-pop boundary. */
    openUrlFn?: (
        url: string,
        opts?: { appIdSuffix?: string },
    ) => { status: "spawned" | "no-binary" };
    /** Tests can stub the browser-close boundary. */
    closeUrlFn?: (url: string) => boolean;
    /** Tests can stub the token-file probe. */
    tokenExists?: (path: string) => boolean;
    /** Tests can stub the auth-marker write so the real ~/.eliza isn't touched. */
    onSignedIn?: (provider: LoginProvider) => void;
}

function readLoginOptions(options: unknown): LoginRuntimeOptions {
    if (typeof options !== "object" || options === null) return {};
    const out: LoginRuntimeOptions = {};
    const o = options as Record<string, unknown>;
    if (typeof o["spawnFn"] === "function") out.spawnFn = o["spawnFn"] as SpawnFn;
    if (typeof o["sleepFn"] === "function") {
        out.sleepFn = o["sleepFn"] as (ms: number) => Promise<void>;
    }
    if (typeof o["urlTimeoutMs"] === "number") out.urlTimeoutMs = o["urlTimeoutMs"];
    if (typeof o["timeoutMs"] === "number") out.timeoutMs = o["timeoutMs"];
    if (typeof o["pollIntervalMs"] === "number") out.pollIntervalMs = o["pollIntervalMs"];
    if (typeof o["openUrlFn"] === "function") {
        out.openUrlFn = o["openUrlFn"] as (
            url: string,
            opts?: { appIdSuffix?: string },
        ) => { status: "spawned" | "no-binary" };
    }
    if (typeof o["closeUrlFn"] === "function") {
        out.closeUrlFn = o["closeUrlFn"] as (url: string) => boolean;
    }
    if (typeof o["tokenExists"] === "function") {
        out.tokenExists = o["tokenExists"] as (path: string) => boolean;
    }
    if (typeof o["onSignedIn"] === "function") {
        out.onSignedIn = o["onSignedIn"] as (provider: LoginProvider) => void;
    }
    return out;
}

/**
 * Build a chat-facing Action wrapping `runLoginFlow` for one provider.
 * The factory lets LOGIN_CLAUDE and LOGIN_CODEX share orchestration.
 */
function makeLoginAction(
    name: string,
    similes: string[],
    provider: LoginProvider,
    examples: ActionExample[][],
): Action {
    return {
        name,
        similes,
        description: `Sign into the ${provider.displayName} CLI via its OAuth device-code flow so app generation can use real ${provider.displayName} codegen.`,

        validate: async () => true,

        handler: async (_runtime, _message, _state, options, callback) => {
            const opts = readLoginOptions(options);

            // Deferred-resolve plumbing so the handler can RETURN as soon as
            // the OAuth URL is on the user's screen, instead of blocking the
            // chat for up to 5 minutes while we poll for the token. The
            // background poller still writes the auth marker via onSignedIn
            // when the user finishes — next chat turn picks it up.
            let promptText: string | null = null;
            let resolvePrompt: (() => void) | null = null;
            const promptFired = new Promise<void>((resolve) => {
                resolvePrompt = resolve;
            });

            const flowOpts: RunLoginOptions = {
                ...(opts.spawnFn !== undefined ? { spawnFn: opts.spawnFn } : {}),
                ...(opts.sleepFn !== undefined ? { sleepFn: opts.sleepFn } : {}),
                ...(opts.urlTimeoutMs !== undefined ? { urlTimeoutMs: opts.urlTimeoutMs } : {}),
                ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
                ...(opts.pollIntervalMs !== undefined
                    ? { pollIntervalMs: opts.pollIntervalMs }
                    : {}),
                ...(opts.openUrlFn !== undefined ? { openUrlFn: opts.openUrlFn } : {}),
                ...(opts.closeUrlFn !== undefined ? { closeUrlFn: opts.closeUrlFn } : {}),
                ...(opts.tokenExists !== undefined ? { tokenExists: opts.tokenExists } : {}),
                ...(opts.onSignedIn !== undefined ? { onSignedIn: opts.onSignedIn } : {}),
                onPrompt: async ({ url, code }) => {
                    // The browser has just been popped (or attempted) by
                    // runLoginFlow. Keep the URL in the chat too, so the
                    // user has a fallback if chromium failed silently.
                    const codeLine = code !== null ? ` Your code is ${code}.` : "";
                    promptText =
                        `I've opened the sign-in page for you — finish there and I'll pick up the rest. ` +
                        `If the window didn't appear, the URL is ${url}.${codeLine}`;
                    if (callback) await callback({ text: promptText, actions: [name] });
                    if (resolvePrompt !== null) resolvePrompt();
                },
            };

            const flowPromise = runLoginFlow(provider, flowOpts);

            // Race the prompt vs the flow. If the prompt fires first (the
            // common case once the CLI prints its OAuth URL), return the
            // prompt text immediately and let the poll loop continue in
            // background. Otherwise the flow finished without a prompt
            // (already-logged-in / no-binary / no-url / timeout) — handle
            // those as before.
            const winner = await Promise.race([
                promptFired.then(() => "prompt" as const),
                flowPromise.then((r) => ({ kind: "flow" as const, result: r })),
            ]);

            if (winner === "prompt") {
                // Detach the rest of the flow — it'll write the marker via
                // onSignedIn when the token lands. Swallow any errors so an
                // orphaned poll loop doesn't unhandled-reject the agent.
                flowPromise.catch(() => {});
                const text = promptText ?? "I've opened the sign-in page for you — finish there and I'll pick up the rest.";
                return {
                    success: true,
                    text,
                    data: { actionName: name, status: "prompted" },
                };
            }

            const result = winner.result;
            const friendlyName = provider.displayName;
            switch (result.status) {
                case "already-logged-in": {
                    const text =
                        `You're already signed into ${friendlyName}. ` +
                        "I'll use it for app generation.";
                    if (callback) await callback({ text, actions: [name] });
                    return {
                        success: true,
                        text,
                        data: { actionName: name, status: result.status },
                    };
                }
                case "logged-in": {
                    const text =
                        friendlyName === "Claude"
                            ? "Signed in to Claude. You can now ask me to 'build me a calendar' with real codegen."
                            : "Signed in to Codex. You can now ask me to 'build me a calendar' with real codegen.";
                    if (callback) await callback({ text, actions: [name] });
                    return {
                        success: true,
                        text,
                        data: { actionName: name, status: result.status },
                    };
                }
                case "no-binary": {
                    const text =
                        `I can't find the ${friendlyName} CLI on this system (expected at ${provider.binaryPath}). ` +
                        `On the live USB it ships in the squashfs; if you're in dev, install it on PATH as '${provider.binaryName}'.`;
                    if (callback) await callback({ text, actions: [name] });
                    return { success: false, text, data: { actionName: name, status: result.status } };
                }
                case "no-url": {
                    const snippet = result.stdout.trim().split("\n").slice(0, 3).join(" ").slice(0, 200);
                    const detail = snippet.length > 0 ? ` (CLI said: "${snippet}")` : "";
                    const text =
                        `I couldn't drive the ${friendlyName} login flow — the CLI didn't print an OAuth URL${detail}. ` +
                        `Try opening a terminal and running '${provider.binaryName} ${provider.loginArgs.join(" ")}' directly.`;
                    if (callback) await callback({ text, actions: [name] });
                    return { success: false, text, data: { actionName: name, status: result.status } };
                }
                case "timeout": {
                    const text =
                        `I didn't see the sign-in complete — want to try again? ` +
                        `If something went wrong, you can close the browser window.`;
                    if (callback) await callback({ text, actions: [name] });
                    return { success: false, text, data: { actionName: name, status: result.status } };
                }
            }
        },

        examples,
    };
}

export const LOGIN_CLAUDE_ACTION = makeLoginAction(
    "LOGIN_CLAUDE",
    [
        "log into claude",
        "login to claude",
        "use claude code",
        "sign into claude",
        "authenticate claude",
        "claude login",
        "set up claude",
    ],
    CLAUDE_PROVIDER,
    [
        [
            { name: "{{user}}", content: { text: "log into claude" } },
            {
                name: "Eliza",
                content: {
                    text: "I've opened the sign-in page for you — finish there and I'll pick up the rest.",
                },
            },
        ],
        [
            { name: "{{user}}", content: { text: "claude login" } },
            {
                name: "Eliza",
                content: { text: "You're already signed into Claude. I'll use it for app generation." },
            },
        ],
    ],
);

export const LOGIN_CODEX_ACTION = makeLoginAction(
    "LOGIN_CODEX",
    [
        "log into codex",
        "login to codex",
        "sign into codex",
        "codex login",
        "use codex",
    ],
    CODEX_PROVIDER,
    [
        [
            { name: "{{user}}", content: { text: "log into codex" } },
            {
                name: "Eliza",
                content: {
                    text: "I've opened the sign-in page for you — finish there and I'll pick up the rest.",
                },
            },
        ],
        [
            { name: "{{user}}", content: { text: "codex login" } },
            {
                name: "Eliza",
                content: { text: "Signed in to Codex. You can now ask me to 'build me a calendar' with real codegen." },
            },
        ],
    ],
);

/** Test-only exports — not part of the runtime surface. */
export const __test = {
    defaultSpawn,
    resolveBinary,
};
