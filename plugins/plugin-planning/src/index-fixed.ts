// Fixed imports using specific paths to avoid workspace issues
import type { Plugin, Action, Provider } from '@elizaos/core';
import { Service } from '@elizaos/core';

// Simple message classifier provider
export const messageClassifierProvider: Provider = {
  name: 'MESSAGE_CLASSIFIER',
  description: 'Classifies messages for strategic planning',

  get: async (runtime, message, _state) => {
    const text = message.content.text || '';

    // Simple classification logic
    let classification = 'SIMPLE';

    if (text.includes('plan') || text.includes('strategy') || text.includes('coordinate')) {
      classification = 'STRATEGIC';
    } else if (
      text.includes('research') ||
      text.includes('analyze') ||
      text.includes('investigate')
    ) {
      classification = 'RESEARCH_NEEDED';
    } else if (text.includes('integrate') || text.includes('connect') || text.includes('add')) {
      classification = 'CAPABILITY_REQUEST';
    }

    return {
      text: `Message classification: ${classification}`,
      values: {
        messageClassification: classification,
        complexity: classification === 'SIMPLE' ? 'low' : 'high',
      },
    };
  },
};

// Simple example actions
export const analyzeInputAction: Action = {
  name: 'ANALYZE_INPUT',
  similes: ['EXAMINE', 'REVIEW'],
  description: 'Analyzes user input and extracts key information',

  validate: async (_runtime, _message) => {
    return true; // Always available
  },

  handler: async (runtime, message, state, options, callback) => {
    const analysis = {
      intent: 'user_request',
      complexity: 'medium',
      requiredActions: ['PROCESS_ANALYSIS'],
    };

    if (callback) {
      await callback({
        text: 'Input analyzed successfully',
        thought: 'Extracted key information from user input',
        actions: ['PROCESS_ANALYSIS'],
      });
    }

    return {
      values: { analysis },
      data: { inputAnalysis: analysis },
      text: 'Analysis completed',
    };
  },

  examples: [],
};

export const processAnalysisAction: Action = {
  name: 'PROCESS_ANALYSIS',
  similes: ['HANDLE', 'EXECUTE'],
  description: 'Processes analysis results and makes decisions',

  validate: async (_runtime, _message) => {
    return true;
  },

  handler: async (runtime, message, state, options, callback) => {
    const decision = {
      action: 'execute_final',
      confidence: 0.8,
      reasoning: 'Based on analysis, proceeding with execution',
    };

    if (callback) {
      await callback({
        text: 'Analysis processed, ready for execution',
        thought: 'Made decision based on analysis results',
        actions: ['EXECUTE_FINAL'],
      });
    }

    return {
      values: { decision },
      data: { processingResult: decision },
      text: 'Processing completed',
    };
  },

  examples: [],
};

export const executeFinalAction: Action = {
  name: 'EXECUTE_FINAL',
  similes: ['COMPLETE', 'FINISH'],
  description: 'Executes the final action based on processing results',

  validate: async (_runtime, _message) => {
    return true;
  },

  handler: async (runtime, message, state, options, callback) => {
    if (callback) {
      await callback({
        text: 'Task completed successfully',
        thought: 'Executed final action in the chain',
      });
    }

    return {
      values: { completed: true },
      data: { executionResult: 'success' },
      text: 'Execution completed',
    };
  },

  examples: [],
};

export const createPlanAction: Action = {
  name: 'CREATE_PLAN',
  similes: ['PLAN', 'STRATEGIZE'],
  description: 'Creates a strategic plan for complex tasks',

  validate: async (runtime, message) => {
    return message.content.text?.includes('plan') || false;
  },

  handler: async (runtime, message, state, options, callback) => {
    const plan = {
      goal: 'Address user request systematically',
      steps: ['analyze', 'plan', 'execute'],
      timeline: '30 minutes',
    };

    if (callback) {
      await callback({
        text: 'Strategic plan created successfully',
        thought: 'Developed a systematic approach to the request',
      });
    }

    return {
      values: { plan },
      data: { strategicPlan: plan },
      text: 'Plan creation completed',
    };
  },

  examples: [],
};

// Simple planning service stub
class SimplePlanningService extends Service {
  capabilityDescription = 'Provides planning and execution capabilities';

  static async start(runtime: any): Promise<SimplePlanningService> {
    const instance = new SimplePlanningService(runtime);
    return instance;
  }

  async stop(): Promise<void> {
    // Cleanup if needed
  }
}

export const planningPlugin: Plugin = {
  name: '@elizaos/plugin-planning',
  description: 'Comprehensive planning and execution plugin with unified planning service',

  providers: [messageClassifierProvider],

  actions: [analyzeInputAction, processAnalysisAction, executeFinalAction, createPlanAction],

  services: [SimplePlanningService],

  evaluators: [],
};

// Maintain backwards compatibility
export const strategyPlugin = planningPlugin;

export default planningPlugin;
