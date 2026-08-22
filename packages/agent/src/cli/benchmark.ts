/**
 * Runs headless benchmark tasks through the production message loop. One-shot
 * and line-delimited server modes share a process-owned cancellation signal;
 * the command does not invent a response deadline, and runtime shutdown drains
 * tracked post-delivery work before the database closes.
 */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import * as readline from "node:readline";
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  logger,
  stringToUuid,
  type UUID,
} from "@elizaos/core";

/** Input task schema accepted from the orchestrator. */
export interface BenchmarkTask {
  id: string;
  type?: string;
  prompt: string;
  context?: Record<string, unknown>;
  expected?: string;
}

/** Output result schema written to stdout. */
export interface BenchmarkResult {
  id: string;
  response: string;
  task_type: string;
  actions_taken: string[];
  duration_ms: number;
  success: boolean;
  error?: string;
}

const REQUIRED_CODING_ACTIONS = ["READ", "WRITE", "EDIT", "SHELL"] as const;

function missingCodingActions(runtime: AgentRuntime): string[] {
  const names = new Set(
    runtime.actions.map((action) => action.name.trim().toUpperCase()),
  );
  return REQUIRED_CODING_ACTIONS.filter((name) => !names.has(name));
}

function detectTaskType(task: BenchmarkTask): string {
  if (task.type) return task.type;
  if (
    /\b(implement|build|create|write|code|function|class|module|component|api|endpoint|cli|test suite|refactor|debug|fix.*bug)\b/i.test(
      task.prompt,
    )
  ) {
    return "coding";
  }
  return "research";
}

/** Runs one task through the same message service used by interactive hosts. */
export async function runBenchmarkTask(
  runtime: AgentRuntime,
  task: BenchmarkTask,
  abortSignal: AbortSignal,
): Promise<BenchmarkResult> {
  const start = performance.now();
  const taskType = detectTaskType(task);
  const userId = crypto.randomUUID() as UUID;
  const roomId = stringToUuid(`benchmark-${task.id}`);
  const worldId = stringToUuid(`benchmark-world-${task.id}`);
  const messageServerId = stringToUuid(`benchmark-server-${task.id}`) as UUID;
  let callbackText = "";
  let streamText = "";
  const actionsTaken: string[] = [];

  try {
    abortSignal.throwIfAborted();
    if (taskType === "coding") {
      const missing = missingCodingActions(runtime);
      if (missing.length > 0) {
        return {
          id: task.id,
          response: "",
          task_type: taskType,
          actions_taken: [],
          duration_ms: Math.round(performance.now() - start),
          success: false,
          error: `Coding benchmark runtime is missing required actions: ${missing.join(", ")}`,
        };
      }
    }
    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "Benchmark",
      source: "benchmark",
      channelId: `benchmark-${task.id}`,
      type: ChannelType.DM,
      messageServerId,
      metadata: { ownership: { ownerId: userId } },
    });
    abortSignal.throwIfAborted();

    const message = createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId: userId,
      roomId,
      content: {
        text: task.prompt,
        source: "benchmark",
        channelType: ChannelType.DM,
      },
    });
    if (task.context) {
      if (message.metadata?.type !== "message") {
        throw new Error("Benchmark message is missing message metadata");
      }
      message.metadata.benchmarkContext = JSON.stringify(task.context);
    }

    if (!runtime.messageService) {
      return {
        id: task.id,
        response: "",
        task_type: taskType,
        actions_taken: [],
        duration_ms: Math.round(performance.now() - start),
        success: false,
        error: "runtime.messageService is not available",
      };
    }

    const result = await runtime.messageService.handleMessage(
      runtime,
      message,
      async (content, actionName) => {
        if (content.text) callbackText += content.text;
        if (actionName && !actionsTaken.includes(actionName)) {
          actionsTaken.push(actionName);
        }
        return [];
      },
      {
        abortSignal,
        ...(taskType === "coding" ? { codingMode: true } : {}),
        onStreamChunk: async (chunk: string) => {
          if (chunk) streamText += chunk;
        },
      },
    );

    const resultText = result.responseContent?.text ?? "";
    const messagesText = result.responseMessages
      .map((m) => m.content?.text ?? "")
      .filter(Boolean)
      .join("\n");

    // The message service's final response is authoritative. Stream and callback
    // channels are delivery transports, so choosing the longest text can replace
    // the final answer with duplicated chunks or verbose action output.
    const responseText =
      resultText || messagesText || streamText || callbackText || "";
    const success = result.didRespond && responseText.trim().length > 0;

    return {
      id: task.id,
      response: responseText,
      task_type: taskType,
      actions_taken: actionsTaken,
      duration_ms: Math.round(performance.now() - start),
      success,
      ...(!success
        ? { error: result.reason ?? "Agent completed without a response" }
        : {}),
    };
  } catch (err) {
    // error-policy:J1 the command boundary serializes task failures for its caller.
    return {
      id: task.id,
      response: streamText || callbackText,
      task_type: taskType,
      actions_taken: actionsTaken,
      duration_ms: Math.round(performance.now() - start),
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a JSON string into a BenchmarkTask, throwing on invalid input. */
export function parseBenchmarkTask(raw: string): BenchmarkTask {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("Invalid task JSON: expected an object");
  }
  const candidate = parsed;
  if (
    typeof candidate.id !== "string" ||
    candidate.id.trim() === "" ||
    typeof candidate.prompt !== "string" ||
    candidate.prompt.trim() === ""
  ) {
    throw new Error(
      'Invalid task JSON: "id" and "prompt" must be non-empty strings',
    );
  }
  if (candidate.type !== undefined && typeof candidate.type !== "string") {
    throw new Error('Invalid task JSON: "type" must be a string when provided');
  }
  if (
    candidate.expected !== undefined &&
    typeof candidate.expected !== "string"
  ) {
    throw new Error(
      'Invalid task JSON: "expected" must be a string when provided',
    );
  }
  if (
    candidate.context !== undefined &&
    (typeof candidate.context !== "object" ||
      candidate.context === null ||
      Array.isArray(candidate.context))
  ) {
    throw new Error(
      'Invalid task JSON: "context" must be an object when provided',
    );
  }
  return {
    id: candidate.id,
    prompt: candidate.prompt,
    ...(typeof candidate.type === "string" ? { type: candidate.type } : {}),
    ...(typeof candidate.expected === "string"
      ? { expected: candidate.expected }
      : {}),
    ...(typeof candidate.context === "object" && candidate.context !== null
      ? { context: candidate.context as Record<string, unknown> }
      : {}),
  };
}

/** Write a result as a single JSON line to stdout. */
function writeResult(result: BenchmarkResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** Runs line-delimited tasks until input closes or the process owner cancels. */
export async function runBenchmarkServer(
  runtime: AgentRuntime,
  abortSignal: AbortSignal,
  input: NodeJS.ReadableStream = process.stdin,
  output: (result: BenchmarkResult) => void = writeResult,
): Promise<void> {
  const rl = readline.createInterface({
    input,
    terminal: false,
  });
  const closeOnAbort = () => rl.close();
  abortSignal.addEventListener("abort", closeOnAbort, { once: true });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let task: BenchmarkTask;
      try {
        task = parseBenchmarkTask(trimmed);
      } catch (err) {
        // error-policy:J1 each line is an independent input boundary.
        output({
          id: "unknown",
          response: "",
          task_type: "",
          actions_taken: [],
          duration_ms: 0,
          success: false,
          error: `Failed to parse task: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      const result = await runBenchmarkTask(runtime, task, abortSignal);
      // A broken stdout/transport is process-fatal; it is not malformed input.
      output(result);
    }
  } finally {
    abortSignal.removeEventListener("abort", closeOnAbort);
    rl.close();
  }
}

export interface BenchmarkCommandOptions {
  task?: string;
  server?: boolean;
}

/** Parses the autonomous CLI benchmark flags with the same strictness as Commander. */
export function parseBenchmarkCommandOptions(
  argv: readonly string[],
  startIndex = 3,
): BenchmarkCommandOptions {
  const options: BenchmarkCommandOptions = {};
  for (let index = startIndex; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--server") {
      options.server = true;
      continue;
    }
    if (argument === "--task") {
      const path = argv[index + 1];
      if (!path || path.startsWith("--")) {
        throw new Error("benchmark --task requires a path");
      }
      options.task = path;
      index += 1;
      continue;
    }
    throw new Error(`Unknown benchmark option: ${argument}`);
  }
  return options;
}

type RuntimeShutdown = (
  runtime: AgentRuntime | null | undefined,
  context: string,
) => Promise<void>;

/** @internal Installs the benchmark process boundary's SIGINT/SIGTERM owner. */
export function installOwnerSignalHandlers(
  controller: AbortController,
): () => void {
  const handleSignal = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) return;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    controller.abort(new Error(`Benchmark owner received ${signal}`));
  };
  const handleInterrupt = () => handleSignal("SIGINT");
  const handleTerminate = () => handleSignal("SIGTERM");
  process.once("SIGINT", handleInterrupt);
  process.once("SIGTERM", handleTerminate);
  return () => {
    process.off("SIGINT", handleInterrupt);
    process.off("SIGTERM", handleTerminate);
  };
}

/** Reads one task from a stream until EOF or owner cancellation. */
export async function readBenchmarkInput(
  abortSignal: AbortSignal,
  input: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      input.off("data", handleData);
      input.off("end", handleEnd);
      input.off("error", handleError);
      abortSignal.removeEventListener("abort", handleAbort);
    };
    const handleData = (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const handleEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf-8").trim());
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const handleAbort = () => {
      cleanup();
      reject(abortSignal.reason);
    };

    input.on("data", handleData);
    input.once("end", handleEnd);
    input.once("error", handleError);
    abortSignal.addEventListener("abort", handleAbort, { once: true });
    if (abortSignal.aborted) handleAbort();
  });
}

async function readOneShotTask(
  taskPath: string | undefined,
  abortSignal: AbortSignal,
): Promise<BenchmarkTask | undefined> {
  let taskJson: string;
  if (taskPath) {
    try {
      taskJson = readFileSync(taskPath, "utf-8");
    } catch (err) {
      // error-policy:J1 file input is a CLI boundary with an explicit exit status.
      process.stderr.write(
        `[benchmark] Failed to read task file: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 2;
      return undefined;
    }
  } else {
    try {
      taskJson = await readBenchmarkInput(abortSignal);
    } catch (err) {
      // error-policy:J1 stdin and owner cancellation terminate the one-shot command.
      if (!abortSignal.aborted) {
        process.stderr.write(
          `[benchmark] Failed to read stdin: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 2;
      }
      return undefined;
    }
    if (!taskJson) {
      process.stderr.write(
        "[benchmark] No task provided. Use --task <file> or pipe JSON to stdin.\n",
      );
      process.exitCode = 2;
      return undefined;
    }
  }

  try {
    return parseBenchmarkTask(taskJson);
  } catch (err) {
    // error-policy:J1 invalid untrusted input is reported at the CLI boundary.
    process.stderr.write(
      `[benchmark] Invalid task JSON: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 2;
    return undefined;
  }
}

/**
 * Entry point for the `benchmark` CLI subcommand.
 */
export async function runBenchmark(
  opts: BenchmarkCommandOptions,
): Promise<void> {
  if (!process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = "error";
  }
  process.env.ELIZA_HEADLESS = "1";
  const previousBlockDeferred = process.env.ELIZA_BLOCK_DEFERRED_PLUGIN_IMPORTS;
  // Coding tools are part of the normal deferred desktop wave. A benchmark is
  // not latency-sensitive boot UI: it must await the complete capability set
  // before sending the first task or the planner can receive zero native tools.
  process.env.ELIZA_BLOCK_DEFERRED_PLUGIN_IMPORTS = "1";

  const ownerController = new AbortController();
  const removeSignalHandlers = installOwnerSignalHandlers(ownerController);
  let runtime: AgentRuntime | undefined;
  let shutdownRuntime: RuntimeShutdown | undefined;
  try {
    const oneShotTask = opts.server
      ? undefined
      : await readOneShotTask(opts.task, ownerController.signal);
    if (!opts.server && !oneShotTask) return;

    try {
      const runtimeModule = await import("../runtime/eliza.ts");
      shutdownRuntime = runtimeModule.shutdownRuntime;
      runtime = await runtimeModule.bootElizaRuntime({
        abortSignal: ownerController.signal,
      });
    } catch (err) {
      if (ownerController.signal.aborted) return;
      // error-policy:J1 the CLI renders boot failure as its machine-readable result.
      writeResult({
        id: oneShotTask?.id ?? (opts.task ? "file" : "stdin"),
        response: "",
        task_type: "",
        actions_taken: [],
        duration_ms: 0,
        success: false,
        error: `Runtime boot failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      if (process.exitCode === undefined) process.exitCode = 1;
      return;
    }

    if (ownerController.signal.aborted) return;

    if (opts.server) {
      await runBenchmarkServer(runtime, ownerController.signal);
      logger.info(
        ownerController.signal.aborted
          ? "[benchmark] Owner cancelled server input, shutting down"
          : "[benchmark] EOF on stdin, shutting down",
      );
      if (!ownerController.signal.aborted) process.exitCode = 0;
      return;
    }
    if (!oneShotTask) return;

    const result = await runBenchmarkTask(
      runtime,
      oneShotTask,
      ownerController.signal,
    );
    writeResult(result);
    if (!ownerController.signal.aborted) {
      process.exitCode = result.success ? 0 : 1;
    }
  } finally {
    try {
      if (runtime && shutdownRuntime) {
        await shutdownRuntime(runtime, "benchmark shutdown");
      }
    } catch (err) {
      // error-policy:J1 shutdown failure is visible through stderr and exit status.
      process.stderr.write(
        `[benchmark] Runtime shutdown failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      if (process.exitCode === undefined || process.exitCode === 0) {
        process.exitCode = 1;
      }
    } finally {
      removeSignalHandlers();
      if (previousBlockDeferred === undefined) {
        delete process.env.ELIZA_BLOCK_DEFERRED_PLUGIN_IMPORTS;
      } else {
        process.env.ELIZA_BLOCK_DEFERRED_PLUGIN_IMPORTS = previousBlockDeferred;
      }
    }
  }
}
