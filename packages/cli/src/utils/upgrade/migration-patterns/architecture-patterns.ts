/**
 * ARCHITECTURE PATTERNS MODULE
 *
 * Responsibilities:
 * - Critical architecture issues and solutions
 * - Service layer patterns and best practices
 * - Handler signature transformations
 * - Memory and provider patterns
 * - Configuration validation patterns
 * - Provider-specific migration patterns
 */

import type { ArchitectureIssue } from '../types.js';

/**
 * Critical architecture issues from the mega prompt and plugin-news analysis
 */
export const ARCHITECTURE_ISSUES: ArchitectureIssue[] = [
  // CRITICAL: State Structure Transformation Patterns (MISSING FROM ORIGINAL)
  {
    type: 'state-structure-access',
    severity: 'critical',
    pattern: 'Direct state property access instead of state.values/state.data structure',
    solution:
      'Replace direct property access with state.values for simple values and state.data for complex objects',
    codeExample: {
      wrong: `// V1 Direct state access
const tokenA = state.tokenA;
const amount = state.amount;
const slippage = state.slippage;
const fromChain = state.fromChain;
const proposalId = state.proposalId;
const tokenId = state.tokenId;
const walletAddress = state.walletAddress;
const balances = state.balances;
const validator = state.validator;`,
      correct: `// V2 Structured state access
const tokenA = state.values.tokenA;
const amount = state.values.amount;
const slippage = state.data.slippage;
const fromChain = state.values.fromChain;
const proposalId = state.values.proposalId;
const tokenId = state.values.tokenId;
const walletAddress = state.values.walletAddress;
const balances = state.data.balances;
const validator = state.data.validator;`,
    },
  },

  {
    type: 'state-persistence-pattern',
    severity: 'critical',
    pattern: 'Old state persistence without structured access',
    solution: 'Update state persistence to use values/data structure',
    codeExample: {
      wrong: `// V1 State persistence
state.swapResult = result;
state.transactionHash = hash;
state.lastUpdate = Date.now();`,
      correct: `// V2 Structured state persistence
state.values.transactionHash = hash;
state.values.lastUpdate = Date.now().toString();
state.data.swapResult = result;
state.data.transactionDetails = details;`,
    },
  },

  // CRITICAL: ActionExample Format Changes (MISSING FROM ORIGINAL)
  {
    type: 'action-example-user-field',
    severity: 'critical',
    pattern: 'ActionExample using "user" instead of "name" field',
    solution: 'Replace "user" field with "name" field in ActionExample',
    codeExample: {
      wrong: `examples: [
  [
    {
      user: "user",
      content: { text: "example" }
    }
  ]
]`,
      correct: `examples: [
  [
    {
      name: "user",
      content: { text: "example" }
    }
  ]
]`,
    },
  },

  {
    type: 'action-example-content-structure',
    severity: 'critical',
    pattern: 'ActionExample missing content wrapper or proper structure',
    solution: 'Ensure ActionExample has proper content wrapper with text field',
    codeExample: {
      wrong: `examples: [
  [
    {
      name: "user",
      text: "example message"
    }
  ]
]`,
      correct: `examples: [
  [
    {
      name: "user",
      content: { 
        text: "example message",
        action: "ACTION_NAME"
      }
    }
  ]
]`,
    },
  },

  // CRITICAL: Content Interface Changes (MISSING FROM ORIGINAL)
  {
    type: 'content-text-optional',
    severity: 'critical',
    pattern: 'Content interface assuming text field is required',
    solution: 'Make text field optional in Content interface usage',
    codeExample: {
      wrong: `const content: Content = {
  text: responseText,
  action: "ACTION_NAME",
  source: "plugin-name"
};`,
      correct: `const content: Content = {
  text: responseText, // Optional field
  actions: ["ACTION_NAME"], // Array instead of single action
  source: "plugin-name"
};`,
    },
  },

  {
    type: 'content-action-to-actions',
    severity: 'critical',
    pattern: 'Content interface using "action" instead of "actions" array',
    solution: 'Replace "action" field with "actions" array in Content interface',
    codeExample: {
      wrong: `callback({
  text: "Response text",
  action: "MY_ACTION",
  source: "plugin"
});`,
      correct: `callback({
  text: "Response text",
  actions: ["MY_ACTION"],
  source: "plugin"
});`,
    },
  },

  // CRITICAL: Handler Signature Specifics (ENHANCED FROM ORIGINAL)
  {
    type: 'handler-responses-parameter',
    severity: 'critical',
    pattern: 'Handler missing responses: Memory[] parameter',
    solution: 'Add responses: Memory[] parameter to handler signature',
    codeExample: {
      wrong: `handler: async (
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
  _options: { [key: string]: unknown },
  callback: HandlerCallback
) => {`,
      correct: `handler: async (
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
  _options: { [key: string]: unknown },
  callback: HandlerCallback,
  responses: Memory[]
) => {`,
    },
  },

  {
    type: 'handler-state-undefined-removal',
    severity: 'critical',
    pattern: 'Handler with state: State | undefined parameter',
    solution: 'Remove undefined from state parameter - state is always provided in V2',
    codeExample: {
      wrong: `handler: async (
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  _options: { [key: string]: unknown },
  callback: HandlerCallback
) => {`,
      correct: `handler: async (
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
  _options: { [key: string]: unknown },
  callback: HandlerCallback
) => {`,
    },
  },

  // CRITICAL: generateObject to runtime.useModel Pattern (ENHANCED)
  {
    type: 'generate-object-replacement',
    severity: 'critical',
    pattern: 'Using generateObject or generateObjectDeprecated instead of runtime.useModel',
    solution: 'Replace generateObject with runtime.useModel(ModelType.OBJECT_GENERATION, params)',
    codeExample: {
      wrong: `const result = await generateObject({
  runtime,
  context: prompt,
  modelClass: ModelClass.LARGE,
  schema: MySchema
});

// or
const result = await generateObjectDeprecated({
  runtime,
  context: prompt,
  modelClass: ModelClass.LARGE
});`,
      correct: `const result = await runtime.useModel(ModelType.OBJECT_GENERATION, {
  prompt: prompt,
  schema: MySchema,
  temperature: 0.1
});

// For non-object generation:
const textResult = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: prompt,
  temperature: 0.7
});`,
    },
  },

  // CRITICAL: Runtime State Composition Updates (ENHANCED)
  {
    type: 'runtime-compose-state',
    severity: 'critical',
    pattern: 'Using old runtime.composeState pattern',
    solution: 'Update runtime.composeState to use proper context array',
    codeExample: {
      wrong: `if (!state) {
  state = (await runtime.composeState(message)) as State;
} else {
  state = await runtime.updateRecentMessageState(state);
}`,
      correct: `if (!state) {
  state = await runtime.composeState(message, ['RECENT_MESSAGES']);
}
// No need for updateRecentMessageState in V2`,
    },
  },

  {
    type: 'missing-service',
    severity: 'critical',
    pattern: 'Service Layer Required (ONLY if plugin had service in V1)',
    solution:
      'CRITICAL: Only create service if the plugin had a service in V1. Most plugins do NOT need services. Check main branch first.',
    codeExample: {
      wrong: `// ❌ WRONG: Adding service to plugin that didn't have one in V1
export const myPlugin: Plugin = {
    name: "plugin-name",
    actions: actions,
    services: [NewService], // ❌ Don't add if not in V1
};`,
      correct: `// ✅ CORRECT: Two valid patterns depending on V1 plugin

// Pattern 1: Plugin WITHOUT service (most common)
const myPlugin: Plugin = {
    name: 'my-plugin',
    description: 'Plugin description',
    services: [], // ✅ Empty array for plugins without services
    actions: [...],
    providers: [...],
    tests: [...],
    // No init function needed
};

// Pattern 2: Plugin WITH service (only if existed in V1)
export class MyService extends Service {
    static serviceType = 'my-service'; // ✅ No explicit type annotation
    
    constructor(runtime: IAgentRuntime) {
        super(runtime);
    }
    
    static async start(runtime: IAgentRuntime) {
        const service = new MyService(runtime);
        return service;
    }
    
    async stop(): Promise<void> {
        // Cleanup resources
    }
    
    get capabilityDescription(): string {
        return 'Service capability description';
    }
}

const myPlugin: Plugin = {
    name: 'my-plugin',
    description: 'Plugin description',
    services: [MyService], // ✅ Only if service existed in V1
    actions: [...],
    providers: [...],
    tests: [...],
    init: async (config, runtime) => {
        // Initialization logic
    }
};`,
    },
  },

  // PROVIDER-SPECIFIC PATTERNS FROM MIGRATION GUIDE
  {
    type: 'provider-external-dependency',
    severity: 'critical',
    pattern: 'Provider importing external plugin dependencies',
    solution: 'Remove external plugin imports, use service integration pattern instead',
    codeExample: {
      wrong: `import { DeriveKeyProvider, TEEMode } from "@elizaos/plugin-tee";
import NodeCache from "node-cache";
import { ICacheManager } from "@elizaos/core";

export class WalletProvider {
    constructor(
        privateKey: string,
        private cacheManager: ICacheManager,
        options?: WalletOptions
    ) {
        // External dependency initialization
        const teeProvider = new DeriveKeyProvider(TEEMode.LOCAL);
    }
}`,
      correct: `import {
    type IAgentRuntime,
    type Provider,
    type ProviderResult,
    ServiceType,
    elizaLogger,
} from "@elizaos/core";
import { WALLET_SERVICE_NAME } from '../constants';

export class WalletProvider {
    runtime: IAgentRuntime;
    
    constructor(
        privateKey: string,
        runtime: IAgentRuntime,
        options?: WalletOptions
    ) {
        this.runtime = runtime;
        if (options) {
            this.configuration = options;
        }
    }
}`,
    },
  },

  {
    type: 'provider-constructor-migration',
    severity: 'critical',
    pattern: 'Provider constructor with ICacheManager parameter',
    solution: 'Replace ICacheManager with IAgentRuntime parameter',
    codeExample: {
      wrong: `constructor(
    primaryParam: PrimaryType,
    private cacheManager: ICacheManager,
    options?: OptionsType
) {
    this.initMethod(primaryParam);
    this.configMethod(options);
    this.cache = new NodeCache({ stdTTL: this.CACHE_EXPIRY_SEC });
}`,
      correct: `constructor(
    primaryParam: PrimaryType,
    runtime: IAgentRuntime,
    options?: OptionsType
) {
    this.initMethod(primaryParam);
    if (options) {
        this.configuration = options;
    }
    this.runtime = runtime;
}`,
    },
  },

  {
    type: 'provider-caching-system',
    severity: 'critical',
    pattern: 'Provider using dual caching (NodeCache + ICacheManager)',
    solution: 'Replace with runtime-based caching only',
    codeExample: {
      wrong: `private cache: NodeCache;
private cacheManager: ICacheManager;
private CACHE_EXPIRY_SEC = 5;

async getCachedData<T>(key: string): Promise<T | null> {
    // Check NodeCache first
    const cached = this.cache.get<T>(key);
    if (cached) return cached;
    
    // Check ICacheManager
    const managerCached = await this.cacheManager.get<T>(key);
    if (managerCached) {
        this.cache.set(key, managerCached);
        return managerCached;
    }
    return null;
}`,
      correct: `private cacheKey = 'plugin/component';

async getResources(): Promise<Record<ContextType, ResourceType>> {
    const cacheKey = path.join(this.cacheKey, 'resources');
    const cachedData = await this.runtime.getCache<Record<ContextType, ResourceType>>(cacheKey);
    if (cachedData) {
        elizaLogger.log('Returning cached resources');
        return cachedData;
    }
    
    const resources = await this.fetchResources();
    await this.runtime.setCache(cacheKey, resources);
    elizaLogger.log('Resources cached');
    return resources;
}`,
    },
  },

  {
    type: 'provider-single-context',
    severity: 'critical',
    pattern: 'Provider with single context methods',
    solution: 'Replace with multi-context resource methods',
    codeExample: {
      wrong: `private currentContext: SupportedChain = "ethereum";

async getBalance(): Promise<string | null> {
    const cacheKey = \`balance_\${this.currentContext}\`;
    const cachedData = await this.getCachedData<string>(cacheKey);
    if (cachedData) {
        return cachedData;
    }
    // ... fetch logic for current context only
    return result;
}

getCurrentContext(): SupportedChain {
    return this.currentContext;
}`,
      correct: `async getBalances(): Promise<Record<SupportedChain, string>> {
    const cacheKey = path.join(this.cacheKey, 'balances');
    const cachedData = await this.runtime.getCache<Record<SupportedChain, string>>(cacheKey);
    if (cachedData) {
        elizaLogger.log('Returning cached balances');
        return cachedData;
    }

    const balances = {} as Record<SupportedChain, string>;
    const chains = this.getSupportedChains();

    await Promise.all(
        chains.map(async (chain) => {
            try {
                const balance = await this.getBalanceForChain(chain);
                if (balance !== null) {
                    balances[chain] = balance;
                }
            } catch (error) {
                elizaLogger.error(\`Error getting balance for \${chain}:\`, error);
            }
        })
    );

    await this.runtime.setCache(cacheKey, balances);
    elizaLogger.log('Balances cached');
    return balances;
}

getSupportedChains(): SupportedChain[] {
    return Object.keys(this.configuration) as SupportedChain[];
}`,
    },
  },

  {
    type: 'provider-response-format',
    severity: 'critical',
    pattern: 'Provider returning simple types instead of ProviderResult',
    solution: 'Return structured ProviderResult with text, data, and values properties',
    codeExample: {
      wrong: `export const walletProvider: Provider = {
    async get(runtime: IAgentRuntime, _message: Memory, state?: State): Promise<string | null> {
        try {
            const walletInstance = await initWalletProvider(runtime);
            const balance = await walletInstance.getBalance();
            const chainInfo = walletInstance.getCurrentContext();
            return \`Wallet balance: \${balance} on \${chainInfo}\`;
        } catch (error) {
            console.error("Error in wallet provider:", error);
            return null;
        }
    },
};`,
      correct: `export const walletProvider: Provider = {
    name: 'WalletProvider',
    async get(runtime: IAgentRuntime, _message: Memory, state?: State): Promise<ProviderResult> {
        try {
            const walletService = runtime.getService(WALLET_SERVICE_NAME);

            if (!walletService) {
                elizaLogger.warn('Wallet service not found, falling back to direct fetching');
                return await directFetchWalletData(runtime, state);
            }

            const walletData = await (walletService as any).getCachedData();
            if (!walletData) {
                elizaLogger.warn('No cached wallet data available, falling back to direct fetching');
                return await directFetchWalletData(runtime, state);
            }

            const agentName = state?.agentName || 'The agent';
            const formattedBalances = walletData.balances
                .map((balance: any) => \`\${balance.token}: \${balance.amount} \${balance.symbol}\`)
                .join('\\n');

            return {
                text: \`\${agentName}'s Wallet Data:\\n\\n\${formattedBalances}\`,
                data: {
                    address: walletData.address,
                    balances: walletData.balances,
                },
                values: {
                    address: walletData.address,
                    balances: JSON.stringify(walletData.balances),
                },
            };
        } catch (error) {
            console.error('Error in wallet provider:', error);
            return {
                text: 'Error getting wallet provider',
                data: {},
                values: {},
            };
        }
    },
};`,
    },
  },

  {
    type: 'provider-service-integration',
    severity: 'critical',
    pattern: 'Provider using external service initialization',
    solution: 'Use lazy service provider pattern with runtime service registry',
    codeExample: {
      wrong: `export const initWalletProvider = async (runtime: IAgentRuntime) => {
    const teeMode = runtime.getSetting('TEE_MODE') || TEEMode.OFF;
    const config = genConfigFromRuntime(runtime);

    if (teeMode !== TEEMode.OFF) {
        const teeProvider = new DeriveKeyProvider(teeMode);
        const teeResult = await teeProvider.deriveEd25519PrivateKey(config, "ethereum", runtime.agentId);
        return new WalletProvider(teeResult.privateKey, runtime.cacheManager, config);
    } else {
        const privateKey = runtime.getSetting('WALLET_PRIVATE_KEY') as string;
        if (!privateKey) {
            throw new Error('WALLET_PRIVATE_KEY is missing');
        }
        return new WalletProvider(privateKey, runtime.cacheManager, config);
    }
};`,
      correct: `class LazyTeeWalletProvider extends WalletProvider {
    private walletInstance: WalletProvider | null = null;
    private initPromise: Promise<void> | null = null;
    private teeConfig: TeeConfig;

    constructor(runtime: IAgentRuntime, teeConfig: TeeConfig, options: WalletOptions) {
        super('placeholder' as string, runtime, options);
        this.teeConfig = teeConfig;
    }

    private async ensureInitialized(): Promise<void> {
        if (this.walletInstance) return;
        if (!this.initPromise) {
            this.initPromise = this.initializeTee();
        }
        await this.initPromise;
    }

    private async initializeTee(): Promise<void> {
        const teeService = this.runtime.getService(ServiceType.TEE);
        if (!teeService) {
            throw new Error('TEE service not found - ensure TEE plugin is registered');
        }
        const { privateKey } = await (teeService as any).deriveEd25519PrivateKey(this.teeConfig, 'ethereum', this.runtime.agentId);
        this.walletInstance = new WalletProvider(privateKey, this.runtime, this.configuration);
        this.connection = (this.walletInstance as any).connection;
    }

    async getBalances(): Promise<Record<SupportedChain, string>> {
        await this.ensureInitialized();
        return this.walletInstance!.getBalances();
    }
}

export const initWalletProvider = async (runtime: IAgentRuntime) => {
    const teeMode = runtime.getSetting('TEE_MODE') || TEEMode.OFF;
    const config = genConfigFromRuntime(runtime);

    if (teeMode !== TEEMode.OFF) {
        const teeConfig = runtime.getSetting('TEE_CONFIG');
        if (!teeConfig) {
            throw new Error('TEE_CONFIG required when TEE_MODE is enabled');
        }
        return new LazyTeeWalletProvider(runtime, teeConfig, config);
    } else {
        const privateKey = runtime.getSetting('WALLET_PRIVATE_KEY') as string;
        if (!privateKey) {
            throw new Error('WALLET_PRIVATE_KEY is missing');
        }
        return new WalletProvider(privateKey, runtime, config);
    }
};`,
    },
  },

  {
    type: 'provider-configuration-fallback',
    severity: 'high',
    pattern: 'Provider configuration without fallback logic',
    solution: 'Add configuration fallback chain and improved error handling',
    codeExample: {
      wrong: `const genConfigFromRuntime = (runtime: IAgentRuntime): WalletConfig => {
    const configuredChains = (runtime.character.settings.chains as string[]) || [];
    const config: WalletConfig = {};

    for (const chain of configuredChains) {
        const rpcUrl = runtime.getSetting(\`\${chain.toUpperCase()}_RPC_URL\`);
        const chainConfig = WalletProvider.genChainFromName(chain, rpcUrl);
        config[chain] = chainConfig;
    }

    return config;
};`,
      correct: `const genConfigFromRuntime = (runtime: IAgentRuntime): WalletConfig => {
    const configuredChains = (runtime?.character?.settings?.chains as string[]) || [];
    const chainsToUse = configuredChains.length > 0 ? configuredChains : ['ethereum', 'base'];
    
    if (!configuredChains.length) {
        elizaLogger.warn('No chains configured in settings, defaulting to ethereum and base');
    }

    const config: WalletConfig = {};

    for (const chain of chainsToUse) {
        try {
            let rpcUrl = runtime.getSetting(\`\${chain.toUpperCase()}_RPC_URL\`);
            
            if (!rpcUrl) {
                rpcUrl = runtime.getSetting(\`RPC_URL_\${chain.toUpperCase()}\`);
            }
            
            if (!isValidChain(chain)) {
                elizaLogger.warn(\`Chain \${chain} not found in supported chains, skipping\`);
                continue;
            }

            const chainConfig = WalletProvider.genChainFromName(chain, rpcUrl);
            config[chain] = chainConfig;
            elizaLogger.log(\`Configured chain: \${chain}\`);
        } catch (error) {
            elizaLogger.error(\`Error configuring chain \${chain}:\`, error);
        }
    }

    return config;
};`,
    },
  },

  {
    type: 'import-incompatibility',
    severity: 'critical',
    pattern: "Wrong import names that don't exist in V2",
    solution: 'Update imports to V2 names and add type prefix for interfaces',
    codeExample: {
      wrong: `import {
    ActionExample,
    ModelClass,
    Content,
    composeContext,
    generateObjectDeprecated,
} from "@elizaos/core";`,
      correct: `import {
    type ActionExample,
    ModelType,
    type Content,
    composePromptFromState,
    parseKeyValueXml,
    elizaLogger,
} from "@elizaos/core";`,
    },
  },

  // CRITICAL: Model usage pattern transformation
  {
    type: 'model-usage-pattern',
    severity: 'critical',
    pattern: 'Using V1 model generation patterns with composeContext and generateObjectDeprecated',
    solution:
      'Replace with V2 pattern: composePromptFromState + runtime.useModel + parseKeyValueXml',
    codeExample: {
      wrong: `const context = composeContext({ state, template: templateName });
const content = await generateObjectDeprecated({
  runtime,
  context,
  modelClass: ModelClass.LARGE,
});`,
      correct: `const context = composePromptFromState({ state, template: templateName });
const xmlResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: context,
});
const content = parseKeyValueXml(xmlResponse) as any;`,
    },
  },

  {
    type: 'broken-handler',
    severity: 'critical',
    pattern: 'Wrong handler signature',
    solution: 'Update handler to correct V2 signature without Promise<boolean> return',
    codeExample: {
      wrong: `handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: { [key: string]: unknown; } = {},
    callback?: HandlerCallback
): Promise<boolean> => { ... }`,
      correct: `handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: { [key: string]: unknown },
    callback: HandlerCallback
) => {
    // Handler logic
    const content: Content = {
        text: "Response text",
        source: 'my-plugin'
    };
    callback(content);
}`,
    },
  },

  // Handler signature patterns
  {
    type: 'handler-promise-boolean',
    severity: 'critical',
    pattern: 'Handler returns Promise<boolean>',
    solution:
      'Remove Promise<boolean> return type from handler - V2 handlers do not return boolean',
    codeExample: {
      wrong: 'handler: async (...): Promise<boolean> => {\n    // ... logic\n    return true;\n}',
      correct: 'handler: async (...) => {\n    // ... logic\n    callback(content);\n}',
    },
  },
  {
    type: 'handler-optional-params',
    severity: 'high',
    pattern: 'Handler has optional state or callback parameters',
    solution: 'Make state and callback parameters required in V2 handler signature',
    codeExample: {
      wrong: 'handler: async (runtime, message, state?, options, callback?) => {}',
      correct: 'handler: async (runtime, message, state, options, callback) => {}',
    },
  },
  {
    type: 'handler-default-options',
    severity: 'medium',
    pattern: 'Handler has default empty object for options',
    solution: 'Remove default value from options parameter',
    codeExample: {
      wrong: 'handler: async (runtime, message, state, options = {}, callback) => {}',
      correct: 'handler: async (runtime, message, state, _options, callback) => {}',
    },
  },
  {
    type: 'handler-arrow-function',
    severity: 'medium',
    pattern: 'Handler uses arrow function with explicit Promise<boolean>',
    solution: 'Update arrow function handler signature to V2 format',
    codeExample: {
      wrong: 'handler: (runtime, message, state, options) => Promise<boolean>',
      correct:
        'handler: async (runtime, message, state, _options, callback) => { callback(content); }',
    },
  },

  // Memory patterns
  {
    type: 'memory-pattern',
    severity: 'critical',
    pattern: 'Wrong memory creation pattern',
    solution: 'Use runtime.createMemory with proper structure',
    codeExample: {
      wrong: `await runtime.messageManager.createMemory(memory);
// or
await _runtime.memory.create({
    tableName: 'messages',
    data: { ... }
});`,
      correct: `await runtime.createMemory({
    id: createUniqueUuid(runtime, \`my-action-\${Date.now()}\`),
    entityId: message.entityId,
    agentId: runtime.agentId,
    roomId: message.roomId,
    content: {
        text: responseText,
        source: 'my-plugin',
    },
    metadata: {
        type: 'action_response',
        actionName: "MY_ACTION"
    },
    createdAt: Date.now()
}, 'messages');`,
    },
  },
  {
    type: 'memory-upsert-pattern',
    severity: 'high',
    pattern: 'Using runtime.memory.upsert pattern',
    solution: 'Replace with runtime.createMemory or runtime.updateMemory',
    codeExample: {
      wrong: 'await runtime.memory.upsert({ ... });',
      correct: "await runtime.createMemory({ ... }, 'messages');",
    },
  },
  {
    type: 'memory-search-pattern',
    severity: 'high',
    pattern: 'Using runtime.memory.search pattern',
    solution: 'Replace with runtime.searchMemories',
    codeExample: {
      wrong: `await runtime.memory.search({ query: "..." });`,
      correct: `await runtime.searchMemories({ query: "...", count: 10 });`,
    },
  },
  {
    type: 'memory-content-fields',
    severity: 'high',
    pattern: 'Memory content has non-standard fields',
    solution: 'Move extra fields to metadata, keep only text and source in content',
    codeExample: {
      wrong: `content: {
    text: "response",
    actionName: "MY_ACTION",
    data: extraData,
    source: "plugin"
}`,
      correct: `content: {
    text: "response", 
    source: "plugin"
},
metadata: {
    actionName: "MY_ACTION",
    data: extraData
}`,
    },
  },
  {
    type: 'database-adapter-memory',
    severity: 'high',
    pattern: 'Using runtime.databaseAdapter.createMemory',
    solution: 'Replace with runtime.createMemory',
    codeExample: {
      wrong: 'await runtime.databaseAdapter.createMemory(memory);',
      correct: "await runtime.createMemory(memory, 'messages');",
    },
  },

  // Provider patterns
  {
    type: 'provider-interface',
    severity: 'high',
    pattern: 'Custom provider interface',
    solution: 'Use standard Provider interface',
    codeExample: {
      wrong: `export interface CustomProvider {
    type: string;
    initialize: (runtime: IAgentRuntime) => Promise<void>;
    get: (runtime: IAgentRuntime, message?: Memory) => Promise<CustomState>;
    validate: (runtime: IAgentRuntime, message?: Memory) => Promise<boolean>;
}`,
      correct: `export const myStateProvider: Provider = {
    name: 'myState',
    get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
        const myService = runtime.getService('my-service') as MyService;
        
        return {
            data: {
                isInitialized: myService.isInitialized(),
                status: myService.getStatus()
            },
            values: {
                serviceStatus: myService.getStatus() || 'Not initialized'
            },
            text: \`Service status: \${myService.getStatus() || 'Not initialized'}\`
        };
    }
};`,
    },
  },

  // Configuration patterns
  {
    type: 'config-validation',
    severity: 'high',
    pattern: 'Zod validation errors for numeric environment variables',
    solution: 'Use z.coerce.number() for numeric fields that come from environment variables',
    codeExample: {
      wrong: `export const ConfigSchema = z.object({
    MAX_FILE_SIZE: z.number(), // Will fail with NaN from env vars
    TIMEOUT: z.number().optional(),
    MAX_RESULTS: z.number().default(10), // Will fail
});`,
      correct: `export const ConfigSchema = z.object({
    MAX_FILE_SIZE: z.coerce.number().default(10485760), // 10MB default
    TIMEOUT: z.coerce.number().optional(),
    MAX_RESULTS: z.coerce.number().default(10), // Coerce string to number
    // For required numbers without defaults:
    REQUIRED_NUMBER: z.coerce.number().min(1),
});`,
    },
  },
  {
    type: 'config-field-visibility',
    severity: 'medium',
    pattern: 'Private config field in service',
    solution: 'Make config field public for test access',
    codeExample: {
      wrong: `export class MyService extends Service {
    private config: MyConfig;
}`,
      correct: `export class MyService extends Service {
    public config: MyConfig;
}`,
    },
  },

  // Service patterns
  {
    type: 'service-registration',
    severity: 'medium',
    pattern: 'Manual service registration in init',
    solution: 'Services are automatically registered from services array in V2',
    codeExample: {
      wrong: `init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    runtime.registerService(NewsService);
},`,
      correct: `init: async (_config: Record<string, string>, _runtime: IAgentRuntime) => {
    // Services are automatically registered from the services array
},`,
    },
  },

  // ActionExample patterns
  {
    type: 'action-example-role',
    severity: 'high',
    pattern: 'Using role instead of name in ActionExample',
    solution: 'ActionExample must use name field not role',
    codeExample: {
      wrong: `examples: [
    [
        {
            role: "user",
            content: { text: "example" }
        }
    ]
]`,
      correct: `examples: [
    [
        {
            name: "user",
            content: { text: "example" }
        }
    ]
]`,
    },
  },

  // Handler option patterns
  {
    type: 'handler-options-type',
    severity: 'high',
    pattern: 'Wrong options parameter type in handler',
    solution: 'Use proper TypeScript type for options parameter',
    codeExample: {
      wrong: `handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any, // Wrong
    callback: HandlerCallback
)`,
      correct: `handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: { [key: string]: unknown }, // Correct
    callback: HandlerCallback
)`,
    },
  },
];

/**
 * Get all architecture issues
 */
export function getArchitectureIssues(): ArchitectureIssue[] {
  return ARCHITECTURE_ISSUES;
}

/**
 * Find architecture issue by type
 */
export function findArchitectureIssue(type: string): ArchitectureIssue | undefined {
  return ARCHITECTURE_ISSUES.find((issue) => issue.type === type);
}

/**
 * Get issues by severity
 */
export function getIssuesBySeverity(severity: 'critical' | 'high' | 'medium'): ArchitectureIssue[] {
  return ARCHITECTURE_ISSUES.filter((issue) => issue.severity === severity);
}

/**
 * Get issues by category
 */
export function getIssuesByCategory() {
  return {
    service: ARCHITECTURE_ISSUES.filter((issue) => issue.type.includes('service')),
    handler: ARCHITECTURE_ISSUES.filter((issue) => issue.type.includes('handler')),
    memory: ARCHITECTURE_ISSUES.filter((issue) => issue.type.includes('memory')),
    provider: ARCHITECTURE_ISSUES.filter((issue) => issue.type.includes('provider')),
    config: ARCHITECTURE_ISSUES.filter((issue) => issue.type.includes('config')),
    import: ARCHITECTURE_ISSUES.filter((issue) => issue.type.includes('import')),
  };
}

/**
 * Check if code has architecture issues
 */
export function checkForArchitectureIssues(code: string): ArchitectureIssue[] {
  return ARCHITECTURE_ISSUES.filter((issue) => {
    // Check if the code contains patterns from the wrong examples
    if (issue.codeExample?.wrong) {
      return code.includes(issue.codeExample.wrong.slice(0, 50)); // Check first 50 chars
    }
    return false;
  });
}
