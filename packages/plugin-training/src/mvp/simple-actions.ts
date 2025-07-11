/**
 * MVP Actions for Custom Reasoning Service
 *
 * Simple, working actions that actually enable/disable the service
 */

import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import { SimpleReasoningService } from './simple-reasoning-service';

// Global service registry to maintain state
const serviceRegistry = new Map<string, SimpleReasoningService>();

function getOrCreateService(runtime: IAgentRuntime): SimpleReasoningService {
  const key = runtime.agentId;
  if (!serviceRegistry.has(key)) {
    serviceRegistry.set(key, new SimpleReasoningService(runtime));
  }
  return serviceRegistry.get(key)!;
}

export const enableCustomReasoningAction: Action = {
  name: 'ENABLE_REASONING_SERVICE',
  similes: ['ACTIVATE_REASONING_SERVICE', 'TURN_ON_REASONING', 'START_REASONING_SERVICE'],
  description: 'Enable the custom reasoning service with training data collection',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    // Allow if user explicitly mentions enabling/activating custom reasoning
    const text = message.content.text?.toLowerCase() || '';
    return (
      text.includes('enable custom reasoning') ||
      text.includes('activate custom reasoning') ||
      text.includes('turn on reasoning') ||
      text.includes('start custom reasoning')
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ) => {
    try {
      const service = getOrCreateService(runtime);
      const status = service.getStatus();

      if (status.enabled) {
        await callback?.({
          text: `✅ Custom reasoning is already enabled!\n\n📊 Current Status:\n• Service: Active\n• Training data collected: ${
            status.dataCount
          } records\n• Last activity: ${
            status.lastActivity ? new Date(status.lastActivity).toLocaleString() : 'None'
          }`,
          thought: 'Custom reasoning was already enabled, provided status update',
        });
        return;
      }

      await service.enable();

      await callback?.({
        text: '✅ **Custom Reasoning Service Enabled!**\n\n🧠 **What this does:**\n• Intercepts all model calls for training data collection\n• Maintains full backwards compatibility\n• Collects data for future fine-tuning\n• Falls back gracefully on any errors\n\n📊 **Status:** Active and collecting training data',
        thought: 'Successfully enabled custom reasoning service with data collection',
        actions: ['ENABLE_REASONING_SERVICE'],
      });
    } catch (error) {
      await callback?.({
        text: `❌ **Failed to enable custom reasoning service**\n\nError: ${
          (error as Error).message
        }\n\nThe original ElizaOS behavior is preserved.`,
        thought: 'Failed to enable custom reasoning, but original functionality is intact',
      });
    }
  },

  examples: [
    [
      { name: 'User', content: { text: 'enable custom reasoning' } },
      {
        name: 'Agent',
        content: {
          text: '✅ Custom Reasoning Service Enabled!',
          thought: 'Enabled custom reasoning with training data collection',
          actions: ['ENABLE_REASONING_SERVICE'],
        },
      },
    ],
  ],
};

export const disableCustomReasoningAction: Action = {
  name: 'DISABLE_REASONING_SERVICE',
  similes: ['DEACTIVATE_REASONING_SERVICE', 'TURN_OFF_REASONING', 'STOP_REASONING_SERVICE'],
  description: 'Disable the custom reasoning service and restore original ElizaOS behavior',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';
    return (
      text.includes('disable custom reasoning') ||
      text.includes('deactivate custom reasoning') ||
      text.includes('turn off reasoning') ||
      text.includes('stop custom reasoning')
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ) => {
    try {
      const service = getOrCreateService(runtime);
      const status = service.getStatus();

      if (!status.enabled) {
        await callback?.({
          text: `✅ Custom reasoning is already disabled.\n\n📊 Status: Using original ElizaOS behavior\n• Training data preserved: ${
            status.dataCount
          } records`,
          thought: 'User tried to disable custom reasoning but it was already disabled',
        });
        return;
      }

      await service.disable();

      await callback?.({
        text: `✅ **Custom Reasoning Service Disabled**\n\n🔄 **Restored to original ElizaOS behavior**\n• All model calls now use original methods\n• Training data preserved: ${
          status.dataCount
        } records\n• No functionality lost`,
        thought: 'Successfully disabled custom reasoning and restored original behavior',
        actions: ['DISABLE_REASONING_SERVICE'],
      });
    } catch (error) {
      await callback?.({
        text: `❌ **Failed to disable custom reasoning service**\n\nError: ${
          (error as Error).message
        }\n\nPlease check the service status.`,
        thought: 'Failed to disable custom reasoning service',
      });
    }
  },

  examples: [
    [
      { name: 'User', content: { text: 'disable custom reasoning' } },
      {
        name: 'Agent',
        content: {
          text: '✅ Custom Reasoning Service Disabled',
          thought: 'Disabled custom reasoning and restored original behavior',
          actions: ['DISABLE_REASONING_SERVICE'],
        },
      },
    ],
  ],
};

export const checkReasoningStatusAction: Action = {
  name: 'CHECK_REASONING_STATUS',
  similes: ['REASONING_STATUS', 'REASONING_SERVICE_STATUS'],
  description: 'Check the current status of the custom reasoning service',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';
    return (
      text.includes('reasoning status') ||
      text.includes('custom reasoning status') ||
      text.includes('check reasoning')
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ) => {
    try {
      const service = getOrCreateService(runtime);
      const status = service.getStatus();

      const statusText = status.enabled ? '🟢 Active' : '🔴 Disabled';
      const behaviorText = status.enabled
        ? 'Using custom reasoning with training data collection'
        : 'Using original ElizaOS behavior';

      await callback?.({
        text: `📊 **Custom Reasoning Service Status**\n\n**Service Status:** ${statusText}\n**Behavior:** ${behaviorText}\n**Training Data:** ${status.dataCount} records collected\n**Last Activity:** ${status.lastActivity ? new Date(status.lastActivity).toLocaleString() : 'None'}\n\n${status.enabled ? '💡 Say "disable custom reasoning" to turn off' : '💡 Say "enable custom reasoning" to turn on'}`,
        thought: 'Provided current custom reasoning service status',
      });
    } catch (error) {
      await callback?.({
        text: `❌ **Unable to check service status**\n\nError: ${(error as Error).message}`,
        thought: 'Failed to check custom reasoning service status',
      });
    }
  },

  examples: [
    [
      { name: 'User', content: { text: 'check reasoning status' } },
      {
        name: 'Agent',
        content: {
          text: '📊 Custom Reasoning Service Status\n\nService Status: 🟢 Active',
          thought: 'Provided current service status',
        },
      },
    ],
  ],
};
