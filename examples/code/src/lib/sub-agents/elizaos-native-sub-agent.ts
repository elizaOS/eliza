import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ModelType } from "@elizaos/core";
import type {
  CodeTask,
  SubAgentGoal,
  SubAgentTodo,
  TaskResult,
  TaskTraceEvent,
} from "../../types.js";
import type {
  McpToolDefinition,
  SubAgent,
  SubAgentContext,
  SubAgentTool,
  ToolResult,
} from "./types.js";

/**
 * ElizaOS Native system prompt - combines best practices from:
 * - Claude Code: Built-in tools, session management, hooks
 * - Codex: Event streaming, file change tracking, structured output
 * - OpenCode: LSP-awareness, multi-session support, context management
 * - SWE-agent: Think/Act pattern, Agent-Computer Interface, trajectory tracking
 */
const ELIZAOS_NATIVE_SYSTEM_PROMPT = `You are ElizaOS, an expert AI coding agent that combines the best practices from leading coding assistants.
You are methodical, thorough, and precise in your work.

## YOUR METHODOLOGY

You follow a structured approach inspired by the best coding agents:

### 1. THINK Phase (Required Before Every Action)

Before taking any action, you MUST reason through the situation in a <thinking> block:

<thinking>
- What is the goal of this task?
- What do I know so far?
- What information do I need?
- What files might be relevant?
- What is my plan?
</thinking>

This thinking process helps you make better decisions and avoid mistakes.

### 2. LOCATE Phase

Use search and exploration tools to find relevant code:
- Use \`search_files\` to find specific patterns, functions, or imports
- Use \`list_files\` to explore directory structure
- Use \`read_file\` to examine file contents
{context7_docs}

### 3. UNDERSTAND Phase

Before modifying any code:
- Read the files you plan to change
- Understand the existing patterns and conventions
- Check for dependencies and side effects
- Note TypeScript types and interfaces

### 4. PLAN Phase

For complex tasks, create a step-by-step plan:

<plan>
1. [ ] First step description
2. [ ] Second step description
3. [ ] Third step description
</plan>

Update your plan as you progress, marking completed steps with [x].
{todo_instructions}

### 5. IMPLEMENT Phase

Make changes one step at a time:
- Use \`edit_file\` for precise modifications to existing files
- Use \`write_file\` only for new files or complete rewrites
- Verify each change before moving to the next
- Follow existing code patterns and conventions

### 6. VERIFY Phase

After making changes:
- Read the modified files to confirm changes are correct
- Consider running tests if available: \`TOOL: shell(command="npm test")\`
- Check for TypeScript errors: \`TOOL: shell(command="npx tsc --noEmit")\`

## AVAILABLE TOOLS

### File Operations
1. \`TOOL: read_file(filepath="path/to/file")\`
   - Read the contents of a file

2. \`TOOL: write_file(filepath="path/to/file")\`
   CONTENT_START
   <complete file contents - never truncate>
   CONTENT_END
   - Create or overwrite a file with complete contents

3. \`TOOL: edit_file(filepath="file", old_str="exact text to find", new_str="replacement text")\`
   - Make precise search/replace edits
   - The old_str must match exactly (including whitespace)

### Directory Operations
4. \`TOOL: list_files(path="directory")\`
   - List contents of a directory

5. \`TOOL: search_files(pattern="text", path="directory", max_matches="50")\`
   - Search for text patterns in files

### Shell Commands
6. \`TOOL: shell(command="your command")\`
   - Execute shell commands (git, npm, tests, etc.)
   - Use for: running tests, type checking, installing dependencies
{mcp_tools_docs}

## RULES

1. **ALWAYS THINK FIRST**: Start every response with a <thinking> block
2. **ONE TOOL AT A TIME**: Execute tools sequentially, wait for results
3. **COMPLETE CODE ONLY**: Never truncate code or use "..." placeholders
4. **MINIMAL CHANGES**: Prefer small, targeted edits over large rewrites
5. **VERIFY CHANGES**: Read files after editing to confirm correctness
6. **FOLLOW PATTERNS**: Match existing code style and conventions
7. **TYPE SAFETY**: Respect TypeScript types and interfaces
{goals_context}

## OUTPUT FORMAT

Every response should follow this structure:

<thinking>
Your reasoning about the current state and what to do next.
Consider: What do you know? What do you need? What's your plan?
</thinking>

[Then execute ONE tool:]
TOOL: command(args...)

[Or for write_file:]
TOOL: write_file(filepath="path")
CONTENT_START
<complete file contents>
CONTENT_END

[When finished:]
DONE: Brief summary of what was accomplished

## WORKING DIRECTORY

{cwd}

Now, let's solve the task methodically.`;

/**
 * Represents a step in the agent's internal plan
 */
interface PlanStep {
  id: number;
  description: string;
  completed: boolean;
}

/**
 * Parse thinking blocks from response
 */
function parseThinkingBlocks(response: string): string[] {
  const blocks: string[] = [];
  const regex = /<thinking>([\s\S]*?)<\/thinking>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(response)) !== null) {
    blocks.push(match[1].trim());
  }

  return blocks;
}

/**
 * Parse plan from response
 */
function parsePlan(response: string): PlanStep[] {
  const steps: PlanStep[] = [];
  const planMatch = response.match(/<plan>([\s\S]*?)<\/plan>/);

  if (planMatch) {
    const lines = planMatch[1].split("\n");
    let id = 1;

    for (const line of lines) {
      const trimmed = line.trim();
      const stepMatch = trimmed.match(/^\d+\.\s*\[([ x])\]\s*(.+)$/);
      if (stepMatch) {
        steps.push({
          id: id++,
          description: stepMatch[2],
          completed: stepMatch[1] === "x",
        });
      }
    }
  }

  return steps;
}

/**
 * Parse tool calls from response
 */
function parseToolCalls(
  response: string,
): Array<{ name: string; args: Record<string, string>; content?: string }> {
  const calls: Array<{
    name: string;
    args: Record<string, string>;
    content?: string;
  }> = [];

  // Match TOOL: patterns
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

    // Check for content block (write_file)
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
 * Generate Context7 documentation instructions
 */
function generateContext7Docs(
  mcpTools: McpToolDefinition[] | undefined,
): string {
  if (!mcpTools || mcpTools.length === 0) {
    return "";
  }

  const context7Tools = mcpTools.filter((t) => t.server === "context7");
  if (context7Tools.length === 0) {
    return "";
  }

  return `
### Documentation Lookup (Context7 MCP)
When you need documentation for a library or API:
- Use Context7 tools via MCP, for example:
  - TOOL: MCP:context7/resolve-library-id(query="...", libraryName="...")
  - TOOL: MCP:context7/query-docs(libraryId="...", query="...")
- This is especially useful for unfamiliar libraries or APIs
- Always check documentation when unsure about API usage`;
}

/**
 * Generate MCP tools documentation
 */
function generateMcpToolsDocs(
  mcpTools: McpToolDefinition[] | undefined,
): string {
  if (!mcpTools || mcpTools.length === 0) {
    return "";
  }

  const toolDocs = mcpTools
    .map((t) => {
      const params = Object.entries(t.inputSchema.properties)
        .map(([name, prop]) => `${name}="${prop.description}"`)
        .join(", ");
      return `- \`MCP:${t.server}/${t.name}(${params})\` - ${t.description}`;
    })
    .join("\n");

  return `
### MCP Tools (External Services)
Use these via TOOL calls like:
TOOL: MCP:context7/query-docs(libraryId="...", query="...")

${toolDocs}`;
}

/**
 * Generate goals context
 */
function generateGoalsContext(goals: SubAgentGoal[] | undefined): string {
  if (!goals || goals.length === 0) {
    return "";
  }

  const activeGoals = goals.filter((g) => !g.isCompleted);
  if (activeGoals.length === 0) {
    return "";
  }

  const goalsList = activeGoals
    .map((g) => `- ${g.name}${g.description ? `: ${g.description}` : ""}`)
    .join("\n");

  return `
## ACTIVE GOALS

Consider how this task contributes to your active goals:
${goalsList}`;
}

/**
 * Generate todo instructions
 */
function generateTodoInstructions(context: SubAgentContext): string {
  if (!context.createTodo) {
    return "";
  }

  return `
You can create todos to track progress on complex tasks using the createTodo tool.`;
}

/**
 * ElizaOSNativeSubAgent - The best-of-all native ElizaOS coding agent
 *
 * Combines best practices from:
 * - Claude Code: Built-in tools, hooks, session management
 * - Codex: Event streaming, file tracking, structured output
 * - OpenCode: LSP-awareness, context management
 * - SWE-agent: Think/Act pattern, trajectory tracking
 *
 * Key features:
 * - Monologue-style reasoning with <thinking> blocks
 * - Structured planning with step tracking
 * - Context7 MCP integration for documentation
 * - Goals and todo integration
 * - Comprehensive trace logging
 */
export class ElizaOSNativeSubAgent implements SubAgent {
  readonly name = "ElizaOS Native Worker";
  readonly type = "elizaos-native" as const;

  private cancelled = false;
  private plan: PlanStep[] = [];
  private thinkingHistory: string[] = [];
  private readonly maxIterations: number;
  private readonly debug: boolean;
  private readonly enableThinking: boolean;

  constructor(config?: {
    maxIterations?: number;
    debug?: boolean;
    enableThinking?: boolean;
  }) {
    this.maxIterations =
      config?.maxIterations ??
      getEnvInt("ELIZA_CODE_NATIVE_MAX_ITERATIONS", 30);
    this.debug = config?.debug ?? process.env.ELIZA_CODE_DEBUG === "1";
    this.enableThinking = config?.enableThinking ?? true;
  }

  cancel(): void {
    this.cancelled = true;
  }

  async execute(task: CodeTask, context: SubAgentContext): Promise<TaskResult> {
    this.cancelled = false;
    this.plan = [];
    this.thinkingHistory = [];

    const {
      runtime,
      workingDirectory,
      tools,
      mcpTools,
      goals,
      onProgress,
      onMessage,
      onTrace,
      createTodo,
      completeTodo,
      callMcpTool,
      isCancelled,
      isPaused,
    } = context;

    const filesCreated: string[] = [];
    const filesModified: string[] = [];
    const createdTodos: SubAgentTodo[] = [];

    const maxTraceResponseChars = getEnvInt(
      "ELIZA_CODE_TRACE_MAX_RESPONSE_CHARS",
      this.debug ? 20000 : 4000,
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
      return { ts: Date.now(), seq: traceSeq };
    };

    onProgress({ taskId: task.id ?? "", progress: 0 });

    // Build system prompt with dynamic sections
    const systemPrompt = ELIZAOS_NATIVE_SYSTEM_PROMPT.replace(
      "{cwd}",
      workingDirectory,
    )
      .replace("{context7_docs}", generateContext7Docs(mcpTools))
      .replace("{mcp_tools_docs}", generateMcpToolsDocs(mcpTools))
      .replace("{goals_context}", generateGoalsContext(goals))
      .replace("{todo_instructions}", generateTodoInstructions(context));

    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      {
        role: "user",
        content: `## TASK

**${task.name}**

${task.description ?? "No additional description provided."}

Begin by analyzing the task in a <thinking> block, then explore the codebase to understand what needs to be done.`,
      },
    ];

    let iteration = 0;
    let wasPaused = false;

    while (iteration < this.maxIterations && !this.cancelled) {
      // Check cancellation
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

      // Handle pause
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
          temperature: 0.15,
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

      // Parse thinking blocks
      const thinkingBlocks = parseThinkingBlocks(response);
      for (const thinking of thinkingBlocks) {
        this.thinkingHistory.push(thinking);
        if (this.debug || this.enableThinking)
          onMessage(`THINKING: ${truncateText(thinking, 300)}`, "info");
      }

      // Parse and update plan
      const parsedPlan = parsePlan(response);
      if (parsedPlan.length > 0) {
        this.plan = parsedPlan;

        // Create todos for plan steps (if todo integration is available).
        if (createTodo && createdTodos.length === 0) {
          for (const step of this.plan) {
            const todo = await createTodo(
              step.description,
              `Step ${step.id} of task: ${task.name}`,
            );
            createdTodos.push(todo);
          }
        }
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

      const llmTrace: TaskTraceEvent = this.debug
        ? {
            kind: "llm",
            iteration,
            modelType: String(modelType),
            response: responseStored,
            responsePreview,
            prompt: truncateText(
              redactSensitiveText(prompt),
              maxTracePromptChars,
            ),
            ...base(),
          }
        : {
            kind: "llm",
            iteration,
            modelType: String(modelType),
            response: responseStored,
            responsePreview,
            ...base(),
          };
      onTrace?.(llmTrace);

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

        // Complete any remaining todos
        if (completeTodo) {
          for (const todo of createdTodos) {
            if (!todo.isCompleted) {
              await completeTodo(todo.id);
            }
          }
        }

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
          content: `Please continue with the task. 

Remember to:
1. Start with a <thinking> block to reason about your next step
2. Execute ONE tool using the TOOL: syntax
3. Or say DONE: when the task is complete`,
        });
        continue;
      }

      // Execute tools (one at a time for better control)
      const call = toolCalls[0];

      onTrace?.({
        kind: "tool_call",
        iteration,
        name: call.name,
        args: call.args,
        ...base(),
      });

      if (this.debug)
        onMessage(`TOOL: ${call.name}(${JSON.stringify(call.args)})`, "info");

      // Check if this is an MCP tool call
      let result: ToolResult;
      if (call.name.startsWith("MCP:") || call.name.includes("/")) {
        // MCP tool call
        if (callMcpTool) {
          const [server, toolName] = call.name.replace("MCP:", "").split("/");
          result = await callMcpTool(server, toolName, call.args);
        } else {
          result = { success: false, output: "MCP tools not available" };
        }
      } else {
        // Standard tool call
        result = await this.executeTool(
          call.name,
          call.args,
          call.content,
          tools,
          workingDirectory,
          filesCreated,
          filesModified,
          onMessage,
        );
      }

      // Log tool result
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

      // Update plan progress if applicable
      const completedSteps = this.plan.filter((s) => s.completed).length;
      if (
        completeTodo &&
        completedSteps > createdTodos.filter((t) => t.isCompleted).length
      ) {
        const todoToComplete = createdTodos.find((t) => !t.isCompleted);
        if (todoToComplete) {
          await completeTodo(todoToComplete.id);
          todoToComplete.isCompleted = true;
        }
      }

      // Build continuation message
      messages.push({ role: "assistant", content: response });
      messages.push({
        role: "user",
        content: `**Tool Result:**
\`\`\`
${truncateText(result.output, 8000)}
\`\`\`

${result.success ? "✓ Command executed successfully." : "✗ Command failed."}

Continue with the next step. Remember to start with a <thinking> block.`,
      });
    }

    // Max iterations reached
    const summary = `Completed after ${iteration} iterations (max reached)`;
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
    // Handle write_file with content
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
        const sizeValue = result.data?.size;
        const sizeSuffix =
          typeof sizeValue === "number" ? ` (${sizeValue} chars)` : "";
        onMessage(
          `FILE write: ${args.filepath}${sizeSuffix} — ${link}`,
          "info",
        );
      }

      return result;
    }

    // Find tool by name
    const tool = tools.find(
      (t) => t.name === name || t.name === name.toLowerCase(),
    );
    if (!tool) {
      return { success: false, output: `Unknown tool: ${name}` };
    }

    const result = await tool.execute(args);

    // Track file changes
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

  /**
   * Get the agent's thinking history for analysis
   */
  getThinkingHistory(): string[] {
    return [...this.thinkingHistory];
  }

  /**
   * Get the current plan
   */
  getPlan(): PlanStep[] {
    return [...this.plan];
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
 * Factory function to create an ElizaOSNativeSubAgent
 */
export function createElizaOSNativeSubAgent(config?: {
  maxIterations?: number;
  debug?: boolean;
  enableThinking?: boolean;
}): SubAgent {
  return new ElizaOSNativeSubAgent(config);
}
