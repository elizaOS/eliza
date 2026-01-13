import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
  type UUID,
} from "@elizaos/core";
import type { CodeTaskService } from "../services/code-task.js";
import type { SubAgentType } from "../../types.js";

interface TaskRequest {
  name: string;
  description: string;
  steps: string[];
}

/**
 * Strip task context prefix from message text.
 * The chat manager prepends "[Task Context]...[User Message]" to messages.
 * We need to find the LAST [User Message] marker since the task context
 * itself may contain previous user messages.
 */
function stripTaskContext(text: string): string {
  // Find the LAST occurrence of [User Message] marker
  const marker = "[User Message]";
  const lastIndex = text.lastIndexOf(marker);

  if (lastIndex !== -1) {
    const afterMarker = text.substring(lastIndex + marker.length).trim();
    if (afterMarker.length > 0) {
      return afterMarker;
    }
  }

  // Also try case-insensitive search
  const lowerText = text.toLowerCase();
  const lowerMarker = marker.toLowerCase();
  const lastIndexLower = lowerText.lastIndexOf(lowerMarker);

  if (lastIndexLower !== -1) {
    const afterMarker = text.substring(lastIndexLower + marker.length).trim();
    if (afterMarker.length > 0) {
      return afterMarker;
    }
  }

  // Fallback: if [Task Context] is at the start, try to find content after double newline
  if (text.startsWith("[Task Context]")) {
    const doubleNewline = text.indexOf("\n\n");
    if (doubleNewline !== -1) {
      const afterContext = text.substring(doubleNewline + 2).trim();
      if (afterContext.length > 0) {
        return afterContext;
      }
    }
  }

  return text;
}

/**
 * Extract task details from message
 */
function parseTaskRequest(rawText: string): TaskRequest {
  // Strip task context prefix if present
  const text = stripTaskContext(rawText);

  let name = "";
  let description = "";
  const steps: string[] = [];

  // Try explicit task name patterns
  const explicitPatterns = [
    /(?:create|start|new)\s+(?:a\s+)?task\s*[:-]?\s*["']?([^"'\n]+)["']?/i,
    /(?:task|job)\s*[:-]?\s*["']?([^"'\n]+)["']?/i,
  ];

  for (const pattern of explicitPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      name = match[1].trim().substring(0, 100);
      break;
    }
  }

  // Implicit patterns
  if (!name) {
    const implicitPatterns = [
      /(?:make|build|implement|create|develop|write)\s+(?:a\s+)?(?:me\s+)?["']?([^"'\n,.]+)["']?/i,
      /(?:can you|please|could you)\s+(?:make|build|implement|create)\s+(?:a\s+)?["']?([^"'\n,.]+)["']?/i,
    ];

    for (const pattern of implicitPatterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        let extracted = match[1].trim();
        extracted = extracted.charAt(0).toUpperCase() + extracted.slice(1);
        name = extracted.substring(0, 100);
        break;
      }
    }
  }

  // Fallback
  if (!name) {
    const words = text.split(/\s+/).slice(0, 5).join(" ");
    name = words.substring(0, 50) || "New Task";
  }

  // Validate the extracted name - reject clearly invalid names
  // that might come from malformed context parsing
  const invalidPatterns = [
    /^Context\]?$/i, // "Context]" from task context
    /^s:$/i, // "s:" from malformed parsing
    /^Task:?$/i, // Just "Task" or "Task:"
    /^\*+$/, // Just asterisks
    /^\[.*\]$/, // Just bracketed text
    /^#+ /, // Markdown headers
  ];

  if (
    invalidPatterns.some((p) => p.test(name.trim())) ||
    name.trim().length < 3
  ) {
    // Try to extract a better name from the full text
    const cleanWords = text
      .replace(/\[.*?\]/g, "") // Remove bracketed content
      .replace(/#+\s*/g, "") // Remove markdown headers
      .replace(/\*+/g, "") // Remove asterisks
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 6)
      .join(" ");
    name = cleanWords.substring(0, 60) || "New Task";
  }

  // Extract description
  const descMatch = text.match(/(?:description|details?|about)[:\s]+(.+)/i);
  description = descMatch?.[1]?.trim() ?? text.substring(0, 500);

  // Extract steps
  const stepsMatch = text.match(
    /(?:steps?|plan)[:\s]+([\s\S]+?)(?:$|description)/i,
  );
  if (stepsMatch?.[1]) {
    const stepLines = stepsMatch[1].split(/\n|(?:\d+\.)/);
    for (const line of stepLines) {
      const cleaned = line.replace(/^[-*•]\s*/, "").trim();
      if (cleaned.length === 0) continue;
      // Guard against accidentally capturing structured headers as steps.
      if (/^(description|details?)\s*[:-]/i.test(cleaned)) continue;
      if (/^(create|start|new)\s+(?:a\s+)?task\s*[:-]/i.test(cleaned)) continue;
      steps.push(cleaned);
    }
  }

  // Deduplicate steps while preserving order (helps avoid double-parsing artifacts)
  if (steps.length > 1) {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const step of steps) {
      const normalized = step.replace(/\s+/g, " ").trim().toLowerCase();
      if (!normalized) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      deduped.push(step.replace(/\s+/g, " ").trim());
    }
    steps.length = 0;
    steps.push(...deduped);
  }

  return { name, description, steps };
}

/**
 * Get recent conversation context for task creation.
 * Fetches up to 30 messages and trims to fit within context limits.
 */
async function getConversationContext(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<string> {
  // Max characters for conversation context (fits within 120k token context)
  const MAX_CONTEXT_CHARS = 120000;

  const getMemories = (
    runtime as { getMemories?: IAgentRuntime["getMemories"] }
  ).getMemories;
  if (typeof getMemories !== "function") {
    return "";
  }

  // Get recent messages from the same room (fetch enough to fill context)
  const recentMessages = await getMemories({
    roomId: message.roomId,
    tableName: "messages",
    count: 100, // Fetch last 100 messages to have plenty of context
  });

  if (recentMessages.length === 0) {
    return "";
  }

  // Sort by creation time (oldest first)
  const sorted = recentMessages.sort((a, b) => {
    const timeA = a.createdAt ?? 0;
    const timeB = b.createdAt ?? 0;
    return timeA - timeB;
  });

  // Format all messages
  const formattedMessages = sorted.map((msg) => {
    const role = msg.entityId === runtime.agentId ? "Assistant" : "User";
    const text = stripTaskContext(msg.content.text ?? "");
    return { role, text, formatted: `${role}: ${text}` };
  });

  // Build context, keeping most recent messages and trimming older ones if needed
  // Start from the end (most recent) and work backwards
  const includedMessages: string[] = [];
  let totalChars = 0;

  // Always include the most recent messages first (they're most relevant)
  for (let i = formattedMessages.length - 1; i >= 0; i--) {
    const msg = formattedMessages[i];
    const msgLength = msg.formatted.length + 2; // +2 for \n\n separator

    if (totalChars + msgLength <= MAX_CONTEXT_CHARS) {
      includedMessages.unshift(msg.formatted);
      totalChars += msgLength;
    } else {
      // If we can't fit this message, try to include a truncated summary
      // of earlier conversation
      if (i > 0) {
        const earlierCount = i + 1;
        const summary = `[... ${earlierCount} earlier messages omitted for brevity ...]`;
        if (totalChars + summary.length + 2 <= MAX_CONTEXT_CHARS) {
          includedMessages.unshift(summary);
        }
      }
      break;
    }
  }

  return includedMessages.join("\n\n");
}

/**
 * Use LLM to generate a meaningful task name and description from conversation
 */
async function generateTaskFromConversation(
  runtime: IAgentRuntime,
  conversationContext: string,
  currentMessage: string,
): Promise<TaskRequest> {
  const prompt = `You are analyzing a conversation to create a development task.

## Recent Conversation:
${conversationContext}

## Current Message:
${stripTaskContext(currentMessage)}

## Instructions:
Based on the conversation above, extract:
1. A short, descriptive task name (max 60 chars) that captures what needs to be built
2. A clear description of what the task should accomplish
3. If apparent, a list of high-level steps

Respond in this exact JSON format:
{
  "name": "Build 3D Tetris Game",
  "description": "Create a 3D Tetris game using Three.js with piece rotation, line clearing, and scoring",
  "steps": ["Set up Three.js scene", "Create tetromino pieces", "Implement game logic"]
}

IMPORTANT: 
- The name should describe WHAT is being built, not the conversation (e.g., "Build 3D Tetris" not "User wants something")
- If the last message is vague like "sounds good" or "let's do it", use the earlier context to determine the actual task
- Return ONLY valid JSON, no other text`;

  try {
    const result = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      maxTokens: 500,
      temperature: 0.3,
    });

    const text = typeof result === "string" ? result : String(result);

    // Try to parse JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        name?: string;
        description?: string;
        steps?: string[];
      };
      return {
        name: (parsed.name ?? "New Task").substring(0, 100),
        description:
          parsed.description ?? conversationContext.substring(0, 500),
        steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      };
    }
    // Fallback if no JSON found in response
    return parseTaskRequest(
      stripTaskContext(currentMessage).trim() || conversationContext.trim(),
    );
  } catch (err: Error) {
    const msg = err.message;
    logger.error(`CREATE_TASK planning model failed: ${msg}`);
    // Fallback to simple parsing if LLM fails
    const context = conversationContext.trim();
    const current = stripTaskContext(currentMessage).trim();
    const merged = !context
      ? current
      : !current
        ? context
        : context.includes(current)
          ? context
          : `${context}\n\n${current}`;
    return parseTaskRequest(merged);
  }
}

export const createTaskAction: Action = {
  name: "CREATE_TASK",
  similes: ["START_TASK", "SPAWN_TASK", "NEW_TASK", "BEGIN_TASK"],
  description: `Create a background task for complex, multi-step development work that runs autonomously.

USE THIS ACTION WHEN:
- User explicitly says "create task", "start task", or "new task"
- User wants to "implement", "build", "create", or "develop" a significant feature
- Work requires multiple files, steps, or extended execution time
- User describes a complex feature without specifying individual files

DO NOT USE WHEN:
- User wants a small code snippet or function (use GENERATE)
- User wants to understand or plan something (use PLAN or ASK)
- Request is simple enough to complete in one action

TASK EXECUTION:
- Tasks run in the background with their own execution context
- Progress is tracked with steps that can be monitored
- Tasks can be paused, resumed, or cancelled
- Uses LLM to generate implementation plans if steps aren't provided

INPUTS:
- Task name (extracted from request or generated from context)
- Description (from user message or conversation context)
- Optional: Explicit steps if user provides them`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";

    const isExplicitTaskRequest = text.includes("task");
    const hasBuildIntent =
      text.includes("implement") ||
      text.includes("build") ||
      text.includes("create") ||
      text.includes("develop") ||
      text.includes("add") ||
      text.includes("update") ||
      text.includes("modify") ||
      text.includes("change") ||
      text.includes("refactor") ||
      text.includes("fix");

    if (!isExplicitTaskRequest && !hasBuildIntent) return false;

    // In orchestrator mode, we allow tasks even for explicit file edits/creates,
    // so the main agent does not write/edit files directly.

    // Avoid spawning tasks for tiny “generate a function/class” requests unless explicitly asked.
    const looksLikeSmallSnippet =
      /\b(function|class|interface|type|snippet|quicksort|algorithm)\b/i.test(
        text,
      );
    if (looksLikeSmallSnippet && !isExplicitTaskRequest) return false;

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options: HandlerOptions | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = runtime.getService("CODE_TASK") as CodeTaskService | null;
    if (!service) {
      const error = "CodeTaskService not available";
      if (callback) await callback({ content: { text: error } });
      return { success: false, text: error };
    }

    // Check for options-provided title and steps (useful for programmatic calls and tests)
    const opts = options as
      | {
          title?: string;
          steps?: string[];
          description?: string;
          subAgentType?: string;
        }
      | undefined;
    const optTitle = opts?.title;
    const optSteps = opts?.steps;
    const optDescription = opts?.description;
    const optSubAgentType = normalizeSubAgentType(opts?.subAgentType);

    const rawText = message.content.text ?? "";
    const stripped = stripTaskContext(rawText);
    const parsed = parseTaskRequest(rawText);
    const parsedSubAgentType = extractRequestedSubAgentType(stripped);

    const hasStructuredFields =
      /(?:^|\n)\s*(?:create\s+(?:a\s+)?task|start\s+(?:a\s+)?task|new\s+task|task)\s*[:-]/i.test(
        stripped,
      ) ||
      /(?:^|\n)\s*(?:description|details?)\s*[:-]/i.test(stripped) ||
      /(?:^|\n)\s*(?:steps?|plan)\s*[:-]/i.test(stripped) ||
      parsed.steps.length > 0;

    // Use options-provided values if available, otherwise parse/generate
    let name: string;
    let description: string;
    let steps: string[];

    if (optTitle) {
      // Options take precedence
      name = optTitle;
      description = optDescription ?? parsed.description;
      steps = optSteps ?? parsed.steps;
    } else if (hasStructuredFields) {
      ({ name, description, steps } = parsed);
    } else {
      ({ name, description, steps } = await generateTaskFromConversation(
        runtime,
        await getConversationContext(runtime, message),
        rawText,
      ));
    }

    // Override steps if provided via options
    if (optSteps && optSteps.length > 0) {
      steps = optSteps;
    }

    try {
      // Create task using service (persisted via core runtime)
      const roomId = message.roomId as UUID | undefined;
      const subAgentType: SubAgentType =
        optSubAgentType ?? parsedSubAgentType ?? "eliza";
      const task = await service.createCodeTask(
        name,
        description,
        roomId,
        subAgentType,
      );

      // If user didn't provide steps via options or parsing, generate a plan using a model.
      // When steps are explicitly provided (optSteps), skip model generation.
      const taskId = task.id ?? "";
      let finalSteps = steps;
      const hasProvidedSteps =
        (optSteps && optSteps.length > 0) || steps.length > 0;
      if (!hasProvidedSteps) {
        finalSteps = await generatePlanSteps(runtime, {
          taskName: name,
          description,
          cwd: task.metadata.workingDirectory,
          userRequest: message.content.text ?? "",
        });
      }

      let planPreview = "";
      for (const stepDesc of finalSteps) {
        await service.addStep(taskId, stepDesc);
      }

      if (finalSteps.length > 0) {
        planPreview = finalSteps
          .slice(0, 6)
          .map((s, i) => `${i + 1}. ${s}`)
          .join("\n");
        await service.appendOutput(taskId, `Plan:\n${planPreview}`);
      }

      // Allow disabling background execution (useful for unit tests and environments
      // where model/tool execution is not desired).
      const disableExecution =
        process.env.ELIZA_CODE_DISABLE_TASK_EXECUTION === "1";
      if (disableExecution) {
        const descPreview =
          description.length > 200
            ? `${description.substring(0, 200)}…`
            : description;
        const lines: string[] = [];
        lines.push(`Created task: ${task.name}`);
        lines.push(`Description: ${descPreview}`);
        if (finalSteps.length > 0) lines.push(`Steps: ${finalSteps.length}`);
        if (planPreview) {
          lines.push("Plan:");
          lines.push(planPreview);
        }
        lines.push("Execution disabled (ELIZA_CODE_DISABLE_TASK_EXECUTION=1).");
        const disabledResult = lines.join("\n");
        if (callback) await callback({ content: { text: disabledResult } });
        const stableTaskId = task.id ?? taskId;
        return {
          success: true,
          text: disabledResult,
          data: {
            taskId: stableTaskId,
            name: task.name,
            steps: finalSteps.length,
            executionDisabled: true,
          },
        };
      }

      const descPreview =
        description.length > 200
          ? `${description.substring(0, 200)}…`
          : description;
      const lines: string[] = [];
      lines.push(`Created task: ${task.name}`);
      lines.push(`Sub-agent: ${subAgentType}`);
      lines.push(`Description: ${descPreview}`);
      if (finalSteps.length > 0) lines.push(`Steps: ${finalSteps.length}`);
      if (planPreview) {
        lines.push("Plan:");
        lines.push(planPreview);
      }
      lines.push("Starting execution…");
      const result = lines.join("\n");

      if (callback) await callback({ content: { text: result } });

      // Start execution in background
      service.startTaskExecution(taskId).catch((err) => {
        logger.error(
          `Task execution failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      return {
        success: true,
        text: result,
        data: {
          taskId: task.id ?? taskId,
          name: task.name,
          steps: finalSteps.length,
        },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`CREATE_TASK error: ${error}`);
      if (callback)
        await callback({
          content: { text: `Failed to create task: ${error}` },
        });
      return { success: false, text: error };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "create a task to implement user authentication" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Creating task for user authentication...",
          actions: ["CREATE_TASK"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "implement a file upload feature" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll create a task to implement file upload...",
          actions: ["CREATE_TASK"],
        },
      },
    ],
  ],
};

function extractRequestedSubAgentType(text: string): SubAgentType | undefined {
  const lower = text.toLowerCase();

  // Explicit directive patterns
  const patterns = [
    /(?:^|\n)\s*(?:agent|sub-agent|subagent|worker)\s*[:=]\s*([a-z0-9_-]+)/i,
    /\buse\s+([a-z0-9_-]+)\s+(?:agent|sub-agent|subagent|worker)\b/i,
    /\bwith\s+([a-z0-9_-]+)\s+(?:agent|sub-agent|subagent|worker)\b/i,
  ];

  for (const p of patterns) {
    const m = lower.match(p);
    if (m?.[1]) {
      const normalized = normalizeSubAgentType(m[1]);
      if (normalized) return normalized;
    }
  }

  // Shorthand mentions
  if (lower.includes("claude-code") || lower.includes("claude code")) {
    return "claude-code";
  }
  if (lower.includes("codex")) return "codex";
  if (lower.includes("opencode") || lower.includes("open code")) return "opencode";
  if (lower.includes("sweagent") || lower.includes("swe-agent")) return "sweagent";
  if (
    lower.includes("elizaos-native") ||
    lower.includes("eliza native") ||
    lower.includes("native sub-agent")
  ) {
    return "elizaos-native";
  }

  return undefined;
}

function normalizeSubAgentType(input: string | undefined): SubAgentType | null {
  const raw = (input ?? "").trim().toLowerCase();
  if (!raw) return null;

  if (raw === "eliza") return "eliza";
  if (raw === "claude" || raw === "claude-code" || raw === "claudecode")
    return "claude-code";
  if (raw === "codex") return "codex";
  if (raw === "opencode" || raw === "open-code" || raw === "open_code")
    return "opencode";
  if (raw === "sweagent" || raw === "swe-agent" || raw === "swe_agent")
    return "sweagent";
  if (
    raw === "elizaos-native" ||
    raw === "eliza-native" ||
    raw === "native" ||
    raw === "elizaosnative"
  )
    return "elizaos-native";

  return null;
}

function parseNumberedSteps(text: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const steps: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*(?:\d+[).\]]|[-*])\s+(.+)\s*$/);
    if (m?.[1]) {
      const step = m[1].trim();
      if (step.length > 0) steps.push(step);
    }
  }

  // If the model didn't format as a list, fall back to non-empty lines.
  if (steps.length === 0) return lines.slice(0, 8);
  return steps.slice(0, 12);
}

async function generatePlanSteps(
  runtime: IAgentRuntime,
  input: {
    taskName: string;
    description: string;
    cwd: string;
    userRequest: string;
  },
): Promise<string[]> {
  const prompt = [
    "You are an expert software engineer. Create a concrete, step-by-step implementation plan.",
    "",
    `Task: ${input.taskName}`,
    `Working directory: ${input.cwd}`,
    "",
    "User request:",
    input.userRequest,
    "",
    "Rules:",
    "- Return ONLY a numbered list of 4-8 steps.",
    "- Steps must be actionable and specific (e.g., name files or commands when possible).",
    "- Include an explicit 'Verify' step (tests/build/run).",
  ].join("\n");

  // Prefer reasoning model if available, fall back to TEXT_LARGE
  const modelType = runtime.getModel(ModelType.TEXT_REASONING_LARGE)
    ? ModelType.TEXT_REASONING_LARGE
    : ModelType.TEXT_LARGE;

  const result = await runtime.useModel(modelType, {
    prompt,
    maxTokens: 700,
    temperature: 0.2,
  });

  const text = typeof result === "string" ? result : String(result);
  return parseNumberedSteps(text);
}
