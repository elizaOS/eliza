import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import {
  decodePlan,
  getPlanProgress,
  PLAN_SOURCE,
  PLAN_STATUS_LABELS,
  PLUGIN_PLANS_TABLE,
  TASK_STATUS_LABELS,
  TaskStatus,
} from "../types.js";

export const planStatusProvider: Provider = {
  name: "PLAN_STATUS",
  description: "Provides current plan status and task progress for active plans",

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    try {
      const memories = await runtime.getMemories({
        roomId: message.roomId,
        tableName: PLUGIN_PLANS_TABLE,
        count: 50,
      });

      const planMemories = memories.filter((m) => m.content.source === PLAN_SOURCE);

      if (planMemories.length === 0) {
        return { text: "No active plans" };
      }

      const planSummaries: string[] = [];
      const planDataList: Array<{
        id: string;
        title: string;
        status: string;
        progress: number;
        taskCount: number;
        completedCount: number;
      }> = [];

      for (const mem of planMemories) {
        const plan = decodePlan(mem.content.text);
        if (!plan) continue;

        const progress = getPlanProgress(plan);
        const statusLabel = PLAN_STATUS_LABELS[plan.status] ?? plan.status;
        const completedCount = plan.tasks.filter(
          (t) => t.status === TaskStatus.COMPLETED
        ).length;
        const inProgressCount = plan.tasks.filter(
          (t) => t.status === TaskStatus.IN_PROGRESS
        ).length;

        let summary = `- ${plan.title} [${statusLabel}] ${progress}% (${completedCount}/${plan.tasks.length} tasks)`;
        if (inProgressCount > 0) {
          const inProgressTasks = plan.tasks
            .filter((t) => t.status === TaskStatus.IN_PROGRESS)
            .map((t) => t.title);
          summary += `\n  In progress: ${inProgressTasks.join(", ")}`;
        }

        const nextPending = plan.tasks.find((t) => t.status === TaskStatus.PENDING);
        if (nextPending) {
          summary += `\n  Next: ${nextPending.title}`;
        }

        planSummaries.push(summary);

        planDataList.push({
          id: plan.id,
          title: plan.title,
          status: plan.status,
          progress,
          taskCount: plan.tasks.length,
          completedCount,
        });
      }

      const text = `Active Plans (${planSummaries.length}):\n${planSummaries.join("\n")}`;

      return {
        text,
        data: {
          plans: planDataList,
          count: planDataList.length,
        },
      };
    } catch (_error) {
      return { text: "Error retrieving plan status" };
    }
  },
};
