/**
 * MVP Plugin - Minimal Viable Product for Custom Reasoning
 *
 * This is a working plugin that actually integrates with ElizaOS
 */

import type { Plugin, IAgentRuntime } from '@elizaos/core';
import { elizaLogger } from '@elizaos/core';
import {
  enableCustomReasoningAction,
  disableCustomReasoningAction,
  checkReasoningStatusAction,
} from './simple-actions';

export const mvpCustomReasoningPlugin: Plugin = {
  name: 'mvp-custom-reasoning',
  description: 'MVP Custom Reasoning Service with training data collection',

  actions: [enableCustomReasoningAction, disableCustomReasoningAction, checkReasoningStatusAction],

  async init(config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    // Minimal initialization
    elizaLogger.info('MVP Custom Reasoning Plugin initialized');

    // Create training_data table if SQL plugin is available
    try {
      const sqlService = runtime.getService?.('sql');
      if (sqlService) {
        await (sqlService as any).query(`
                    CREATE TABLE IF NOT EXISTS training_data (
                        id TEXT PRIMARY KEY,
                        timestamp INTEGER NOT NULL,
                        agent_id TEXT NOT NULL,
                        room_id TEXT,
                        model_type TEXT NOT NULL CHECK (model_type IN ('should_respond', 'planning', 'coding')),
                        input_data TEXT NOT NULL,
                        output_data TEXT,
                        success BOOLEAN NOT NULL DEFAULT FALSE,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `);
        elizaLogger.info('Training data table initialized');
      }
    } catch (error) {
      elizaLogger.warn('Failed to initialize training data table:', error);
      // Don't fail plugin initialization if database setup fails
    }
  },

  // No services, providers, or evaluators for MVP
  // Just the core actions that actually work
};
