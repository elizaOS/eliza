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

export interface CliGenerateResult {
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

function getBunRuntime() {
  const bunRuntime = (
    globalThis as typeof globalThis & {
      Bun?: {
        spawn(
          args: string[],
          options: { stdout: "pipe"; stderr: "pipe" }
        ): {
          stdout: ReadableStream<Uint8Array>;
          stderr: ReadableStream<Uint8Array>;
          exited: Promise<number>;
        };
      };
    }
  ).Bun;

  if (!bunRuntime) {
    throw new Error("[Anthropic CLI] Bun runtime is required for CLI mode");
  }

  return bunRuntime;
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
  const [output, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`[Anthropic CLI] claude -p failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
  }

  let data: ClaudeCliResult;
  try {
    data = JSON.parse(output) as ClaudeCliResult;
  } catch {
    throw new Error(`[Anthropic CLI] Failed to parse JSON. Raw: ${output.slice(0, 500)}`);
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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        lineBuf += decoder.decode(value, { stream: true });
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
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
    } finally {
      resolveText(fullText);
      if (!usageResolved) resolveUsage(undefined);
      if (!finishResolved) resolveFinish("end_turn");
    }
  }

  return {
    textStream: createTextStream(),
    text: textPromise,
    usage: usagePromise,
    finishReason: finishPromise,
  } as TextStreamResult;
}
