import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { CodeTaskService } from "../services/code-task.js";

/**
 * Task Context Provider
 *
 * Injects the current task's status and recent output into the agent's context.
 * This allows the agent to be aware of ongoing work and respond appropriately
 * when users ask about progress.
 */
export const taskContextProvider: Provider = {
  name: "TASK_CONTEXT",
  description:
    "Provides context about the current active task and recent task activity",
  dynamic: true,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService("CODE_TASK") as CodeTaskService | null;

    if (!service) {
      return {
        text: "Task service not available.",
        values: { hasTask: false, taskCount: 0 },
        data: { currentTask: null, tasks: [] },
      };
    }

    try {
      const contextText = await service.getTaskContext();
      const currentTask = await service.getCurrentTask();
      const allTasks = await service.getRecentTasks(10);

      const running = allTasks.filter(
        (t) => t.metadata.status === "running",
      ).length;
      const completed = allTasks.filter(
        (t) => t.metadata.status === "completed",
      ).length;
      const failed = allTasks.filter(
        (t) => t.metadata.status === "failed",
      ).length;
      const cancelled = allTasks.filter(
        (t) => t.metadata.status === "cancelled",
      ).length;
      const pending = allTasks.filter(
        (t) => t.metadata.status === "pending",
      ).length;

      return {
        text: contextText,
        values: {
          hasTask: currentTask !== null,
          taskCount: allTasks.length,
          currentTaskId: currentTask?.id ?? null,
          currentTaskStatus: currentTask?.metadata.status ?? null,
          currentTaskProgress: currentTask?.metadata.progress ?? 0,
          runningTasks: running,
          completedTasks: completed,
          failedTasks: failed,
          cancelledTasks: cancelled,
          pendingTasks: pending,
        },
        data: {
          currentTask: currentTask
            ? {
                id: currentTask.id,
                name: currentTask.name,
                status: currentTask.metadata.status,
                progress: currentTask.metadata.progress,
              }
            : null,
          tasks: allTasks.map((t) => ({
            id: t.id,
            name: t.name,
            status: t.metadata.status,
            progress: t.metadata.progress,
          })),
        },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        text: `Error loading task context: ${error}`,
        values: { hasTask: false, taskCount: 0, error },
        data: { currentTask: null, tasks: [] },
      };
    }
  },
};
