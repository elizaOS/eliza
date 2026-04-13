import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ModelType } from "@elizaos/core";
import type {
  CodeTask,
  JsonValue,
  TaskResult,
  TaskTraceEvent,
} from "../../types.js";
import type {
  SubAgent,
  SubAgentContext,
  SubAgentTool,
  ToolResult,
} from "./types.js";

/**
 * OpenCode-style system prompt implementing LSP-aware coding assistance.
 * This is used when the OpenCode CLI is not available.
 */
const OPENCODE_SYSTEM_PROMPT = `You are OpenCode, an expert AI coding agent with LSP integration awareness.
You help developers write, debug, and refactor code with precision and context-awareness.

## CAPABILITIES

1. **LSP-Aware Editing**: Consider type information, imports, and dependencies when making changes
2. **Multi-Session Support**: Handle complex tasks by breaking them into logical steps
3. **Context Management**: Track relevant files and maintain awareness of the broader codebase
4. **Precise Modifications**: Make targeted, minimal changes that preserve existing functionality

## AVAILABLE TOOLS

1. TOOL: read_file(filepath="path/to/file")
   - Read the contents of a file

2. TOOL: list_files(path="directory")
   - List contents of a directory

3. TOOL: search_files(pattern="text", path="directory", max_matches="50")
   - Search for text patterns in files

4. TOOL: shell(command="your command")
   - Execute shell commands (use for git, tests, type checking, etc.)

5. TOOL: edit_file(filepath="file", old_str="find this", new_str="replace with")
   - Make precise search/replace edits to files

6. TOOL: write_file(filepath="path/to/file")
   CONTENT_START
   <complete file contents>
   CONTENT_END
   - Create or overwrite a file with complete contents

## METHODOLOGY

### 1. UNDERSTAND
- Read relevant files to understand the context
- Check for type definitions and interfaces
- Understand the existing code patterns

### 2. PLAN
- Identify all files that need modification
- Consider imports and dependencies
- Plan changes in the correct order

### 3. IMPLEMENT
- Make precise, targeted changes
- Prefer edit_file for modifications
- Use write_file only for new files

### 4. VERIFY
- Read modified files to confirm changes
- Consider running type checks or tests
- Ensure no unintended side effects

## RULES

1. **COMPLETE CODE ONLY**: Never truncate or use placeholders
2. **MINIMAL CHANGES**: Change only what's necessary
3. **TYPE SAFETY**: Respect TypeScript types and interfaces
4. **PRESERVE PATTERNS**: Follow existing code conventions
5. **ONE TOOL AT A TIME**: Execute tools sequentially, waiting for results

## OUTPUT FORMAT

When using tools:
TOOL: command(args...)

For write_file with content:
TOOL: write_file(filepath="path/to/file")
CONTENT_START
<complete file contents here>
CONTENT_END

When finished:
DONE: <summary of what was accomplished>

## WORKING DIRECTORY

{cwd}`;

/**
 * OpenCode event types when using the CLI
 */
interface OpenCodeEvent {
  type:
    | "message"
    | "tool_call"
    | "tool_result"
    | "file_change"
    | "done"
    | "error";
  data: Record<string, JsonValue>;
}

/**
 * Parse events from OpenCode CLI output
 */
function parseOpenCodeOutput(output: string): OpenCodeEvent[] {
  const events: OpenCodeEvent[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try to parse as JSON event
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, JsonValue>;
        if (parsed.type && typeof parsed.type === "string") {
          events.push({
            type: parsed.type as OpenCodeEvent["type"],
            data: parsed,
          });
        }
      } catch {
        // Not valid JSON, treat as message
        events.push({
          type: "message",
          data: { content: trimmed },
        });
      }
    } else {
      // Plain text output
      events.push({
        type: "message",
        data: { content: trimmed },
      });
    }
  }

  return events;
}

/**
 * Parse tool calls from prompt-based response
 */
function parseToolCalls(
  response: string,
): Array<{ name: string; args: Record<string, string>; content?: string }> {
  const calls: Array<{
    name: string;
    args: Record<string, string>;
    content?: string;
  }> = [];

  // Match all TOOL: patterns
  const toolMatches = response.matchAll(
    /TOOL:\s*([A-Za-z0-9_:/.-]+)\s*\(([^)]*)\)/g,
  );

  for (const match of toolMatches) {
    const name = match[1];
    const argsStr = match[2];
    const args: Record<string, string> = {};

    // Parse key="value" pairs
    const argMatches = argsStr.matchAll(/(\w+)="([^"]*)"/g);
    for (const argMatch of argMatches) {
      args[argMatch[1]] = argMatch[2];
    }

    // Check for content block (for write_file)
    let content: string | undefined;
    if (name === "write_file") {
      const fullMatch = match[0];
      const afterTool = response.slice(
        response.indexOf(fullMatch) + fullMatch.length,
      );
      const contentMatch = afterTool.match(
        /CONTENT_START\s*([\s\S]*?)\s*CONTENT_END/,
      );
      if (contentMatch) {
        content = contentMatch[1];
      }
    }

    calls.push({ name, args, content });
  }

  return calls;
}

/**
 * Check if OpenCode CLI is available
 */
async function isOpenCodeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("opencode", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        resolve(false);
      }
    }, 5000);

    child.on("error", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(false);
      }
    });

    child.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(code === 0);
      }
    });
  });
}

/**
 * OpenCodeSubAgent - Implements OpenCode-style coding assistance
 *
 * Key features:
 * - LSP-aware editing suggestions
 * - Multi-session support for complex tasks
 * - Context management across files
 * - Supports both CLI mode and prompt-based fallback
 */
export class OpenCodeSubAgent implements SubAgent {
  readonly name = "OpenCode Worker";
  readonly type = "opencode" as const;

  private cancelled = false;
  private process: ChildProcess | null = null;
  private readonly maxIterations: number;
  private readonly debug: boolean;
  private readonly preferCli: boolean;

  constructor(config?: {
    maxIterations?: number;
    debug?: boolean;
    preferCli?: boolean;
  }) {
    this.maxIterations =
      config?.maxIterations ??
      getEnvInt("ELIZA_CODE_OPENCODE_MAX_ITERATIONS", 25);
    this.debug = config?.debug ?? process.env.ELIZA_CODE_DEBUG === "1";
    this.preferCli =
      config?.preferCli ?? process.env.ELIZA_CODE_OPENCODE_PREFER_CLI === "1";
  }

  cancel(): void {
    this.cancelled = true;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  async execute(task: CodeTask, context: SubAgentContext): Promise<TaskResult> {
    this.cancelled = false;

    // Check if CLI is available and preferred
    if (this.preferCli) {
      const cliAvailable = await isOpenCodeAvailable();
      if (cliAvailable) {
        return this.executeWithCli(task, context);
      }
    }

    // Fall back to prompt-based execution
    return this.executeWithPrompt(task, context);
  }

  /**
   * Execute task using OpenCode CLI
   */
  private async executeWithCli(
    task: CodeTask,
    context: SubAgentContext,
  ): Promise<TaskResult> {
    const { workingDirectory, onMessage, onTrace, isCancelled } = context;

    const filesCreated: string[] = [];
    const filesModified: string[] = [];
    let finalResponse = "";

    let traceSeq = 0;
    const base = (): Pick<TaskTraceEvent, "ts" | "seq"> => {
      traceSeq += 1;
      return { ts: Date.now(), seq: traceSeq };
    };

    return new Promise((resolve) => {
      const prompt = `${task.name}\n\n${task.description ?? ""}`.trim();

      // Spawn OpenCode CLI with JSON output mode
      this.process = spawn("opencode", ["--json", "--prompt", prompt], {
        cwd: workingDirectory,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, OPENCODE_NONINTERACTIVE: "1" },
      });

      let _stdout = "";
      let stderr = "";

      this.process.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        _stdout += chunk;

        if (isCancelled()) {
          this.cancel();
          return;
        }

        const events = parseOpenCodeOutput(chunk);
        for (const event of events) {
          switch (event.type) {
            case "message": {
              const content = event.data.content as string;
              if (content) {
                finalResponse = content;
                if (this.debug) {
                  onMessage(content, "info");
                }
              }
              break;
            }
            case "tool_call": {
              const toolName = event.data.tool as string;
              const toolArgs = event.data.args as Record<string, string>;
              onTrace?.({
                kind: "tool_call",
                iteration: traceSeq,
                name: toolName,
                args: toolArgs,
                ...base(),
              });
              break;
            }
            case "tool_result": {
              const toolName = event.data.tool as string;
              const success = event.data.success as boolean;
              const output = event.data.output as string;
              onTrace?.({
                kind: "tool_result",
                iteration: traceSeq,
                name: toolName,
                success,
                output: truncateText(output, 4000),
                outputPreview: truncateText(output, 180),
                ...base(),
              });
              break;
            }
            case "file_change": {
              const filepath = event.data.path as string;
              const action = event.data.action as string;
              if (filepath) {
                if (action === "create" || action === "write") {
                  if (!filesCreated.includes(filepath)) {
                    filesCreated.push(filepath);
                  }
                } else {
                  if (!filesModified.includes(filepath)) {
                    filesModified.push(filepath);
                  }
                }
                const abs = path.resolve(workingDirectory, filepath);
                const link = pathToFileURL(abs).toString();
                onMessage(`FILE ${action}: ${filepath} — ${link}`, "info");
              }
              break;
            }
            case "done": {
              finalResponse = (event.data.summary as string) || finalResponse;
              break;
            }
            case "error": {
              const errorMsg = event.data.message as string;
              onMessage(`Error: ${errorMsg}`, "error");
              break;
            }
          }
        }
      });

      this.process.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      this.process.on("error", (error) => {
        resolve({
          success: false,
          summary: `OpenCode CLI error: ${error.message}`,
          filesCreated,
          filesModified,
          error: error.message,
        });
      });

      this.process.on("close", (code) => {
        this.process = null;

        if (this.cancelled || isCancelled()) {
          resolve({
            success: false,
            summary: "Cancelled",
            filesCreated,
            filesModified,
            error: "Cancelled",
          });
          return;
        }

        const summary =
          finalResponse.trim().split("\n")[0] ||
          `Completed with exit code ${code}`;
        resolve({
          success: code === 0,
          summary,
          filesCreated,
          filesModified,
          error: code !== 0 ? stderr || `Exit code: ${code}` : undefined,
        });
      });
    });
  }

  /**
   * Execute task using prompt-based approach (ElizaOS runtime)
   */
  private async executeWithPrompt(
    task: CodeTask,
    context: SubAgentContext,
  ): Promise<TaskResult> {
    const {
      runtime,
      workingDirectory,
      tools,
      callMcpTool,
      onProgress,
      onMessage,
      onTrace,
      isCancelled,
      isPaused,
    } = context;

    const filesCreated: string[] = [];
    const filesModified: string[] = [];

    const maxTraceResponseChars = getEnvInt(
      "ELIZA_CODE_TRACE_MAX_RESPONSE_CHARS",
      this.debug ? 20000 : 4000,
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
      return { ts: Date.now(), seq: traceSeq };
    };

    onProgress({ taskId: task.id ?? "", progress: 0 });

    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      {
        role: "user",
        content: `Execute this task: ${task.name}

Description: ${task.description ?? "No additional description provided."}

Start by understanding the requirements, then implement the solution step by step.`,
      },
    ];

    let iteration = 0;
    let wasPaused = false;

    while (iteration < this.maxIterations && !this.cancelled) {
      if (isCancelled()) {
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

      if (isPaused?.()) {
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
      onProgress({
        taskId: task.id ?? "",
        progress: Math.min(
          90,
          Math.round((iteration / this.maxIterations) * 80),
        ),
      });

      // Call LLM
      const systemPrompt = OPENCODE_SYSTEM_PROMPT.replace(
        "{cwd}",
        workingDirectory,
      );
      const history = messages
        .map((m) =>
          m.role === "user" ? `User: ${m.content}` : `Assistant: ${m.content}`,
        )
        .join("\n\n");
      const prompt = `${systemPrompt}\n\n${history}\n\nAssistant:`;

      const modelType = runtime.getModel(ModelType.TEXT_REASONING_LARGE)
        ? ModelType.TEXT_REASONING_LARGE
        : ModelType.TEXT_LARGE;

      let response: string;
      try {
        response = await runtime.useModel(modelType, {
          prompt,
          maxTokens: 4096,
          temperature: 0.2,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        onMessage(`LLM error: ${errorMsg}`, "error");
        onTrace?.({
          kind: "note",
          level: "error",
          message: errorMsg,
          ...base(),
        });
        return {
          success: false,
          summary: `Failed: ${errorMsg}`,
          filesCreated,
          filesModified,
          error: errorMsg,
        };
      }

      // Log response
      const responseRedacted = redactSensitiveText(response);
      const responseStored = truncateText(
        responseRedacted,
        maxTraceResponseChars,
      );
      const responsePreview = truncateText(
        collapseWhitespace(firstNonEmptyLine(responseStored)),
        maxUiPreviewChars,
      );

      onTrace?.({
        kind: "llm",
        iteration,
        modelType: String(modelType),
        response: responseStored,
        responsePreview,
        ...base(),
      });

      // Check if done
      if (response.includes("DONE:")) {
        const summary =
          response.split("DONE:")[1]?.trim().split("\n")[0] ?? "Task completed";
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
        messages.push({ role: "assistant", content: response });
        messages.push({
          role: "user",
          content:
            "Continue with the task. Use TOOL: to execute commands, or say DONE: when finished.",
        });
        continue;
      }

      // Execute tools
      const results: Array<{ name: string; result: ToolResult }> = [];

      for (const call of toolCalls) {
        onTrace?.({
          kind: "tool_call",
          iteration,
          name: call.name,
          args: call.args,
          ...base(),
        });

        const result =
          (call.name.startsWith("MCP:") || call.name.includes("/")) &&
          callMcpTool
            ? await (async () => {
                const [server, toolName] = call.name
                  .replace("MCP:", "")
                  .split("/");
                if (!server || !toolName) {
                  return {
                    success: false,
                    output: `Invalid MCP tool call name: ${call.name}`,
                  };
                }
                return await callMcpTool(server, toolName, call.args);
              })()
            : await this.executeTool(
                call.name,
                call.args,
                call.content,
                tools,
                workingDirectory,
                filesCreated,
                filesModified,
                onMessage,
              );

        results.push({ name: call.name, result });

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
      }

      // Build result message
      const resultOutput = results
        .map(
          (r) =>
            `[${r.name}] ${r.result.success ? "✓" : "✗"} ${truncateText(r.result.output, 2000)}`,
        )
        .join("\n\n");

      messages.push({ role: "assistant", content: response });
      messages.push({
        role: "user",
        content: `Tool results:\n${resultOutput}\n\nContinue with the next step.`,
      });
    }

    const summary = `Completed after ${iteration} iterations`;
    onMessage(`Warning: ${summary}`, "warning");
    onTrace?.({ kind: "note", level: "warning", message: summary, ...base() });
    return {
      success: true,
      summary,
      filesCreated,
      filesModified,
    };
  }

  private async executeTool(
    name: string,
    args: Record<string, string>,
    content: string | undefined,
    tools: SubAgentTool[],
    workingDirectory: string,
    filesCreated: string[],
    filesModified: string[],
    onMessage: (
      message: string,
      priority: "info" | "warning" | "error",
    ) => void,
  ): Promise<ToolResult> {
    if (name === "write_file" && content !== undefined) {
      const tool = tools.find((t) => t.name === "write_file");
      if (!tool) {
        return { success: false, output: "write_file tool not available" };
      }

      const result = await tool.execute({ ...args, content });

      if (result.success && args.filepath) {
        if (!filesCreated.includes(args.filepath)) {
          filesCreated.push(args.filepath);
        }
        const abs = path.resolve(workingDirectory, args.filepath);
        const link = pathToFileURL(abs).toString();
        onMessage(`FILE write: ${args.filepath} — ${link}`, "info");
      }

      return result;
    }

    const tool = tools.find(
      (t) => t.name === name || t.name === name.toLowerCase(),
    );
    if (!tool) {
      return { success: false, output: `Unknown tool: ${name}` };
    }

    const result = await tool.execute(args);

    const filepath = result.data?.filepath;
    if (result.success && typeof filepath === "string") {
      if (name === "write_file" || name.includes("write")) {
        if (!filesCreated.includes(filepath)) {
          filesCreated.push(filepath);
        }
        const abs = path.resolve(workingDirectory, filepath);
        const link = pathToFileURL(abs).toString();
        const sizeValue = result.data?.size;
        const sizeSuffix =
          typeof sizeValue === "number" ? ` (${sizeValue} chars)` : "";
        onMessage(`FILE write: ${filepath}${sizeSuffix} — ${link}`, "info");
      } else if (name === "edit_file" || name.includes("edit")) {
        if (!filesModified.includes(filepath)) {
          filesModified.push(filepath);
        }
        const abs = path.resolve(workingDirectory, filepath);
        const link = pathToFileURL(abs).toString();
        onMessage(`FILE edit: ${filepath} — ${link}`, "info");
      }
    }

    return result;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getEnvInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;
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
    if (!value || value.length < 12) continue;
    const upper = key.toUpperCase();
    if (
      upper.includes("KEY") ||
      upper.includes("TOKEN") ||
      upper.includes("SECRET") ||
      upper.includes("PASSWORD") ||
      upper.includes("AUTH")
    ) {
      out = out.split(value).join(`[REDACTED:${key}]`);
    }
  }

  return out;
}

/**
 * Factory function to create an OpenCodeSubAgent
 */
export function createOpenCodeSubAgent(config?: {
  maxIterations?: number;
  debug?: boolean;
  preferCli?: boolean;
}): SubAgent {
  return new OpenCodeSubAgent(config);
}
