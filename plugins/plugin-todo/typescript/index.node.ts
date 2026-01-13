import { routes } from "./apis";
import todoPlugin from "./index";

const nodePlugin = {
  ...todoPlugin,
  routes,
};

export { nodePlugin as default };

// Re-export all named exports from index.ts
export {
  todoSchema,
  CacheManager,
  TodoIntegrationBridge,
  NotificationManager,
  TodoReminderService,
  createTodoDataService,
} from "./index";
export type {
  CacheEntry,
  CacheStats,
  NotificationData,
  NotificationPreferences,
  TodoData,
} from "./index";
