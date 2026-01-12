import { logger } from "../../logger.ts";
import { optionExtractionTemplate } from "../../prompts.ts";
import { getUserServerRole } from "../../roles.ts";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";
import { composePrompt, parseKeyValueXml } from "../../utils.ts";

/**
 * Represents an action that allows selecting an option for a pending task that has multiple options.
 * @type {Action}
 * @property {string} name - The name of the action
 * @property {string[]} similes - Similar words or phrases for the action
 * @property {string} description - A brief description of the action
 * @property {Function} validate - Asynchronous function to validate the action
 * @property {Function} handler - Asynchronous function to handle the action
 * @property {ActionExample[][]} examples - Examples demonstrating the usage of the action
 */
export const choiceAction: Action = {
  name: "CHOOSE_OPTION",
  similes: ["SELECT_OPTION", "SELECT", "PICK", "CHOOSE"],
  description: "Selects an option for a pending task that has multiple options",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    if (!state) {
      logger.error(
        { src: "plugin:bootstrap:action:choice", agentId: runtime.agentId },
        "State is required for validating the action",
      );
      throw new Error("State is required for validating the action");
    }

    const room = state.data.room ?? (await runtime.getRoom(message.roomId));

    if (!room || !room.messageServerId) {
      return false;
    }

    const userRole = await getUserServerRole(
      runtime,
      message.entityId,
      room.messageServerId,
    );

    if (userRole !== "OWNER" && userRole !== "ADMIN") {
      return false;
    }

    // Get all tasks with options metadata
    const pendingTasks = await runtime.getTasks({
      roomId: message.roomId,
      tags: ["AWAITING_CHOICE"],
    });

    // Only validate if there are pending tasks with options
    return (
      pendingTasks &&
      pendingTasks.length > 0 &&
      pendingTasks.some((task) => task.metadata?.options)
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    _responses?: Memory[],
  ): Promise<ActionResult> => {
    const pendingTasks = await runtime.getTasks({
      roomId: message.roomId,
      tags: ["AWAITING_CHOICE"],
    });

    if (!pendingTasks || pendingTasks.length === 0) {
      return {
        text: "No pending tasks with options found",
        values: {
          success: false,
          error: "NO_PENDING_TASKS",
        },
        data: {
          actionName: "CHOOSE_OPTION",
          error: "No pending tasks with options found",
        },
        success: false,
      };
    }

    const tasksWithOptions = pendingTasks.filter(
      (task) => task.metadata?.options,
    );

    if (!tasksWithOptions.length) {
      return {
        text: "No tasks currently have options to select from",
        values: {
          success: false,
          error: "NO_OPTIONS_AVAILABLE",
        },
        data: {
          actionName: "CHOOSE_OPTION",
          error: "No tasks currently have options to select from",
        },
        success: false,
      };
    }

    // Format tasks with their options for the LLM, using shortened UUIDs
    // Filter out tasks without IDs (fail-fast: tasks must have IDs)
    const formattedTasks = tasksWithOptions
      .filter(
        (task): task is typeof task & { id: NonNullable<typeof task.id> } => {
          if (!task.id) {
            throw new Error(`Task "${task.name}" is missing required id field`);
          }
          return true;
        },
      )
      .map((task) => {
        // Generate a short ID from the task UUID (first 8 characters should be unique enough)
        const shortId = task.id.substring(0, 8);
        const taskMetadata = task.metadata;
        const taskOptions = taskMetadata?.options;

        return {
          taskId: shortId,
          fullId: task.id,
          name: task.name,
          options: taskOptions
            ? taskOptions.map((opt) => ({
                name: typeof opt === "string" ? opt : opt.name,
                description:
                  typeof opt === "string" ? opt : opt.description || opt.name,
              }))
            : [],
        };
      });

    // format tasks as a string
    const tasksString = formattedTasks
      .map((task) => {
        const taskOptions = task.options;
        return `Task ID: ${task.taskId} - ${task.name}\nAvailable options:\n${taskOptions ? taskOptions.map((opt) => `- ${opt.name}: ${opt.description}`).join("\n") : ""}`;
      })
      .join("\n");

    const prompt = composePrompt({
      state: {
        tasks: tasksString,
        recentMessages: message.content.text || "",
      },
      template: optionExtractionTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });

    const parsed = parseKeyValueXml(result);
    // parseKeyValueXml returns Record<string, unknown> | null
    interface ParsedChoice {
      taskId?: string;
      selectedOption?: string;
    }
    const { taskId, selectedOption } = (parsed as ParsedChoice) || {};

    if (taskId && selectedOption) {
      // Find the task by matching the shortened UUID
      const taskMap = new Map(
        formattedTasks.map((task) => [task.taskId, task]),
      );
      const taskInfo = taskMap.get(taskId) as
        | (typeof formattedTasks)[0]
        | undefined;

      if (!taskInfo) {
        if (callback) {
          await callback({
            text: `Could not find a task matching ID: ${taskId}. Please try again.`,
            actions: ["SELECT_OPTION_ERROR"],
            source: message.content.source,
          });
        }
        return {
          text: `Could not find task with ID: ${taskId}`,
          values: {
            success: false,
            error: "TASK_NOT_FOUND",
            taskId,
          },
          data: {
            actionName: "CHOOSE_OPTION",
            error: "Task not found",
            taskId,
          },
          success: false,
        };
      }

      // Find the actual task using the full UUID
      const selectedTask = tasksWithOptions.find(
        (task) => task.id === taskInfo.fullId,
      );

      if (!selectedTask) {
        if (callback) {
          await callback({
            text: "Error locating the selected task. Please try again.",
            actions: ["SELECT_OPTION_ERROR"],
            source: message.content.source,
          });
        }
        return {
          text: "Error locating the selected task",
          values: {
            success: false,
            error: "TASK_LOOKUP_ERROR",
          },
          data: {
            actionName: "CHOOSE_OPTION",
            error: "Failed to locate task",
          },
          success: false,
        };
      }

      // Ensure selectedTask has an id (required for all operations)
      if (!selectedTask.id) {
        throw new Error(
          `Selected task "${selectedTask.name}" is missing required id field`,
        );
      }
      const selectedTaskId = selectedTask.id;

      if (selectedOption === "ABORT") {
        await runtime.deleteTask(selectedTaskId);
        if (callback) {
          await callback({
            text: `Task "${selectedTask.name}" has been cancelled.`,
            actions: ["CHOOSE_OPTION_CANCELLED"],
            source: message.content.source,
          });
        }
        return {
          text: `Task "${selectedTask.name}" has been cancelled`,
          values: {
            success: true,
            taskAborted: true,
            taskId: selectedTaskId,
            taskName: selectedTask.name,
          },
          data: {
            actionName: "CHOOSE_OPTION",
            selectedOption: "ABORT",
            taskId: selectedTaskId,
            taskName: selectedTask.name,
          },
          success: true,
        };
      }

      const taskWorker = runtime.getTaskWorker(selectedTask.name);
      if (taskWorker) {
        await taskWorker.execute(
          runtime,
          { option: selectedOption },
          selectedTask,
        );
      }
      if (callback) {
        await callback({
          text: `Selected option: ${selectedOption} for task: ${selectedTask.name}`,
          actions: ["CHOOSE_OPTION"],
          source: message.content.source,
        });
      }
      return {
        text: `Selected option: ${selectedOption} for task: ${selectedTask.name}`,
        values: {
          success: true,
          selectedOption,
          taskId: selectedTaskId,
          taskName: selectedTask.name,
          taskExecuted: true,
        },
        data: {
          actionName: "CHOOSE_OPTION",
          selectedOption,
          taskId: selectedTaskId,
          taskName: selectedTask.name,
        },
        success: true,
      };
    }

    // If no task/option was selected, list available options
    let optionsText =
      "Please select a valid option from one of these tasks:\n\n";

    tasksWithOptions.forEach((task) => {
      // Create a shortened UUID for display
      const shortId = task.id?.substring(0, 8);

      optionsText += `**${task.name}** (ID: ${shortId}):\n`;
      const taskMetadata = task.metadata;
      const options = taskMetadata?.options
        ? taskMetadata.options.map((opt) =>
            typeof opt === "string" ? opt : opt.name,
          )
        : [];
      options.push("ABORT");
      optionsText += options.map((opt) => `- ${opt}`).join("\n");
      optionsText += "\n\n";
    });

    if (callback) {
      await callback({
        text: optionsText,
        actions: ["SELECT_OPTION_INVALID"],
        source: message.content.source,
      });
    }

    return {
      text: "No valid option selected",
      values: {
        success: false,
        error: "NO_SELECTION",
        availableTasksCount: tasksWithOptions.length,
      },
      data: {
        actionName: "CHOOSE_OPTION",
        error: "No valid selection made",
        availableTaskNames: formattedTasks.map((t) => t.name),
      },
      success: false,
    };
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "post",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Selected option: post for task: Confirm X Post",
          actions: ["CHOOSE_OPTION"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I choose cancel",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Selected option: cancel for task: Confirm X Post",
          actions: ["CHOOSE_OPTION"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default choiceAction;
