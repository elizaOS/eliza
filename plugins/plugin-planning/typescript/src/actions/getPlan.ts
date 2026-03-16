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
  decodePlan,
  formatPlan,
  type GetPlanParameters,
  getPlanProgress,
  PLAN_SOURCE,
  PLUGIN_PLANS_TABLE,
} from "../types.js";

export const getPlanAction: Action = {
  name: "GET_PLAN",
  description: "Retrieve and display the current status of a plan",
  similes: ["get-plan", "show-plan", "view-plan", "plan-status", "check-plan"],

  examples: [
    [
      {
        name: "User",
        content: { text: "Show me the website launch plan" },
      },
      {
        name: "Assistant",
        content: {
          text: "Here's the current status of the website launch plan.",
          actions: ["GET_PLAN"],
        },
      },
    ],
    [
      {
        name: "User",
        content: { text: "What's the status of my plans?" },
      },
      {
        name: "Assistant",
        content: {
          text: "Let me show you all your current plans.",
          actions: ["GET_PLAN"],
        },
      },
    ],
  ],

  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> {
    return typeof runtime.getMemories === "function";
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
      const params = _options?.parameters as GetPlanParameters | undefined;

      // Retrieve all plans
      const memories = await runtime.getMemories({
        roomId: message.roomId,
        tableName: PLUGIN_PLANS_TABLE,
        count: 50,
      });

      const planMemories = memories.filter((m) => m.content.source === PLAN_SOURCE);

      if (planMemories.length === 0) {
        const noPlanMsg = "No plans found. Create one with CREATE_PLAN.";
        await callback?.({ text: noPlanMsg, source: message.content.source });
        return { text: noPlanMsg, success: true, data: { plans: [], count: 0 } };
      }

      // If a specific plan is requested, find it
      if (params?.planId || params?.title) {
        for (const mem of planMemories) {
          const plan = decodePlan(mem.content.text);
          if (!plan) continue;

          const matchesId = params?.planId && plan.id === params.planId;
          const matchesTitle =
            params?.title && plan.title.toLowerCase().includes(params.title.toLowerCase());

          if (matchesId || matchesTitle) {
            const formatted = formatPlan(plan);
            await callback?.({ text: formatted, source: message.content.source });
            return {
              text: formatted,
              success: true,
              data: {
                planId: plan.id,
                title: plan.title,
                status: plan.status,
                progress: getPlanProgress(plan),
                taskCount: plan.tasks.length,
              },
            };
          }
        }
      }

      // If query provided, use LLM to find best match
      if (content && planMemories.length > 1) {
        const planDescriptions = planMemories.map((m, i) => {
          const plan = decodePlan(m.content.text);
          const progress = plan ? getPlanProgress(plan) : 0;
          return `${i}: "${plan?.title ?? "Unknown"}" (${plan?.status ?? "unknown"}, ${progress}%)`;
        });

        const matchPrompt = `Which plan is the user asking about? If they want to see all plans, return -1.
Request: "${content}"

Plans:
${planDescriptions.join("\n")}

Return ONLY: {"index": <number or -1 for all>}`;

        const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: matchPrompt });
        if (response) {
          try {
            const cleaned = response
              .replace(/^```(?:json)?\n?/, "")
              .replace(/\n?```$/, "")
              .trim();
            const match: { index: number } = JSON.parse(cleaned);
            if (match.index >= 0 && match.index < planMemories.length) {
              const plan = decodePlan(planMemories[match.index].content.text);
              if (plan) {
                const formatted = formatPlan(plan);
                await callback?.({ text: formatted, source: message.content.source });
                return {
                  text: formatted,
                  success: true,
                  data: {
                    planId: plan.id,
                    title: plan.title,
                    status: plan.status,
                    progress: getPlanProgress(plan),
                    taskCount: plan.tasks.length,
                  },
                };
              }
            }
          } catch {
            // Show all plans
          }
        }
      }

      // Show all plans summary
      const planSummaries = planMemories
        .map((m) => {
          const plan = decodePlan(m.content.text);
          if (!plan) return null;
          const progress = getPlanProgress(plan);
          const completedTasks = plan.tasks.filter((t) => t.status === "completed").length;
          return `- ${plan.title} [${plan.status}] ${completedTasks}/${plan.tasks.length} tasks (${progress}%)`;
        })
        .filter(Boolean);

      const summaryText = `Plans (${planSummaries.length}):\n${planSummaries.join("\n")}`;
      await callback?.({ text: summaryText, source: message.content.source });

      return {
        text: summaryText,
        success: true,
        data: {
          count: planSummaries.length,
        },
      };
    } catch (error) {
      logger.error("Failed to get plan:", error);
      const errorMsg = `Failed to get plan: ${error instanceof Error ? error.message : String(error)}`;
      await callback?.({ text: errorMsg, source: message.content.source });
      return { text: errorMsg, success: false };
    }
  },
};
