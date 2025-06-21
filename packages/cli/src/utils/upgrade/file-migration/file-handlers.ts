/**
 * FILE TYPE HANDLERS
 *
 * Responsibilities:
 * - Specific migration logic for different file types
 * - Service, action, provider, config, index file migration
 * - Generic file migration with V1 pattern detection
 * - Integration with Claude SDK for file processing
 */

import { logger } from '@elizaos/core';
import {
  IMPORT_MAPPINGS,
  MODEL_TYPE_MAPPINGS,
  ARCHITECTURE_ISSUES,
} from '../migration-patterns/index.js';
import { EnhancedClaudeSDKAdapter } from '../claude-sdk/index.js';
import { PatternDetection } from './pattern-detection.js';
import type { MigrationContext, SDKMigrationOptions } from '../types.js';

export class FileHandlers {
  private context: MigrationContext;
  private claudeSDKAdapter: EnhancedClaudeSDKAdapter;
  private patternDetection: PatternDetection;

  constructor(context: MigrationContext, claudeSDKAdapter: EnhancedClaudeSDKAdapter) {
    this.context = context;
    this.claudeSDKAdapter = claudeSDKAdapter;
    this.patternDetection = new PatternDetection();
  }

  /**
   * Migrate service files
   */
  async migrateServiceFile(filePath: string, content: string): Promise<void> {
    // Check if service is actually needed
    if (!this.context.hasService) {
      logger.warn(`⚠️  Found service file ${filePath} but no service in main branch - DELETING`);
      // Mark for deletion since service shouldn't exist
      // This will be handled by the caller
      return;
    }

    logger.info(`🔧 Migrating service file: ${filePath} (verified: existed in V1)`);

    const prompt = `# Migrate Service File to V2

File: ${filePath}

Current content:
\`\`\`typescript
${content}
\`\`\`

Requirements:
1. Service must extend base Service class from @elizaos/core
2. Must have static serviceType property
3. Must have static start() method
4. Must have stop() method for cleanup
5. Must have capabilityDescription getter
6. Constructor must accept IAgentRuntime parameter
7. Use double quotes consistently
8. Add 'type' prefix for interface imports

Example V2 service structure:
\`\`\`typescript
export class MyService extends Service {
    static serviceType: string = 'my-service';
    
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
\`\`\`

Migrate this service file to V2 patterns. Make all necessary changes.`;

    await this.runClaudeOnFile(prompt);
  }

  /**
   * Migrate action files
   */
  async migrateActionFile(filePath: string, content: string): Promise<void> {
    logger.info(`🎯 Migrating action file: ${filePath}`);

    // Check if this is a nested action that needs centralization
    if (filePath.match(/src\/actions\/[^/]+\/(index\.ts|.*\.ts)$/)) {
      logger.info(`📁 Found nested action: ${filePath}`);
      // Mark for centralization but don't delete yet
      return;
    }

    const prompt = `# ElizaOS Action V1 to V2 Migration: Complete Transformation

File: ${filePath}

Current content:
\`\`\`typescript
${content}
\`\`\`

## 🔧 **CRITICAL: Exact Import Transformations**

### **REMOVE These V1 Imports:**
- \`composeContext\` → REPLACE WITH \`composePromptFromState\`
- \`generateObjectDeprecated\` → REMOVE (use \`runtime.useModel\`)
- \`generateObject\` → REMOVE (use \`runtime.useModel\`)
- \`ModelClass\` → REPLACE WITH \`ModelType\`
- \`elizaLogger\` → REPLACE WITH \`logger\`

### **ADD These V2 Imports:**
\`\`\`typescript
import {
  composePromptFromState,
  createUniqueUuid,
  logger,
  ModelType,
} from '@elizaos/core';
import type {
  Action,
  ActionExample,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
\`\`\`

## 📊 **CRITICAL: State Structure Transformation**

### **REPLACE V1 Direct State Access:**
\`\`\`typescript
// ❌ V1 Direct state access
const tokenA = state.tokenA;
const amount = state.amount;
const slippage = state.slippage;
const fromChain = state.fromChain;
const proposalId = state.proposalId;
const tokenId = state.tokenId;
const walletAddress = state.walletAddress;
const balances = state.balances;
const validator = state.validator;
\`\`\`

### **WITH V2 Structured State Access:**
\`\`\`typescript
// ✅ V2 Structured state access
const tokenA = state.values.tokenA;
const amount = state.values.amount;
const slippage = state.data.slippage;
const fromChain = state.values.fromChain;
const proposalId = state.values.proposalId;
const tokenId = state.values.tokenId;
const walletAddress = state.values.walletAddress;
const balances = state.data.balances;
const validator = state.data.validator;
\`\`\`

### **REPLACE V1 State Persistence:**
\`\`\`typescript
// ❌ V1 State persistence
state.swapResult = result;
state.transactionHash = hash;
state.lastUpdate = Date.now();
\`\`\`

### **WITH V2 Structured State Persistence:**
\`\`\`typescript
// ✅ V2 Structured state persistence
state.values.transactionHash = hash;
state.values.lastUpdate = Date.now().toString();
state.data.swapResult = result;
state.data.transactionDetails = details;
\`\`\`

## 🎯 **CRITICAL: Model Usage Pattern Transformation**

### **REPLACE V1 Pattern:**
\`\`\`typescript
const actionContext = composeContext({
  state,
  template: actionTemplate,
});
const content = await generateObjectDeprecated({
  runtime,
  context: actionContext,
  modelClass: ModelClass.LARGE,
});

// or
const result = await generateObject({
  runtime,
  context: prompt,
  modelClass: ModelClass.LARGE,
  schema: MySchema
});
\`\`\`

### **WITH V2 Pattern:**
\`\`\`typescript
const actionContext = composePromptFromState({
  state,
  template: actionTemplate,
});

// For object generation:
const result = await runtime.useModel(ModelType.OBJECT_GENERATION, {
  prompt: actionContext,
  schema: MySchema,
  temperature: 0.1
});

// For text generation:
const textResult = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: actionContext,
  temperature: 0.7
});
\`\`\`

## 📊 **State Structure Enhancement**

### **REPLACE V1 State Pattern:**
\`\`\`typescript
if (!state) {
    state = (await runtime.composeState(message)) as State;
} else {
    state = await runtime.updateRecentMessageState(state);
}
\`\`\`

### **WITH V2 Enhanced State Pattern:**
\`\`\`typescript
if (!state) {
    state = await runtime.composeState(_message, ['RECENT_MESSAGES']);
}

// Add contextual information to state
const serviceData = await someService.getData();
state.supportedOptions = options.join(' | ');
state.contextInfo = formatContextInfo(serviceData);
\`\`\`

## 🔄 **Handler Function Transformation**

### **REPLACE V1 Handler:**
\`\`\`typescript
handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback?: HandlerCallback
): Promise<boolean> => {
    // logic
    return true;
}
\`\`\`

### **WITH V2 Handler:**
\`\`\`typescript
handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: { [key: string]: unknown },
    callback: HandlerCallback
) => {
    // logic
    callback(content);
}
\`\`\`

## 🏷️ **CRITICAL: ActionExample Format Transformation**

### **REPLACE V1 ActionExample Format:**
\`\`\`typescript
// ❌ V1 ActionExample with "user" field
examples: [
  [
    {
      user: "user",
      content: { text: "example" }
    },
    {
      user: "assistant", 
      content: { text: "response" }
    }
  ]
]
\`\`\`

### **WITH V2 ActionExample Format:**
\`\`\`typescript
// ✅ V2 ActionExample with "name" field
examples: [
  [
    {
      name: "user",          // ✅ CHANGED from "user" to "name"
      content: {
        text: "Please perform this action",
        action: "PLUGIN_ACTION_NAME"
      }
    },
    {
      name: "assistant",     // ✅ CHANGED from "user" to "name"
      content: {
        text: "I'll help you perform this action",
        action: "PLUGIN_ACTION_NAME"
      }
    }
  ]
]
\`\`\`

## 🎨 **CRITICAL: Content Interface Transformation**

### **REPLACE V1 Content with "action" field:**
\`\`\`typescript
// ❌ V1 Content with single "action" field
callback({
  text: "Response text",
  action: "MY_ACTION",
  source: "plugin"
});

const content: Content = {
  text: responseText,
  action: "ACTION_NAME",
  source: "plugin-name"
};
\`\`\`

### **WITH V2 Content with "actions" array:**
\`\`\`typescript
// ✅ V2 Content with "actions" array
callback({
  text: "Response text",          // Optional in V2
  actions: ["MY_ACTION"],         // Array instead of single action
  source: "plugin"
});

const content: Content = {
  text: responseText,             // Optional field
  actions: ["ACTION_NAME"],       // Array instead of single action
  source: "plugin-name"
};
\`\`\`

## 🚨 **Enhanced Error Handling**

### **REPLACE Basic Error Handling:**
\`\`\`typescript
} catch (error) {
    if (callback) {
        callback({ text: \`Error: \${error.message}\` });
    }
    return false;
}
\`\`\`

### **WITH V2 Enhanced Error Handling:**
\`\`\`typescript
} catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    let userFriendlyMessage = '';
    if (errorMessage.includes('NETWORK_ERROR')) {
        userFriendlyMessage = "The action failed due to network connectivity issues.";
    } else if (errorMessage.includes('INVALID_INPUT')) {
        userFriendlyMessage = 'The action failed due to invalid input.';
    } else {
        userFriendlyMessage = "The action couldn't be completed.";
    }

    if (callback) {
        callback({
            text: userFriendlyMessage,
            content: {
                success: false,
                error: errorMessage,
            },
        });
    }
    return false;
}
\`\`\`

## ⚠️ **VALIDATION REQUIREMENTS**

Apply ALL transformations:
1. Import statements match V2 patterns exactly
2. Model usage follows \`runtime.useModel\` + \`parseKeyValueXml\` pattern  
3. State structure includes enhanced context information
4. Action names use descriptive naming convention
5. Examples include \`name\` field
6. Error handling provides user-friendly messages
7. Handler signature removes Promise<boolean> return type
8. Content structure has only \`text\` and \`source\` fields

**Transform this action file completely to V2 architecture. Make ALL required changes.**`;

    await this.runClaudeOnFile(prompt);
  }

  /**
   * Migrate provider files
   */
  async migrateProviderFile(filePath: string, content: string): Promise<void> {
    logger.info(`🔌 Migrating provider file: ${filePath}`);

    // Check for provider-specific patterns
    const hasProviderPatterns = this.patternDetection.hasProviderPatterns(content);
    const hasExternalDeps = this.patternDetection.hasExternalDependencies(content);

    logger.info(`   Provider patterns detected: ${hasProviderPatterns}`);
    logger.info(`   External dependencies: ${hasExternalDeps}`);

    const prompt = `# ElizaOS Provider V1 to V2 Complete Migration Guide

File: ${filePath}

Current content:
\`\`\`typescript
${content}
\`\`\`

## 🔧 **CRITICAL: Phase 1 - External Dependency Removal**

### **REMOVE These V1 External Dependencies:**
\`\`\`typescript
// ❌ REMOVE ALL of these imports
import { DeriveKeyProvider, TEEMode } from "@elizaos/plugin-tee";
import NodeCache from "node-cache";
import { ICacheManager } from "@elizaos/core";
import { ExternalServiceProvider } from "@elizaos/plugin-[external]";
\`\`\`

### **REPLACE WITH V2 Core Imports:**
\`\`\`typescript
// ✅ ADD these V2 imports
import * as path from 'node:path';
import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
  elizaLogger,
  ServiceType,
} from '@elizaos/core';
import { [PLUGIN]_SERVICE_NAME } from '../constants';
\`\`\`

## 🏗️ **CRITICAL: Phase 2 - Constructor Migration**

### **REPLACE V1 Constructor Pattern:**
\`\`\`typescript
// ❌ V1 Constructor Pattern
export class WalletProvider {
    private cache: NodeCache;
    private cacheKey = "wallet/balance";
    private currentContext: SupportedChain = "ethereum";
    private CACHE_EXPIRY_SEC = 5;
    configuration: WalletConfig = {};
    connection: Connection;

    constructor(
        privateKey: string,
        private cacheManager: ICacheManager,
        options?: WalletOptions
    ) {
        this.initWallet(privateKey);
        this.configMethod(options);
        this.cache = new NodeCache({ stdTTL: this.CACHE_EXPIRY_SEC });
    }
}
\`\`\`

### **WITH V2 Constructor Pattern:**
\`\`\`typescript
// ✅ V2 Constructor Pattern
export class WalletProvider {
    private cacheKey = 'wallet/balance';
    configuration: WalletConfig = {};
    connection!: Connection;  // Note the ! assertion
    runtime: IAgentRuntime;

    constructor(
        privateKey: string,
        runtime: IAgentRuntime,
        options?: WalletOptions
    ) {
        this.initWallet(privateKey);
        if (options) {
            this.configuration = options;
        }
        this.runtime = runtime;
    }
}
\`\`\`

## 💾 **CRITICAL: Phase 3 - Caching System Migration**

### **REMOVE V1 Manual Caching Methods:**
\`\`\`typescript
// ❌ DELETE all these V1 methods
async getCachedData<T>(key: string): Promise<T | null> { /* ... */ }
async setCachedData<T>(cacheKey: string, data: T): Promise<void> { /* ... */ }
readFromCache<T>(key: string): Promise<T | null> { /* ... */ }
writeToCache<T>(key: string, data: T): Promise<void> { /* ... */ }
\`\`\`

### **REPLACE WITH V2 Multi-Context Methods:**
\`\`\`typescript
// ✅ ADD V2 multi-context caching
async getBalances(): Promise<Record<SupportedChain, string>> {
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
}
\`\`\`

## 🔄 **CRITICAL: Phase 4 - Single-Context to Multi-Context**

### **REMOVE V1 Single-Context Methods:**
\`\`\`typescript
// ❌ DELETE these V1 single-context methods
private currentContext: SupportedChain = "ethereum";
async getBalance(): Promise<string | null> { /* single context */ }
getCurrentContext(): SupportedChain { /* ... */ }
setCurrentContext = (context: SupportedChain) => { /* ... */ }
switchContext(context: SupportedChain, customParam?: string) { /* ... */ }
\`\`\`

### **REPLACE WITH V2 Multi-Context Methods:**
\`\`\`typescript
// ✅ ADD V2 multi-context methods
async getBalanceForChain(chain: SupportedChain): Promise<string | null> {
    try {
        const chainConfig = this.configuration[chain];
        if (!chainConfig) {
            elizaLogger.warn(\`No configuration for chain: \${chain}\`);
            return null;
        }
        // Chain-specific balance logic
        return await this.fetchBalanceForChain(chain, chainConfig);
    } catch (error) {
        elizaLogger.error(\`Error getting balance for \${chain}:\`, error);
        return null;
    }
}
\`\`\`

## 🏭 **CRITICAL: Phase 5 - Service Integration**

### **REPLACE V1 External Service Initialization:**
\`\`\`typescript
// ❌ V1 External Service Pattern
export const initWalletProvider = async (runtime: IAgentRuntime) => {
    const teeMode = runtime.getSetting('TEE_MODE') || TEEMode.OFF;
    
    if (teeMode !== TEEMode.OFF) {
        const teeProvider = new DeriveKeyProvider(teeMode);
        const teeResult = await teeProvider.deriveEd25519PrivateKey(config, "ethereum", runtime.agentId);
        return new WalletProvider(teeResult.privateKey, runtime.cacheManager, config);
    }
};
\`\`\`

### **WITH V2 Lazy Service Provider Pattern:**
\`\`\`typescript
// ✅ V2 Lazy Service Provider Pattern
class LazyTeeWalletProvider extends WalletProvider {
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
};
\`\`\`

## 📋 **CRITICAL: Phase 6 - Provider Response Format**

### **REPLACE V1 Provider Response:**
\`\`\`typescript
// ❌ V1 Provider Pattern
export const walletProvider: Provider = {
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
};
\`\`\`

### **WITH V2 ProviderResult Pattern:**
\`\`\`typescript
// ✅ V2 Provider Pattern with Service Integration
async function directFetchWalletData(runtime: IAgentRuntime, state?: State): Promise<ProviderResult> {
    try {
        const walletProvider = await initWalletProvider(runtime);
        const address = walletProvider.getAddress();
        const balances = await walletProvider.getBalances();
        const agentName = state?.agentName || 'The agent';

        const formattedBalances = Object.entries(balances).map(([chain, balance]) => {
            const chainConfig = walletProvider.getChainConfigs(chain as SupportedChain);
            return {
                chain: chain,
                balance: balance,
                symbol: chainConfig.symbol,
                chainId: chainConfig.id,
                name: chainConfig.name,
            };
        });

        const displayText = formattedBalances
            .map((item) => \`\${item.name}: \${item.balance} \${item.symbol}\`)
            .join('\\n');

        return {
            text: \`\${agentName}'s Wallet Data:\\n\\n\${displayText}\`,
            data: {
                address: address,
                balances: formattedBalances,
            },
            values: {
                address: address as string,
                balances: JSON.stringify(formattedBalances),
            },
        };
    } catch (error) {
        console.error('Error fetching wallet data directly:', error);
        return {
            text: 'Error getting wallet provider',
            data: {},
            values: {},
        };
    }
}

export const walletProvider: Provider = {
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
                .map((balance: any) => \`\${balance.name}: \${balance.balance} \${balance.symbol}\`)
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
};
\`\`\`

## ⚙️ **CRITICAL: Phase 7 - Configuration Enhancement**

### **REPLACE V1 Configuration Pattern:**
\`\`\`typescript
// ❌ V1 Configuration Pattern
const genConfigFromRuntime = (runtime: IAgentRuntime): WalletConfig => {
    const configuredChains = (runtime.character.settings.chains as string[]) || [];
    const config: WalletConfig = {};

    for (const chain of configuredChains) {
        const rpcUrl = runtime.getSetting(\`\${chain.toUpperCase()}_RPC_URL\`);
        const chainConfig = WalletProvider.genChainFromName(chain, rpcUrl);
        config[chain] = chainConfig;
    }

    return config;
};
\`\`\`

### **WITH V2 Enhanced Configuration:**
\`\`\`typescript
// ✅ V2 Enhanced Configuration with Fallbacks
const genConfigFromRuntime = (runtime: IAgentRuntime): WalletConfig => {
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
};
\`\`\`

## ✅ **VALIDATION REQUIREMENTS**

Apply ALL transformations:
1. **External Dependencies**: Remove all external plugin imports
2. **Constructor**: Replace ICacheManager with IAgentRuntime 
3. **Caching**: Use runtime.getCache/setCache instead of manual caching
4. **Multi-Context**: Replace single-context with multi-context methods
5. **Service Integration**: Use lazy service provider pattern
6. **Response Format**: Return ProviderResult with text, data, and values
7. **Configuration**: Add fallback logic and enhanced error handling
8. **Imports**: Use proper V2 import patterns
9. **Logging**: Use elizaLogger instead of console.log
10. **Error Handling**: Provide user-friendly error messages

**Transform this provider file completely to V2 architecture using ALL patterns above.**`;

    await this.runClaudeOnFile(prompt);
  }

  /**
   * Migrate index.ts file
   */
  async migrateIndexFile(filePath: string, content: string): Promise<void> {
    logger.info(`📦 Migrating index file: ${filePath}`);

    const prompt = `# Migrate Plugin Index File to V2

File: ${filePath}

Current content:
\`\`\`typescript
${content}
\`\`\`

Requirements:
1. Import all components (service, actions, providers, tests)
2. Export default plugin object with V2 structure
3. Include name, description, services, actions, providers, tests
4. Add init function if needed
5. Remove evaluators (V1 pattern)
6. Use double quotes consistently

Example V2 plugin export:
\`\`\`typescript
import { type Plugin } from '@elizaos/core';
import { MyService } from './service';
import { myPluginActions } from './actions';
import { myPluginProviders } from './providers';
import testSuite from './test/test';

const myPlugin: Plugin = {
    name: 'my-plugin',
    description: 'Plugin description',
    services: [MyService],
    actions: myPluginActions,
    providers: myPluginProviders,
    evaluators: [],
    tests: [testSuite],
    init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
        // initialization if needed
    }
};

export default myPlugin;
\`\`\`

Migrate this index file to proper V2 plugin export.`;

    await this.runClaudeOnFile(prompt);
  }

  /**
   * Migrate config files
   */
  async migrateConfigFile(filePath: string, content: string): Promise<void> {
    logger.info(`⚙️  Migrating config file: ${filePath}`);

    // Skip if it's the new config.ts we created
    if (filePath === 'src/config.ts' && content.includes('zod')) {
      logger.info('✅ Config file already migrated');
      return;
    }

    const prompt = `# Migrate Config File to V2

File: ${filePath}

Current content:
\`\`\`typescript
${content}
\`\`\`

Requirements:
1. Use Zod for schema validation
2. Use runtime.getSetting() instead of direct process.env
3. Export validation function
4. Handle both runtime settings and environment variables
5. Use double quotes consistently

Example V2 config:
\`\`\`typescript
import { z } from 'zod';
import { type IAgentRuntime } from '@elizaos/core';

export const ConfigSchema = z.object({
    API_KEY: z.string().min(1, "API key is required"),
    API_ENDPOINT: z.string().url().optional(),
});

export type MyConfig = z.infer<typeof ConfigSchema>;

export function validateMyConfig(runtime: IAgentRuntime): MyConfig {
    const config = {
        API_KEY: runtime.getSetting('MY_API_KEY') || process.env.MY_API_KEY,
        API_ENDPOINT: runtime.getSetting('MY_API_ENDPOINT') || process.env.MY_API_ENDPOINT,
    };
    
    return ConfigSchema.parse(config);
}
\`\`\`

Migrate this config to V2 patterns with Zod validation.`;

    await this.runClaudeOnFile(prompt);
  }

  /**
   * Migrate generic TypeScript files
   */
  async migrateGenericFile(filePath: string, content: string): Promise<void> {
    const { hasV1Patterns, detectedPatterns } = this.patternDetection.detectV1Patterns(content);

    if (!hasV1Patterns) {
      logger.info(`✅ File ${filePath} appears to be V2 compatible`);
      return;
    }

    // Log detected patterns
    logger.info(`🔄 Migrating generic file: ${filePath}`);
    if (detectedPatterns.length > 0) {
      logger.info(`   Detected V1 patterns: ${detectedPatterns.join(', ')}`);
    }

    const prompt = `# Comprehensive V2 Migration for TypeScript File

File: ${filePath}

Current content:
\`\`\`typescript
${content}
\`\`\`

     Detected V1 patterns that MUST be fixed:
     ${detectedPatterns.map((p: string) => `- ${p}`).join('\n')}

## Critical Import Fixes:
${IMPORT_MAPPINGS.map(
  (m) => `- ${m.description}
  Old: ${m.oldImport}
  New: ${m.newImport}`
).join('\n')}

## Model/API Changes:
${MODEL_TYPE_MAPPINGS.map((m) => `- ${m.v1} → ${m.v2} (${m.description})`).join('\n')}

## Type Import Rules:
1. Separate ALL type imports from value imports
   Wrong: import { Service, type IAgentRuntime } from "@elizaos/core";
   Right: import { Service } from "@elizaos/core";
          import type { IAgentRuntime } from "@elizaos/core";

2. Use type-only imports for interfaces
   Wrong: import { TestSuite } from "@elizaos/core";
   Right: import type { TestSuite } from "@elizaos/core";

## State Object Rules:
1. Never use empty objects as State
   Wrong: state: {}
   Right: state: { values: {}, data: {}, text: "" }

2. Create proper State helper if needed:
   export function createTestState(): State {
     return { values: {}, data: {}, text: "" };
   }

## Handler Signature Rules:
1. Remove Promise<boolean> return type
2. Use proper options type: { [key: string]: unknown }
3. Always include callback parameter

## Memory API Rules:
1. Use runtime.createMemory() not runtime.memory.create()
2. Include all required fields: entityId, agentId, roomId, content, metadata, createdAt
3. Content should only have text and source fields

## Config/Zod Rules:
1. Use z.coerce.number() for ALL numeric environment variables
   Wrong: z.number()
   Right: z.coerce.number()

## Service Rules:
1. Remove explicit ServiceType annotation
   Wrong: static serviceType: ServiceType = "my-service";
   Right: static serviceType = "my-service";

2. Make config public for test access if needed

## Additional Rules:
1. Use double quotes consistently
2. Add null safety with optional chaining (?.)
3. Replace 'any' with proper types or { [key: string]: unknown }
4. Fix ALL occurrences, not just the first one

IMPORTANT: Fix ALL detected patterns comprehensively. Make the file fully V2 compliant.`;

    await this.runClaudeOnFile(prompt);
  }

  /**
   * Run Claude on a specific file with a prompt using SDK
   */
  private async runClaudeOnFile(prompt: string): Promise<void> {
    if (!this.context.repoPath) return;

    try {
      logger.info('🤖 Using Claude SDK for file migration...');

      const options: SDKMigrationOptions = {
        maxTurns: 15, // Increased for complex files like actions
        model: 'claude-sonnet-4-20250514', // Same as original CLI calls
        outputFormat: 'json',
        permissionMode: 'bypassPermissions',
      };

      const result = await this.claudeSDKAdapter.executePrompt(prompt, options, this.context);

      // Handle recoverable conditions (like max turns) vs actual failures
      if (!result.success) {
        if (result.message?.includes('error_max_turns') || result.shouldContinue) {
          logger.warn(`⚠️  File migration hit max turns but continuing: ${result.message}`);
          logger.info('ℹ️  This file will be fixed in the post-migration validation phase');
          // Don't throw - this is recoverable, continue with migration
          return;
        }
        throw new Error(result.message || 'Claude SDK execution failed');
      }

      logger.info('✅ Claude SDK file migration completed successfully');

      if (result.cost) {
        logger.info(`💰 File migration cost: $${result.cost.toFixed(4)}`);
      }

      if (result.warnings && result.warnings.length > 0) {
        for (const warning of result.warnings) {
          logger.warn(`⚠️  ${warning}`);
        }
      }
    } catch (error) {
      logger.error('❌ Claude SDK file migration failed:', error);
      throw error;
    }
  }
}
