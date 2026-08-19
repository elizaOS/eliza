/**
 * Deterministic hang/overflow coverage for `claude -p` stdio collection.
 * The harness builds real ReadableStreams (no live CLI). Origin
 * `new Response(proc.stdout).text()` stayed pending at 401ms when the
 * stream never closed; the collector must fail closed on that class.
 */
import { describe, expect, it, mock } from "bun:test";
import {
  CLAUDE_CLI_MAX_STDIO_BYTES,
  collectClaudeCliOutput,
  readClaudeCliStreamBudget,
} from "../utils/claude-cli";

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text.length > 0) {
        controller.enqueue(new TextEncoder().encode(text));
      }
      controller.close();
    },
  });
}

function hungProcess() {
  let closeStdout: (() => void) | undefined;
  let resolveExit: ((code: number) => void) | undefined;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      closeStdout = () => {
        try {
          controller.close();
        } catch {
          // already closed by a prior kill
        }
      };
    },
  });
  const kill = mock(() => {
    closeStdout?.();
    resolveExit?.(143);
  });
  return {
    stdout,
    stderr: streamOf(""),
    exited: new Promise<number>((resolve) => {
      resolveExit = resolve;
    }),
    kill,
  };
}

describe("claude CLI stdio budget", () => {
  it("rejects a never-ending stdout stream instead of awaiting text() forever", async () => {
    const proc = hungProcess();
    const started = Date.now();
    await expect(collectClaudeCliOutput(proc, { timeoutMs: 40, maxBytes: 1024 })).rejects.toThrow(
      /timed out after 40ms/
    );
    expect(Date.now() - started).toBeLessThan(400);
    expect(proc.kill).toHaveBeenCalled();
  });

  it("rejects stdout that exceeds the decoded-byte cap before JSON.parse", async () => {
    const overflow = "x".repeat(128);
    const proc = {
      stdout: streamOf(overflow),
      stderr: streamOf(""),
      exited: Promise.resolve(0),
      kill: mock(() => undefined),
    };
    await expect(collectClaudeCliOutput(proc, { timeoutMs: 1_000, maxBytes: 64 })).rejects.toThrow(
      /stdout exceeded 64 bytes/
    );
  });

  it("admits a small result inside the budget", async () => {
    const proc = {
      stdout: streamOf('{"result":"ok"}'),
      stderr: streamOf(""),
      exited: Promise.resolve(0),
      kill: mock(() => undefined),
    };
    const collected = await collectClaudeCliOutput(proc, {
      timeoutMs: 1_000,
      maxBytes: 1024,
    });
    expect(collected.output).toBe('{"result":"ok"}');
    expect(collected.exitCode).toBe(0);
  });

  it("credits stream chunks and rejects past the helper cap", async () => {
    await expect(readClaudeCliStreamBudget(streamOf("abcdefghij"), 4, "stdout")).rejects.toThrow(
      /stdout exceeded 4 bytes/
    );
    expect(CLAUDE_CLI_MAX_STDIO_BYTES).toBe(8 * 1024 * 1024);
  });
});
