import { routes } from "./apis";
import todoPlugin from "./index";

const nodePlugin = {
  ...todoPlugin,
  routes,
};

export { nodePlugin as default };

export type {
  CacheEntry,
  CacheStats,
  NotificationData,
  NotificationPreferences,
  TodoData,
} from "./index";
// Re-export all named exports from index.ts
export {
  CacheManager,
  createTodoDataService,
  NotificationManager,
  TodoIntegrationBridge,
  TodoReminderService,
  todoSchema,
} from "./index";
