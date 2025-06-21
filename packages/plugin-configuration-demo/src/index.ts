import type { 
  Plugin, 
  Action, 
  Provider, 
  Evaluator,
  ComponentDefinition,
  EnhancedComponentConfig,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback
} from '@elizaos/core';

// Example configurable action - enabled by default
const configurableGreetingAction: Action = {
  name: 'CONFIGURABLE_GREETING',
  similes: ['GREET', 'HELLO'],
  description: 'A configurable greeting action that can be enabled/disabled',
  
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    return message.content.text?.toLowerCase().includes('hello') ?? false;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state: State, options, callback: HandlerCallback) => {
    const greeting = `Hello! This is a configurable greeting action from ${runtime.character.name}`;
    
    await callback({
      text: greeting,
      thought: 'Executed configurable greeting action',
      actions: ['CONFIGURABLE_GREETING']
    });

    return {
      text: greeting,
      values: { greetingExecuted: true }
    };
  },

  examples: [[
    { name: 'User', content: { text: 'Hello there!' } },
    { name: 'Agent', content: { text: 'Hello! This is a configurable greeting action from Agent', actions: ['CONFIGURABLE_GREETING'] } }
  ]]
};

// Example configurable action - disabled by default (risky operation)
const riskyOperationAction: Action = {
  name: 'RISKY_OPERATION',
  similes: ['DANGER', 'RISK'],
  description: 'A risky operation that is disabled by default for security',
  
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    return message.content.text?.toLowerCase().includes('risky') ?? false;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state: State, options, callback: HandlerCallback) => {
    const warning = '⚠️ This is a risky operation that should only be enabled when needed!';
    
    await callback({
      text: warning,
      thought: 'Executed risky operation - this should be configurable',
      actions: ['RISKY_OPERATION']
    });

    return {
      text: warning,
      values: { riskyOperationExecuted: true }
    };
  },

  examples: [[
    { name: 'User', content: { text: 'Do something risky' } },
    { name: 'Agent', content: { text: '⚠️ This is a risky operation that should only be enabled when needed!', actions: ['RISKY_OPERATION'] } }
  ]]
};

// Example configurable provider - enabled by default
const timeProvider: Provider = {
  name: 'CONFIGURABLE_TIME',
  description: 'Provides current time - can be disabled to save resources',
  
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const now = new Date();
    return {
      text: `[CONFIGURABLE TIME]\nCurrent time: ${now.toISOString()}\n[/CONFIGURABLE TIME]`,
      values: {
        currentTime: now.toISOString(),
        timestamp: now.getTime()
      }
    };
  }
};

// Example configurable provider - disabled by default (expensive operation)
const expensiveDataProvider: Provider = {
  name: 'EXPENSIVE_DATA',
  description: 'Expensive data provider that makes external API calls',
  
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Simulate expensive operation
    await new Promise(resolve => setTimeout(resolve, 100));
    
    return {
      text: `[EXPENSIVE DATA]\nThis data comes from an expensive API call\n[/EXPENSIVE DATA]`,
      values: {
        expensiveData: { cost: 'high', value: 'important_data' }
      }
    };
  }
};

// Example configurable evaluator - enabled by default
const configurableEvaluator: Evaluator = {
  name: 'CONFIGURABLE_EVALUATOR',
  description: 'Evaluates conversation quality - can be disabled',
  
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    return true; // Always run when enabled
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Store evaluation result
    await runtime.createMemory({
      entityId: runtime.agentId,
      roomId: message.roomId,
      content: {
        text: 'Conversation evaluated by configurable evaluator',
        type: 'evaluation',
        metadata: { quality: 'good', evaluator: 'CONFIGURABLE_EVALUATOR' }
      }
    }, 'evaluations');
  },

  examples: [
    {
      prompt: 'Evaluate this conversation',
      messages: [
        { name: 'User', content: { text: 'Hello' } },
        { name: 'Agent', content: { text: 'Hi there!' } }
      ],
      outcome: 'Conversation quality evaluated and stored'
    }
  ]
};

// Define enhanced configurations for each component
const greetingConfig: EnhancedComponentConfig = {
  enabled: true,        // ComponentConfig property
  defaultEnabled: true, // EnhancedComponentConfig property
  category: 'communication',
  permissions: ['basic_interaction'],
  experimental: false
};

const riskyConfig: EnhancedComponentConfig = {
  enabled: false,       // ComponentConfig property - disabled by default for security
  defaultEnabled: false, // EnhancedComponentConfig property
  category: 'advanced',
  permissions: ['admin_operations'],
  experimental: true,
  disabledReason: 'Risky operation - enable only when needed'
};

const timeProviderConfig: EnhancedComponentConfig = {
  enabled: true,        // ComponentConfig property
  defaultEnabled: true, // EnhancedComponentConfig property
  category: 'utilities',
  permissions: ['basic_info']
};

const expensiveProviderConfig: EnhancedComponentConfig = {
  enabled: false,       // ComponentConfig property - disabled by default due to cost
  defaultEnabled: false, // EnhancedComponentConfig property
  category: 'external_apis',
  permissions: ['external_access'],
  disabledReason: 'Expensive operation - enable only when needed'
};

const evaluatorConfig: EnhancedComponentConfig = {
  enabled: true,        // ComponentConfig property
  defaultEnabled: true, // EnhancedComponentConfig property
  category: 'analysis',
  permissions: ['memory_access']
};

// Define component definitions using the new unified system
const componentDefinitions: ComponentDefinition[] = [
  {
    type: 'action',
    component: configurableGreetingAction,
    config: greetingConfig
  },
  {
    type: 'action', 
    component: riskyOperationAction,
    config: riskyConfig
  },
  {
    type: 'provider',
    component: timeProvider,
    config: timeProviderConfig
  },
  {
    type: 'provider',
    component: expensiveDataProvider,
    config: expensiveProviderConfig
  },
  {
    type: 'evaluator',
    component: configurableEvaluator,
    config: evaluatorConfig
  }
];

// Legacy components (always enabled for backwards compatibility)
const legacyGreetingAction: Action = {
  name: 'LEGACY_GREETING',
  description: 'Legacy greeting action - always enabled',
  
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    return message.content.text?.toLowerCase().includes('legacy') ?? false;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state: State, options, callback: HandlerCallback) => {
    await callback({
      text: 'This is a legacy greeting action - always enabled!',
      actions: ['LEGACY_GREETING']
    });
  },

  examples: [[
    { name: 'User', content: { text: 'legacy hello' } },
    { name: 'Agent', content: { text: 'This is a legacy greeting action - always enabled!', actions: ['LEGACY_GREETING'] } }
  ]]
};

// Main plugin definition
export const configurationDemoPlugin: Plugin = {
  name: '@elizaos/plugin-configuration-demo',
  description: 'Demonstrates the dynamic plugin configuration system with both legacy and configurable components',
  
  // Plugin-level configuration
  config: {
    defaultEnabled: true,
    category: 'demo',
    permissions: ['basic_operations'],
    metadata: {
      version: '1.0.0',
      purpose: 'demonstration',
      features: ['configurable_actions', 'configurable_providers', 'configurable_evaluators']
    }
  },

  // New unified configurable components system
  components: componentDefinitions,

  // Legacy components (always enabled for backwards compatibility)
  actions: [legacyGreetingAction],

  async init(config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    console.log('Configuration Demo Plugin initialized');
    console.log(`Plugin has ${componentDefinitions.length} configurable components`);
    console.log('Components can be enabled/disabled via the GUI or API');
    
    // Log component configuration status
    const configManager = runtime.getConfigurationManager();
    for (const compDef of componentDefinitions) {
      const componentName = compDef.component.name;
      const isEnabled = configManager.isComponentEnabled(
        '@elizaos/plugin-configuration-demo',
        componentName,
        compDef.type
      );
      console.log(`Component ${componentName} (${compDef.type}): ${isEnabled ? 'ENABLED' : 'DISABLED'}`);
    }
  }
};

export default configurationDemoPlugin;