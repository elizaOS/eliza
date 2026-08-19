/**
 * Deterministic hang and overflow coverage for `claude -p` stdio collection.
 * The harness uses real ReadableStreams and controlled child-process fakes so
 * the timeout remains authoritative even when termination does not settle I/O.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CLI_MAX_STDIO_BYTES,
  collectClaudeCliOutput,
  readClaudeCliStreamBudget,
  streamViaCli,
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
  const kill = vi.fn(() => {
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

function stubbornProcess() {
  return {
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
    exited: new Promise<number>(() => undefined),
    kill: vi.fn(() => undefined),
  };
}

function runtimeStub(): IAgentRuntime {
  return {
    character: { name: "CLI budget test" },
    emitEvent: vi.fn(async () => undefined),
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("also rejects a hung process when kill does not settle its streams or exit promise", async () => {
    const proc = stubbornProcess();
    await expect(collectClaudeCliOutput(proc, { timeoutMs: 20, maxBytes: 1024 })).rejects.toThrow(
      /timed out after 20ms/
    );
    expect(proc.kill).toHaveBeenCalled();
  });

  it("rejects stdout that exceeds the decoded-byte cap before JSON.parse", async () => {
    const overflow = "x".repeat(128);
    const proc = {
      stdout: streamOf(overflow),
      stderr: streamOf(""),
      exited: Promise.resolve(0),
      kill: vi.fn(() => undefined),
    };
    await expect(collectClaudeCliOutput(proc, { timeoutMs: 1_000, maxBytes: 64 })).rejects.toThrow(
      /stdout exceeded 64 bytes/
    );
    expect(proc.kill).toHaveBeenCalled();
  });

  it("kills the child when stderr exceeds its budget", async () => {
    const proc = {
      stdout: streamOf(""),
      stderr: streamOf("x".repeat(128)),
      exited: new Promise<number>(() => undefined),
      kill: vi.fn(() => undefined),
    };
    await expect(collectClaudeCliOutput(proc, { timeoutMs: 1_000, maxBytes: 64 })).rejects.toThrow(
      /stderr exceeded 64 bytes/
    );
    expect(proc.kill).toHaveBeenCalled();
  });

  it("admits a small result inside the budget", async () => {
    const proc = {
      stdout: streamOf('{"result":"ok"}'),
      stderr: streamOf(""),
      exited: Promise.resolve(0),
      kill: vi.fn(() => undefined),
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

  it("drains and bounds streaming stderr without reporting a healthy finish", async () => {
    const proc = {
      stdout: new ReadableStream<Uint8Array>(),
      stderr: streamOf("x".repeat(CLAUDE_CLI_MAX_STDIO_BYTES + 1)),
      exited: new Promise<number>(() => undefined),
      kill: vi.fn(() => undefined),
    };
    vi.stubGlobal("Bun", { spawn: vi.fn(() => proc) });

    const result = streamViaCli(runtimeStub(), "hello", "claude-test", "TEXT_SMALL");
    const consume = async () => {
      for await (const _chunk of result.textStream) {
        // No chunks are expected; consuming drives the supervised stream.
      }
    };

    await expect(consume()).rejects.toThrow(/stderr exceeded 8388608 bytes/);
    await expect(result.finishReason).resolves.toBe("error");
    expect(proc.kill).toHaveBeenCalled();
  });
});
