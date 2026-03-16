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
  encodePlan,
  formatPlan,
  PLAN_SOURCE,
  PLUGIN_PLANS_TABLE,
  PlanStatus,
  type UpdatePlanParameters,
} from "../types.js";

export const updatePlanAction: Action = {
  name: "UPDATE_PLAN",
  description: "Update an existing plan's title, description, or status",
  similes: ["update-plan", "modify-plan", "change-plan", "edit-plan"],

  examples: [
    [
      {
        name: "User",
        content: { text: "Update the website launch plan to include a testing phase" },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll update the website launch plan with the testing phase.",
          actions: ["UPDATE_PLAN"],
        },
      },
    ],
    [
      {
        name: "User",
        content: { text: "Mark the migration plan as completed" },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll mark the migration plan as completed.",
          actions: ["UPDATE_PLAN"],
        },
      },
    ],
  ],

  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> {
    return typeof runtime.getMemories === "function" && typeof runtime.updateMemory === "function";
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
        const errorMessage = "Please describe what to update in the plan.";
        await callback?.({ text: errorMessage, source: message.content.source });
        return { text: errorMessage, success: false };
      }

      const params = _options?.parameters as UpdatePlanParameters | undefined;

      // Retrieve all plans from memory
      const memories = await runtime.getMemories({
        roomId: message.roomId,
        tableName: PLUGIN_PLANS_TABLE,
        count: 50,
      });

      const planMemories = memories.filter((m) => m.content.source === PLAN_SOURCE);

      if (planMemories.length === 0) {
        const noPlanMsg = "No plans found. Create a plan first with CREATE_PLAN.";
        await callback?.({ text: noPlanMsg, source: message.content.source });
        return { text: noPlanMsg, success: false };
      }

      // Find the target plan
      let targetMemory = planMemories[0];
      let targetPlan = decodePlan(targetMemory.content.text);

      if (params?.planId) {
        for (const mem of planMemories) {
          const plan = decodePlan(mem.content.text);
          if (plan && plan.id === params.planId) {
            targetMemory = mem;
            targetPlan = plan;
            break;
          }
        }
      } else if (planMemories.length > 1) {
        // Use LLM to find the best matching plan
        const planDescriptions = planMemories.map((m, i) => {
          const plan = decodePlan(m.content.text);
          return `${i}: "${plan?.title ?? "Unknown"}" - ${plan?.description ?? ""}`;
        });

        const matchPrompt = `Which plan should be updated based on this request?
Request: "${content}"

Plans:
${planDescriptions.join("\n")}

Return ONLY: {"index": <number>}`;

        const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: matchPrompt });
        if (response) {
          try {
            const cleaned = response.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
            const match: { index: number } = JSON.parse(cleaned);
            if (match.index >= 0 && match.index < planMemories.length) {
              targetMemory = planMemories[match.index];
              targetPlan = decodePlan(targetMemory.content.text);
            }
          } catch {
            // Use first plan as fallback
          }
        }
      }

      if (!targetPlan) {
        const errorMsg = "Could not find the plan to update.";
        await callback?.({ text: errorMsg, source: message.content.source });
        return { text: errorMsg, success: false };
      }

      // Apply updates
      if (params?.title) targetPlan.title = params.title;
      if (params?.description) targetPlan.description = params.description;
      if (params?.status) targetPlan.status = params.status;
      targetPlan.updatedAt = Date.now();

      // If no explicit params, use LLM to determine updates
      if (!params?.title && !params?.description && !params?.status) {
        const updatePrompt = `Given this update request, determine what should change in the plan.
Request: "${content}"
Current plan title: "${targetPlan.title}"
Current description: "${targetPlan.description}"
Current status: "${targetPlan.status}"

Return ONLY a JSON object with fields to change (omit unchanged fields):
{"title": "new title", "description": "new description", "status": "active|completed|archived|draft"}`;

        const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: updatePrompt });
        if (response) {
          try {
            const cleaned = response.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
            const updates: { title?: string; description?: string; status?: string } =
              JSON.parse(cleaned);
            if (updates.title) targetPlan.title = updates.title;
            if (updates.description) targetPlan.description = updates.description;
            if (
              updates.status &&
              Object.values(PlanStatus).includes(updates.status as PlanStatus)
            ) {
              targetPlan.status = updates.status as PlanStatus;
            }
          } catch {
            // Keep existing plan as-is
          }
        }
      }

      // Save updated plan
      const memoryId = targetMemory.id;
      if (!memoryId) {
        const errorMsg = "Plan memory has no id.";
        await callback?.({ text: errorMsg, source: message.content.source });
        return { text: errorMsg, success: false };
      }
      await runtime.updateMemory({
        id: memoryId,
        content: {
          text: encodePlan(targetPlan),
          source: PLAN_SOURCE,
        },
        createdAt: targetMemory.createdAt ?? Date.now(),
      });

      const formatted = formatPlan(targetPlan);
      const successMsg = `Updated plan "${targetPlan.title}".\n\n${formatted}`;
      await callback?.({ text: successMsg, source: message.content.source });

      return {
        text: successMsg,
        success: true,
        data: { planId: targetPlan.id, title: targetPlan.title, status: targetPlan.status },
      };
    } catch (error) {
      logger.error("Failed to update plan:", error);
      const errorMsg = `Failed to update plan: ${error instanceof Error ? error.message : String(error)}`;
      await callback?.({ text: errorMsg, source: message.content.source });
      return { text: errorMsg, success: false };
    }
  },
};
