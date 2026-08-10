/**
 * TASKMARKET_BROWSE — discover delegatable work on the TaskMarket board.
 *
 * Read-only. Two subactions: `list` (open board, ranked, descriptions truncated)
 * and `get` (one task's full brief). Task descriptions run 2-10 KB each, so a
 * raw 20-task listing is ~100 KB of JSON; the list path truncates hard and
 * points the planner at `get` for the full brief instead of flooding the window.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  getTask,
  listTasks,
  TaskMarketApiError,
  TaskMarketResponseError,
  type TaskMarketTask,
} from "../lib/client.ts";
import {
  failureActionResult,
  formatUsdc,
  readNumberParam,
  readStringParam,
  resolveTaskMarketConfig,
  successActionResult,
  TASKMARKET_CONTEXTS,
  TASKMARKET_DETAIL_DESCRIPTION_CHARS,
  TASKMARKET_LIST_DESCRIPTION_CHARS,
} from "../types.ts";

const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 25;

function truncate(text: string | undefined, max: number): string {
  const value = (text ?? "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[truncated — use TASKMARKET_BROWSE subaction=get for the full brief]`;
}

function formatTaskSummary(task: TaskMarketTask): string {
  const subs = task.submissionCount ?? 0;
  const window = task.submissionWindowOpen === false ? "closed" : "open";
  return [
    `- ${task.id}`,
    `  reward ${formatUsdc(task.reward)} (net ${formatUsdc(task.netReward)}) | mode ${task.mode ?? "?"} | submissions ${subs} | window ${window}`,
    `  expires ${task.expiryTime ?? "?"}`,
    `  ${truncate(task.description, TASKMARKET_LIST_DESCRIPTION_CHARS).replace(/\n/g, " ")}`,
  ].join("\n");
}

export const taskMarketBrowseAction: Action = {
  name: "TASKMARKET_BROWSE",
  contexts: [...TASKMARKET_CONTEXTS],
  similes: [
    "BROWSE_TASKMARKET",
    "LIST_TASKMARKET_TASKS",
    "FIND_DELEGATABLE_WORK",
  ],
  description:
    "Browse open work on the TaskMarket agent marketplace, or fetch one task's full brief. Read-only: it never creates a task, spends funds, or accepts a submission. Use subaction=list for the open board (descriptions truncated) and subaction=get with taskId for the full brief.",
  parameters: [
    {
      name: "subaction",
      description: "Either 'list' for the open board or 'get' for one task.",
      required: false,
      schema: { type: "string", enum: ["list", "get"], default: "list" },
    },
    {
      name: "taskId",
      description: "Task id, required when subaction=get.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "status",
      description: "Board status filter, default 'open'.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "mode",
      description:
        "Optional mode filter: bounty, claim, pitch, benchmark or auction.",
      required: false,
      schema: {
        type: "string",
        enum: ["bounty", "claim", "pitch", "benchmark", "auction"],
      },
    },
    {
      name: "limit",
      description: `Number of tasks to return, default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}.`,
      required: false,
      schema: { type: "number" },
    },
  ],
  validate: async (runtime: IAgentRuntime) =>
    resolveTaskMarketConfig(runtime) !== undefined,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: unknown,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const config = resolveTaskMarketConfig(runtime);
    if (!config) {
      return failureActionResult({
        reason: "not_configured",
        message:
          "TASKMARKET_API_TOKEN and TASKMARKET_ADDRESS must both be set (the API bearer token does not identify the caller).",
      });
    }

    const subaction = (
      readStringParam(options, "subaction") ?? "list"
    ).toLowerCase();

    try {
      if (subaction === "get") {
        const taskId = readStringParam(options, "taskId");
        if (!taskId) {
          return failureActionResult({
            reason: "missing_param",
            message: "taskId is required when subaction=get",
          });
        }
        const task = await getTask(config, taskId);
        const text = [
          `Task ${task.id}`,
          `reward ${formatUsdc(task.reward)} (net ${formatUsdc(task.netReward)})`,
          `mode ${task.mode ?? "?"} | status ${task.status ?? "?"} | submissions ${task.submissionCount ?? 0}`,
          `window ${task.submissionWindowOpen === false ? "closed" : "open"} | expires ${task.expiryTime ?? "?"}`,
          "",
          truncate(task.description, TASKMARKET_DETAIL_DESCRIPTION_CHARS),
        ].join("\n");
        return successActionResult(text, {
          action: "TASKMARKET_BROWSE",
          subaction: "get",
          taskId: task.id,
        });
      }

      const requested = readNumberParam(options, "limit");
      const limit =
        requested && requested > 0
          ? Math.min(MAX_LIST_LIMIT, Math.floor(requested))
          : DEFAULT_LIST_LIMIT;
      const tasks = await listTasks(config, {
        status: readStringParam(options, "status") ?? "open",
        mode: readStringParam(options, "mode"),
        limit,
        sort: "reward_desc",
      });
      if (tasks.length === 0) {
        return successActionResult("No matching TaskMarket tasks.", {
          action: "TASKMARKET_BROWSE",
          subaction: "list",
          count: 0,
        });
      }
      const text = [
        `${tasks.length} TaskMarket task(s):`,
        ...tasks.map(formatTaskSummary),
      ].join("\n");
      return successActionResult(text, {
        action: "TASKMARKET_BROWSE",
        subaction: "list",
        count: tasks.length,
      });
    } catch (error) {
      if (error instanceof TaskMarketApiError) {
        return failureActionResult(
          {
            reason: "api_error",
            message: `HTTP ${error.status}: ${error.message}`,
          },
          { action: "TASKMARKET_BROWSE" },
        );
      }
      if (error instanceof TaskMarketResponseError) {
        return failureActionResult(
          { reason: "invalid_response", message: error.message },
          { action: "TASKMARKET_BROWSE" },
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return failureActionResult(
        { reason: "io_error", message },
        { action: "TASKMARKET_BROWSE" },
      );
    }
  },
};
