import { describe, it, expect, vi, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  analyzeInputAction,
  processAnalysisAction,
  executeFinalAction,
} from '../actions/chain-example';
import { messageClassifierProvider } from '../providers/message-classifier';
import {
  capabilityRequiredAction,
  classificationDependentAction,
  multiProviderAction,
  conditionalFailureAction,
  stateModifierAction,
  parallelAction,
} from './test-actions';
import {
  priorityDetectorProvider,
  capabilityDetectorProvider,
  contextHistoryProvider,
  resourceAvailabilityProvider,
  sentimentAnalysisProvider,
  taskComplexityProvider,
} from './test-providers';
import {
  type IAgentRuntime,
  type Memory,
  type State,
  type Action,
  type Provider,
  type UUID,
  ModelType,
} from '@elizaos/core';

// Mock runtime with action/provider selection capabilities
const createMockRuntime = (overrides?: Partial<IAgentRuntime>): IAgentRuntime => {
  const registeredActions: Action[] = [];
  const registeredProviders: Provider[] = [];

  const mockRuntime: IAgentRuntime = {
    agentId: uuidv4() as UUID,
    character: {
      name: 'Test Agent',
      modelPriority: {
        [ModelType.TEXT_LARGE]: ['gpt-4'],
      },
    },

    // Action registration and selection
    registerAction: vi.fn((action: Action) => {
      registeredActions.push(action);
    }),

    getAction: vi.fn((name: string) => {
      return registeredActions.find((a) => a.name === name);
    }),

    getActions: vi.fn(() => registeredActions),

    // Provider registration and selection
    registerProvider: vi.fn((provider: Provider) => {
      registeredProviders.push(provider);
    }),

    getProvider: vi.fn((name: string) => {
      return registeredProviders.find((p) => p.name === name);
    }),

    getProviders: vi.fn(() => registeredProviders),

    // State composition with providers
    composeState: vi.fn(async (message: Memory, includeList?: string[]) => {
      const state: State = {
        values: {},
        data: { providers: {} },
        text: '',
      };

      // Run requested providers
      const providersToRun = includeList
        ? registeredProviders.filter((p) => includeList.includes(p.name))
        : registeredProviders.filter((p) => !p.dynamic && !p.private);

      for (const provider of providersToRun) {
        const result = await provider.get(mockRuntime, message, state);
        if (result.text) {
          state.text += result.text + '\n';
        }
        if (result.data) {
          state.data.providers[provider.name] = result.data;
        }
        if (result.values) {
          Object.assign(state.values, result.values);
        }
      }

      return state;
    }),

    // Model selection (for LLM action selection)
    useModel: vi.fn(async (type: (typeof ModelType)[keyof typeof ModelType], params: any) => {
      if (type === ModelType.TEXT_LARGE) {
        // Simulate LLM selecting actions based on message content
        const prompt = params.prompt || '';
        const availableActions = registeredActions.map((a) => a.name);

        if (prompt.includes('analyze')) {
          return JSON.stringify({ action: 'ANALYZE_INPUT' });
        } else if (prompt.includes('process')) {
          return JSON.stringify({ action: 'PROCESS_ANALYSIS' });
        } else if (prompt.includes('execute')) {
          return JSON.stringify({ action: 'EXECUTE_FINAL' });
        }

        return JSON.stringify({ action: availableActions[0] || 'REPLY' });
      }
      return null;
    }),

    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },

    ...overrides,
  } as any;

  return mockRuntime;
};

describe('Planning Plugin Scenario Tests', () => {
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();

    // Register actions
    runtime.registerAction(analyzeInputAction);
    runtime.registerAction(processAnalysisAction);
    runtime.registerAction(executeFinalAction);
    runtime.registerAction(capabilityRequiredAction);
    runtime.registerAction(classificationDependentAction);
    runtime.registerAction(multiProviderAction);
    runtime.registerAction(conditionalFailureAction);
    runtime.registerAction(stateModifierAction);
    runtime.registerAction(parallelAction);

    // Register providers
    runtime.registerProvider(messageClassifierProvider);
    runtime.registerProvider(priorityDetectorProvider);
    runtime.registerProvider(capabilityDetectorProvider);
    runtime.registerProvider(contextHistoryProvider);
    runtime.registerProvider(resourceAvailabilityProvider);
    runtime.registerProvider(sentimentAnalysisProvider);
    runtime.registerProvider(taskComplexityProvider);
  });

  describe('Message Classification Scenarios', () => {
    it('should classify analysis request correctly', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Please analyze this market data for trends' },
      };

      const state = await runtime.composeState(message);

      expect(state.data.providers.messageClassifier).toBeDefined();
      expect(state.data.providers.messageClassifier.classification).toBe('analysis');
      expect(state.data.providers.messageClassifier.confidence).toBeGreaterThan(0.7);
    });

    it('should classify processing request correctly', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Process the quarterly reports and generate summaries' },
      };

      const state = await runtime.composeState(message);

      expect(state.data.providers.messageClassifier.classification).toBe('processing');
      expect(state.data.providers.messageClassifier.confidence).toBeGreaterThan(0.7);
    });

    it('should classify execution request correctly', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Execute the final deployment steps' },
      };

      const state = await runtime.composeState(message);

      expect(state.data.providers.messageClassifier.classification).toBe('execution');
    });

    it('should classify strategic planning request', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Develop a strategy for entering new markets' },
      };

      const state = await runtime.composeState(message);

      expect(state.data.providers.messageClassifier.classification).toBe('strategic');
      expect(state.data.providers.messageClassifier.confidence).toBeGreaterThan(0.6);
    });

    it('should handle ambiguous messages with lower confidence', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Hello, how are you today?' },
      };

      const state = await runtime.composeState(message);

      expect(state.data.providers.messageClassifier.classification).toBe('general');
      expect(state.data.providers.messageClassifier.confidence).toBeLessThanOrEqual(0.5);
    });
  });

  describe('Action Selection Scenarios', () => {
    it('should select ANALYZE_INPUT for analysis requests', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Analyze the customer feedback data' },
      };

      // Validate the action should be available
      const analyzeAction = analyzeInputAction; // Use the imported action directly
      expect(analyzeAction).toBeDefined();
      expect(await analyzeAction.validate!(runtime, message)).toBe(true);

      // Simulate LLM action selection
      const selectedAction = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt:
          'User says: "Analyze the customer feedback data". Available actions: ANALYZE_INPUT, PROCESS_ANALYSIS, EXECUTE_FINAL',
      });

      expect(JSON.parse(selectedAction as string).action).toBe('ANALYZE_INPUT');
    });

    it('should select appropriate action chain for complex requests', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Analyze the data, process it, and execute the recommendations' },
      };

      const state = await runtime.composeState(message);

      // All actions should be valid for this complex request
      expect(await analyzeInputAction.validate!(runtime, message)).toBe(true);
      expect(await processAnalysisAction.validate!(runtime, message)).toBe(true);
      expect(await executeFinalAction.validate!(runtime, message)).toBe(true);
    });

    it('should validate action dependencies', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Execute the recommendations' },
      };

      const state: State = { values: {}, data: {}, text: '' };

      // Process action should fail without previous analysis
      await expect(processAnalysisAction.handler(runtime, message, state, {})).rejects.toThrow(
        'No analysis data available'
      );
    });
  });

  describe('End-to-End Action Chain Scenarios', () => {
    it('should complete full chain for positive sentiment', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'This is a good product with excellent features' },
      };

      const state = await runtime.composeState(message);
      const callback = vi.fn();

      // Step 1: Analyze
      const result1 = await analyzeInputAction.handler(runtime, message, state, {});

      if (!result1 || typeof result1 === 'boolean') {
        throw new Error('Expected ActionResult, got boolean or null');
      }

      expect(result1.values?.success).toBeUndefined(); // No success property in ActionResult
      expect(result1.data?.sentiment).toBe('positive');
      expect(result1.values?.continueChain).toBeUndefined(); // No continueChain in ActionResult

      // Step 2: Process
      const result2 = await processAnalysisAction.handler(runtime, message, state, {
        previousResults: [result1],
      });

      if (!result2 || typeof result2 === 'boolean') {
        throw new Error('Expected ActionResult, got boolean or null');
      }

      expect(result2.data).toBeDefined();
      expect(result2.data?.decisions?.suggestedResponse).toContain('positive feedback');

      // Step 3: Execute
      const result3 = await executeFinalAction.handler(
        runtime,
        message,
        state,
        { previousResults: [result1, result2] },
        callback
      );

      if (!result3 || typeof result3 === 'boolean') {
        throw new Error('Expected ActionResult, got boolean or null');
      }

      expect(result3.data).toBeDefined();
      expect(callback).toHaveBeenCalledWith({
        text: 'Thank you for the positive feedback!',
        source: 'chain_example',
      });
    });

    it('should handle negative sentiment appropriately', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'This is bad and needs improvement' },
      };

      const state = await runtime.composeState(message);
      const callback = vi.fn();

      // Analyze
      const result1 = await analyzeInputAction.handler(runtime, message, state, {});
      if (!result1 || typeof result1 === 'boolean') {
        throw new Error('Expected ActionResult, got boolean or null');
      }
      expect(result1.data?.sentiment).toBe('negative');

      // Process
      const result2 = await processAnalysisAction.handler(runtime, message, state, {
        previousResults: [result1],
      });

      if (!result2 || typeof result2 === 'boolean') {
        throw new Error('Expected ActionResult, got boolean or null');
      }
      expect(result2.data?.decisions?.suggestedResponse).toContain('understand your concerns');

      // Execute
      await executeFinalAction.handler(
        runtime,
        message,
        state,
        { previousResults: [result1, result2] },
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        text: 'I understand your concerns and will help address them.',
        source: 'chain_example',
      });
    });

    it('should stop chain when more info needed', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Hi' }, // Too short
      };

      const state = await runtime.composeState(message);

      // Analyze
      const result1 = await analyzeInputAction.handler(runtime, message, state, {});
      if (!result1 || typeof result1 === 'boolean') {
        throw new Error('Expected ActionResult, got boolean or null');
      }
      expect(result1.data?.wordCount).toBeLessThan(5);

      // Process should indicate needs more info
      const result2 = await processAnalysisAction.handler(runtime, message, state, {
        previousResults: [result1],
      });

      if (!result2 || typeof result2 === 'boolean') {
        throw new Error('Expected ActionResult, got boolean or null');
      }
      expect(result2.data?.decisions?.needsMoreInfo).toBe(true);
    });
  });

  describe('Provider and Action Integration Scenarios', () => {
    it('should use classification to influence action selection', async () => {
      const strategicMessage: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'We need a comprehensive strategy for Q4 planning' },
      };

      const state = await runtime.composeState(strategicMessage);

      // Classification should be strategic
      expect(state.data.providers.messageClassifier.classification).toBe('strategic');

      // This should influence which actions are valid
      // In a real implementation, actions might check classification
      const classification = state.data.providers.messageClassifier.classification;
      expect(classification).toBe('strategic');
    });

    it('should handle provider data in action execution', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Analyze this with high priority processing' },
      };

      // Add a custom provider that adds priority
      const priorityProvider: Provider = {
        name: 'priorityDetector',
        get: async (runtime, message, state) => {
          const hasPriority = message.content.text?.includes('high priority');
          return {
            data: { priority: hasPriority ? 'high' : 'normal' },
            values: { isPriority: hasPriority },
          };
        },
      };

      runtime.registerProvider(priorityProvider);

      const state = await runtime.composeState(message, ['messageClassifier', 'priorityDetector']);

      expect(state.data.providers.priorityDetector.priority).toBe('high');
      expect(state.values.isPriority).toBe(true);

      // Actions can now use this provider data
      const result = await analyzeInputAction.handler(runtime, message, state, {});
      if (!result || typeof result === 'boolean') {
        throw new Error('Expected ActionResult, got boolean or null');
      }
      expect(result.data).toBeDefined();
    });
  });

  describe('Error and Edge Case Scenarios', () => {
    it('should handle missing content gracefully', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: {}, // No text
      };

      const state = await runtime.composeState(message);

      // Provider should handle missing text
      expect(state.data.providers.messageClassifier.classification).toBe('general');
      expect(state.data.providers.messageClassifier.originalText).toBeUndefined();

      // Action should handle missing text
      const result = await analyzeInputAction.handler(runtime, message, state, {});
      if (!result || typeof result === 'boolean') {
        throw new Error('Expected ActionResult, got boolean or null');
      }
      expect(result.data).toBeDefined();
      expect(result.data?.wordCount).toBe(0);
    });

    it('should handle provider errors', async () => {
      const errorProvider: Provider = {
        name: 'errorProvider',
        get: async () => {
          throw new Error('Provider failed');
        },
      };

      runtime.registerProvider(errorProvider);

      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Test message' },
      };

      // Runtime should handle provider errors gracefully
      await expect(runtime.composeState(message, ['errorProvider'])).rejects.toThrow(
        'Provider failed'
      );
    });

    it('should handle action abort signals', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Start a long analysis' },
      };

      const abortController = new AbortController();
      abortController.abort();

      await expect(
        analyzeInputAction.handler(runtime, message, {}, { abortSignal: abortController.signal })
      ).rejects.toThrow('Analysis aborted');
    });
  });

  describe('Complex Multi-Step Scenarios', () => {
    it('should handle research and analysis workflow', async () => {
      const researchMessage: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: {
          text: 'Research competitor analysis for our product strategy and process the findings',
        },
      };

      const state = await runtime.composeState(researchMessage);

      // Should classify as both analysis and strategic
      const classification = state.data.providers.messageClassifier.classification;
      expect(['analysis', 'strategic']).toContain(classification);

      // Execute analysis
      const analysisResult = await analyzeInputAction.handler(runtime, researchMessage, state, {});

      if (!analysisResult || typeof analysisResult === 'boolean') {
        throw new Error('Expected ActionResult, got boolean or null');
      }

      expect(analysisResult.data?.topics).toContain('strategy');
      expect(analysisResult.data?.wordCount).toBeGreaterThan(5);

      // Process with strategy context
      const processingResult = await processAnalysisAction.handler(
        runtime,
        researchMessage,
        state,
        { previousResults: [analysisResult] }
      );

      if (!processingResult || typeof processingResult === 'boolean') {
        throw new Error('Expected ActionResult, got boolean or null');
      }

      expect(processingResult.data?.decisions?.isComplex).toBe(false);
      expect(processingResult.data?.decisions?.requiresAction).toBe(true);
    });

    it('should handle conditional branching based on analysis', async () => {
      const scenarios = [
        {
          text: 'Quick update',
          expectedNeedsInfo: true,
          shouldContinue: false,
        },
        {
          text: 'Please analyze our quarterly sales data and identify key trends for the board presentation',
          expectedNeedsInfo: false,
          shouldContinue: true,
        },
      ];

      for (const scenario of scenarios) {
        const message: Memory = {
          id: uuidv4() as UUID,
          entityId: uuidv4() as UUID,
          roomId: uuidv4() as UUID,
          content: { text: scenario.text },
        };

        const state = await runtime.composeState(message);

        // Analyze
        const result1 = await analyzeInputAction.handler(runtime, message, state, {});
        if (!result1 || typeof result1 === 'boolean') {
          throw new Error('Expected ActionResult, got boolean or null');
        }

        // Process
        const result2 = await processAnalysisAction.handler(runtime, message, state, {
          previousResults: [result1],
        });

        if (!result2 || typeof result2 === 'boolean') {
          throw new Error('Expected ActionResult, got boolean or null');
        }

        expect(result2.data?.decisions?.needsMoreInfo).toBe(scenario.expectedNeedsInfo);
      }
    });
  });

  describe('Synthetic Action Scenarios', () => {
    it('should validate capability requirements', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Perform advanced analysis on the dataset' },
      };

      // State without required capability
      const stateWithoutCapability: State = { values: {}, data: {}, text: '' };
      expect(
        await capabilityRequiredAction.validate!(runtime, message, stateWithoutCapability)
      ).toBe(false);

      // State with required capability
      const stateWithCapability: State = {
        values: { capabilities: ['advanced_analysis'] },
        data: {},
        text: '',
      };
      expect(await capabilityRequiredAction.validate!(runtime, message, stateWithCapability)).toBe(
        true
      );
    });

    it('should select actions based on classification', async () => {
      const strategicMessage: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Develop a comprehensive strategy for market expansion' },
      };

      const state = await runtime.composeState(strategicMessage);

      // Classification-dependent action should be valid
      expect(await classificationDependentAction.validate!(runtime, strategicMessage, state)).toBe(
        true
      );

      // Execute the action
      const callback = vi.fn();
      const result = await classificationDependentAction.handler(
        runtime,
        strategicMessage,
        state,
        {},
        callback
      );

      expect(result.data.classification).toBe('strategic');
      expect(callback).toHaveBeenCalledWith({
        text: 'Executing strategic planning module...',
        actions: ['CLASSIFICATION_DEPENDENT'],
      });
    });

    it('should combine multiple providers in action execution', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'This is a high priority strategic analysis request' },
      };

      const state = await runtime.composeState(message, ['messageClassifier', 'priorityDetector']);

      // Multi-provider action should be valid
      expect(await multiProviderAction.validate!(runtime, message, state)).toBe(true);

      // Execute the action
      const result = await multiProviderAction.handler(runtime, message, state, {});

      if (!result || typeof result === 'boolean') {
        throw new Error('Expected ActionResult, got boolean or null');
      }
      expect(result.data?.strategy).toEqual({
        approach: 'long-term',
        urgency: 'immediate',
        resources: 'premium',
      });
    });

    it('should handle conditional failures appropriately', async () => {
      const failMessage: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'This will fail intentionally' },
      };

      const callback = vi.fn();
      const emptyState: State = { values: {}, data: {}, text: '' };
      const result = await conditionalFailureAction.handler(
        runtime,
        failMessage,
        emptyState,
        {},
        callback
      );

      if (!result || typeof result === 'boolean') {
        throw new Error('Expected ActionResult, got boolean or null');
      }
      expect(result.data?.failed).toBe(true);
      expect(result.data?.reason).toBe('Message contained failure trigger');
      expect(callback).toHaveBeenCalledWith({
        text: 'I encountered an error processing that request.',
        error: true,
      });
    });

    it('should modify state for subsequent actions', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Modify the state' },
      };

      const initialState: State = { values: { actionCount: 5 }, data: {}, text: '' };

      const result = await stateModifierAction.handler(runtime, message, initialState, {});

      if (!result || typeof result === 'boolean') {
        throw new Error('Expected ActionResult, got boolean or null');
      }
      expect(result.values?.actionCount).toBe(6);
      expect(result.values?.lastModified).toBeDefined();
      expect(result.values?.capabilities).toContain('advanced_analysis');
    });
  });

  describe('Provider Combination Scenarios', () => {
    it('should handle priority and sentiment together', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'This is urgent! I am very frustrated with the bad service!' },
      };

      const state = await runtime.composeState(message, [
        'priorityDetector',
        'sentimentAnalysis',
        'messageClassifier',
      ]);

      expect(state.data.providers.priorityDetector.priority).toBe('critical');
      expect(state.data.providers.sentimentAnalysis.sentiment).toBe('negative');
      expect(state.values.requiresEmpathy).toBe(true);
      expect(state.values.isPriority).toBe(true);
    });

    it('should detect task complexity accurately', async () => {
      const complexMessage: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: {
          text: 'First, analyze the API response data, then integrate it with our database, and after that deploy the updated algorithm to production if all tests pass',
        },
      };

      // Task complexity is private, must be explicitly included
      const state = await runtime.composeState(complexMessage, ['taskComplexity']);

      expect(state.data.providers.taskComplexity.complexity).toBe('complex');
      expect(state.data.providers.taskComplexity.factors.hasMultipleSteps).toBe(true);
      expect(state.data.providers.taskComplexity.factors.hasConditions).toBe(true);
      expect(state.data.providers.taskComplexity.factors.hasTechnicalTerms).toBe(true);
      expect(state.values.requiresPlanning).toBe(true);
    });

    it('should check resource availability for action execution', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'Execute resource-intensive operation' },
      };

      // Resource availability is dynamic, must be explicitly requested
      const state = await runtime.composeState(message, ['resourceAvailability']);

      expect(state.data.providers.resourceAvailability).toBeDefined();
      expect(state.data.providers.resourceAvailability.memory.available).toBe(true);
      expect(state.data.providers.resourceAvailability.apiQuota.remaining).toBeGreaterThan(0);
      expect(state.values.apiQuotaSufficient).toBe(true);
    });

    it('should handle capability detection and gap analysis', async () => {
      const message: Memory = {
        id: uuidv4() as UUID,
        entityId: uuidv4() as UUID,
        roomId: uuidv4() as UUID,
        content: { text: 'I need you to analyze data, create a strategy, and execute the plan' },
      };

      const stateWithSomeCapabilities: State = {
        values: { capabilities: ['analysis'] },
        data: {},
        text: '',
      };

      // Manually run capability detector on the state
      const capabilityResult = await capabilityDetectorProvider.get(
        runtime,
        message,
        stateWithSomeCapabilities
      );

      expect(capabilityResult.data?.requiredCapabilities).toContain('analysis');
      expect(capabilityResult.data?.requiredCapabilities).toContain('strategic_planning');
      expect(capabilityResult.data?.requiredCapabilities).toContain('execution');
      expect(capabilityResult.data?.missingCapabilities).toContain('strategic_planning');
      expect(capabilityResult.data?.missingCapabilities).toContain('execution');
      expect(capabilityResult.values?.hasAllCapabilities).toBe(false);
    });
  });
});
