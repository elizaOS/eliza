/**
 * CLI subcommand for headless benchmark execution.
 *
 * Accepts a task as JSON (from --task <file> or stdin), boots the runtime
 * in headless mode, sends the prompt through handleMessage (the real agent
 * loop including action selection), captures the response, and writes a
 * JSON result to stdout.
 *
 * Task prompts are augmented with type-aware instructions so the agent
 * produces thorough, structured responses through its normal flow.
 *
 * Server mode (--server) keeps the runtime alive and reads line-delimited
 * JSON from stdin, writing one result line per task.
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
interface BenchmarkTask {
  id: string;
  type?: string;
  prompt: string;
  context?: Record<string, unknown>;
  expected?: string;
}

/** Output result schema written to stdout. */
interface BenchmarkResult {
  id: string;
  response: string;
  actions_taken: string[];
  duration_ms: number;
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Prompt augmentation — steers the agent via the normal message flow
// ---------------------------------------------------------------------------

const RESEARCH_AUGMENTATION =
  "\n\nPlease give a thorough, structured answer with ## headings, bullet points, and a conclusion. Be detailed and comprehensive.";

const CODING_AUGMENTATION =
  "\n\nPlease write the complete code implementation directly in your response using ```typescript blocks. Include all imports, types, and error handling. Do not delegate — write the code yourself.";

const DEFAULT_AUGMENTATION =
  "\n\nPlease give a detailed, structured answer with headings and bullet points.";

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

function augmentPrompt(task: BenchmarkTask): string {
  const taskType = detectTaskType(task);
  switch (taskType) {
    case "research":
      return task.prompt + RESEARCH_AUGMENTATION;
    case "coding":
      return task.prompt + CODING_AUGMENTATION;
    default:
      return task.prompt + DEFAULT_AUGMENTATION;
  }
}

// ---------------------------------------------------------------------------
// Task execution — uses handleMessage (the real agent loop)
// ---------------------------------------------------------------------------

async function runTask(
  runtime: AgentRuntime,
  task: BenchmarkTask,
  timeoutMs: number,
): Promise<BenchmarkResult> {
  const start = performance.now();
  const taskType = detectTaskType(task);
  const userId = crypto.randomUUID() as UUID;
  const roomId = stringToUuid(`benchmark-${task.id}`);
  const worldId = stringToUuid(`benchmark-world-${task.id}`);
  const messageServerId = stringToUuid(`benchmark-server-${task.id}`) as UUID;

  try {
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

    const augmentedPrompt = augmentPrompt(task);

    const message = createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId: userId,
      roomId,
      content: {
        text: augmentedPrompt,
        source: "benchmark",
        channelType: ChannelType.DM,
      },
    });

    if (!runtime.messageService) {
      return {
        id: task.id,
        response: "",
        actions_taken: [taskType],
        duration_ms: Math.round(performance.now() - start),
        success: false,
        error: "runtime.messageService is not available",
      };
    }

    let callbackText = "";
    let streamText = "";
    const actionsTaken: string[] = [taskType];

    // Race message handling against the timeout.
    // Text can arrive via three channels:
    //   1. callback — action handler results
    //   2. onStreamChunk — streamed LLM tokens
    //   3. result.responseContent — final composed response
    // We capture all three and deduplicate.
    const result = (await Promise.race([
      (async () => {
        const handleResult = await runtime.messageService?.handleMessage(
          runtime,
          message,
          async (content) => {
            if (content?.text) {
              callbackText += content.text;
            }
            // Track actions taken
            const action = (content as Record<string, unknown>)?.action;
            if (typeof action === "string" && !actionsTaken.includes(action)) {
              actionsTaken.push(action);
            }
            return [];
          },
          {
            onStreamChunk: async (chunk: string) => {
              if (chunk) streamText += chunk;
            },
          },
        );
        return handleResult;
      })(),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), timeoutMs),
      ),
    ])) as unknown;

    if (result === "timeout") {
      const responseText = streamText || callbackText;
      return {
        id: task.id,
        response: responseText,
        actions_taken: actionsTaken,
        duration_ms: Math.round(performance.now() - start),
        success: false,
        error: `Timeout after ${timeoutMs}ms`,
      };
    }

    // Extract text from all channels, preferring the richest source.
    // result.responseContent has the final composed text from the LLM.
    const resultRecord =
      typeof result === "object" && result !== null
        ? (result as Record<string, unknown>)
        : null;
    const responseContent =
      resultRecord?.responseContent &&
      typeof resultRecord.responseContent === "object"
        ? (resultRecord.responseContent as Record<string, unknown>)
        : null;
    const resultText =
      responseContent && typeof responseContent.text === "string"
        ? responseContent.text
        : "";

    // Also check responseMessages for additional text
    const responseMessages = Array.isArray(resultRecord?.responseMessages)
      ? (resultRecord.responseMessages as Array<{
          content?: { text?: string };
        }>)
      : [];
    const messagesText = responseMessages
      .map((m) => m.content?.text ?? "")
      .filter(Boolean)
      .join("\n");

    // Pick the best source — longest non-empty wins, since the same
    // text may appear in multiple channels.
    const candidates = [
      resultText,
      messagesText,
      streamText,
      callbackText,
    ].filter(Boolean);
    const responseText =
      candidates.sort((a, b) => b.length - a.length)[0] ?? "";

    return {
      id: task.id,
      response: responseText,
      actions_taken: actionsTaken,
      duration_ms: Math.round(performance.now() - start),
      success: true,
    };
  } catch (err) {
    return {
      id: task.id,
      response: "",
      actions_taken: [taskType],
      duration_ms: Math.round(performance.now() - start),
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Parse a JSON string into a BenchmarkTask, throwing on invalid input. */
function parseTask(raw: string): BenchmarkTask {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("id" in parsed) ||
    !("prompt" in parsed)
  ) {
    throw new Error(
      'Invalid task JSON: must contain at minimum "id" and "prompt" fields',
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
  timeoutMs: number,
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const task = parseTask(trimmed);
      const result = await runTask(runtime, task, timeoutMs);
      writeResult(result);
    } catch (err) {
      const errorResult: BenchmarkResult = {
        id: "unknown",
        response: "",
        actions_taken: [],
        duration_ms: 0,
        success: false,
        error: `Failed to parse task: ${err instanceof Error ? err.message : String(err)}`,
      };
      writeResult(errorResult);
    }
  }
}

export interface BenchmarkCommandOptions {
  task?: string;
  server?: boolean;
  timeout: string;
}

/**
 * Entry point for the `benchmark` CLI subcommand.
 */
export async function runBenchmark(
  opts: BenchmarkCommandOptions,
): Promise<void> {
  const timeoutMs = Number.parseInt(opts.timeout, 10);
  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    console.error("[benchmark] Invalid timeout value");
    process.exit(2);
  }

  // Suppress noisy runtime logs — benchmark output must be clean JSON on stdout
  if (!process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = "error";
  }
  process.env.ELIZA_HEADLESS = "1";

  const { bootElizaRuntime } = await import("../runtime/eliza.ts");
  let runtime: AgentRuntime;
  try {
    runtime = await bootElizaRuntime();
  } catch (err) {
    const errorResult: BenchmarkResult = {
      id: opts.task ? "file" : "stdin",
      response: "",
      actions_taken: [],
      duration_ms: 0,
      success: false,
      error: `Runtime boot failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    writeResult(errorResult);
    process.exit(1);
  }

  if (opts.server) {
    await runServerMode(runtime, timeoutMs);
    logger.info("[benchmark] EOF on stdin, shutting down");
    process.exit(0);
  }

  // Single-task mode
  let taskJson: string;
  if (opts.task) {
    try {
      taskJson = readFileSync(opts.task, "utf-8");
    } catch (err) {
      console.error(
        `[benchmark] Failed to read task file: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(2);
    }
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    taskJson = Buffer.concat(chunks).toString("utf-8").trim();
    if (!taskJson) {
      console.error(
        "[benchmark] No task provided. Use --task <file> or pipe JSON to stdin.",
      );
      process.exit(2);
    }
  }

  let task: BenchmarkTask;
  try {
    task = parseTask(taskJson);
  } catch (err) {
    console.error(
      `[benchmark] Invalid task JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }

  const result = await runTask(runtime, task, timeoutMs);
  writeResult(result);
  process.exit(result.success ? 0 : 1);
}
