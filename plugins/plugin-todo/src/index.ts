import type { Plugin } from '@elizaos/core';
import { type IAgentRuntime, logger } from '@elizaos/core';

import { routes } from './apis.js';

// Import actions
import { cancelTodoAction } from './actions/cancelTodo.js';
import { completeTodoAction } from './actions/completeTodo.js';
import { confirmTodoAction } from './actions/confirmTodo.js';
import { createTodoAction } from './actions/createTodo.js';
import { updateTodoAction } from './actions/updateTodo.js';

// Import providers
import { todosProvider } from './providers/todos.js';

// Import services
import { TodoReminderService } from './services/reminderService.js';
import { TodoIntegrationBridge } from './services/integrationBridge.js';

// Import schema
import { todoSchema } from './schema.js';

// Import tests
import { TodoPluginE2ETestSuite } from './tests.js';

/**
 * The TodoPlugin provides task management functionality with daily recurring and one-off tasks,
 * including creating, completing, updating, and deleting tasks, as well as a point system for
 * task completion.
 */
export const TodoPlugin: Plugin = {
  name: 'todo',
  description: 'Provides task management functionality with daily recurring and one-off tasks.',
  providers: [todosProvider],
  dependencies: ['@elizaos/plugin-sql', '@elizaos/plugin-rolodex'],
  testDependencies: ['@elizaos/plugin-sql', '@elizaos/plugin-rolodex'],
  actions: [
    createTodoAction,
    completeTodoAction,
    confirmTodoAction,
    updateTodoAction,
    cancelTodoAction,
  ],
  services: [TodoReminderService, TodoIntegrationBridge],
  routes,
  schema: todoSchema,
  tests: [TodoPluginE2ETestSuite],

  async init(config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    try {
      // Database migrations are handled by the SQL plugin
      if (runtime.db) {
        logger.info('Database available, TodoPlugin ready for operation');
      } else {
        logger.warn('No database instance available, operations will be limited');
      }

      // Check for rolodex plugin availability
      const messageDeliveryService = runtime.getService('MESSAGE_DELIVERY' as any);
      if (messageDeliveryService) {
        logger.info('Rolodex message delivery service available - external notifications enabled');
      } else {
        logger.warn('Rolodex not available - only in-app notifications will work');
      }

      logger.info('TodoPlugin initialized with reminder and integration capabilities');
    } catch (error) {
      logger.error('Error initializing TodoPlugin:', error);
      throw error;
    }
  },
};

export default TodoPlugin;

// Export discoverable services for external use
export { TodoReminderService } from './services/reminderService.js';
export { TodoIntegrationBridge } from './services/integrationBridge.js';

// Export internal managers for advanced usage
export { NotificationManager } from './services/notificationManager.js';
export { CacheManager } from './services/cacheManager.js';

// Export data service utilities
export { createTodoDataService } from './services/todoDataService.js';
export type { TodoData } from './services/todoDataService.js';

// Export types
export type { CacheEntry, CacheStats } from './services/cacheManager.js';
export type { NotificationData, NotificationPreferences } from './services/notificationManager.js';

// Export schema
export { todoSchema } from './schema.js';
