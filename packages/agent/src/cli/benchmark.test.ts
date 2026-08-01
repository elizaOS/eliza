/**
 * Exercises benchmark result, cancellation, validation, and command cleanup.
 * Live-model proof covers the production model and PGLite path separately.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, DefaultMessageService } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseBenchmarkTask,
  runBenchmark,
  runBenchmarkTask,
} from "./benchmark.ts";

const lifecycle = vi.hoisted(() => ({
  boot: vi.fn(),
  shutdown: vi.fn(),
}));

vi.mock("../runtime/eliza.ts", () => ({
  bootElizaRuntime: lifecycle.boot,
  shutdownRuntime: lifecycle.shutdown,
}));

function createRuntime(): AgentRuntime {
  const runtime = new AgentRuntime({ logLevel: "fatal" });
  runtime.messageService = new DefaultMessageService();
  vi.spyOn(runtime, "ensureConnection").mockResolvedValue(undefined);
  return runtime;
}

function getMessageService(runtime: AgentRuntime): DefaultMessageService {
  const service = runtime.messageService;
  if (!(service instanceof DefaultMessageService)) {
    throw new Error("Expected the benchmark test message service");
  }
  return service;
}

describe("runBenchmarkTask", () => {
  it("passes owner cancellation into the message loop and captures every output channel", async () => {
    const runtime = createRuntime();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let receivedText: string | undefined;
    vi.spyOn(getMessageService(runtime), "handleMessage").mockImplementation(
      async (_runtime, message, callback, options) => {
        receivedSignal = options?.abortSignal;
        receivedText = message.content.text;
        await options?.onStreamChunk?.("stream response");
        await callback?.({ text: "callback" }, "SEARCH");
        return {
          didRespond: true,
          responseContent: { text: "the final and longest response" },
          responseMessages: [],
        };
      },
    );

    const result = await runBenchmarkTask(
      runtime,
      { id: "complete", prompt: "Explain the result" },
      controller.signal,
    );

    expect(receivedSignal).toBe(controller.signal);
    expect(receivedText).toBe("Explain the result");
    expect(result).toMatchObject({
      id: "complete",
      response: "the final and longest response",
      actions_taken: ["SEARCH"],
      success: true,
    });
  });

  it("returns partial streamed output when the owner cancels without late completion", async () => {
    const runtime = createRuntime();
    const controller = new AbortController();
    let enteredMessageLoop: (() => void) | undefined;
    const messageLoopEntered = new Promise<void>((resolve) => {
      enteredMessageLoop = resolve;
    });
    vi.spyOn(getMessageService(runtime), "handleMessage").mockImplementation(
      async (_runtime, _message, _callback, options) => {
        await options?.onStreamChunk?.("partial response");
        enteredMessageLoop?.();
        await new Promise<void>((_resolve, reject) => {
          options?.abortSignal?.addEventListener(
            "abort",
            () => reject(options.abortSignal?.reason),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    );

    const task = runBenchmarkTask(
      runtime,
      { id: "cancel", prompt: "Wait for cancellation" },
      controller.signal,
    );
    await messageLoopEntered;
    controller.abort(new Error("owner cancelled"));

    await expect(task).resolves.toMatchObject({
      response: "partial response",
      success: false,
      error: "owner cancelled",
    });
  });

  it("does not report a completed non-response as success", async () => {
    const runtime = createRuntime();
    vi.spyOn(getMessageService(runtime), "handleMessage").mockResolvedValue({
      didRespond: false,
      responseContent: null,
      responseMessages: [],
      reason: "reply gate declined",
    });

    await expect(
      runBenchmarkTask(
        runtime,
        { id: "no-response", prompt: "Say something" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      response: "",
      success: false,
      error: "reply gate declined",
    });
  });
});

describe("parseBenchmarkTask", () => {
  it("validates the complete task boundary", () => {
    expect(
      parseBenchmarkTask(
        JSON.stringify({
          id: "valid",
          prompt: "Run it",
          type: "research",
          context: { source: "test" },
          expected: "done",
        }),
      ),
    ).toMatchObject({ id: "valid", prompt: "Run it" });
  });

  it.each([
    "null",
    "{}",
    JSON.stringify({ id: "", prompt: "Run it" }),
    JSON.stringify({ id: "x", prompt: 42 }),
    JSON.stringify({ id: "x", prompt: "Run it", type: 42 }),
    JSON.stringify({ id: "x", prompt: "Run it", context: [] }),
  ])("rejects malformed input: %s", (input) => {
    expect(() => parseBenchmarkTask(input)).toThrow("Invalid task JSON");
  });
});

describe("runBenchmark lifecycle", () => {
  let fixtureDir: string;
  let runtime: AgentRuntime;

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "eliza-benchmark-test-"));
    runtime = createRuntime();
    lifecycle.boot.mockReset().mockResolvedValue(runtime);
    lifecycle.shutdown.mockReset().mockResolvedValue(undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("shuts down the runtime after a successful task", async () => {
    vi.spyOn(getMessageService(runtime), "handleMessage").mockResolvedValue({
      didRespond: true,
      responseContent: { text: "done" },
      responseMessages: [],
    });
    const taskPath = join(fixtureDir, "task.json");
    await writeFile(taskPath, JSON.stringify({ id: "ok", prompt: "Run it" }));

    await runBenchmark({ task: taskPath });

    expect(lifecycle.boot).toHaveBeenCalledOnce();
    expect(lifecycle.shutdown).toHaveBeenCalledWith(
      runtime,
      "benchmark shutdown",
    );
    expect(process.exitCode).toBe(0);
  });

  it("rejects malformed task files before paying runtime boot cost", async () => {
    const taskPath = join(fixtureDir, "bad.json");
    await writeFile(taskPath, JSON.stringify({ id: "bad", prompt: null }));

    await runBenchmark({ task: taskPath });

    expect(lifecycle.boot).not.toHaveBeenCalled();
    expect(lifecycle.shutdown).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it("surfaces shutdown failure instead of leaving a successful exit status", async () => {
    vi.spyOn(getMessageService(runtime), "handleMessage").mockResolvedValue({
      didRespond: true,
      responseContent: { text: "done" },
      responseMessages: [],
    });
    lifecycle.shutdown.mockRejectedValue(new Error("close failed"));
    const taskPath = join(fixtureDir, "task.json");
    await writeFile(taskPath, JSON.stringify({ id: "ok", prompt: "Run it" }));

    await runBenchmark({ task: taskPath });

    expect(process.exitCode).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Runtime shutdown failed: close failed"),
    );
  });
});
