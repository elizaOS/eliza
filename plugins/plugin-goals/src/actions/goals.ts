/**
 * OWNER_GOALS — owner-set long-horizon life goals.
 *
 * Self-contained goal CRUD surface backed by {@link GoalsService} (the goals
 * back-end this plugin owns). Used in the PA-free deployment topology; when
 * `@elizaos/plugin-personal-assistant` is loaded it registers its own richer
 * `OWNER_GOALS` natural-language flow, which delegates to the same
 * {@link GoalsService} CRUD methods.
 *
 * Dispatch: create | update | delete | review. The handler resolves the
 * subaction + params (planner-trust path first, LLM extraction fallback) via
 * `resolveActionArgs`, then calls the goals back-end.
 */

import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  resolveActionArgs,
  type State,
  type SubactionsMap,
} from "@elizaos/core";
import type { LifeOpsGoalRecord } from "@elizaos/shared";
import { GoalsServiceError } from "../goal-normalize.ts";
import { createOwnerGoalsService } from "../goals-runtime.ts";
import {
  GOAL_CHECKIN_PROGRESS_STATES,
  type GoalCheckinProgress,
  getGoalsCheckinService,
} from "../services/checkin.ts";
import { GOAL_ACTIONS, GOALS_CONTEXTS, GOALS_LOG_PREFIX } from "../types.ts";

type GoalSubaction = (typeof GOAL_ACTIONS)[number];

interface GoalActionParams {
  id?: string;
  title?: string;
  description?: string;
  note?: string;
  progress?: string;
}

function parseCheckinProgress(
  value: string | undefined,
): GoalCheckinProgress | undefined {
  if (value === undefined) return undefined;
  return GOAL_CHECKIN_PROGRESS_STATES.find((state) => state === value);
}

const SUBACTIONS: SubactionsMap<GoalSubaction> = {
  create: {
    description: "Create a new owner long-horizon life goal.",
    descriptionCompressed: "create owner long-horizon goal",
    required: ["title"],
    optional: ["description"],
  },
  update: {
    description: "Update an existing owner goal by id.",
    descriptionCompressed: "update owner goal by id",
    required: ["id"],
    optional: ["title", "description"],
  },
  delete: {
    description: "Delete an owner goal by id.",
    descriptionCompressed: "delete owner goal by id",
    required: ["id"],
  },
  review: {
    description: "Review the current state of an owner goal by id.",
    descriptionCompressed: "review owner goal state by id",
    required: ["id"],
  },
  checkin: {
    description:
      "Record the owner's check-in response for a goal by id: optional note plus progress (on_track | at_risk | needs_attention).",
    descriptionCompressed: "record goal check-in response by id",
    required: ["id"],
    optional: ["note", "progress"],
  },
};

function describeGoal(record: LifeOpsGoalRecord): string {
  return record.goal.title;
}

export const ownerGoalsAction: Action = {
  name: "OWNER_GOALS",
  description:
    "Manage the owner's long-horizon life goals. Actions: create, update, delete, review, checkin. Goals carry a horizon (e.g. quarter, year, life), feed routine + reminder generation, and cadenced goals get scheduled check-ins whose responses are recorded via checkin.",
  descriptionCompressed:
    "owner goals: create|update|delete|review|checkin; long-horizon, drives routines",
  contexts: [...GOALS_CONTEXTS],
  contextGate: { anyOf: [...GOALS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  tags: [
    "domain:goals",
    "capability:write",
    "capability:update",
    "capability:delete",
    "surface:owner",
  ],
  similes: ["GOALS", "LIFE_GOALS", "SET_GOAL", "UPDATE_GOAL", "REVIEW_GOALS"],
  parameters: [
    {
      name: "action",
      description: "Action: create | update | delete | review.",
      required: true,
      schema: { type: "string" as const, enum: [...GOAL_ACTIONS] },
    },
    {
      name: "id",
      description: "Goal id (update/delete/review).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "title",
      description: "Goal title (create/update).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "description",
      description: "Longer goal description (create/update).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "note",
      description: "Owner's check-in note (checkin).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "progress",
      description: "Reported goal progress (checkin).",
      required: false,
      schema: {
        type: "string" as const,
        enum: [...GOAL_CHECKIN_PROGRESS_STATES],
      },
    },
  ],
  validate: async (_runtime: IAgentRuntime): Promise<boolean> => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const resolved = await resolveActionArgs<GoalSubaction, GoalActionParams>({
      runtime,
      message,
      state,
      options,
      actionName: "OWNER_GOALS",
      subactions: SUBACTIONS,
    });
    if (!resolved.ok) {
      await callback?.({ text: resolved.clarification });
      return {
        success: false,
        text: resolved.clarification,
        data: { action: "clarify", missing: resolved.missing },
      };
    }

    const service = createOwnerGoalsService(runtime);
    const { subaction, params } = resolved;

    try {
      switch (subaction) {
        case "create": {
          const record = await service.createGoal({
            title: params.title ?? "",
            description: params.description,
          });
          const text = `Added goal "${describeGoal(record)}".`;
          await callback?.({ text });
          return { success: true, text, data: { action: "create", record } };
        }
        case "update": {
          const record = await service.updateGoal(params.id ?? "", {
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.description !== undefined
              ? { description: params.description }
              : {}),
          });
          const text = `Updated goal "${describeGoal(record)}".`;
          await callback?.({ text });
          return { success: true, text, data: { action: "update", record } };
        }
        case "delete": {
          const record = await service.getGoal(params.id ?? "");
          await service.deleteGoal(params.id ?? "");
          const text = `${describeGoal(record)} is off your goals list.`;
          await callback?.({ text });
          return {
            success: true,
            text,
            data: { action: "delete", id: params.id },
          };
        }
        case "review": {
          const record = await service.getGoal(params.id ?? "");
          const text = `Goal "${describeGoal(record)}" is ${record.goal.reviewState.replace(/_/g, " ")} (status: ${record.goal.status}).`;
          await callback?.({ text });
          return { success: true, text, data: { action: "review", record } };
        }
        case "checkin": {
          const checkinService = getGoalsCheckinService(runtime);
          if (!checkinService) {
            const text = `${GOALS_LOG_PREFIX} the goal check-in engine is not available on this runtime.`;
            await callback?.({ text });
            return {
              success: false,
              text,
              data: { action: "checkin", error: "checkin_service_missing" },
            };
          }
          const progress = parseCheckinProgress(params.progress);
          if (params.progress !== undefined && progress === undefined) {
            const text = `${GOALS_LOG_PREFIX} progress must be one of: ${GOAL_CHECKIN_PROGRESS_STATES.join(", ")}.`;
            await callback?.({ text });
            return {
              success: false,
              text,
              data: { action: "checkin", error: "invalid_progress" },
            };
          }
          const { goal, completedTaskId } =
            await checkinService.recordCheckinResponse({
              goalId: params.id ?? "",
              ...(params.note !== undefined ? { note: params.note } : {}),
              ...(progress !== undefined ? { progress } : {}),
            });
          const text = `Logged check-in for "${goal.title}"${progress ? ` — ${progress.replace(/_/g, " ")}` : ""}.`;
          await callback?.({ text });
          return {
            success: true,
            text,
            data: { action: "checkin", goal, completedTaskId },
          };
        }
      }
    } catch (error) {
      if (error instanceof GoalsServiceError) {
        const text = `${GOALS_LOG_PREFIX} ${error.message}`;
        await callback?.({ text });
        return {
          success: false,
          text,
          data: { action: subaction, error: error.message },
        };
      }
      throw error;
    }
  },
};
