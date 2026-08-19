/**
 * CLI auth mode: `generateViaCli` / `streamViaCli` shell out to `claude -p` via
 * `Bun.spawn` when `ANTHROPIC_AUTH_MODE=claude-cli`, parsing the CLI's JSON
 * result into text plus token usage and emitting a usage event. The child is
 * killed if it never exits, and stdout/stderr are credited against a byte
 * budget before they become a string — origin `new Response(proc.stdout).text()`
 * never settled when the stream stayed open. Bun-only (fails on Node
 * runtimes); does not support `messages`, `tools`, `toolChoice`, or
 * `responseSchema`.
 */
import type { IAgentRuntime, ModelTypeName, TextStreamResult } from "@elizaos/core";
import { buildCanonicalSystemPrompt, logger } from "@elizaos/core";
import { emitModelUsageEvent } from "./events";

interface ClaudeCliModelUsage {
  inputTokens: number;
  outputTokens: number;
}

interface ClaudeCliResult {
  result: string;
  duration_ms: number;
  duration_api_ms: number;
  modelUsage: Record<string, ClaudeCliModelUsage>;
}

interface CliGenerateResult {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
}

type ClaudeStreamEvent =
  | {
      type: "stream_event";
      event?: {
        delta?: {
          type?: string;
          text?: string;
        };
      };
    }
  | {
      type: "result";
      modelUsage?: Record<string, ClaudeCliModelUsage>;
      stop_reason?: string;
    };

function isClaudeStreamEvent(value: unknown): value is ClaudeStreamEvent {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "stream_event" || type === "result";
}

function buildCliArgs(
  prompt: string,
  modelName: string,
  systemPrompt: string | undefined,
  maxTokens: number | undefined,
  streaming: boolean
): string[] {
  const args = [
    "claude",
    "-p",
    prompt,
    "--model",
    modelName,
    "--output-format",
    streaming ? "stream-json" : "json",
  ];
  if (streaming) args.push("--verbose", "--include-partial-messages");
  if (maxTokens != null) args.push("--max-tokens", String(maxTokens));
  if (systemPrompt) args.push("--system-prompt", systemPrompt);
  return args;
}

function parseUsage(
  modelUsage: Record<string, ClaudeCliModelUsage> | undefined
): CliGenerateResult["usage"] {
  const entry = modelUsage ? Object.values(modelUsage)[0] : undefined;
  if (!entry) return null;
  return {
    promptTokens: entry.inputTokens,
    completionTokens: entry.outputTokens,
    totalTokens: entry.inputTokens + entry.outputTokens,
  };
}

/** Wall-clock bound for one `claude -p` child. Real generations stay under this. */
export const CLAUDE_CLI_TIMEOUT_MS = 180_000;

/** Peak stdout or stderr materialized from the child before kill. */
export const CLAUDE_CLI_MAX_STDIO_BYTES = 8 * 1024 * 1024;

interface ClaudeCliProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

function getBunRuntime() {
  const bunRuntime = (
    globalThis as typeof globalThis & {
      Bun?: {
        spawn(args: string[], options: { stdout: "pipe"; stderr: "pipe" }): ClaudeCliProcess;
      };
    }
  ).Bun;

  if (!bunRuntime) {
    throw new Error("[Anthropic CLI] Bun runtime is required for CLI mode");
  }

  return bunRuntime;
}

/** Read a child stream and reject before the allocation exceeds `maxBytes`. */
export async function readClaudeCliStreamBudget(
  stream: ReadableStream<Uint8Array>,
  maxBytes = CLAUDE_CLI_MAX_STDIO_BYTES,
  label = "stdio"
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`[Anthropic CLI] ${label} exceeded ${maxBytes} bytes (got ${total})`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

/**
 * Collect stdout/stderr from a `claude -p` child and kill it if it never
 * exits. Tests pass a short timeout so a never-ending stream fails closed
 * without waiting the production 180s.
 */
export async function collectClaudeCliOutput(
  proc: ClaudeCliProcess,
  options?: { timeoutMs?: number; maxBytes?: number }
): Promise<{ output: string; stderr: string; exitCode: number }> {
  const timeoutMs = options?.timeoutMs ?? CLAUDE_CLI_TIMEOUT_MS;
  const maxBytes = options?.maxBytes ?? CLAUDE_CLI_MAX_STDIO_BYTES;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [output, stderr, exitCode] = await Promise.all([
      readClaudeCliStreamBudget(proc.stdout, maxBytes, "stdout"),
      readClaudeCliStreamBudget(proc.stderr, maxBytes, "stderr"),
      proc.exited,
    ]);
    if (timedOut) {
      throw new Error(`[Anthropic CLI] claude -p timed out after ${timeoutMs}ms`);
    }
    return { output, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a prompt through `claude -p` (non-streaming).
 */
export async function generateViaCli(
  runtime: IAgentRuntime,
  prompt: string,
  modelName: string,
  modelType: ModelTypeName,
  maxTokens?: number,
  systemPrompt?: string
): Promise<CliGenerateResult> {
  const args = buildCliArgs(
    prompt,
    modelName,
    systemPrompt ?? buildCanonicalSystemPrompt({ character: runtime.character }),
    maxTokens,
    false
  );
  logger.debug(`[Anthropic CLI] ${modelType} → ${modelName}`);

  const proc = getBunRuntime().spawn(args, { stdout: "pipe", stderr: "pipe" });
  const { output, stderr, exitCode } = await collectClaudeCliOutput(proc);

  if (exitCode !== 0) {
    throw new Error(`[Anthropic CLI] claude -p failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
  }

  let data: ClaudeCliResult;
  try {
    data = JSON.parse(output) as ClaudeCliResult;
  } catch (error) {
    // error-policy:J2 context-adding rethrow — surface the raw CLI output that
    // failed to parse, with the parse error as cause.
    throw new Error(`[Anthropic CLI] Failed to parse JSON. Raw: ${output.slice(0, 500)}`, {
      cause: error,
    });
  }

  logger.debug(
    `[Anthropic CLI] ${modelType} done in ${data.duration_ms}ms (API: ${data.duration_api_ms}ms)`
  );

  const usage = parseUsage(data.modelUsage);
  if (usage) {
    emitModelUsageEvent(
      runtime,
      modelType,
      prompt,
      {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      },
      modelName
    );
  }

  return { text: data.result, usage };
}

/**
 * Run a prompt through `claude -p` with real-time streaming.
 * Spawns with --output-format stream-json --verbose --include-partial-messages
 * and yields text_delta events as they arrive from the CLI.
 */
export function streamViaCli(
  runtime: IAgentRuntime,
  prompt: string,
  modelName: string,
  modelType: ModelTypeName,
  maxTokens?: number,
  systemPrompt?: string
): TextStreamResult {
  const args = buildCliArgs(
    prompt,
    modelName,
    systemPrompt ?? buildCanonicalSystemPrompt({ character: runtime.character }),
    maxTokens,
    true
  );
  logger.debug(`[Anthropic CLI] streaming ${modelType} → ${modelName}`);

  const proc = getBunRuntime().spawn(args, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, CLAUDE_CLI_TIMEOUT_MS);

  let fullText = "";
  let usageResolved = false;
  let finishResolved = false;
  let resolveText!: (v: string) => void;
  let resolveUsage!: (
    v: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined
  ) => void;
  let resolveFinish!: (v: string | undefined) => void;

  const textPromise = new Promise<string>((r) => {
    resolveText = r;
  });
  const usagePromise = new Promise<
    { promptTokens: number; completionTokens: number; totalTokens: number } | undefined
  >((r) => {
    resolveUsage = r;
  });
  const finishPromise = new Promise<string | undefined>((r) => {
    resolveFinish = r;
  });

  async function* createTextStream(): AsyncGenerator<string> {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";
    let streamFailed = false;
    let decodedBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        decodedBytes += value.byteLength;
        if (decodedBytes > CLAUDE_CLI_MAX_STDIO_BYTES) {
          await reader.cancel();
          proc.kill();
          throw new Error(
            `[Anthropic CLI] stdout exceeded ${CLAUDE_CLI_MAX_STDIO_BYTES} bytes (got ${decodedBytes})`
          );
        }

        lineBuf += decoder.decode(value, { stream: true });
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            // error-policy:J3 untrusted-input sanitizing — `--verbose` CLI
            // output interleaves non-JSON lines with the stream-json protocol;
            // skipping a non-parsing line is the expected filter, and a wholly
            // broken stream still surfaces via the CLI's non-zero exit.
            continue;
          }
          if (!isClaudeStreamEvent(parsed)) continue;
          const event: ClaudeStreamEvent = parsed;

          if (event.type === "stream_event" && event.event?.delta?.type === "text_delta") {
            const chunk = event.event.delta.text;
            if (typeof chunk === "string") {
              fullText += chunk;
              yield chunk;
            }
          }

          if (event.type === "result") {
            const usage = parseUsage(event.modelUsage);
            if (usage) {
              emitModelUsageEvent(
                runtime,
                modelType,
                prompt,
                {
                  promptTokens: usage.promptTokens,
                  completionTokens: usage.completionTokens,
                  totalTokens: usage.totalTokens,
                },
                modelName
              );
              resolveUsage(usage);
            } else {
              resolveUsage(undefined);
            }
            usageResolved = true;
            resolveFinish(event.stop_reason ?? "end_turn");
            finishResolved = true;
          }
        }
      }

      // The CLI signals failure via its exit code. A stream that ended after a
      // non-zero exit is a provider failure, not an empty completion — throw so
      // the consumer sees the real error instead of a fabricated "end_turn"
      // with zero chunks (#9324: throw, never fabricate).
      const exitCode = await proc.exited;
      if (timedOut) {
        streamFailed = true;
        throw new Error(`[Anthropic CLI] claude -p timed out after ${CLAUDE_CLI_TIMEOUT_MS}ms`);
      }
      if (exitCode !== 0) {
        streamFailed = true;
        // error-policy:J6 best-effort diagnostics on an already-failed process —
        // the typed failure below throws regardless of stderr readability.
        const stderrText = await readClaudeCliStreamBudget(
          proc.stderr,
          CLAUDE_CLI_MAX_STDIO_BYTES,
          "stderr"
        ).catch(() => "");
        // error-policy:J6 stderr is diagnostics on an already-failed stream.
        throw new Error(
          `[Anthropic CLI] claude -p stream failed (exit ${exitCode}): ${stderrText.slice(0, 500)}`
        );
      }
    } finally {
      clearTimeout(timer);
      resolveText(fullText);
      if (!usageResolved) resolveUsage(undefined);
      if (!finishResolved) resolveFinish(streamFailed ? "error" : "end_turn");
    }
  }

  return {
    textStream: createTextStream(),
    text: textPromise,
    usage: usagePromise,
    finishReason: finishPromise,
  } as TextStreamResult;
}
