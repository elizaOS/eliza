// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Unit tests for `claude-cloud-plugin.ts`. The only side-effect boundary
 * is `Bun.spawn`/`child_process.spawn` (we shell out to `claude --print`),
 * so every test injects a fake spawn + a fake `isSignedIn` to keep the
 * suite hermetic. None of these tests run the real claude binary.
 *
 * The plugin is the new TEXT_LARGE provider: registered after the local
 * 1B Llama plugin with `priority: 100`, so once Claude is signed in
 * `runtime.useModel(TEXT_LARGE)` (called from `rephraseAsEliza`) routes
 * to sonnet via the CLI instead of the local llama.cpp stack.
 */

import { describe, expect, test } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";

import type { SpawnFn, SpawnHandle } from "../src/runtime/actions/login-claude.ts";
import {
    claudeCloudPlugin,
    createClaudeCloudPlugin,
    generateViaClaude,
} from "../src/runtime/claude-cloud-plugin.ts";

const fakeRuntime = {} as unknown as IAgentRuntime;

/**
 * Build a SpawnHandle that resolves with the given stdout/exit code on
 * the next macrotask. Same shape as `login-claude.test.ts`'s harness so
 * the two suites stay aligned.
 */
function fakeHandle(opts: {
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    delayMs?: number;
}): SpawnHandle {
    const stdoutBuf = { value: opts.stdout ?? "" };
    const stderrBuf = { value: opts.stderr ?? "" };
    let killed = false;
    const exit = new Promise<number | null>((resolve) => {
        setTimeout(() => {
            if (killed) return;
            resolve(opts.exitCode ?? 0);
        }, opts.delayMs ?? 0);
    });
    return {
        exit,
        stdoutBuf,
        stderrBuf,
        kill: () => {
            killed = true;
        },
    } satisfies SpawnHandle;
}

/** A spawn handle that never resolves until killed — for timeout tests. */
function hangingHandle(): SpawnHandle {
    let resolveExit: ((v: number | null) => void) | null = null;
    const exit = new Promise<number | null>((resolve) => {
        resolveExit = resolve;
    });
    return {
        exit,
        stdoutBuf: { value: "" },
        stderrBuf: { value: "" },
        kill: () => {
            if (resolveExit !== null) resolveExit(null);
        },
    } satisfies SpawnHandle;
}

describe("generateViaClaude — happy path", () => {
    test("returns trimmed stdout when claude exits 0", async () => {
        const spawnFn: SpawnFn = () =>
            fakeHandle({ stdout: "  Hi nubs — calendar is up.  \n", exitCode: 0 });
        const out = await generateViaClaude(
            fakeRuntime,
            { prompt: "Say hi." },
            {
                spawnFn,
                isSignedInFn: () => true,
                binaryExistsFn: () => true,
                timeoutMs: 1000,
            },
        );
        expect(out).toBe("Hi nubs — calendar is up.");
    });

    test("passes --model and the prompt as final positional arg", async () => {
        const captured: { cmd?: string; args?: readonly string[] } = {};
        const spawnFn: SpawnFn = (cmd, args) => {
            captured.cmd = cmd;
            captured.args = args;
            return fakeHandle({ stdout: "ok", exitCode: 0 });
        };
        await generateViaClaude(
            fakeRuntime,
            { prompt: "rephrase this" },
            {
                spawnFn,
                isSignedInFn: () => true,
                binaryExistsFn: () => true,
                timeoutMs: 1000,
                maxTokens: 150,
                model: "claude-sonnet-test",
                binaryPath: "/fake/claude",
            },
        );
        expect(captured.cmd).toBe("/fake/claude");
        // claude CLI 2.x argv: --print --model <id> <prompt>. No --max-tokens
        // (CLI rejects it; the prompt instruction caps length instead).
        const args = captured.args ?? [];
        expect(args[0]).toBe("--print");
        expect(args[1]).toBe("--model");
        expect(args[2]).toBe("claude-sonnet-test");
        expect(args[3]).toBe("rephrase this");
        expect(args).not.toContain("--max-tokens");
    });

    test("stitches `system` block onto the user prompt", async () => {
        let capturedPrompt = "";
        const spawnFn: SpawnFn = (_cmd, args) => {
            capturedPrompt = String(args[args.length - 1]);
            return fakeHandle({ stdout: "ok", exitCode: 0 });
        };
        await generateViaClaude(
            fakeRuntime,
            { system: "You are Eliza.", prompt: "Hi." },
            {
                spawnFn,
                isSignedInFn: () => true,
                binaryExistsFn: () => true,
                timeoutMs: 1000,
            },
        );
        expect(capturedPrompt).toContain("You are Eliza.");
        expect(capturedPrompt).toContain("Hi.");
        // The system text should come first so claude treats it as the
        // persona prefix, not the user's question.
        expect(capturedPrompt.indexOf("You are Eliza.")).toBeLessThan(
            capturedPrompt.indexOf("Hi."),
        );
    });
});

describe("generateViaClaude — failure modes (caller falls back via try/catch)", () => {
    test("throws on non-zero exit so rephraseAsEliza falls back to preset", async () => {
        const spawnFn: SpawnFn = () =>
            fakeHandle({ stdout: "", stderr: "fatal: rate limited", exitCode: 1 });
        await expect(
            generateViaClaude(
                fakeRuntime,
                { prompt: "Say hi." },
                {
                    spawnFn,
                    isSignedInFn: () => true,
                    binaryExistsFn: () => true,
                    timeoutMs: 1000,
                },
            ),
        ).rejects.toThrow(/exited 1/);
    });

    test("throws on empty stdout even with exit 0", async () => {
        const spawnFn: SpawnFn = () =>
            fakeHandle({ stdout: "   \n  \t  ", exitCode: 0 });
        await expect(
            generateViaClaude(
                fakeRuntime,
                { prompt: "Say hi." },
                {
                    spawnFn,
                    isSignedInFn: () => true,
                    binaryExistsFn: () => true,
                    timeoutMs: 1000,
                },
            ),
        ).rejects.toThrow(/empty/);
    });

    test("times out cleanly when claude hangs and reports elapsed ms", async () => {
        let killCalls = 0;
        const spawnFn: SpawnFn = () => {
            const h = hangingHandle();
            return {
                ...h,
                kill: (sig) => {
                    killCalls += 1;
                    h.kill(sig);
                },
            } satisfies SpawnHandle;
        };
        await expect(
            generateViaClaude(
                fakeRuntime,
                { prompt: "Say hi." },
                {
                    spawnFn,
                    isSignedInFn: () => true,
                    binaryExistsFn: () => true,
                    timeoutMs: 30,
                },
            ),
        ).rejects.toThrow(/timed out/);
        expect(killCalls).toBeGreaterThanOrEqual(1);
    });
});

describe("generateViaClaude — availability gate", () => {
    test("delegates to local-llama (does NOT spawn claude) when claude is signed out", async () => {
        // `@elizaos/core`'s model resolver does NOT cascade to the next
        // tier on throw — it surfaces the throw to the caller. So when
        // claude is signed out we have to delegate to the local-llama
        // fallback ourselves; otherwise `runChatModel` ends up returning
        // its "I can't reach my local model" preset instead of a real 1B
        // reply.
        let spawned = false;
        const spawnFn: SpawnFn = () => {
            spawned = true;
            return fakeHandle({ stdout: "should never be reached", exitCode: 0 });
        };
        let fallbackCalled = false;
        const out = await generateViaClaude(
            fakeRuntime,
            { prompt: "Say hi." },
            {
                spawnFn,
                isSignedInFn: () => false,
                binaryExistsFn: () => true,
                timeoutMs: 1000,
                fallbackFn: async () => {
                    fallbackCalled = true;
                    return "local-llama-reply";
                },
            },
        );
        expect(fallbackCalled).toBe(true);
        expect(out).toBe("local-llama-reply");
        expect(spawned).toBe(false);
    });

    test("delegates to local-llama when the claude binary is missing", async () => {
        let spawned = false;
        const spawnFn: SpawnFn = () => {
            spawned = true;
            return fakeHandle({ stdout: "x", exitCode: 0 });
        };
        let fallbackCalled = false;
        const out = await generateViaClaude(
            fakeRuntime,
            { prompt: "Say hi." },
            {
                spawnFn,
                isSignedInFn: () => true,
                binaryExistsFn: () => false,
                timeoutMs: 1000,
                binaryPath: "/nope/claude",
                fallbackFn: async () => {
                    fallbackCalled = true;
                    return "local-llama-reply";
                },
            },
        );
        expect(fallbackCalled).toBe(true);
        expect(out).toBe("local-llama-reply");
        expect(spawned).toBe(false);
    });

    test("throws on empty prompt instead of paying for an empty request", async () => {
        await expect(
            generateViaClaude(
                fakeRuntime,
                { prompt: "   " },
                {
                    spawnFn: () => fakeHandle({ stdout: "x", exitCode: 0 }),
                    isSignedInFn: () => true,
                    binaryExistsFn: () => true,
                    timeoutMs: 1000,
                },
            ),
        ).rejects.toThrow(/empty prompt/);
    });
});

describe("Plugin shape", () => {
    test("default plugin registers a TEXT_LARGE handler with priority 100", () => {
        expect(claudeCloudPlugin.name).toBe("usbeliza-claude-cloud");
        expect(claudeCloudPlugin.priority).toBe(100);
        expect(claudeCloudPlugin.models).toBeDefined();
        expect(claudeCloudPlugin.models?.[ModelType.TEXT_LARGE]).toBeDefined();
    });

    test("factory-built plugin routes useModel-shaped calls through generateViaClaude", async () => {
        const plugin = createClaudeCloudPlugin({
            spawnFn: () => fakeHandle({ stdout: "factory-output", exitCode: 0 }),
            isSignedInFn: () => true,
            binaryExistsFn: () => true,
            timeoutMs: 1000,
        });
        const handler = plugin.models?.[ModelType.TEXT_LARGE];
        if (handler === undefined) throw new Error("expected handler");
        const out = await handler(fakeRuntime, { prompt: "ping" });
        expect(out).toBe("factory-output");
    });

    test("factory-built plugin delegates to the local-llama fallback when signed out", async () => {
        const plugin = createClaudeCloudPlugin({
            spawnFn: () => fakeHandle({ stdout: "should-not-fire", exitCode: 0 }),
            isSignedInFn: () => false,
            binaryExistsFn: () => true,
            timeoutMs: 1000,
            fallbackFn: async () => "fallback-reply",
        });
        const handler = plugin.models?.[ModelType.TEXT_LARGE];
        if (handler === undefined) throw new Error("expected handler");
        const out = await handler(fakeRuntime, { prompt: "ping" });
        expect(out).toBe("fallback-reply");
    });
});
