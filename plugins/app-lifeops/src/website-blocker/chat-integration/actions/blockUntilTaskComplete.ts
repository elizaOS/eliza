import crypto from "node:crypto";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { executeRawSql, sqlQuote } from "../../../lifeops/sql.js";
import { BlockRuleWriter } from "../block-rule-service.js";

interface BlockUntilTaskCompleteParams {
  websites?: unknown;
  todoId?: unknown;
  todoName?: unknown;
  unlockDurationMinutes?: unknown;
  profile?: unknown;
}

function coerceStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (Array.isArray(value)) {
    const result: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.trim();
      if (trimmed.length > 0) result.push(trimmed);
    }
    return result;
  }
  return [];
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function coerceString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

const TASK_GATE_SIGNAL_RE =
  /\buntil\b[\s\S]{0,80}\b(finish|complete|done|todo|task|workout|assignment|report)\b|\b(after|once)\b[\s\S]{0,80}\b(finish|complete|done|todo|task|workout|assignment|report)\b|\b(finish|complete|done)\b[\s\S]{0,40}\b(todo|task|workout|assignment|report)\b/i;
const FIXED_DURATION_SIGNAL_RE =
  /\bfor\s+\d+\s*(minute|minutes|min|hour|hours|hr|hrs|day|days)\b|\b\d+\s*(minute|minutes|min|hour|hours|hr|hrs|day|days)\b/i;

function getMessageText(
  message: { content?: { text?: unknown } } | undefined,
): string {
  return typeof message?.content?.text === "string"
    ? message.content.text.trim()
    : "";
}

function shouldRejectFixedDurationRequest(messageText: string): boolean {
  if (!messageText) {
    return false;
  }
  return (
    FIXED_DURATION_SIGNAL_RE.test(messageText) &&
    !TASK_GATE_SIGNAL_RE.test(messageText)
  );
}

async function findTodoIdByName(
  runtime: IAgentRuntime,
  name: string,
): Promise<string | null> {
  const agentId = String(runtime.agentId);
  const needle = name.toLowerCase();
  const rows = await executeRawSql(
    runtime,
    `SELECT id, title FROM life_task_definitions
       WHERE agent_id = ${sqlQuote(agentId)}
         AND status = 'active'
       ORDER BY created_at DESC`,
  );
  for (const row of rows) {
    const title = typeof row.title === "string" ? row.title.toLowerCase() : "";
    if (title === needle || title.includes(needle)) {
      const id = row.id;
      if (typeof id === "string") return id;
    }
  }
  return null;
}

async function createTodoByName(
  runtime: IAgentRuntime,
  name: string,
): Promise<string> {
  const agentId = String(runtime.agentId);
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  await executeRawSql(
    runtime,
    `INSERT INTO life_task_definitions (
       id, agent_id, domain, subject_type, subject_id, visibility_scope,
       context_policy, kind, title, description, original_intent, timezone,
       status, priority, cadence_json, window_policy_json,
       progression_rule_json, website_access_json, reminder_plan_id, goal_id, source,
       metadata_json, created_at, updated_at
     ) VALUES (
       ${sqlQuote(id)},
       ${sqlQuote(agentId)},
       'user_lifeops',
       'owner',
       ${sqlQuote(agentId)},
       'owner_only',
       'explicit_only',
       'todo',
       ${sqlQuote(name)},
       '',
       ${sqlQuote(name)},
       'UTC',
       'active',
       3,
       '{}',
       '{}',
       '{}',
       NULL,
       NULL,
       NULL,
       'block-until-task-complete',
       '{}',
       ${sqlQuote(nowIso)},
       ${sqlQuote(nowIso)}
     )`,
  );
  logger.info(`[BLOCK_UNTIL_TASK_COMPLETE] Created todo ${id} for "${name}"`);
  return id;
}

export const blockUntilTaskCompleteAction: Action = {
  name: "BLOCK_UNTIL_TASK_COMPLETE",
  similes: [
    "BLOCK_SITES_UNTIL_TODO_DONE",
    "BLOCK_WEBSITE_UNTIL_TASK",
    "CONDITIONAL_WEBSITE_BLOCK",
    "BLOCK_UNTIL_DONE",
    "FOCUS_UNTIL_TASK_DONE",
  ],
  description:
    "Block websites until a specific todo is marked complete. Use this only when the unblock condition is finishing a task, workout, assignment, or todo, like 'block x.com until I finish my workout'. " +
    "Creates a block rule whose release is gated on todo completion. If todoName is provided with no matching active todo, the todo is created first. " +
    "Do not use this for fixed-duration blocks like 'for 2 hours' or generic focus blocks like 'turn on social media blocking' — those are OWNER_WEBSITE_BLOCK.",
  descriptionCompressed: "Block websites until a named todo is completed.",
  contexts: ["screen_time", "browser", "tasks", "automation"],
  roleGate: { minRole: "OWNER" },
  validate: async (_runtime, message) =>
    !shouldRejectFixedDurationRequest(getMessageText(message)),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options?: HandlerOptions,
  ): Promise<ActionResult> => {
    const contentParams =
      message.content && typeof message.content === "object"
        ? (message.content as BlockUntilTaskCompleteParams)
        : {};
    const params = {
      ...contentParams,
      ...((options?.parameters ?? {}) as BlockUntilTaskCompleteParams),
    };
    const websites = coerceStringArray(params.websites);
    if (websites.length === 0) {
      return {
        success: false,
        text: "BLOCK_UNTIL_TASK_COMPLETE requires at least one website.",
        data: {
          actionName: "BLOCK_UNTIL_TASK_COMPLETE",
          reason: "missing_websites",
        },
      };
    }

    const explicitTodoId = coerceString(params.todoId);
    const todoName = coerceString(params.todoName);
    const unlockDurationMinutes = coerceNumber(params.unlockDurationMinutes);
    const profile =
      coerceString(params.profile) ?? `chat-${websites.join(",")}`;

    let todoId: string;
    let createdTodo = false;
    if (explicitTodoId) {
      todoId = explicitTodoId;
    } else if (todoName) {
      const matched = await findTodoIdByName(runtime, todoName);
      if (matched) {
        todoId = matched;
      } else {
        todoId = await createTodoByName(runtime, todoName);
        createdTodo = true;
      }
    } else {
      return {
        success: false,
        text: "BLOCK_UNTIL_TASK_COMPLETE requires either todoId or todoName.",
        data: {
          actionName: "BLOCK_UNTIL_TASK_COMPLETE",
          reason: "missing_todo_gate",
          websites,
        },
      };
    }

    const writer = new BlockRuleWriter(runtime);
    const unlockDurationMs =
      unlockDurationMinutes !== null && unlockDurationMinutes > 0
        ? Math.round(unlockDurationMinutes * 60_000)
        : null;
    const ruleId = await writer.createBlockRule({
      profile,
      websites,
      gateType: "until_todo",
      gateTodoId: todoId,
      unlockDurationMs,
    });

    return {
      success: true,
      text: `Block rule created for ${websites.join(", ")} until todo ${todoId} is completed.`,
      data: {
        actionName: "BLOCK_UNTIL_TASK_COMPLETE",
        ruleId,
        todoId,
        createdTodo,
        websites,
        unlockDurationMs,
      },
    };
  },
  parameters: [
    {
      name: "websites",
      description: "List of website hostnames to block.",
      required: true,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "todoId",
      description:
        "ID of an existing todo. Preferred over todoName when known.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "todoName",
      description:
        "Name of the todo. Resolved against active todos; created if no match.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "unlockDurationMinutes",
      description:
        "Optional: once the gate is satisfied, re-lock the same websites after this many minutes.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "profile",
      description: "Optional profile label for the block rule.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Block x.com until I finish my workout." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Block rule created for x.com until todo workout is completed.",
          action: "BLOCK_UNTIL_TASK_COMPLETE",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Block youtube until I finish this report." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Block rule created for youtube.com until todo report is completed.",
          action: "BLOCK_UNTIL_TASK_COMPLETE",
        },
      },
    ],
  ] as ActionExample[][],
};
