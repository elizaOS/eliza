/**
 * Exercises benchmark result, cancellation, validation, and command cleanup.
 * Live-model proof covers the production model and PGLite path separately.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { AgentRuntime, DefaultMessageService } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installOwnerSignalHandlers,
  parseBenchmarkCommandOptions,
  parseBenchmarkTask,
  readBenchmarkInput,
  runBenchmark,
  runBenchmarkServer,
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

function installCodingActions(runtime: AgentRuntime): void {
  for (const name of ["READ", "WRITE", "EDIT", "SHELL"]) {
    runtime.actions.push({ name } as never);
  }
}

describe("runBenchmarkTask", () => {
  it("passes owner cancellation into the message loop and captures every output channel", async () => {
    const runtime = createRuntime();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let receivedCodingMode: boolean | undefined;
    let receivedText: string | undefined;
    let receivedBenchmarkContext: string | undefined;
    vi.spyOn(getMessageService(runtime), "handleMessage").mockImplementation(
      async (_runtime, message, callback, options) => {
        receivedSignal = options?.abortSignal;
        receivedCodingMode = options?.codingMode;
        receivedText = message.content.text;
        receivedBenchmarkContext =
          message.metadata?.type === "message"
            ? message.metadata.benchmarkContext
            : undefined;
        await options?.onStreamChunk?.("stream response");
        await callback?.(
          { text: "callback output that is longer than the final response" },
          "SEARCH",
        );
        return {
          didRespond: true,
          responseContent: { text: "the final response" },
          responseMessages: [],
        };
      },
    );

    const result = await runBenchmarkTask(
      runtime,
      {
        id: "complete",
        prompt: "Explain the result",
        context: { fixture: "ground truth" },
      },
      controller.signal,
    );

    expect(receivedSignal).toBe(controller.signal);
    expect(receivedCodingMode).toBeUndefined();
    expect(receivedText).toBe("Explain the result");
    expect(receivedBenchmarkContext).toBe('{"fixture":"ground truth"}');
    expect(result).toMatchObject({
      id: "complete",
      response: "the final response",
      actions_taken: ["SEARCH"],
      success: true,
    });
  });

  it("routes explicit coding tasks through the coding message loop", async () => {
    const runtime = createRuntime();
    installCodingActions(runtime);
    let receivedCodingMode: boolean | undefined;
    vi.spyOn(getMessageService(runtime), "handleMessage").mockImplementation(
      async (_runtime, _message, _callback, options) => {
        receivedCodingMode = options?.codingMode;
        return {
          didRespond: true,
          responseContent: { text: "implemented and verified" },
          responseMessages: [],
        };
      },
    );

    const result = await runBenchmarkTask(
      runtime,
      { id: "coding", type: "coding", prompt: "Fix the parser" },
      new AbortController().signal,
    );

    expect(receivedCodingMode).toBe(true);
    expect(result).toMatchObject({ task_type: "coding", success: true });
  });

  it("fails closed before model inference when coding tools are unavailable", async () => {
    const runtime = createRuntime();
    const handleMessage = vi.spyOn(getMessageService(runtime), "handleMessage");

    const result = await runBenchmarkTask(
      runtime,
      { id: "missing-tools", type: "coding", prompt: "Fix the parser" },
      new AbortController().signal,
    );

    expect(handleMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      task_type: "coding",
      success: false,
      response: "",
      error:
        "Coding benchmark runtime is missing required actions: READ, WRITE, EDIT, SHELL",
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

describe("parseBenchmarkCommandOptions", () => {
  it("parses the supported one-shot and server flags", () => {
    expect(
      parseBenchmarkCommandOptions([
        "bun",
        "agent",
        "benchmark",
        "--task",
        "task.json",
        "--server",
      ]),
    ).toEqual({ task: "task.json", server: true });
  });

  it("rejects removed or unknown timeout flags", () => {
    expect(() =>
      parseBenchmarkCommandOptions([
        "bun",
        "agent",
        "benchmark",
        "--timeout",
        "30000",
      ]),
    ).toThrow("Unknown benchmark option: --timeout");
  });

  it("rejects a task flag without a path", () => {
    expect(() =>
      parseBenchmarkCommandOptions(["bun", "agent", "benchmark", "--task"]),
    ).toThrow("benchmark --task requires a path");
  });
});

describe("benchmark process ownership", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "maps %s to cancellation and the conventional exit code",
    (signal, code) => {
      const controller = new AbortController();
      const existing = new Set(process.listeners(signal));
      const remove = installOwnerSignalHandlers(controller);
      const listener = process
        .listeners(signal)
        .find((candidate) => !existing.has(candidate));
      if (!listener) throw new Error(`missing ${signal} benchmark listener`);

      (listener as () => void)();

      expect(controller.signal.aborted).toBe(true);
      expect(process.exitCode).toBe(code);
      remove();
      expect(process.listeners(signal)).toEqual([...existing]);
    },
  );

  it("aborts an in-progress stdin read without waiting for EOF", async () => {
    const input = new PassThrough();
    const controller = new AbortController();
    const read = readBenchmarkInput(controller.signal, input);

    controller.abort(new Error("owner stopped input"));

    await expect(read).rejects.toThrow("owner stopped input");
    input.destroy();
  });

  it("isolates malformed server lines and continues with the next real task", async () => {
    const runtime = createRuntime();
    vi.spyOn(getMessageService(runtime), "handleMessage").mockResolvedValue({
      didRespond: true,
      responseContent: { text: "done" },
      responseMessages: [],
    });
    const input = new PassThrough();
    const results: Array<{ id: string; success: boolean }> = [];
    const server = runBenchmarkServer(
      runtime,
      new AbortController().signal,
      input,
      (result) => results.push(result),
    );
    input.end('{"id":"bad"}\n{"id":"ok","prompt":"Run it"}\n');

    await server;

    expect(results).toMatchObject([
      { id: "unknown", success: false },
      { id: "ok", success: true },
    ]);
  });

  it("does not misreport an output transport failure as invalid task JSON", async () => {
    const runtime = createRuntime();
    vi.spyOn(getMessageService(runtime), "handleMessage").mockResolvedValue({
      didRespond: true,
      responseContent: { text: "done" },
      responseMessages: [],
    });
    const input = new PassThrough();
    const transportFailure = new Error("stdout closed");
    const server = runBenchmarkServer(
      runtime,
      new AbortController().signal,
      input,
      () => {
        throw transportFailure;
      },
    );
    input.end('{"id":"ok","prompt":"Run it"}\n');

    await expect(server).rejects.toBe(transportFailure);
  });

  it("closes server mode when the owner cancels an open input", async () => {
    const input = new PassThrough();
    const controller = new AbortController();
    const server = runBenchmarkServer(
      createRuntime(),
      controller.signal,
      input,
    );

    controller.abort(new Error("owner stopped server"));

    await expect(server).resolves.toBeUndefined();
    input.destroy();
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

  it("blocks for deferred capabilities during boot and restores the caller environment", async () => {
    const previous = process.env.ELIZA_BLOCK_DEFERRED_PLUGIN_IMPORTS;
    delete process.env.ELIZA_BLOCK_DEFERRED_PLUGIN_IMPORTS;
    lifecycle.boot.mockImplementation(async () => {
      expect(process.env.ELIZA_BLOCK_DEFERRED_PLUGIN_IMPORTS).toBe("1");
      return runtime;
    });
    vi.spyOn(getMessageService(runtime), "handleMessage").mockResolvedValue({
      didRespond: true,
      responseContent: { text: "done" },
      responseMessages: [],
    });
    const taskPath = join(fixtureDir, "task.json");
    await writeFile(taskPath, JSON.stringify({ id: "boot", prompt: "Run it" }));

    try {
      await runBenchmark({ task: taskPath });
      expect(process.env.ELIZA_BLOCK_DEFERRED_PLUGIN_IMPORTS).toBeUndefined();
    } finally {
      if (previous === undefined)
        delete process.env.ELIZA_BLOCK_DEFERRED_PLUGIN_IMPORTS;
      else process.env.ELIZA_BLOCK_DEFERRED_PLUGIN_IMPORTS = previous;
    }
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

  it("cancels boot on SIGINT without fabricating a result", async () => {
    const taskPath = join(fixtureDir, "task.json");
    await writeFile(taskPath, JSON.stringify({ id: "boot", prompt: "Run it" }));
    lifecycle.boot.mockImplementation(
      (options: { abortSignal: AbortSignal }) =>
        new Promise<AgentRuntime>((_resolve, reject) => {
          options.abortSignal.addEventListener(
            "abort",
            () => reject(options.abortSignal.reason),
            { once: true },
          );
        }),
    );
    const existingListeners = new Set(process.listeners("SIGINT"));

    const command = runBenchmark({ task: taskPath });
    await vi.waitFor(() => expect(lifecycle.boot).toHaveBeenCalledOnce());
    const benchmarkListener = process
      .listeners("SIGINT")
      .find((listener) => !existingListeners.has(listener));
    if (!benchmarkListener)
      throw new Error("missing benchmark SIGINT listener");
    (benchmarkListener as () => void)();
    await command;

    expect(process.exitCode).toBe(130);
    expect(lifecycle.shutdown).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
  });
});
