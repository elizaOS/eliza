/**
 * Todo Plugin for elizaOS
 *
 * Provides comprehensive task management functionality including:
 * - Daily recurring tasks
 * - One-off tasks with due dates and priorities
 * - Aspirational goals
 * - Reminder notifications
 * - Integration with other plugins
 *
 * ## Features
 *
 * - CREATE_TODO: Create new tasks from natural language
 * - COMPLETE_TODO: Mark tasks as completed
 * - UPDATE_TODO: Modify existing tasks
 * - CANCEL_TODO: Remove tasks from the list
 * - CONFIRM_TODO: Confirm pending task creation
 *
 * ## Configuration
 *
 * This plugin requires:
 * - @elizaos/plugin-sql for database operations
 * - @elizaos/plugin-rolodex (optional) for external notifications
 */

import type { Plugin } from '@elizaos/core';
import { type IAgentRuntime, logger } from '@elizaos/core';

import { routes } from './apis';

// Import actions
import { cancelTodoAction } from './actions/cancelTodo';
import { completeTodoAction } from './actions/completeTodo';
import { confirmTodoAction } from './actions/confirmTodo';
import { createTodoAction } from './actions/createTodo';
import { updateTodoAction } from './actions/updateTodo';

// Import providers
import { todosProvider } from './providers/todos';

// Import services
import { TodoReminderService } from './services/reminderService';
import { TodoIntegrationBridge } from './services/integrationBridge';

// Import schema
import { todoSchema } from './schema';

// Tests import removed for type checking

// Re-export types for consumers
export * from './types';

/**
 * The TodoPlugin provides task management functionality with daily recurring and one-off tasks,
 * including creating, completing, updating, and deleting tasks, as well as reminder notifications.
 */
export const todoPlugin: Plugin = {
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

  async init(config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    try {
      // Database migrations are handled by the SQL plugin
      if (runtime.db) {
        logger.info('Database available, TodoPlugin ready for operation');
      } else {
        logger.warn('No database instance available, operations will be limited');
      }

      // Check for rolodex plugin availability
      const messageDeliveryService = runtime.getService('MESSAGE_DELIVERY' as never);
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

export default todoPlugin;

// Export discoverable services for external use
export { TodoReminderService } from './services/reminderService';
export { TodoIntegrationBridge } from './services/integrationBridge';

// Export internal managers for advanced usage
export { NotificationManager } from './services/notificationManager';
export { CacheManager } from './services/cacheManager';

// Export data service utilities
export { createTodoDataService } from './services/todoDataService';
export type { TodoData } from './services/todoDataService';

// Export types from managers
export type { CacheEntry, CacheStats } from './services/cacheManager';
export type { NotificationData, NotificationPreferences } from './services/notificationManager';

// Export schema
export { todoSchema } from './schema';

