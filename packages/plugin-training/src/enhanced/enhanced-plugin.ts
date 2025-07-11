/**
 * Enhanced Custom Reasoning Plugin
 *
 * Complete implementation with database integration, file system storage,
 * and comprehensive training data collection capabilities.
 */

import { type Plugin, logger } from '@elizaos/core';
import { enhancedActions } from './enhanced-actions';
import { trainingSchema } from './schema';

/**
 * Enhanced Custom Reasoning Plugin
 *
 * Features:
 * - Database persistence using plugin-sql integration
 * - File system storage in training_recording/ for visual debugging
 * - Session management and statistics tracking
 * - Complete ModelType support for all use cases
 * - Non-breaking backwards compatibility when disabled
 */
export const enhancedCustomReasoningPlugin: Plugin = {
  name: 'enhanced-custom-reasoning',
  description:
    'Enhanced custom reasoning plugin with comprehensive training data collection, database storage, and session management',

  // Actions for enable/disable/status functionality
  actions: enhancedActions,

  // Plugin initialization
  init: async (config, runtime) => {
    logger.info('🔬 Enhanced Custom Reasoning Plugin initializing...');

    try {
      // Verify database adapter availability
      const dbAdapter = (runtime as any).databaseAdapter;
      if (!dbAdapter) {
        logger.warn(
          '⚠️ No database adapter found. Enhanced reasoning will work but without database storage.'
        );
      } else {
        logger.info('✅ Database adapter detected for enhanced reasoning data storage');

        // Check if we can access the database
        const db = dbAdapter.db;
        if (db) {
          logger.info('✅ Database connection available for training data storage');

          // Test database connectivity
          try {
            await db.execute({ sql: 'SELECT 1', args: [] });
            logger.info('✅ Database connectivity verified');
          } catch (error) {
            logger.warn('⚠️ Database connectivity test failed:', error);
          }
        } else {
          logger.warn('⚠️ Database handle not available in adapter');
        }
      }

      // Verify file system access for training_recording directory
      try {
        const fs = await import('fs/promises');
        const path = await import('path');

        const trainingDir = path.join(process.cwd(), 'training_recording');
        await fs.mkdir(trainingDir, { recursive: true });

        // Test write access
        const testFile = path.join(trainingDir, 'test_write.tmp');
        await fs.writeFile(testFile, 'test', 'utf-8');
        await fs.unlink(testFile);

        logger.info('✅ File system access verified for training_recording directory');
      } catch (error) {
        logger.error('❌ File system access failed for training_recording directory:', error);
        throw new Error(
          `Enhanced reasoning requires write access to training_recording directory: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Log available actions
      logger.info('🎯 Enhanced reasoning actions available:', {
        actions: enhancedActions.map((action) => action.name),
        enableTriggers: ['enable enhanced reasoning', 'enable training', 'start training'],
        disableTriggers: ['disable enhanced reasoning', 'disable training', 'stop training'],
        statusTriggers: ['enhanced reasoning status', 'training status', 'session status'],
      });

      logger.info('🚀 Enhanced Custom Reasoning Plugin initialized successfully');
    } catch (error) {
      logger.error('❌ Enhanced Custom Reasoning Plugin initialization failed:', error);
      throw error;
    }
  },

  // Schema for database integration (if needed by plugin-sql)
  schema: trainingSchema,

  // Plugin metadata
  priority: 1, // Higher priority to ensure proper loading order

  // Dependencies
  dependencies: ['@elizaos/plugin-sql'], // Requires SQL plugin for database storage
};
