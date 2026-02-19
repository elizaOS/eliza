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
  type CompleteTaskParameters,
  decodePlan,
  encodePlan,
  formatPlan,
  getPlanProgress,
  PLAN_SOURCE,
  PLUGIN_PLANS_TABLE,
  PlanStatus,
  TaskStatus,
} from "../types.js";

export const completeTaskAction: Action = {
  name: "COMPLETE_TASK",
  description: "Mark a specific task within a plan as completed",
  similes: ["complete-task", "finish-task", "done-task", "mark-done", "task-done"],

  examples: [
    [
      {
        name: "User",
        content: { text: "Mark the database setup task as done" },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll mark the database setup task as completed.",
          actions: ["COMPLETE_TASK"],
        },
      },
    ],
    [
      {
        name: "User",
        content: { text: "I finished the testing phase" },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll mark the testing phase task as completed.",
          actions: ["COMPLETE_TASK"],
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
        const errorMsg = "Please specify which task to complete.";
        await callback?.({ text: errorMsg, source: message.content.source });
        return { text: errorMsg, success: false };
      }

      const params = _options?.parameters as CompleteTaskParameters | undefined;

      // Retrieve plans
      const memories = await runtime.getMemories({
        roomId: message.roomId,
        tableName: PLUGIN_PLANS_TABLE,
        count: 50,
      });

      const planMemories = memories.filter((m) => m.content.source === PLAN_SOURCE);

      if (planMemories.length === 0) {
        const noPlanMsg = "No plans found. Create a plan first.";
        await callback?.({ text: noPlanMsg, source: message.content.source });
        return { text: noPlanMsg, success: false };
      }

      // Find the plan and task
      let targetMemory = planMemories[0];
      let targetPlan = decodePlan(targetMemory.content.text);
      let taskIndex = -1;

      if (params?.planId) {
        for (const mem of planMemories) {
          const plan = decodePlan(mem.content.text);
          if (plan && plan.id === params.planId) {
            targetMemory = mem;
            targetPlan = plan;
            break;
          }
        }
      }

      if (!targetPlan) {
        const errorMsg = "Could not find the plan.";
        await callback?.({ text: errorMsg, source: message.content.source });
        return { text: errorMsg, success: false };
      }

      // Find the task by ID or title
      if (params?.taskId) {
        taskIndex = targetPlan.tasks.findIndex((t) => t.id === params.taskId);
      } else if (params?.taskTitle) {
        taskIndex = targetPlan.tasks.findIndex(
          (t) => t.title.toLowerCase() === params.taskTitle?.toLowerCase()
        );
      } else {
        // Use LLM to identify which task to complete
        const taskDescriptions = targetPlan.tasks.map(
          (t, i) => `${i}: "${t.title}" (${t.status})`
        );

        const matchPrompt = `Which task should be marked as completed?
Request: "${content}"

Tasks in plan "${targetPlan.title}":
${taskDescriptions.join("\n")}

Return ONLY: {"index": <number or -1>}`;

        const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: matchPrompt });
        if (response) {
          try {
            const cleaned = response
              .replace(/^```(?:json)?\n?/, "")
              .replace(/\n?```$/, "")
              .trim();
            const match: { index: number } = JSON.parse(cleaned);
            taskIndex = match.index;
          } catch {
            taskIndex = -1;
          }
        }
      }

      if (taskIndex < 0 || taskIndex >= targetPlan.tasks.length) {
        const noTaskMsg = "Could not identify which task to complete. Please be more specific.";
        await callback?.({ text: noTaskMsg, source: message.content.source });
        return { text: noTaskMsg, success: false };
      }

      const task = targetPlan.tasks[taskIndex];

      if (task.status === TaskStatus.COMPLETED) {
        const alreadyDoneMsg = `Task "${task.title}" is already completed.`;
        await callback?.({ text: alreadyDoneMsg, source: message.content.source });
        return { text: alreadyDoneMsg, success: true };
      }

      // Mark task as completed
      task.status = TaskStatus.COMPLETED;
      task.completedAt = Date.now();
      targetPlan.updatedAt = Date.now();

      // Auto-complete plan if all tasks are done
      const progress = getPlanProgress(targetPlan);
      if (progress === 100) {
        targetPlan.status = PlanStatus.COMPLETED;
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
      const completionNote = progress === 100 ? " All tasks completed - plan is now finished!" : "";
      const successMsg = `Completed task "${task.title}" (${progress}% done).${completionNote}\n\n${formatted}`;
      await callback?.({ text: successMsg, source: message.content.source });

      return {
        text: successMsg,
        success: true,
        data: {
          planId: targetPlan.id,
          taskId: task.id,
          taskTitle: task.title,
          progress,
          planCompleted: progress === 100,
        },
      };
    } catch (error) {
      logger.error("Failed to complete task:", error);
      const errorMsg = `Failed to complete task: ${error instanceof Error ? error.message : String(error)}`;
      await callback?.({ text: errorMsg, source: message.content.source });
      return { text: errorMsg, success: false };
    }
  },
};
