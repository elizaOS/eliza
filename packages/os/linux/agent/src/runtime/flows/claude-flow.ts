// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Multi-turn Claude sign-in flow.
 *
 * Claude CLI 2.1+ ships a `paste-code` OAuth where the redirect lands
 * on `https://platform.claude.com/oauth/code/callback` and shows the
 * user an auth code to paste back into the CLI's terminal prompt. The
 * earlier "localhost callback server" pattern is gone, so we can't
 * auto-detect completion — the human has to copy the code from the web
 * page into chat.
 *
 *   step "awaiting-code"  — claude CLI is alive, stdin connected to a
 *                          pipe we hold. Chromium has been opened with
 *                          the OAuth URL. Next user message is the
 *                          code — we write it to the CLI's stdin and
 *                          wait for "Login successful." on stdout.
 *
 * The CLI's PKCE code_challenge is generated per-spawn and lives in
 * the CLI process's memory, so we MUST keep the same CLI process alive
 * across the multi-turn boundary. Module-level `ACTIVE` map keeps the
 * ChildProcess reachable; the FlowState on disk only stores breadcrumbs.
 * If the agent restarts mid-flow, the map empties and we abort with a
 * "let's start over" reply.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

import { CLAUDE_PROVIDER } from "../actions/login-claude.ts";
import { closeUrl, openUrl } from "../actions/open-url.ts";
import { markSignedIn } from "../auth/state.ts";
import { clearFlow, setFlow, type FlowState } from "./state.ts";

/**
 * Module-level handle to the running claude CLI subprocess + the
 * chromium window we popped for OAuth. Keyed by flowId so the same
 * flow file can host multiple providers later (codex etc).
 */
interface ActiveClaudeFlow {
    readonly child: ChildProcess;
    readonly oauthUrl: string;
    /** Buffer accumulator for stdout — we look for "Login successful." */
    stdout: string;
    /** Buffer accumulator for stderr — surface failures verbatim. */
    stderr: string;
}
const ACTIVE = new Map<string, ActiveClaudeFlow>();

export interface ClaudeFlowReply {
    readonly reply: string;
    /** True when this turn ended the flow (success / bail / hard failure). */
    readonly done: boolean;
}

const URL_RE = /(https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+)/;
const SUCCESS_RE = /Login successful\.?/i;
/** Looks like a claude auth code: long token with a `#` separator. */
const CODE_RE = /^[A-Za-z0-9_\-]{16,}#[A-Za-z0-9_\-]{16,}\s*$/;

/**
 * Spawn `claude auth login`, capture the OAuth URL it prints, open
 * chromium pointed at it, and stash the running child for the
 * code-paste step.
 *
 * On any spawn / parse failure we return a `done: true` reply with a
 * graceful-degrade message — onboarding (or the action caller) can
 * proceed without auth. The flow state is NOT set in that case.
 */
export async function beginClaudeFlow(): Promise<ClaudeFlowReply> {
    // Fast path: already signed in.
    if (existsSync(CLAUDE_PROVIDER.tokenFile)) {
        return {
            reply: "Looks like Claude is already signed in. Ready when you are.",
            done: true,
        };
    }

    const cmd = (() => {
        if (existsSync(CLAUDE_PROVIDER.binaryPath)) return CLAUDE_PROVIDER.binaryPath;
        for (const p of ["/usr/local/bin/claude", "/usr/bin/claude"]) {
            if (existsSync(p)) return p;
        }
        return null;
    })();
    if (cmd === null) {
        return {
            reply: "The claude CLI isn't on this image — I'll stay local.",
            done: true,
        };
    }

    // Spawn the CLI with stdin connected so we can paste the code in
    // when the user gives it to us. The CLI prints the OAuth URL to
    // stdout, waits for "Paste code here >" on stdin, then exits 0 on
    // success.
    let child: ChildProcess;
    try {
        child = spawn(cmd, ["auth", "login", "--claudeai"], {
            // Important: stdin is a PIPE we hold open across turns.
            stdio: ["pipe", "pipe", "pipe"],
            // BROWSER=/bin/true so claude CLI's own xdg-open call no-ops;
            // we open the chromium window ourselves (chrome-less, sized).
            env: { ...process.env, BROWSER: "/bin/true" },
        });
    } catch (err) {
        return {
            reply: `Couldn't start the claude sign-in: ${(err as Error).message}. Staying local for now.`,
            done: true,
        };
    }

    // Scrape stdout for the OAuth URL. Timeout 8s.
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
    });

    const deadline = Date.now() + 8000;
    let url: string | null = null;
    while (Date.now() < deadline) {
        const match = URL_RE.exec(stdout);
        if (match) {
            url = match[1] ?? null;
            break;
        }
        await new Promise((r) => setTimeout(r, 200));
    }

    if (url === null) {
        child.kill();
        return {
            reply:
                "I couldn't get a sign-in URL from claude — the CLI didn't print one in time. " +
                "Try again in a moment, or open a terminal and run `claude auth login` manually.",
            done: true,
        };
    }

    // Open the chromium window pointing at the OAuth URL. Chrome-less
    // app mode (--app=URL) so the user sees just the auth page, no
    // tabs / URL bar / menu.
    openUrl(url, { appIdSuffix: "oauth-claude" });

    const flowId = "claude-signin";
    ACTIVE.set(flowId, {
        child,
        oauthUrl: url,
        stdout,
        stderr,
    });
    // Keep the stdout buffer growing so we can see "Login successful."
    child.stdout?.on("data", (chunk: Buffer) => {
        const handle = ACTIVE.get(flowId);
        if (handle !== undefined) handle.stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        const handle = ACTIVE.get(flowId);
        if (handle !== undefined) handle.stderr += chunk.toString();
    });
    // If the child dies unexpectedly, clean up so the next turn knows.
    child.on("exit", () => {
        ACTIVE.delete(flowId);
    });

    setFlow({
        schema_version: 1,
        flowId,
        step: "awaiting-code",
        data: {},
        updatedAt: Date.now(),
    });

    return {
        reply:
            "I opened the Claude sign-in page for you. After you sign in, " +
            "claude.ai will show an Authentication Code — copy that and paste " +
            "it here in chat. (It's a long string with a `#` in the middle.)",
        done: false,
    };
}

/**
 * Process the user's message during the awaiting-code step. We expect
 * a single token in the standard claude format (`<base64>#<base64>`).
 * Anything else gets a gentle clarification.
 */
export async function continueClaudeFlow(
    message: string,
    state: FlowState,
): Promise<ClaudeFlowReply> {
    if (state.flowId !== "claude-signin") {
        return {
            reply: "I lost track of the sign-in — try `login to claude` again.",
            done: true,
        };
    }

    const handle = ACTIVE.get("claude-signin");
    if (handle === undefined) {
        clearFlow();
        return {
            reply:
                "The sign-in process restarted (the CLI exited). " +
                "Try `login to claude` to start over.",
            done: true,
        };
    }

    const candidate = message.trim();
    if (!CODE_RE.test(candidate)) {
        return {
            reply:
                "That doesn't look like the auth code. It's the long string " +
                "that claude.ai shows after you sign in — letters / numbers / " +
                "underscores with a `#` in the middle. Try again.",
            done: false,
        };
    }

    // Write the code + newline to claude's stdin. The CLI will
    // exchange it for a token, print "Login successful.", and exit 0.
    handle.child.stdin?.write(`${candidate}\n`);

    // Race the child's exit against a wall-clock timeout. On success,
    // the CLI exits 0 within ~3s; on a bad code, it prints an error
    // and exits non-zero.
    const result = await Promise.race([
        new Promise<{ kind: "exit"; code: number | null }>((resolve) =>
            handle.child.on("exit", (code) => resolve({ kind: "exit", code })),
        ),
        new Promise<{ kind: "timeout" }>((resolve) =>
            setTimeout(() => resolve({ kind: "timeout" }), 30000),
        ),
    ]);

    // Close the chromium window — auth flow is over either way.
    closeUrl(handle.oauthUrl);
    ACTIVE.delete("claude-signin");
    clearFlow();

    if (result.kind === "timeout") {
        handle.child.kill();
        return {
            reply:
                "The sign-in didn't complete in 30 seconds. " +
                "Try `login to claude` again — it usually goes faster.",
            done: true,
        };
    }

    if (result.code === 0 || SUCCESS_RE.test(handle.stdout)) {
        // Write the agent's auth marker so chat-fallthrough + rephrase
        // start routing through cloud Claude. Idempotent if the marker
        // already exists.
        try {
            markSignedIn("claude");
        } catch {
            // Marker write failed (read-only fs etc) — auth still works,
            // just won't be detected by claude-cloud-plugin until next
            // boot writes it.
        }
        return {
            reply:
                "Signed in. Cloud Claude's online now — I'll route everything " +
                "through it from here.",
            done: true,
        };
    }

    // Non-zero exit means the CLI rejected the code (PKCE mismatch,
    // expired, or wrong code). Surface a short tail of stderr.
    const tail = handle.stderr.trim().slice(-300);
    return {
        reply:
            `Claude rejected that code (exit ${result.code ?? "?"})` +
            (tail.length > 0 ? `: ${tail}` : "") +
            ". Try `login to claude` again — sometimes the code expires.",
        done: true,
    };
}

/**
 * Detect the message that starts a claude sign-in. Mirrors the
 * LOGIN_CLAUDE action's similes but is gated by the dispatcher BEFORE
 * action selection so the multi-turn flow wins.
 */
export function shouldStartClaudeFlow(message: string): boolean {
    const norm = message.trim().toLowerCase();
    if (norm.length === 0) return false;
    const triggers = [
        "log into claude",
        "login to claude",
        "log in to claude",
        "sign into claude",
        "sign in to claude",
        "sign me into claude",
        "claude sign in",
        "claude login",
        "use claude code",
        "connect claude",
    ];
    return triggers.some((t) => norm === t || norm.includes(t));
}
