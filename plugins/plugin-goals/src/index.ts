import type { Plugin } from '@elizaos/core';
import { type IAgentRuntime, logger } from '@elizaos/core';

import { routes } from './apis.js';

// Import actions
import { cancelGoalAction } from './actions/cancelGoal.js';
import { completeGoalAction } from './actions/completeGoal.js';
import { confirmGoalAction } from './actions/confirmGoal.js';
import { createGoalAction } from './actions/createGoal.js';
import { updateGoalAction } from './actions/updateGoal.js';

// Import providers
import { goalsProvider } from './providers/goals.js';

// Import services
import { GoalDataServiceWrapper } from './services/goalDataService.js';

// Import schema
import { goalSchema } from './schema.js';

// Import tests
import { GoalsPluginE2ETestSuite } from './tests.js';

/**
 * The GoalsPlugin provides goal management functionality,
 * including creating, completing, updating, and canceling goals.
 */
export const GoalsPlugin: Plugin = {
  name: 'goals',
  description: 'Provides goal management functionality for tracking and achieving objectives.',
  providers: [goalsProvider],
  testDependencies: ['@elizaos/plugin-sql'],
  actions: [
    createGoalAction,
    completeGoalAction,
    confirmGoalAction,
    updateGoalAction,
    cancelGoalAction,
  ],
  services: [GoalDataServiceWrapper],
  routes,
  schema: goalSchema,
  tests: [GoalsPluginE2ETestSuite],

  async init(config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    try {
      // Database migrations are handled by the SQL plugin
      if (runtime.db) {
        logger.info('Database available, GoalsPlugin ready for operation');
      } else {
        logger.warn('No database instance available, operations will be limited');
      }

      logger.info('GoalsPlugin initialized successfully');
    } catch (error) {
      logger.error('Error initializing GoalsPlugin:', error);
      throw error;
    }
  },
};

export default GoalsPlugin;

// Export data service utilities
export { createGoalDataService, GoalDataServiceWrapper } from './services/goalDataService.js';
export type { GoalData } from './services/goalDataService.js';

// Export schema
export { goalSchema } from './schema.js';
