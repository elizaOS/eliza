import { Action, IAgentRuntime, Memory, State, ActionResult, HandlerCallback } from '@elizaos/core';

// Synthetic action that requires specific capabilities
export const capabilityRequiredAction: Action = {
  name: 'CAPABILITY_CHECK',
  description: 'Action that requires specific capabilities to run',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Check if required capability exists in state
    const hasCapability = state?.values?.capabilities?.includes('advanced_analysis');
    return hasCapability === true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any
  ): Promise<ActionResult> => {
    return {
      data: {
        actionName: 'CAPABILITY_CHECK',
        usedCapability: 'advanced_analysis',
        result: 'Performed advanced analysis',
      },
    };
  },

  effects: {
    requires: ['advanced_analysis_capability'],
    provides: ['advanced_analysis_result'],
    modifies: [],
  },
};

// Synthetic action that depends on message classification
export const classificationDependentAction: Action = {
  name: 'CLASSIFICATION_DEPENDENT',
  description: 'Action that only runs for specific message classifications',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const classification = state?.data?.providers?.messageClassifier?.classification;
    return classification === 'strategic' || classification === 'analysis';
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const classification = state?.data?.providers?.messageClassifier?.classification;

    let response = '';
    if (classification === 'strategic') {
      response = 'Executing strategic planning module...';
    } else if (classification === 'analysis') {
      response = 'Running analysis module...';
    }

    if (callback) {
      await callback({
        text: response,
        actions: ['CLASSIFICATION_DEPENDENT'],
      });
    }

    return {
      data: {
        actionName: 'CLASSIFICATION_DEPENDENT',
        classification,
        executed: true,
      },
    };
  },
};

// Synthetic action that uses multiple providers
export const multiProviderAction: Action = {
  name: 'MULTI_PROVIDER',
  description: 'Action that combines data from multiple providers',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Check if all required providers have data
    const hasClassifier = !!state?.data?.providers?.messageClassifier;
    const hasPriority = !!state?.data?.providers?.priorityDetector;
    return hasClassifier && hasPriority;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any
  ): Promise<ActionResult> => {
    const classification = state?.data?.providers?.messageClassifier?.classification;
    const priority = state?.data?.providers?.priorityDetector?.priority;

    const strategy = {
      approach: classification === 'strategic' ? 'long-term' : 'tactical',
      urgency: priority === 'high' ? 'immediate' : 'scheduled',
      resources: priority === 'high' ? 'premium' : 'standard',
    };

    return {
      data: {
        actionName: 'MULTI_PROVIDER',
        strategy,
        combinedInsights: true,
      },
      values: {
        executionStrategy: strategy,
      },
    };
  },
};

// Synthetic action that can fail based on conditions
export const conditionalFailureAction: Action = {
  name: 'CONDITIONAL_FAILURE',
  description: 'Action that may fail based on input conditions',

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    return true; // Always available for testing
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const text = message.content.text || '';

    // Fail if message contains "fail"
    if (text.toLowerCase().includes('fail')) {
      // Instead of returning error, handle the failure internally
      if (callback) {
        await callback({
          text: 'I encountered an error processing that request.',
          error: true,
        });
      }

      return {
        data: {
          actionName: 'CONDITIONAL_FAILURE',
          failed: true,
          reason: 'Message contained failure trigger',
        },
      };
    }

    // Succeed otherwise
    return {
      data: {
        actionName: 'CONDITIONAL_FAILURE',
        passed: true,
      },
    };
  },
};

// Synthetic action that modifies state for next actions
export const stateModifierAction: Action = {
  name: 'STATE_MODIFIER',
  description: 'Action that modifies state for subsequent actions',

  validate: async () => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any
  ): Promise<ActionResult> => {
    const currentCount = state?.values?.actionCount || 0;

    return {
      data: {
        actionName: 'STATE_MODIFIER',
        modifiedFields: ['actionCount', 'lastModified', 'capabilities'],
      },
      values: {
        actionCount: currentCount + 1,
        lastModified: Date.now(),
        capabilities: [...(state?.values?.capabilities || []), 'advanced_analysis'],
      },
    };
  },
};

// Synthetic action for testing parallel execution
export const parallelAction: Action = {
  name: 'PARALLEL_ACTION',
  description: 'Action designed for parallel execution testing',

  validate: async () => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any
  ): Promise<ActionResult> => {
    const startTime = Date.now();

    // Simulate async work
    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      data: {
        actionName: 'PARALLEL_ACTION',
        threadId: options?.threadId || 'main',
        executionTime: Date.now() - startTime,
      },
    };
  },
};
