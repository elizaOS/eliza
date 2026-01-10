/**
 * Minimal working planning plugin for testing
 */

// Define types inline to avoid import issues
interface Plugin {
  name: string;
  description: string;
  providers?: Provider[];
  actions?: Action[];
  services?: any[];
  evaluators?: any[];
}

interface Provider {
  name: string;
  description?: string;
  get: (runtime: any, message: any, state: any) => Promise<any>;
}

interface Action {
  name: string;
  similes?: string[];
  description: string;
  validate: (runtime: any, message: any, state?: any) => Promise<boolean>;
  handler: (runtime: any, message: any, state?: any, options?: any, callback?: any) => Promise<any>;
  examples?: any[];
}

// Message classifier provider
export const messageClassifierProvider: Provider = {
  name: 'MESSAGE_CLASSIFIER',
  description: 'Classifies messages for strategic planning',

  get: async (runtime, message, _state) => {
    const text = message.content?.text || '';

    let classification = 'SIMPLE';
    let complexity = 'low';

    // Multi-step planning indicators
    const multiStepIndicators = [
      'and',
      'then',
      'also',
      'make sure',
      'include',
      'ensure',
      'step',
      'process',
      'workflow',
      'sequence',
    ];

    // Strategic planning keywords
    const strategicKeywords = [
      'plan',
      'strategy',
      'coordinate',
      'organize',
      'manage',
      'schedule',
      'meeting',
      'project',
      'workflow',
      'process',
    ];

    // Research/analysis keywords
    const researchKeywords = [
      'research',
      'analyze',
      'investigate',
      'study',
      'examine',
      'review',
      'evaluate',
      'assess',
      'compare',
    ];

    // Complex task indicators
    const complexTaskIndicators = [
      'email',
      'document',
      'report',
      'presentation',
      'meeting',
      'send',
      'create',
      'generate',
      'compose',
      'draft',
    ];

    // Count indicators
    const hasMultiStep = multiStepIndicators.some((indicator) =>
      text.toLowerCase().includes(indicator)
    );
    const hasStrategic = strategicKeywords.some((keyword) => text.toLowerCase().includes(keyword));
    const hasResearch = researchKeywords.some((keyword) => text.toLowerCase().includes(keyword));
    const hasComplexTask = complexTaskIndicators.some((indicator) =>
      text.toLowerCase().includes(indicator)
    );

    // Classify based on patterns
    if (hasStrategic || (hasMultiStep && hasComplexTask)) {
      classification = 'STRATEGIC';
      complexity = 'high';
    } else if (hasResearch) {
      classification = 'RESEARCH_NEEDED';
      complexity = 'medium';
    } else if (hasComplexTask || text.length > 80) {
      classification = 'CAPABILITY_REQUEST';
      complexity = 'medium';
    }

    return {
      text: `[MESSAGE CLASSIFIER]\nClassification: ${classification}\nComplexity: ${complexity}\nRequires Planning: ${classification !== 'SIMPLE'}\n[/MESSAGE CLASSIFIER]`,
      values: {
        messageClassification: classification,
        complexity,
        requiresPlanning: classification !== 'SIMPLE',
        hasMultiStep,
        hasStrategic,
        hasComplexTask,
      },
    };
  },
};

// Planning action that creates multi-step plans
export const createPlanAction: Action = {
  name: 'CREATE_PLAN',
  similes: ['PLAN', 'STRATEGIZE', 'ORGANIZE'],
  description: 'Creates a strategic plan for complex tasks',

  validate: async (runtime, message) => {
    const text = message.content?.text || '';
    // Activate for complex requests or when explicitly asked to plan
    return (
      text.includes('plan') ||
      text.includes('strategy') ||
      text.includes('step') ||
      text.includes('organize') ||
      text.length > 100
    ); // Long requests might need planning
  },

  handler: async (runtime, message, state, options, callback) => {
    const userRequest = message.content?.text || '';

    // Simple plan generation logic
    const steps: string[] = [];

    if (userRequest.includes('email')) {
      steps.push('COMPOSE_EMAIL', 'SEND_EMAIL');
    }

    if (userRequest.includes('research') || userRequest.includes('search')) {
      steps.push('SEARCH_INFORMATION', 'ANALYZE_RESULTS');
    }

    if (userRequest.includes('report') || userRequest.includes('document')) {
      steps.push('GATHER_DATA', 'CREATE_DOCUMENT');
    }

    if (userRequest.includes('meeting') || userRequest.includes('schedule')) {
      steps.push('CHECK_CALENDAR', 'SCHEDULE_MEETING');
    }

    // Default steps if no specific actions identified
    if (steps.length === 0) {
      steps.push('ANALYZE_REQUEST', 'EXECUTE_ACTION', 'PROVIDE_RESPONSE');
    }

    const plan = {
      goal: `Complete user request: ${userRequest}`,
      steps: steps.map((step, index) => ({
        number: index + 1,
        action: step,
        description: `Execute ${step.toLowerCase().replace('_', ' ')}`,
      })),
      estimatedTime: `${steps.length * 2} minutes`,
      complexity: steps.length > 2 ? 'high' : 'medium',
    };

    if (callback) {
      await callback({
        text: `I've created a ${plan.complexity}-complexity plan with ${plan.steps.length} steps to complete your request.`,
        thought: `Generated strategic plan: ${plan.goal}`,
        actions: ['CREATE_PLAN'],
      });
    }

    return {
      values: {
        plan,
        planCreated: true,
        nextActions: steps,
      },
      data: {
        strategicPlan: plan,
        executionSteps: steps,
      },
      text: `Plan created with ${plan.steps.length} steps`,
    };
  },

  examples: [
    [
      {
        name: 'user',
        content: { text: 'I need to research market trends and create a comprehensive report' },
      },
      {
        name: 'agent',
        content: {
          text: "I'll create a strategic plan to research market trends and compile a comprehensive report.",
          thought:
            'This requires research, analysis, and document creation - perfect for multi-step planning.',
          actions: ['CREATE_PLAN'],
        },
      },
    ],
  ],
};

// Execute plan action that follows through on created plans
export const executePlanAction: Action = {
  name: 'EXECUTE_PLAN',
  similes: ['IMPLEMENT', 'FOLLOW_THROUGH', 'CARRY_OUT'],
  description: 'Executes a previously created plan step by step',

  validate: async (runtime, message, state) => {
    // Only valid if there's a plan in the state
    return state?.values?.planCreated || state?.data?.strategicPlan;
  },

  handler: async (runtime, message, state, options, callback) => {
    const plan = state?.data?.strategicPlan || state?.values?.plan;

    if (!plan) {
      if (callback) {
        await callback({
          text: 'No plan found to execute. Please create a plan first.',
          thought: 'User requested plan execution but no plan exists in state',
        });
      }
      return { values: { error: 'No plan to execute' } };
    }

    // Simulate step-by-step execution with realistic outputs
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      let stepOutput = '';

      // Generate realistic step outputs based on action type
      switch (step.action) {
        case 'COMPOSE_EMAIL':
          stepOutput = 'Email composed with meeting details and agenda';
          break;
        case 'SEND_EMAIL':
          stepOutput = 'Email sent successfully to recipient';
          break;
        case 'CHECK_CALENDAR':
          stepOutput = 'Calendar checked for availability';
          break;
        case 'SCHEDULE_MEETING':
          stepOutput = 'Meeting scheduled for tomorrow at 2 PM';
          break;
        case 'SEARCH_INFORMATION':
          stepOutput = 'Information search completed';
          break;
        case 'ANALYZE_RESULTS':
          stepOutput = 'Analysis completed successfully';
          break;
        case 'GATHER_DATA':
          stepOutput = 'Data gathering completed';
          break;
        case 'CREATE_DOCUMENT':
          stepOutput = 'Document created successfully';
          break;
        default:
          stepOutput = `${step.action.toLowerCase().replace('_', ' ')} completed`;
      }

      if (callback) {
        await callback({
          text: stepOutput,
          thought: `Working on plan step: ${step.action}`,
          actions: [step.action],
        });
      }

      // Simulate some processing time
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (callback) {
      await callback({
        text: 'Plan execution completed! All steps have been carried out successfully.',
        thought: 'Successfully executed the strategic plan',
        actions: ['EXECUTE_PLAN'],
      });
    }

    return {
      values: {
        planExecuted: true,
        executionComplete: true,
        success: true,
      },
      data: {
        executionResult: 'success',
        completedSteps: plan.steps.length,
      },
      text: 'Plan execution completed successfully',
    };
  },

  examples: [],
};

// Reply action for simple responses
export const planningReplyAction: Action = {
  name: 'PLANNING_REPLY',
  similes: ['RESPOND', 'ANSWER'],
  description: 'Provides thoughtful responses with planning consideration',

  validate: async (_runtime, _message) => {
    return true; // Always available as fallback
  },

  handler: async (runtime, message, state, options, callback) => {
    const _userRequest = message.content?.text || '';
    const classification = state?.values?.messageClassification || 'SIMPLE';

    let response = '';

    if (classification === 'STRATEGIC') {
      response =
        'I understand this requires a strategic approach. Let me think through this systematically and create a plan.';
    } else if (classification === 'RESEARCH_NEEDED') {
      response =
        "This request requires research and analysis. I'll need to gather information and provide you with comprehensive findings.";
    } else if (classification === 'CAPABILITY_REQUEST') {
      response =
        "I see you're looking to integrate or add new capabilities. Let me help you with that implementation.";
    } else {
      response = "I'll help you with that request. Let me work on this for you.";
    }

    if (callback) {
      await callback({
        text: response,
        thought: `Responding to ${classification} request with appropriate planning consideration`,
        actions: ['PLANNING_REPLY'],
      });
    }

    return {
      values: { responseGiven: true },
      data: { responseType: classification },
      text: response,
    };
  },

  examples: [],
};

// Main plugin definition
export const planningPlugin: Plugin = {
  name: '@elizaos/plugin-planning',
  description:
    'Strategic planning and execution plugin for ElizaOS with step-by-step plan creation and execution',

  providers: [messageClassifierProvider],

  actions: [createPlanAction, executePlanAction, planningReplyAction],

  services: [], // No services for now to avoid import issues

  evaluators: [],
};

// Export for testing
export default planningPlugin;
