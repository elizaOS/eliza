/** Exposes safe, read-only Taskmarket discovery to an Eliza agent. */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  TaskmarketClient,
  type TaskmarketMode,
  type TaskmarketSort,
} from "../client.js";

interface BrowseOptions extends HandlerOptions {
  limit?: number;
  cursor?: string;
  mode?: TaskmarketMode;
  sort?: TaskmarketSort;
  minRewardBaseUnits?: string;
  deadlineHours?: number;
}

type TaskmarketTaskLister = Pick<TaskmarketClient, "listTasks">;
type TaskmarketClientFactory = () => TaskmarketTaskLister;

function readBrowseOptions(options?: HandlerOptions): BrowseOptions {
  const direct = (options ?? {}) as Record<string, unknown>;
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters } as BrowseOptions;
}

function describeTask(
  task: Awaited<ReturnType<TaskmarketClient["listTasks"]>>["tasks"][number],
): string {
  return JSON.stringify(task);
}

export function createBrowseTaskmarketTasksAction(
  createClient: TaskmarketClientFactory = () => new TaskmarketClient(),
): Action {
  return {
    name: "BROWSE_TASKMARKET_TASKS",
    description:
      "Browse open Taskmarket tasks by reward, mode, and deadline without spending funds or signing wallet transactions.",
    similes: [
      "FIND_TASKMARKET_WORK",
      "LIST_TASKMARKET_TASKS",
      "SEARCH_TASKMARKET",
    ],
    contexts: ["automation", "knowledge"],
    roleGate: { minRole: "USER" },
    parameters: [
      {
        name: "limit",
        description: "Number of tasks from 1 to 50; defaults to 50.",
        required: false,
        schema: { type: "number", minimum: 1, maximum: 50 },
      },
      {
        name: "cursor",
        description:
          "Opaque nextCursor from a prior result page. Pass it unchanged to continue.",
        required: false,
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "mode",
        description: "Optional Taskmarket work mode.",
        required: false,
        schema: {
          type: "string",
          enum: ["bounty", "claim", "pitch", "benchmark", "auction"],
        },
      },
      {
        name: "sort",
        description: "Result ordering.",
        required: false,
        schema: {
          type: "string",
          enum: ["newest", "reward_desc", "reward_asc", "deadline_asc"],
        },
      },
      {
        name: "minRewardBaseUnits",
        description: "Minimum reward in six-decimal USDC base units.",
        required: false,
        schema: { type: "string", pattern: "^[0-9]+$" },
      },
      {
        name: "deadlineHours",
        description: "Only tasks expiring within this many hours.",
        required: false,
        schema: { type: "number", minimum: 1 },
      },
    ],
    validate: async () => true,
    handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state: State | undefined,
      options?: BrowseOptions,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      try {
        const filters = readBrowseOptions(options);
        const page = await createClient().listTasks({
          limit: filters.limit,
          cursor: filters.cursor,
          mode: filters.mode,
          sort: filters.sort,
          minRewardBaseUnits: filters.minRewardBaseUnits,
          deadlineHours: filters.deadlineHours,
        });
        const taskText = page.tasks.length
          ? `Open Taskmarket tasks (${page.tasks.length}):\n${page.tasks.map(describeTask).join("\n")}`
          : "No open Taskmarket tasks matched those filters.";
        const text = page.hasMore
          ? `${taskText}\nMore tasks are available. Continue with cursor=${JSON.stringify(page.nextCursor)}.`
          : taskText;
        await callback?.({
          text,
          source: message.content.source,
          actions: ["BROWSE_TASKMARKET_TASKS"],
        });
        return { success: true, text, data: { ...page, readOnly: true } };
      } catch (error) {
        // error-policy:J1 The action boundary translates API and validation failures for the planner.
        const detail =
          error instanceof Error ? error.message : "Unknown Taskmarket error";
        const text = `Unable to browse Taskmarket tasks: ${detail}`;
        await callback?.({
          text,
          source: message.content.source,
          actions: ["BROWSE_TASKMARKET_TASKS"],
        });
        return {
          success: false,
          text,
          data: { readOnly: true, error: detail },
        };
      }
    },
    examples: [
      [
        {
          name: "{{user1}}",
          content: { text: "Find the highest-paying open Taskmarket work" },
        },
        {
          name: "{{agentName}}",
          content: {
            text: "I'll browse Taskmarket's public listings.",
            actions: ["BROWSE_TASKMARKET_TASKS"],
          },
        },
      ],
    ],
  };
}

export const browseTaskmarketTasksAction = createBrowseTaskmarketTasksAction();
