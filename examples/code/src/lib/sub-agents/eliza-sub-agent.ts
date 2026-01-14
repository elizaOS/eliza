import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type IAgentRuntime,
  ModelType,
  type ModelTypeName,
} from "@elizaos/core";
import type {
  CodeTask,
  JsonValue,
  TaskResult,
  TaskTraceEvent,
} from "../../types.js";
import { parseToolCalls, type ToolCall } from "./tools.js";
import type {
  SubAgent,
  SubAgentContext,
  SubAgentTool,
  ToolResult,
} from "./types.js";

const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `You are a coding assistant. Execute tasks using these tools:

AVAILABLE TOOLS:
1. TOOL: read_file(filepath="path/to/file")
2. TOOL: list_files(path="directory")
3. TOOL: search_files(pattern="text", path="directory", max_matches="50")
4. TOOL: shell(command="your command")
5. TOOL: edit_file(filepath="file", old_str="find this", new_str="replace with")
6. TOOL: write_file(filepath="path/to/file")
   CONTENT_START
   file content here
   CONTENT_END

RULES:
- You may call one or more tools per response, then wait for results
- Prefer search_files to locate definitions/usages quickly
- For write_file: Use CONTENT_START and CONTENT_END markers
- Write COMPLETE code - never truncate or use placeholders
- Say "DONE: summary" when finished

Working directory: {cwd}`;

export interface ToolCallingSubAgentConfig {
  name: string;
  type: SubAgent["type"];
  systemPromptTemplate: string;
}

/**
 * ElizaSubAgent - Executes tasks using the runtime's LLM.
 * Implements an agentic tool-calling loop.
 */
export class ElizaSubAgent implements SubAgent {
  readonly name: string;
  readonly type: SubAgent["type"];
  private readonly systemPromptTemplate: string;

  private cancelled = false;
  private readonly maxIterations = getEnvInt(
    "ELIZA_CODE_SUBAGENT_MAX_ITERATIONS",
    25,
  );

  constructor(config?: Partial<ToolCallingSubAgentConfig>) {
    this.name = config?.name ?? "Eliza Code Agent";
    this.type = config?.type ?? "eliza";
    this.systemPromptTemplate =
      config?.systemPromptTemplate ?? DEFAULT_SYSTEM_PROMPT_TEMPLATE;
  }

  cancel(): void {
    this.cancelled = true;
  }

  async execute(task: CodeTask, context: SubAgentContext): Promise<TaskResult> {
    this.cancelled = false;
    const { runtime, workingDirectory, onProgress, onMessage, onTrace } =
      context;
    const tools = context.tools;

    const filesCreated: string[] = [];
    const filesModified: string[] = [];

    const debug = process.env.ELIZA_CODE_DEBUG === "1";
    const maxTraceResponseChars = getEnvInt(
      "ELIZA_CODE_TRACE_MAX_RESPONSE_CHARS",
      debug ? 20000 : 4000,
    );
    const maxTracePromptChars = getEnvInt(
      "ELIZA_CODE_TRACE_MAX_PROMPT_CHARS",
      20000,
    );
    const maxTraceToolOutputChars = getEnvInt(
      "ELIZA_CODE_TRACE_MAX_TOOL_OUTPUT_CHARS",
      8000,
    );
    const maxUiPreviewChars = getEnvInt(
      "ELIZA_CODE_TRACE_UI_PREVIEW_CHARS",
      180,
    );

    let traceSeq = 0;
    const base = (): Pick<TaskTraceEvent, "ts" | "seq"> => {
      traceSeq += 1;
      return {
        ts: Date.now(),
        seq: traceSeq,
      };
    };

    onProgress({ taskId: task.id ?? "", progress: 0 });

    const messages: ConversationMessage[] = [
      {
        role: "user",
        content: `Execute this task: ${task.name}\n\nDescription: ${task.description}\n\nStart by examining what's needed, then implement it step by step.`,
      },
    ];

    let iteration = 0;
    let wasPaused = false;

    try {
      while (iteration < this.maxIterations && !this.cancelled) {
        if (context.isCancelled()) {
          onMessage("Task cancelled", "warning");
          onTrace?.({
            kind: "status",
            status: "cancelled",
            message: "Task cancelled",
            ...base(),
          });
          return {
            success: false,
            summary: "Task was cancelled",
            filesCreated,
            filesModified,
            error: "Cancelled by user",
          };
        }

        if (context.isPaused?.()) {
          if (!wasPaused) {
            wasPaused = true;
            onMessage("Task paused", "warning");
            onTrace?.({
              kind: "status",
              status: "paused",
              message: "Task paused",
              ...base(),
            });
          }
          await sleep(300);
          continue;
        }

        if (wasPaused) {
          wasPaused = false;
          onMessage("Task resumed", "info");
          onTrace?.({
            kind: "status",
            status: "resumed",
            message: "Task resumed",
            ...base(),
          });
        }

        iteration++;

        // Call LLM
        const llm = await this.callLLM(runtime, messages, workingDirectory);
        const response = llm.response;
        onProgress({
          taskId: task.id ?? "",
          progress: Math.min(
            90,
            Math.round((iteration / this.maxIterations) * 80),
          ),
        });

        const responseRedacted = redactSensitiveText(response);
        const responseStored = truncateText(
          responseRedacted,
          maxTraceResponseChars,
        );
        const responsePreview = truncateText(
          collapseWhitespace(firstNonEmptyLine(responseStored)),
          maxUiPreviewChars,
        );

        const llmBase = base();
        const llmTrace: TaskTraceEvent = debug
          ? {
              kind: "llm",
              iteration,
              modelType: String(llm.modelType),
              response: responseStored,
              responsePreview,
              prompt: truncateText(
                redactSensitiveText(llm.prompt),
                maxTracePromptChars,
              ),
              ...llmBase,
            }
          : {
              kind: "llm",
              iteration,
              modelType: String(llm.modelType),
              response: responseStored,
              responsePreview,
              ...llmBase,
            };
        onTrace?.(llmTrace);

        if (debug && responsePreview) {
          onMessage(`LLM: ${responsePreview}`, "info");
        }

        // Check if done
        if (response.includes("DONE:")) {
          const summary =
            response.split("DONE:")[1]?.trim().split("\n")[0] ??
            "Task completed";
          onMessage(`Done: ${summary}`, "info");
          onTrace?.({
            kind: "note",
            level: "info",
            message: `Done: ${summary}`,
            ...base(),
          });
          return {
            success: true,
            summary,
            filesCreated,
            filesModified,
          };
        }

        // Parse and execute tool calls
        const toolCalls = parseToolCalls(response);

        if (toolCalls.length === 0) {
          // No tool calls - prompt for action
          messages.push({ role: "assistant", content: response });
          messages.push({
            role: "user",
            content:
              "Continue with the task. Use TOOL: to call tools, or say DONE: when finished.",
          });
          continue;
        }

        // Execute tools
        const toolCallLines = toolCalls
          .map((call) => {
            onTrace?.({
              kind: "tool_call",
              iteration,
              name: call.name,
              args: call.args,
              ...base(),
            });
            return `TOOL: ${formatToolCall(call)}`;
          })
          .join("\n");
        if (debug && toolCallLines) onMessage(toolCallLines, "info");

        const results = await this.executeTools(
          toolCalls,
          tools,
          filesCreated,
          filesModified,
          workingDirectory,
          onMessage,
        );

        const toolResultLines = results.executed
          .map(({ call, result }) => {
            const outputRedacted = redactSensitiveText(result.output);
            const outputStored = truncateText(
              outputRedacted,
              maxTraceToolOutputChars,
            );
            const outputPreview = truncateText(
              collapseWhitespace(firstNonEmptyLine(outputStored)),
              maxUiPreviewChars,
            );

            onTrace?.({
              kind: "tool_result",
              iteration,
              name: call.name,
              success: result.success,
              output: outputStored,
              outputPreview,
              ...base(),
            });

            const status = result.success ? "✓" : "✗";
            return `RESULT: ${call.name} ${status}${outputPreview ? ` — ${outputPreview}` : ""}`;
          })
          .join("\n");
        if (debug && toolResultLines) onMessage(toolResultLines, "info");

        if (debug) {
          onMessage(results.summary, "info");
        } else if (results.executed.some((e) => !e.result.success)) {
          onMessage(results.summary, "warning");
        }

        messages.push({ role: "assistant", content: response });
        messages.push({
          role: "user",
          content: `Tool results:\n${results.output}\n\nContinue.`,
        });
      }

      // Max iterations reached
      const summary = `Completed after ${iteration} iterations`;
      onMessage(`Warning: ${summary}`, "warning");
      onTrace?.({
        kind: "note",
        level: "warning",
        message: summary,
        ...base(),
      });
      return {
        success: true,
        summary,
        filesCreated,
        filesModified,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      onMessage(`Error: ${errorMessage}`, "error");
      onTrace?.({
        kind: "note",
        level: "error",
        message: errorMessage,
        ...base(),
      });
      return {
        success: false,
        summary: `Failed: ${errorMessage}`,
        filesCreated,
        filesModified,
        error: errorMessage,
      };
    }
  }

  private async callLLM(
    runtime: IAgentRuntime,
    messages: ConversationMessage[],
    cwd: string,
  ): Promise<{ prompt: string; response: string; modelType: ModelTypeName }> {
    const systemPrompt = this.systemPromptTemplate.replace("{cwd}", cwd);

    const history = messages
      .map((m) =>
        m.role === "user" ? `User: ${m.content}` : `Assistant: ${m.content}`,
      )
      .join("\n\n");

    const prompt = `${systemPrompt}\n\n${history}\n\nAssistant:`;
    const modelType = runtime.getModel(ModelType.TEXT_REASONING_LARGE)
      ? ModelType.TEXT_REASONING_LARGE
      : ModelType.TEXT_LARGE;
    const response = await runtime.useModel(modelType, {
      prompt,
      maxTokens: 4096,
      temperature: 0.2,
    });
    return { prompt, response, modelType };
  }

  private async executeTools(
    calls: ToolCall[],
    tools: SubAgentTool[],
    filesCreated: string[],
    filesModified: string[],
    workingDirectory: string,
    onMessage: (
      message: string,
      priority: "info" | "warning" | "error",
    ) => void,
  ): Promise<{
    output: string;
    summary: string;
    executed: Array<{ call: ToolCall; result: ToolResult }>;
  }> {
    const outputs: string[] = [];
    const summaries: string[] = [];
    const executed: Array<{ call: ToolCall; result: ToolResult }> = [];

    for (const call of calls) {
      const tool = tools.find(
        (t) => t.name === call.name || t.name === call.name.toLowerCase(),
      );
      if (!tool) {
        const missing: ToolResult = { success: false, output: "Unknown tool" };
        outputs.push(`[${call.name}] ${missing.output}`);
        summaries.push(`${call.name}: ✗`);
        executed.push({ call, result: missing });
        continue;
      }

      const result = await tool.execute(call.args);
      executed.push({ call, result });
      outputs.push(`[${call.name}] ${result.output}`);
      summaries.push(`${call.name}: ${result.success ? "✓" : "✗"}`);

      // Track file changes
      const filepathValue: JsonValue | undefined = result.data?.filepath;
      if (result.success && typeof filepathValue === "string") {
        const filepath = filepathValue;
        const toolName = call.name.toLowerCase();
        if (toolName.includes("write")) {
          if (!filesCreated.includes(filepath)) filesCreated.push(filepath);
        } else if (toolName.includes("edit")) {
          if (!filesModified.includes(filepath)) filesModified.push(filepath);
        }

        // Emit file events into the user-visible log so the user can follow along.
        if (toolName === "write_file" || toolName === "edit_file") {
          const abs = path.resolve(workingDirectory, filepath);
          const link = pathToFileURL(abs).toString();
          const kind = toolName === "write_file" ? "write" : "edit";
          const sizeValue: JsonValue | undefined = result.data?.size;
          const sizeSuffix =
            typeof sizeValue === "number" ? ` (${sizeValue} chars)` : "";
          onMessage(`FILE ${kind}: ${filepath}${sizeSuffix} — ${link}`, "info");
        }
      }
    }

    return {
      output: outputs.join("\n"),
      summary: `Tools: ${summaries.join(", ")}`,
      executed,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

function getEnvInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  if (parsed < 1) return defaultValue;
  return parsed;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const safe = Math.max(0, maxChars - 1);
  return `${text.slice(0, safe)}…`;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function firstNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

function redactSensitiveText(text: string): string {
  let out = text;

  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED:PRIVATE_KEY]",
  );
  out = out.replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "[REDACTED:API_KEY]");
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:AWS_ACCESS_KEY_ID]");
  out = out.replace(/\bASIA[0-9A-Z]{16}\b/g, "[REDACTED:AWS_ACCESS_KEY_ID]");
  out = out.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "[REDACTED:GITHUB_TOKEN]");
  out = out.replace(
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    "[REDACTED:GITHUB_TOKEN]",
  );
  out = out.replace(
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    "[REDACTED:SLACK_TOKEN]",
  );
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/g, "Bearer [REDACTED]");
  out = out.replace(/\bBasic\s+[A-Za-z0-9+/=]{10,}\b/g, "Basic [REDACTED]");
  out = out.replace(/(password\s*[:=]\s*)(\S+)/gi, "$1[REDACTED]");

  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (!shouldRedactEnvKey(key)) continue;
    if (value.length < 12) continue;
    out = out.split(value).join(`[REDACTED:${key}]`);
  }

  return out;
}

function shouldRedactEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (upper.includes("KEY")) return true;
  if (upper.includes("TOKEN")) return true;
  if (upper.includes("SECRET")) return true;
  if (upper.includes("PASSWORD")) return true;
  if (upper.includes("PASSWD")) return true;
  if (upper.includes("AUTH")) return true;
  return false;
}

function formatToolCall(call: ToolCall): string {
  const argsText = Object.entries(call.args)
    .map(
      ([k, v]) => `${k}="${truncateText(v.replace(/\s+/g, " ").trim(), 80)}"`,
    )
    .join(", ");
  return `${call.name}(${argsText})`;
}

/**
 * Create an ElizaSubAgent instance
 */
export function createElizaSubAgent(): SubAgent {
  return new ElizaSubAgent();
}
