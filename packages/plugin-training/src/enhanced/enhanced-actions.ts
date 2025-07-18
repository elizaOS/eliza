/**
 * Enhanced Custom Reasoning Actions
 *
 * Actions that interact with the EnhancedReasoningService for comprehensive
 * training data collection with database and file system storage.
 */

import { type Action, type IAgentRuntime, type Memory, type State } from '@elizaos/core';
import { EnhancedReasoningService } from './enhanced-reasoning-service';

// Global service registry for enhanced service instances
const enhancedServiceRegistry = new Map<string, EnhancedReasoningService>();

/**
 * Get or create enhanced service instance for the given runtime
 */
function getOrCreateEnhancedService(runtime: IAgentRuntime): EnhancedReasoningService {
  const agentId = runtime.agentId;

  if (!enhancedServiceRegistry.has(agentId)) {
    enhancedServiceRegistry.set(agentId, new EnhancedReasoningService(runtime));
  }

  return enhancedServiceRegistry.get(agentId)!;
}

/**
 * Enable Enhanced Custom Reasoning Action
 * Starts comprehensive training data collection with database and file storage
 */
export const enableEnhancedReasoningAction: Action = {
  name: 'ENABLE_ENHANCED_REASONING',
  similes: ['ENABLE_TRAINING', 'START_TRAINING', 'ACTIVATE_ENHANCED_REASONING'],
  description: 'Enable enhanced custom reasoning with comprehensive training data collection',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';
    return (
      text.includes('enable enhanced reasoning') ||
      text.includes('enable training') ||
      text.includes('start training') ||
      text.includes('activate enhanced reasoning') ||
      text.includes('turn on enhanced reasoning') ||
      text.includes('start enhanced reasoning')
    );
  },

  handler: async (runtime, message, state, options, callback) => {
    try {
      const service = getOrCreateEnhancedService(runtime);
      await service.enable();

      const status = service.getStatus();

      await callback?.({
        text: `🚀 **Enhanced Custom Reasoning Service Enabled!**

🔬 **Session Started**: ${status.sessionId}
📊 **Features Active**:
• Database storage for training data
• File system recording for visual debugging  
• Session tracking and statistics
• Complete ModelType support

💾 **Data Collection**: Training data will be saved to:
• Database: \`training_data\` and \`training_sessions\` tables
• Files: \`training_recording/${status.sessionId}/\` directory

The service will now intercept all \`useModel\` calls and collect comprehensive training data. When disabled, it will seamlessly return to normal operation.`,
        thought:
          'Successfully enabled enhanced reasoning service with comprehensive data collection capabilities',
        actions: ['ENABLE_ENHANCED_REASONING'],
      });
    } catch (error) {
      await callback?.({
        text: `❌ **Failed to enable enhanced reasoning**: ${error instanceof Error ? error.message : String(error)}

Please check that:
• Database adapter is properly configured
• File system permissions are correct
• No other training session is currently active`,
        thought: 'Failed to enable enhanced reasoning service due to error',
        actions: ['ENABLE_ENHANCED_REASONING'],
      });
    }
  },

  examples: [
    [
      {
        name: 'User',
        content: { text: 'Enable enhanced reasoning for training data collection' },
      },
      {
        name: 'Agent',
        content: {
          text: '🚀 Enhanced Custom Reasoning Service Enabled! Session started with comprehensive data collection.',
          thought: 'Enabled enhanced reasoning with database and file storage',
          actions: ['ENABLE_ENHANCED_REASONING'],
        },
      },
    ],
  ],
};

/**
 * Disable Enhanced Custom Reasoning Action
 * Stops training data collection and completes the session
 */
export const disableEnhancedReasoningAction: Action = {
  name: 'DISABLE_ENHANCED_REASONING',
  similes: ['DISABLE_TRAINING', 'STOP_TRAINING', 'DEACTIVATE_ENHANCED_REASONING'],
  description: 'Disable enhanced custom reasoning and complete training session',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';
    return (
      text.includes('disable enhanced reasoning') ||
      text.includes('disable training') ||
      text.includes('stop training') ||
      text.includes('deactivate enhanced reasoning') ||
      text.includes('turn off enhanced reasoning') ||
      text.includes('stop enhanced reasoning')
    );
  },

  handler: async (runtime, message, state, options, callback) => {
    try {
      const service = getOrCreateEnhancedService(runtime);

      // Get final status before disabling
      const finalStatus = service.getStatus();

      if (!finalStatus.enabled) {
        await callback?.({
          text: `ℹ️ **Enhanced reasoning is already disabled**

No active training session found. Use "enable enhanced reasoning" to start collecting training data.`,
          thought: 'Enhanced reasoning was already disabled',
          actions: ['DISABLE_ENHANCED_REASONING'],
        });
        return;
      }

      await service.disable();

      await callback?.({
        text: `🛑 **Enhanced Custom Reasoning Service Disabled**

📊 **Session Complete**: ${finalStatus.sessionId}
📈 **Final Statistics**:
• Total model calls: ${finalStatus.stats.totalCalls}
• Successful calls: ${finalStatus.stats.successfulCalls}
• Failed calls: ${finalStatus.stats.failedCalls}
• Duration: ${Math.round(finalStatus.stats.durationMs / 1000)}s
• Records collected: ${finalStatus.stats.recordsCollected}

💾 **Data Saved**: Training data has been saved to database and files for analysis.

The service has returned to normal operation. All \`useModel\` calls will now behave as before.`,
        thought: 'Successfully disabled enhanced reasoning service and completed training session',
        actions: ['DISABLE_ENHANCED_REASONING'],
      });
    } catch (error) {
      await callback?.({
        text: `❌ **Failed to disable enhanced reasoning**: ${error instanceof Error ? error.message : String(error)}

The service may still be active. Please try again or restart the agent if issues persist.`,
        thought: 'Failed to disable enhanced reasoning service due to error',
        actions: ['DISABLE_ENHANCED_REASONING'],
      });
    }
  },

  examples: [
    [
      {
        name: 'User',
        content: { text: 'Disable enhanced reasoning and save the training data' },
      },
      {
        name: 'Agent',
        content: {
          text: '🛑 Enhanced Custom Reasoning Service Disabled. Training session complete with 42 records collected.',
          thought: 'Disabled enhanced reasoning and completed training session',
          actions: ['DISABLE_ENHANCED_REASONING'],
        },
      },
    ],
  ],
};

/**
 * Check Enhanced Reasoning Status Action
 * Provides detailed status information about the current session
 */
export const checkEnhancedReasoningStatusAction: Action = {
  name: 'CHECK_ENHANCED_REASONING_STATUS',
  similes: ['TRAINING_STATUS', 'REASONING_STATUS', 'SESSION_STATUS'],
  description: 'Check the status of enhanced custom reasoning and current training session',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';
    return (
      text.includes('enhanced reasoning status') ||
      text.includes('training status') ||
      text.includes('reasoning status') ||
      text.includes('check enhanced reasoning') ||
      text.includes('session status') ||
      text.includes('training session status')
    );
  },

  handler: async (runtime, message, state, options, callback) => {
    try {
      const service = getOrCreateEnhancedService(runtime);
      const status = service.getStatus();

      if (status.enabled) {
        const durationSeconds = Math.round(status.stats.durationMs / 1000);
        const successRate =
          status.stats.totalCalls > 0
            ? Math.round((status.stats.successfulCalls / status.stats.totalCalls) * 100)
            : 0;

        await callback?.({
          text: `🔬 **Enhanced Reasoning Status: ACTIVE**

📊 **Current Session**: ${status.sessionId}
⏱️ **Duration**: ${durationSeconds}s
📈 **Statistics**:
• Total model calls: ${status.stats.totalCalls}
• Successful calls: ${status.stats.successfulCalls}
• Failed calls: ${status.stats.failedCalls}
• Success rate: ${successRate}%
• Records collected: ${status.stats.recordsCollected}

💾 **Data Storage**: Training data is being saved to:
• Database: \`training_data\` and \`training_sessions\` tables  
• Files: \`training_recording/${status.sessionId}/\` directory

🔄 **Status**: All \`useModel\` calls are being intercepted and training data is being collected.`,
          thought: 'Enhanced reasoning is active and collecting training data',
          actions: ['CHECK_ENHANCED_REASONING_STATUS'],
        });
      } else {
        await callback?.({
          text: `💤 **Enhanced Reasoning Status: INACTIVE**

🔄 **Service State**: Disabled
📊 **Active Session**: None

ℹ️ **Normal Operation**: All \`useModel\` calls are behaving normally without data collection.

Use "enable enhanced reasoning" to start a new training session with comprehensive data collection.`,
          thought: 'Enhanced reasoning is currently disabled',
          actions: ['CHECK_ENHANCED_REASONING_STATUS'],
        });
      }
    } catch (error) {
      await callback?.({
        text: `❌ **Error checking enhanced reasoning status**: ${error instanceof Error ? error.message : String(error)}

The service may not be properly initialized. Please try enabling enhanced reasoning first.`,
        thought: 'Error occurred while checking enhanced reasoning status',
        actions: ['CHECK_ENHANCED_REASONING_STATUS'],
      });
    }
  },

  examples: [
    [
      {
        name: 'User',
        content: { text: 'What is the enhanced reasoning status?' },
      },
      {
        name: 'Agent',
        content: {
          text: '🔬 Enhanced Reasoning Status: ACTIVE. Current session has collected 15 training records.',
          thought: 'Provided current enhanced reasoning status and statistics',
          actions: ['CHECK_ENHANCED_REASONING_STATUS'],
        },
      },
    ],
  ],
};

/**
 * Export all enhanced actions
 */
export const enhancedActions = [
  enableEnhancedReasoningAction,
  disableEnhancedReasoningAction,
  checkEnhancedReasoningStatusAction,
];
