import {
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
  type UUID,
} from "@elizaos/core";
import { allProviderDocs, type ProviderDoc } from "../generated/specs/specs";
import { createTodoDataService } from "../services/todoDataService";

const fallbackSpec: ProviderDoc = {
  name: "todos",
  description: "Information about the user's current tasks, completed tasks, and points",
};
const spec = allProviderDocs.find((doc) => doc.name === "todos") ?? fallbackSpec;

export const todosProvider: Provider = {
  name: spec.name,
  description: "Information about the user's current tasks, completed tasks, and points",
  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    try {
      logger.debug(
        "[TodosProvider] Received state:",
        JSON.stringify(state?.data?.room ?? "No room data in state", null, 2)
      );
      logger.debug("[TodosProvider] Received message:", JSON.stringify(message, null, 2));

      const currentDate = new Date();
      const sevenDaysAgo = new Date(currentDate);
      sevenDaysAgo.setDate(currentDate.getDate() - 7);

      const roomId = message.roomId;
      if (!roomId) {
        logger.error("TodosProvider - message missing roomId");
        return {
          text: "No room context available",
          values: {},
        };
      }
      logger.debug("TodosProvider - message:", JSON.stringify(message, null, 2));

      const roomDetails = await runtime.getRoom(roomId);
      const _worldId =
        (roomDetails?.worldId as UUID | undefined) ||
        message.worldId ||
        createUniqueUuid(runtime, message.entityId);
      logger.debug("TodosProvider - roomDetails:", JSON.stringify(roomDetails, null, 2));

      const dataService = createTodoDataService(runtime);

      const allEntityTodos = await dataService.getTodos({
        entityId: message.entityId as UUID,
      });

      logger.debug("TodosProvider - allEntityTodos:", JSON.stringify(allEntityTodos, null, 2));

      const pendingTodos = allEntityTodos.filter((todo) => !todo.isCompleted);

      const completedTodos = allEntityTodos.filter((todo) => {
        if (!todo.isCompleted) return false;

        // Check completion date if available
        if (todo.completedAt) {
          return todo.completedAt >= sevenDaysAgo;
        }

        if (todo.updatedAt) {
          return todo.updatedAt >= sevenDaysAgo;
        }

        return false;
      });

      const dailyTodos = pendingTodos.filter((todo) => todo.type === "daily");
      const formattedDailyTasks = dailyTodos
        .map((todo) => {
          const streak = todo.metadata?.streak || 0;
          return `- ${todo.name} (daily, streak: ${streak} day${streak === 1 ? "" : "s"})`;
        })
        .join("\n");

      const oneOffTodos = pendingTodos.filter((todo) => todo.type === "one-off");
      const formattedOneOffTasks = oneOffTodos
        .map((todo) => {
          const priority = todo.priority || 4;
          const urgent = todo.isUrgent ? " 🔴 URGENT" : "";

          let dueDateText = "no due date";
          if (todo.dueDate) {
            dueDateText = `due ${todo.dueDate.toLocaleDateString()}`;
          }

          return `- ${todo.name} (P${priority}${urgent}, ${dueDateText})`;
        })
        .join("\n");

      // Aspirational goals (no due date)
      const aspirationalTodos = pendingTodos.filter((todo) => todo.type === "aspirational");
      const formattedAspirationalTasks = aspirationalTodos
        .map((todo) => {
          return `- ${todo.name} (aspirational goal)`;
        })
        .join("\n");

      const formattedCompletedTasks = completedTodos
        .map((todo) => {
          let completedDateText = "recently";

          if (todo.completedAt) {
            completedDateText = todo.completedAt.toLocaleDateString();
          } else if (todo.updatedAt) {
            completedDateText = todo.updatedAt.toLocaleDateString();
          }

          const pointsEarned = todo.metadata?.pointsAwarded || 0;
          return `- ${todo.name} (completed ${completedDateText}, +${pointsEarned} points)`;
        })
        .join("\n");

      let output = `# User's Todos (Tasks)\n\nThese are the tasks which the agent is managing for the user. This is the actual list of todos, any other is probably from previous conversations.\n\n`;

      output += `\n## Daily Todos\n`;
      output += formattedDailyTasks || "No daily todos.";

      output += `\n\n## One-off Todos\n`;
      output += formattedOneOffTasks || "No one-off todos.";

      output += `\n\n## Aspirational Todos\n`;
      output += formattedAspirationalTasks || "No aspirational todos.";

      output += `\n\n## Recently Completed (Last 7 Days)\n`;
      output += formattedCompletedTasks || "No todos completed in the last 7 days.";

      output +=
        "\n\nIMPORTANT: Do not tell the user that a task exists or has been added if it is not in the list above. As an AI, you may hallucinate, so it is important to ground your answer in the information above which we know to be true from the database.\n\n";

      const result: ProviderResult = {
        data: {
          dailyTodos: dailyTodos.map((todo) => ({
            id: todo.id,
            name: todo.name,
            description: todo.description || null,
            type: todo.type,
            priority: todo.priority || null,
            isUrgent: todo.isUrgent,
            isCompleted: todo.isCompleted,
            dueDate: todo.dueDate?.toISOString() || null,
            completedAt: todo.completedAt?.toISOString() || null,
            createdAt: todo.createdAt.toISOString(),
            updatedAt: todo.updatedAt.toISOString(),
            tags: todo.tags || [],
          })),
          oneOffTodos: oneOffTodos.map((todo) => ({
            id: todo.id,
            name: todo.name,
            description: todo.description || null,
            type: todo.type,
            priority: todo.priority || null,
            isUrgent: todo.isUrgent,
            isCompleted: todo.isCompleted,
            dueDate: todo.dueDate?.toISOString() || null,
            completedAt: todo.completedAt?.toISOString() || null,
            createdAt: todo.createdAt.toISOString(),
            updatedAt: todo.updatedAt.toISOString(),
            tags: todo.tags || [],
          })),
          aspirationalTodos: aspirationalTodos.map((todo) => ({
            id: todo.id,
            name: todo.name,
            description: todo.description || null,
            type: todo.type,
            priority: todo.priority || null,
            isUrgent: todo.isUrgent,
            isCompleted: todo.isCompleted,
            dueDate: todo.dueDate?.toISOString() || null,
            completedAt: todo.completedAt?.toISOString() || null,
            createdAt: todo.createdAt.toISOString(),
            updatedAt: todo.updatedAt.toISOString(),
            tags: todo.tags || [],
          })),
          completedTodos: completedTodos.map((todo) => ({
            id: todo.id,
            name: todo.name,
            description: todo.description || null,
            type: todo.type,
            priority: todo.priority || null,
            isUrgent: todo.isUrgent,
            isCompleted: todo.isCompleted,
            dueDate: todo.dueDate?.toISOString() || null,
            completedAt: todo.completedAt?.toISOString() || null,
            createdAt: todo.createdAt.toISOString(),
            updatedAt: todo.updatedAt.toISOString(),
            tags: todo.tags || [],
          })),
        },
        values: {
          dailyTasks: formattedDailyTasks || "None",
          oneOffTasks: formattedOneOffTasks || "None",
          aspirationalTasks: formattedAspirationalTasks || "None",
          completedTasks: formattedCompletedTasks || "None",
        },
        text: output,
      };

      logger.debug("TodosProvider - result:", JSON.stringify(result, null, 2));

      return result;
    } catch (error) {
      logger.error(
        "Error in TodosProvider:",
        error instanceof Error ? error.message : String(error)
      );

      // Return a simple error message if something goes wrong
      return {
        data: {},
        values: {},
        text: "Sorry, there was an error retrieving your tasks.",
      };
    }
  },
};

export default todosProvider;
