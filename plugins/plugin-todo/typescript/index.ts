import type { Plugin } from "@elizaos/core";
import { type IAgentRuntime, logger } from "@elizaos/core";
import { cancelTodoAction } from "./actions/cancelTodo";
import { completeTodoAction } from "./actions/completeTodo";
import { confirmTodoAction } from "./actions/confirmTodo";
import { createTodoAction } from "./actions/createTodo";
import { updateTodoAction } from "./actions/updateTodo";
import { todosProvider } from "./providers/todos";
import { todoSchema } from "./schema";
import { TodoIntegrationBridge } from "./services/integrationBridge";
import { TodoReminderService } from "./services/reminderService";

export const todoPlugin: Plugin = {
  name: "todo",
  description: "Provides task management functionality with daily recurring and one-off tasks.",
  providers: [todosProvider],
  dependencies: ["@elizaos/plugin-sql", "@elizaos/plugin-rolodex"],
  testDependencies: ["@elizaos/plugin-sql", "@elizaos/plugin-rolodex"],
  actions: [
    createTodoAction,
    completeTodoAction,
    confirmTodoAction,
    updateTodoAction,
    cancelTodoAction,
  ],
  services: [TodoReminderService, TodoIntegrationBridge],
  routes: [],
  schema: todoSchema,

  async init(_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    try {
      if (runtime.db) {
        logger.info("Database available, TodoPlugin ready for operation");
      } else {
        logger.warn("No database instance available, operations will be limited");
      }

      const messageDeliveryService = runtime.getService("MESSAGE_DELIVERY" as never);
      if (messageDeliveryService) {
        logger.info("Rolodex message delivery service available");
      } else {
        logger.warn("Rolodex not available - only in-app notifications will work");
      }

      logger.info("TodoPlugin initialized");
    } catch (error) {
      logger.error(
        "Error initializing TodoPlugin:",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  },
};

export default todoPlugin;

export { todoSchema } from "./schema";
export type { CacheEntry, CacheStats } from "./services/cacheManager";
export { CacheManager } from "./services/cacheManager";
export { TodoIntegrationBridge } from "./services/integrationBridge";
export type {
  NotificationData,
  NotificationPreferences,
} from "./services/notificationManager";
export { NotificationManager } from "./services/notificationManager";
export { TodoReminderService } from "./services/reminderService";
export type { TodoData } from "./services/todoDataService";
export { createTodoDataService } from "./services/todoDataService";
