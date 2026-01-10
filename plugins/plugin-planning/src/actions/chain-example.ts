import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  ActionResult,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

// Example action 1: Analyze input
export const analyzeInputAction: Action = {
  name: 'ANALYZE_INPUT',
  description: 'Analyzes user input and extracts key information',

  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    // This action can always run
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    console.log('[ChainExample] Analyzing input...');

    // Check for abort
    if (options?.abortSignal?.aborted) {
      throw new Error('Analysis aborted');
    }

    // Extract information from the message
    const text = message.content.text || '';
    const words = text.trim() ? text.split(/\s+/) : [];
    const hasNumbers = /\d/.test(text);
    const lowerText = text.toLowerCase();
    const sentiment =
      lowerText.includes('urgent') ||
      lowerText.includes('emergency') ||
      lowerText.includes('critical')
        ? 'urgent'
        : lowerText.includes('good')
          ? 'positive'
          : lowerText.includes('bad')
            ? 'negative'
            : 'neutral';

    const analysis = {
      wordCount: words.length,
      hasNumbers,
      sentiment,
      topics: words.filter((w) => w.length >= 5).map((w) => w.toLowerCase()),
      timestamp: Date.now(),
    };

    console.log('[ChainExample] Analysis complete:', analysis);

    return {
      data: analysis,
      text: `Analyzed ${words.length} words with ${sentiment} sentiment`,
    };
  },
};

// Example action 2: Process based on analysis
export const processAnalysisAction: Action = {
  name: 'PROCESS_ANALYSIS',
  description: 'Processes the analysis results and makes decisions',

  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    console.log('[ChainExample] Processing analysis...');

    // Get previous analysis result
    const previousResult = options?.previousResults?.[0];
    if (!previousResult?.data) {
      throw new Error('No analysis data available');
    }

    const analysis = previousResult.data;

    // Make decisions based on analysis
    const decisions = {
      needsMoreInfo: analysis.wordCount < 5,
      isComplex: analysis.wordCount > 20,
      requiresAction: analysis.sentiment !== 'neutral' || analysis.wordCount > 8,
      suggestedResponse:
        analysis.sentiment === 'positive'
          ? 'Thank you for the positive feedback!'
          : analysis.sentiment === 'negative'
            ? 'I understand your concerns and will help address them.'
            : 'I can help you with that.',
    };

    // Simulate some processing time
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Check abort signal
    if (options?.abortSignal?.aborted) {
      throw new Error('Processing aborted');
    }

    console.log('[ChainExample] Processing complete:', decisions);

    return {
      data: {
        analysis,
        decisions,
        processedAt: Date.now(),
      },
      text: decisions.suggestedResponse,
      continueChain: !decisions.needsMoreInfo,
    } as any; // Extended ActionResult with continueChain
  },
};

// Example action 3: Execute final action
export const executeFinalAction: Action = {
  name: 'EXECUTE_FINAL',
  description: 'Executes the final action based on processing results',

  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    console.log('[ChainExample] Executing final action...');

    // Get all previous results
    const _analysisResult = options?.previousResults?.find(
      (r: any) => r.data?.wordCount !== undefined
    );
    const processingResult = options?.previousResults?.find(
      (r: any) => r.data?.decisions !== undefined
    );

    if (!processingResult?.data?.decisions) {
      throw new Error('No processing results available');
    }

    const decisions = processingResult.data.decisions;

    // Execute based on decisions
    const execution = {
      action: decisions.requiresAction ? 'RESPOND' : 'ACKNOWLEDGE',
      message: decisions.suggestedResponse,
      metadata: {
        chainId: options?.chainContext?.chainId,
        totalSteps: options?.chainContext?.totalActions,
        completedAt: Date.now(),
      },
    };

    // Simulate execution
    await new Promise((resolve) => setTimeout(resolve, 100));

    console.log('[ChainExample] Execution complete:', execution);

    // Call the callback to send response
    if (_callback) {
      await _callback({
        text: execution.message,
        source: 'chain_example',
      });
    }

    return {
      data: execution,
      text: execution.message,
      cleanup: async () => {
        console.log('[ChainExample] Cleaning up resources...');
        // Clean up any resources here
      },
    } as any; // Extended ActionResult with cleanup
  },
};

// The rest of the actions would follow the same pattern...

export const chainExampleAction: Action = {
  name: 'CHAIN_EXAMPLE',
  description: 'Example action demonstrating action chaining with state passing',

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    // Validate when this chain should be triggered
    const text = message.content.text?.toLowerCase() || '';
    return text.includes('chain example') || text.includes('demonstrate chaining');
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: any,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      // This demonstrates how actions can be chained programmatically
      // In practice, the LLM would generate the action chain based on the goal

      const actionPlan = {
        id: uuidv4(),
        goal: 'Demonstrate action chaining capabilities',
        steps: [
          {
            id: 'step_1',
            actionName: 'REPLY',
            parameters: {
              message: 'Starting action chain demonstration...',
            },
          },
          {
            id: 'step_2',
            actionName: 'ANALYZE_CONTEXT',
            parameters: {
              context: message.content.text,
            },
            dependencies: ['step_1'],
          },
          {
            id: 'step_3',
            actionName: 'GENERATE_STRATEGY',
            parameters: {
              analysisResults: '{{step_2.data.analysis}}',
            },
            dependencies: ['step_2'],
          },
          {
            id: 'step_4',
            actionName: 'EXECUTE_STRATEGY',
            parameters: {
              strategy: '{{step_3.data.strategy}}',
            },
            dependencies: ['step_3'],
          },
        ],
        executionModel: 'sequential' as const,
      };

      // Demonstrate state accumulation
      const initialState = {
        chainStartTime: Date.now(),
        originalMessage: message.content.text,
        steps: [],
      };

      // In a real implementation, this would be handled by the ActionExecutorService
      // For now, we'll just return the plan and initial state
      if (callback) {
        await callback({
          text: `I've prepared a ${actionPlan.steps.length}-step action chain to demonstrate our capabilities. The chain will: analyze context, generate a strategy, and execute it.`,
          actions: ['CHAIN_EXAMPLE'],
          actionPlan,
        });
      }

      return {
        data: {
          actionName: 'CHAIN_EXAMPLE',
          plan: actionPlan,
          stepsToExecute: actionPlan.steps.length,
          chainExampleState: initialState,
          planId: actionPlan.id,
        },
        text: `Created ${actionPlan.steps.length}-step action chain`,
      };
    } catch (error) {
      return {
        text: `Failed to create action chain: ${(error as Error).message}`,
        data: { actionName: 'CHAIN_EXAMPLE', failed: true },
      };
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: {
          text: 'Can you demonstrate action chaining?',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've prepared a 4-step action chain to demonstrate our capabilities.",
          actions: ['CHAIN_EXAMPLE'],
        },
      },
    ],
  ],
};

// Example of a sub-action that would be part of the chain
export const analyzeContextAction: Action = {
  name: 'ANALYZE_CONTEXT',
  description: 'Analyzes the context from previous steps',

  validate: async (_runtime: IAgentRuntime, _message: Memory, state?: State) => {
    // This action is only valid if it's part of a chain
    return state?.data?.planId !== undefined;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      // Access previous action results from state
      const _previousResults = state?.actionResults || [];
      const _context = options?.context?.previousResults || [];

      // Simulate analysis
      const analysis = {
        sentiment: 'positive',
        intent: 'demonstration_request',
        complexity: 'medium',
        suggestedApproach: 'step_by_step_explanation',
      };

      if (callback) {
        await callback({
          text: 'Context analyzed. Proceeding to strategy generation...',
          actions: ['ANALYZE_CONTEXT'],
        });
      }

      return {
        data: {
          actionName: 'ANALYZE_CONTEXT',
          analysis,
          contextLength: message.content.text?.length || 0,
          analysisComplete: true,
          analysisResults: analysis,
        },
        text: 'Context analysis completed',
      };
    } catch (error) {
      return {
        text: `Failed to analyze context: ${(error as Error).message}`,
        data: { actionName: 'ANALYZE_CONTEXT', failed: true },
      };
    }
  },
};

// Example showing how state flows between actions
export const generateStrategyAction: Action = {
  name: 'GENERATE_STRATEGY',
  description: 'Generates a strategy based on analysis',

  validate: async (_runtime: IAgentRuntime, _message: Memory, state?: State) => {
    // Only valid if analysis has been completed
    return state?.analysisComplete === true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      // Access analysis results from previous action's state
      const analysisResults = state?.analysisResults;

      if (!analysisResults) {
        throw new Error('No analysis results found in state');
      }

      // Generate strategy based on analysis
      const strategy = {
        approach: analysisResults.suggestedApproach,
        steps: [
          'Acknowledge request',
          'Explain concept',
          'Provide example',
          'Confirm understanding',
        ],
        estimatedDuration: '2-3 minutes',
        resources: ['documentation', 'examples'],
      };

      if (callback) {
        await callback({
          text: `Strategy generated based on ${analysisResults.intent} intent. Ready to execute.`,
          actions: ['GENERATE_STRATEGY'],
        });
      }

      return {
        data: {
          actionName: 'GENERATE_STRATEGY',
          strategy,
          basedOn: analysisResults,
          strategyGenerated: true,
          readyToExecute: true,
        },
        text: 'Strategy generated successfully',
      };
    } catch (error) {
      return {
        text: `Failed to generate strategy: ${(error as Error).message}`,
        data: { actionName: 'GENERATE_STRATEGY', failed: true },
      };
    }
  },
};

// CREATE_PLAN action for comprehensive project planning
export const createPlanAction: Action = {
  name: 'CREATE_PLAN',
  description: 'Creates a comprehensive project plan with multiple phases and tasks',
  similes: ['PLAN_PROJECT', 'GENERATE_PLAN', 'MAKE_PLAN', 'PROJECT_PLAN'],

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    // Validate when user requests planning or project creation
    const text = message.content.text?.toLowerCase() || '';
    return (
      text.includes('plan') ||
      text.includes('project') ||
      text.includes('comprehensive') ||
      text.includes('organize') ||
      text.includes('strategy')
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      console.log('[CREATE_PLAN] Starting comprehensive plan creation...');

      // Extract project requirements from the message
      const _text = message.content.text || '';

      // Create a comprehensive plan structure
      const plan = {
        id: uuidv4(),
        name: 'Comprehensive Project Plan',
        description: 'Multi-phase project plan with coordinated execution',
        createdAt: Date.now(),
        phases: [
          {
            id: 'phase_1',
            name: 'Setup and Infrastructure',
            description: 'Initial project setup and infrastructure creation',
            tasks: [
              {
                id: 'task_1_1',
                name: 'Repository Setup',
                description: 'Create GitHub repository with proper documentation',
                action: 'CREATE_GITHUB_REPO',
                dependencies: [],
                estimatedDuration: '30 minutes',
              },
            ],
          },
          {
            id: 'phase_2',
            name: 'Research and Knowledge',
            description: 'Conduct research and build knowledge base',
            tasks: [
              {
                id: 'task_2_1',
                name: 'Research Best Practices',
                description: 'Research best practices for the project domain',
                action: 'start_research',
                dependencies: ['task_1_1'],
                estimatedDuration: '2 hours',
              },
              {
                id: 'task_2_2',
                name: 'Process Knowledge',
                description: 'Store research findings in knowledge base',
                action: 'PROCESS_KNOWLEDGE',
                dependencies: ['task_2_1'],
                estimatedDuration: '45 minutes',
              },
            ],
          },
          {
            id: 'phase_3',
            name: 'Task Management',
            description: 'Create and organize project tasks',
            tasks: [
              {
                id: 'task_3_1',
                name: 'Create Initial Tasks',
                description: 'Create todo tasks based on plan milestones',
                action: 'CREATE_TODO',
                dependencies: ['task_2_2'],
                estimatedDuration: '30 minutes',
              },
            ],
          },
        ],
        executionStrategy: 'sequential',
        totalEstimatedDuration: '4 hours',
        successCriteria: [
          'All phases completed successfully',
          'Repository created with documentation',
          'Research conducted and stored',
          'Tasks created and organized',
        ],
      };

      // Store plan in working memory
      const planState = {
        planId: plan.id,
        currentPhase: 0,
        completedTasks: [],
        plan,
      };

      if (callback) {
        await callback({
          text: `I've created a comprehensive ${plan.phases.length}-phase project plan:

**Phase 1: Setup and Infrastructure**
- Repository setup with GitHub integration

**Phase 2: Research and Knowledge**  
- Research best practices
- Process and store findings

**Phase 3: Task Management**
- Create structured todo tasks

The plan includes ${plan.phases.reduce((total, phase) => total + phase.tasks.length, 0)} tasks with an estimated duration of ${plan.totalEstimatedDuration}. Each phase builds on the previous one to ensure proper coordination.

Ready to begin execution when you are!`,
          actions: ['CREATE_PLAN'],
          source: 'planning',
        });
      }

      console.log('[CREATE_PLAN] Plan created successfully:', plan.name);

      return {
        data: {
          actionName: 'CREATE_PLAN',
          phaseCount: plan.phases.length,
          taskCount: plan.phases.reduce((total, phase) => total + phase.tasks.length, 0),
          ...planState,
        },
        text: `Created ${plan.phases.length}-phase plan with ${plan.phases.reduce((total, phase) => total + phase.tasks.length, 0)} tasks`,
      };
    } catch (error) {
      console.error('[CREATE_PLAN] Error creating plan:', error);

      if (callback) {
        await callback({
          text: 'I encountered an error while creating the comprehensive plan. Let me try a simpler approach.',
          actions: ['CREATE_PLAN'],
          source: 'planning',
        });
      }

      return {
        text: `Failed to create plan: ${(error as Error).message}`,
        data: { actionName: 'CREATE_PLAN', failed: true },
      };
    }
  },
  examples: [
    [
      {
        name: '{{user}}',
        content: {
          text: 'I need to launch a new open-source project. Please create a comprehensive plan.',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've created a comprehensive 3-phase project plan for your open-source launch.",
          actions: ['CREATE_PLAN'],
        },
      },
    ],
  ],
};
