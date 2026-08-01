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

    const candidates = [
      resultText,
      messagesText,
      streamText,
      callbackText,
    ].filter(Boolean);
    const responseText =
      candidates.sort((a, b) => b.length - a.length)[0] ?? "";
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

/** Parse a JSON string into a BenchmarkTask, throwing on invalid input. */
export function parseBenchmarkTask(raw: string): BenchmarkTask {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("id" in parsed) ||
    typeof parsed.id !== "string" ||
    parsed.id.trim() === "" ||
    !("prompt" in parsed) ||
    typeof parsed.prompt !== "string" ||
    parsed.prompt.trim() === ""
  ) {
    throw new Error(
      'Invalid task JSON: "id" and "prompt" must be non-empty strings',
    );
  }
  if (
    "type" in parsed &&
    parsed.type !== undefined &&
    typeof parsed.type !== "string"
  ) {
    throw new Error('Invalid task JSON: "type" must be a string when provided');
  }
  if (
    "expected" in parsed &&
    parsed.expected !== undefined &&
    typeof parsed.expected !== "string"
  ) {
    throw new Error(
      'Invalid task JSON: "expected" must be a string when provided',
    );
  }
  if (
    "context" in parsed &&
    parsed.context !== undefined &&
    (typeof parsed.context !== "object" ||
      parsed.context === null ||
      Array.isArray(parsed.context))
  ) {
    throw new Error(
      'Invalid task JSON: "context" must be an object when provided',
    );
  }
  return parsed as BenchmarkTask;
}

/** Write a result as a single JSON line to stdout. */
function writeResult(result: BenchmarkResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/**
 * Server mode: read line-delimited JSON tasks from stdin, process each
 * against the running runtime, and write results to stdout.
 */
async function runServerMode(
  runtime: AgentRuntime,
  abortSignal: AbortSignal,
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });
  const closeOnAbort = () => rl.close();
  abortSignal.addEventListener("abort", closeOnAbort, { once: true });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const task = parseBenchmarkTask(trimmed);
        const result = await runBenchmarkTask(runtime, task, abortSignal);
        writeResult(result);
      } catch (err) {
        // error-policy:J1 each line is an independent command boundary in server mode.
        const errorResult: BenchmarkResult = {
          id: "unknown",
          response: "",
          task_type: "",
          actions_taken: [],
          duration_ms: 0,
          success: false,
          error: `Failed to parse task: ${err instanceof Error ? err.message : String(err)}`,
        };
        writeResult(errorResult);
      }
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

type RuntimeShutdown = (
  runtime: AgentRuntime | null | undefined,
  context: string,
) => Promise<void>;

function installOwnerSignalHandlers(controller: AbortController): () => void {
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

async function readStdin(abortSignal: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      process.stdin.off("data", handleData);
      process.stdin.off("end", handleEnd);
      process.stdin.off("error", handleError);
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

    process.stdin.on("data", handleData);
    process.stdin.once("end", handleEnd);
    process.stdin.once("error", handleError);
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
      taskJson = await readStdin(abortSignal);
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
      runtime = await runtimeModule.bootElizaRuntime();
    } catch (err) {
      // error-policy:J1 the CLI renders boot failure as its machine-readable result.
      writeResult({
        id: opts.task ? "file" : "stdin",
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
      await runServerMode(runtime, ownerController.signal);
      logger.info("[benchmark] EOF on stdin, shutting down");
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
      await shutdownRuntime?.(runtime, "benchmark shutdown");
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
    }
  }
}
