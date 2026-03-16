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
} from "@elizaos/core";
import {
  type CreatePlanParameters,
  encodePlan,
  formatPlan,
  generatePlanId,
  generateTaskId,
  type Plan,
  PLAN_SOURCE,
  PLUGIN_PLANS_TABLE,
  PlanStatus,
  type Task,
  TaskStatus,
} from "../types.js";

export const createPlanAction: Action = {
  name: "CREATE_PLAN",
  description: "Create a new plan with tasks to accomplish a goal",
  similes: ["create-plan", "new-plan", "make-plan", "plan-this", "organize-tasks"],

  examples: [
    [
      {
        name: "User",
        content: { text: "Create a plan for launching the new website" },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll create a launch plan for the new website with key tasks.",
          actions: ["CREATE_PLAN"],
        },
      },
    ],
    [
      {
        name: "User",
        content: { text: "Plan out the steps to migrate the database to PostgreSQL" },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll create a migration plan with the necessary steps.",
          actions: ["CREATE_PLAN"],
        },
      },
    ],
  ],

  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> {
    return typeof runtime.createMemory === "function";
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> {
    try {
      const content = message.content.text;
      if (!content) {
        const errorMessage = "Please describe what you want to plan.";
        await callback?.({ text: errorMessage, source: message.content.source });
        return { text: errorMessage, success: false };
      }

      const params = _options?.parameters as CreatePlanParameters | undefined;
      let planTitle: string = params?.title ?? "";
      let planDescription: string = params?.description ?? "";
      let taskDefs: Array<{
        title: string;
        description?: string;
        dependencies?: string[];
      }> = params?.tasks ?? [];

      // Use LLM to generate plan structure if not explicitly provided
      if (!params?.title || taskDefs.length === 0) {
        const planPrompt = `Create a structured plan from this request. Return ONLY a JSON object (no markdown):
{
  "title": "Brief plan title",
  "description": "Plan description and goal",
  "tasks": [
    {"title": "Task 1 title", "description": "What to do"},
    {"title": "Task 2 title", "description": "What to do", "dependencies": ["task-1"]},
    {"title": "Task 3 title", "description": "What to do"}
  ]
}

User request: "${content}"`;

        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: planPrompt,
        });

        if (response) {
          try {
            const cleaned = response
              .replace(/^```(?:json)?\n?/, "")
              .replace(/\n?```$/, "")
              .trim();
            const parsed: {
              title?: string;
              description?: string;
              tasks?: Array<{ title: string; description?: string; dependencies?: string[] }>;
            } = JSON.parse(cleaned);
            planTitle = parsed.title ?? (planTitle || content.substring(0, 80));
            planDescription = parsed.description ?? (planDescription || content);
            taskDefs =
              Array.isArray(parsed.tasks) && parsed.tasks.length > 0 ? parsed.tasks : taskDefs;
          } catch (parseError) {
            logger.warn("Failed to parse plan extraction:", parseError);
            planTitle = content.length > 80 ? `${content.substring(0, 77)}...` : content;
            planDescription = content;
          }
        }
      }

      if (!planTitle) {
        planTitle = content.length > 80 ? `${content.substring(0, 77)}...` : content;
      }

      const now = Date.now();
      const tasks: Task[] = taskDefs.map((td, i) => ({
        id: generateTaskId(i),
        title: td.title,
        description: td.description ?? "",
        status: TaskStatus.PENDING,
        order: i + 1,
        dependencies: td.dependencies ?? [],
        assignee: null,
        createdAt: now,
        completedAt: null,
      }));

      const plan: Plan = {
        id: generatePlanId(),
        title: planTitle,
        description: planDescription,
        status: PlanStatus.ACTIVE,
        tasks,
        createdAt: now,
        updatedAt: now,
        metadata: {},
      };

      const memoryEntry: Memory = {
        agentId: runtime.agentId,
        roomId: message.roomId,
        entityId: (message as Memory & { entityId?: string; userId?: string }).entityId ?? (message as { userId?: string }).userId,
        content: {
          text: encodePlan(plan),
          source: PLAN_SOURCE,
        },
        createdAt: now,
      };

      await runtime.createMemory(memoryEntry, PLUGIN_PLANS_TABLE, true);

      const formatted = formatPlan(plan);
      const successMessage = `Created plan "${plan.title}" with ${tasks.length} task${tasks.length === 1 ? "" : "s"}.\n\n${formatted}`;
      await callback?.({ text: successMessage, source: message.content.source });

      return {
        text: successMessage,
        success: true,
        data: {
          planId: plan.id,
          title: plan.title,
          taskCount: tasks.length,
        },
      };
    } catch (error) {
      logger.error("Failed to create plan:", error);
      const errorMessage = `Failed to create plan: ${error instanceof Error ? error.message : String(error)}`;
      await callback?.({ text: errorMessage, source: message.content.source });
      return { text: errorMessage, success: false };
    }
  },
};
