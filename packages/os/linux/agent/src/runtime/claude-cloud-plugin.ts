// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Cloud Claude as a TEXT_LARGE model provider — drives the same `claude`
 * CLI that `runtime/actions/login-claude.ts` signs the user into, but in
 * its non-interactive `--print` mode so `useModel(TEXT_LARGE)` produces
 * sentences from sonnet/opus instead of the 1B local Llama.
 *
 * Why a plugin and not a swap of the local-llama handler: the local 1B
 * is still load-bearing — it's the model on a fresh boot before any auth,
 * and the "claude got signed out" recovery path. By registering Claude as
 * a *higher-priority* TEXT_LARGE handler (Plugin.priority = 100 vs the
 * default 0 on local-llama-plugin), `@elizaos/core`'s model resolver will
 * pick Claude when it's available and silently fall back to local when
 * Claude's handler throws.
 *
 * The resolver code lives in @elizaos/core's `registerModel`:
 *
 *   models.sort((a, b) =>
 *     (b.priority - a.priority) || (a.registrationOrder - b.registrationOrder)
 *   );
 *
 * Higher priority wins; ties break on first-registered. We pin both —
 * `priority: 100` AND register after local-llama in `eliza.ts` — so the
 * choice is robust against either-tier changes upstream.
 *
 * Recovery semantics: when `isSignedIn("claude")` is false (the auth
 * marker at `~/.eliza/auth/claude.json` is missing or says `signed-out`)
 * the handler DELEGATES to the local-llama plugin's `generateViaLocalLlama`
 * function. We tried throwing first on the theory that `@elizaos/core`'s
 * resolver would cascade to the next-priority TEXT_LARGE provider — it
 * does not (resolver picks the top-priority handler and surfaces the
 * throw to the caller). So a chat-fallthrough hitting `useModel(TEXT_LARGE)`
 * with no claude auth would 100%-reliably return the `runChatModel`
 * "I can't reach my local model" preset instead of a real 1B reply.
 * Delegation is the correct shape: this plugin is *always available* as
 * a TEXT_LARGE provider; whether it goes through claude or local is an
 * internal implementation detail of the handler.
 *
 * The implementation is DI-friendly: tests inject `spawnFn` /
 * `isSignedInFn` / `binaryExistsFn` / `nowFn` via plugin options or
 * direct factory call. The default `spawnFn` is `node:child_process.spawn`
 * shaped to the same `SpawnHandle` interface `login-claude.ts` exports —
 * we reuse that type so tests share a mock harness.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
    ModelType,
    type IAgentRuntime,
    type Plugin,
} from "@elizaos/core";

import { isSignedIn } from "./auth/state.ts";
import { CLAUDE_PROVIDER, type SpawnFn, type SpawnHandle } from "./actions/login-claude.ts";
import { generateViaLocalLlama } from "./local-llama-plugin.ts";

/** Same shape as the local-llama handler param. */
interface TextParams {
    prompt?: string;
    system?: string;
    stopSequences?: string[];
    temperature?: number;
    maxTokens?: number;
}

/**
 * Hard cap on captured stdout/stderr bytes — a hostile or runaway claude
 * subprocess could otherwise pour gigabytes into the buffer. 256 KiB is
 * ~3x the largest sensible rephrase reply (300 chars).
 */
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Tight default timeout. claude usually replies in 2-4s; >12s is a hung
 * subprocess and the rephrase caller has its own 8s wrapper anyway, so
 * giving the spawn a hair more headroom than that lets the *spawn* fail
 * cleanly before the rephrase race-with-timeout fires.
 */
const DEFAULT_TIMEOUT_MS = 12_000;

/** Default rephrase token cap — enough for two sentences. */
const DEFAULT_MAX_TOKENS = 300;

/**
 * Default model. The task contract says sonnet for low latency; the
 * caller can override via the `USBELIZA_CLAUDE_MODEL` env var if a newer
 * fast model appears. We pin a concrete name rather than letting the CLI
 * default to opus-4-7 (slow + expensive).
 */
const DEFAULT_MODEL = "claude-sonnet-4-6";

export interface ClaudeCloudOptions {
    /** Override the spawn boundary (tests). Defaults to `defaultSpawn`. */
    spawnFn?: SpawnFn;
    /** Override the signed-in probe (tests). Defaults to `isSignedIn("claude")`. */
    isSignedInFn?: () => boolean;
    /** Override the binary-exists probe (tests). Defaults to `existsSync(CLAUDE_PROVIDER.binaryPath)`. */
    binaryExistsFn?: (path: string) => boolean;
    /** Override the wall-clock (tests). Defaults to `Date.now`. */
    nowFn?: () => number;
    /** Override the timeout. Defaults to `DEFAULT_TIMEOUT_MS`. */
    timeoutMs?: number;
    /** Override the max-tokens flag. Defaults to `DEFAULT_MAX_TOKENS`. */
    maxTokens?: number;
    /** Override the model name. Defaults to `DEFAULT_MODEL` or `$USBELIZA_CLAUDE_MODEL`. */
    model?: string;
    /** Override the binary path. Defaults to `CLAUDE_PROVIDER.binaryPath`. */
    binaryPath?: string;
    /**
     * Override the local-llama fallback (tests). Defaults to
     * `generateViaLocalLlama` imported from `./local-llama-plugin.ts`.
     * Production code uses the default; tests inject a stub so they
     * don't have to load a real GGUF.
     */
    fallbackFn?: (runtime: IAgentRuntime, params: TextParams) => Promise<string>;
}

/**
 * Production spawn implementation — same shape as `defaultSpawn` in
 * `login-claude.ts`, but capped at `MAX_OUTPUT_BYTES` so a runaway child
 * can't OOM the agent.
 */
function defaultSpawn(cmd: string, args: readonly string[]): SpawnHandle {
    const stdoutBuf = { value: "" };
    const stderrBuf = { value: "" };
    const child = spawn(cmd, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    // claude --print reads its prompt from argv, not stdin — close stdin
    // immediately so it doesn't hang waiting for EOF.
    try {
        child.stdin?.end();
    } catch {
        // Best-effort; if stdin is already closed (rare race with spawn
        // error), proceed.
    }
    const exit = new Promise<number | null>((resolve) => {
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutBuf.value.length >= MAX_OUTPUT_BYTES) return;
        stdoutBuf.value += chunk.toString();
        if (stdoutBuf.value.length > MAX_OUTPUT_BYTES) {
            stdoutBuf.value = stdoutBuf.value.slice(0, MAX_OUTPUT_BYTES);
            try {
                child.kill();
            } catch {
                // Already exiting — fine.
            }
        }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrBuf.value.length >= MAX_OUTPUT_BYTES) return;
        stderrBuf.value += chunk.toString();
        if (stderrBuf.value.length > MAX_OUTPUT_BYTES) {
            stderrBuf.value = stderrBuf.value.slice(0, MAX_OUTPUT_BYTES);
        }
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
 * Stitch the optional `system` block onto the user prompt. claude --print
 * has no separate system slot in its argv API, so we prepend the system
 * text the same way `rephraseAsEliza` does for the local-llama call.
 */
function buildPrompt(params: TextParams): string {
    const userPrompt = (params.prompt ?? "").trim();
    if (typeof params.system === "string" && params.system.length > 0) {
        return `${params.system}\n\n${userPrompt}`;
    }
    return userPrompt;
}

/**
 * Drive `claude --print` once. Returns the trimmed stdout on success;
 * throws on timeout / non-zero exit / empty reply so the caller's
 * try/catch falls back to a safer string.
 */
export async function generateViaClaude(
    runtime: IAgentRuntime,
    params: TextParams,
    options: ClaudeCloudOptions = {},
): Promise<string> {
    const isSignedInFn = options.isSignedInFn ?? (() => isSignedIn("claude"));
    const binaryPath = options.binaryPath ?? CLAUDE_PROVIDER.binaryPath;
    const binaryExistsFn = options.binaryExistsFn ?? ((p: string) => existsSync(p));
    const spawnFn = options.spawnFn ?? defaultSpawn;
    const nowFn = options.nowFn ?? Date.now;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fallbackFn = options.fallbackFn ?? generateViaLocalLlama;
    // maxTokens is currently a no-op — claude CLI 2.x lacks the flag; we
    // keep the option in the surface for future budget tooling and to
    // avoid breaking callers passing it through `useModel` params.
    const _maxTokensReserved = options.maxTokens ?? params.maxTokens ?? DEFAULT_MAX_TOKENS;
    void _maxTokensReserved;
    const model = options.model ?? process.env.USBELIZA_CLAUDE_MODEL ?? DEFAULT_MODEL;

    // Availability gate — when claude isn't reachable (signed out OR CLI
    // missing) delegate to local-llama instead of throwing. @elizaos/core's
    // resolver doesn't cascade providers on throw; the throw would surface
    // through `useModel` and the caller in `dispatch.runChatModel` would
    // fall back to a hardcoded "I can't reach my local model" preset —
    // exactly the wrong outcome since local-llama is right there.
    if (!isSignedInFn() || !binaryExistsFn(binaryPath)) {
        return fallbackFn(runtime, params);
    }

    const prompt = buildPrompt(params);
    if (prompt.length === 0) {
        throw new Error("usbeliza-claude-cloud: empty prompt");
    }

    // claude CLI 2.x doesn't expose a --max-tokens flag (only
    // --max-budget-usd for dollar caps). The prompt itself includes a
    // "<= 300 chars" instruction; claude respects it well enough that
    // hard-capping is unnecessary for the rephrase use case.
    const args = [
        "--print",
        "--model",
        model,
        prompt,
    ];

    const handle = spawnFn(binaryPath, args);

    // Race exit against a wall-clock timeout. We don't use AbortSignal
    // here because the `SpawnHandle` boundary we share with `login-claude`
    // exposes `kill()` directly — same shape for tests.
    const start = nowFn();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    const winner: number | null | "timeout" = await Promise.race([
        handle.exit,
        timedOut,
    ]);
    if (timer !== undefined) clearTimeout(timer);

    if (winner === "timeout") {
        handle.kill();
        const elapsed = nowFn() - start;
        throw new Error(
            `usbeliza-claude-cloud: claude --print timed out after ${elapsed}ms`,
        );
    }

    const exitCode = winner;
    if (exitCode !== 0) {
        const stderr = handle.stderrBuf.value.trim().slice(0, 400);
        const detail = stderr.length > 0 ? `: ${stderr}` : "";
        throw new Error(
            `usbeliza-claude-cloud: claude --print exited ${exitCode}${detail}`,
        );
    }

    const stdout = handle.stdoutBuf.value.trim();
    if (stdout.length === 0) {
        throw new Error("usbeliza-claude-cloud: claude --print returned empty");
    }
    return stdout;
}

/**
 * Build a plugin instance. Tests use the factory to inject hermetic
 * `spawnFn` / `isSignedInFn` and pin model + timeout. Production code
 * imports the default-export `claudeCloudPlugin` below.
 */
export function createClaudeCloudPlugin(options: ClaudeCloudOptions = {}): Plugin {
    return {
        name: "usbeliza-claude-cloud",
        description:
            "Cloud Claude as the TEXT_LARGE provider via `claude --print` " +
            "(non-interactive mode). Higher-priority than local-llama-plugin, " +
            "so once the user is signed into Claude every rephrase + chat " +
            "fallthrough comes from sonnet. Throws when claude is signed out " +
            "so `rephraseAsEliza`'s preset fallback wins instead of the 1B.",
        // Higher than the default 0 used by local-llama-plugin so the core
        // resolver picks Claude when both are registered. See the file
        // header for the resolver semantics.
        priority: 100,
        models: {
            [ModelType.TEXT_LARGE]: async (runtime, params) =>
                generateViaClaude(runtime, params as unknown as TextParams, options),
        },
    };
}

/** Production plugin instance with default DI. */
export const claudeCloudPlugin: Plugin = createClaudeCloudPlugin();

/** Test-only exports. */
export const __test = {
    defaultSpawn,
    buildPrompt,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_TOKENS,
    DEFAULT_MODEL,
};
