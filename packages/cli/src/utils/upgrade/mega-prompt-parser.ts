import type { PromptChunk, ImportMapping, ModelTypeMapping, ArchitectureIssue, TestingPattern } from './types.js';

/**
 * Critical import mappings from the mega prompt and plugin-news analysis
 */
export const IMPORT_MAPPINGS: ImportMapping[] = [
  // CRITICAL V2 Import Name Changes (Simple String Replacements)
  {
    oldImport: 'ModelClass',
    newImport: 'ModelType',
    description: 'CRITICAL: ModelClass is renamed to ModelType in V2',
  },
  {
    oldImport: 'elizaLogger',
    newImport: 'logger',
    description: 'CRITICAL: elizaLogger is renamed to logger in V2',
  },
  
  // CRITICAL Type-Only Imports (Must be separated)
  {
    oldImport: '{ TestSuite }',
    newImport: 'type { TestSuite }',
    description: 'CRITICAL: TestSuite is type-only export in V2',
  },
  {
    oldImport: '{ ActionExample }',
    newImport: 'type { ActionExample }',
    description: 'CRITICAL: ActionExample is type-only export in V2',
  },
  {
    oldImport: '{ Content }',
    newImport: 'type { Content }',
    description: 'CRITICAL: Content is type-only export in V2',
  },
  {
    oldImport: '{ HandlerCallback }',
    newImport: 'type { HandlerCallback }',
    description: 'CRITICAL: HandlerCallback is type-only export in V2',
  },
  {
    oldImport: '{ IAgentRuntime }',
    newImport: 'type { IAgentRuntime }',
    description: 'CRITICAL: IAgentRuntime is type-only export in V2',
  },
  {
    oldImport: '{ State }',
    newImport: 'type { State }',
    description: 'CRITICAL: State is type-only export in V2',
  },
  
  // NEW: Additional critical type-only imports
  {
    oldImport: '{ UUID }',
    newImport: 'type { UUID }',
    description: 'CRITICAL: UUID is type-only export in V2',
  },
  {
    oldImport: '{ Plugin }',
    newImport: 'type { Plugin }',
    description: 'CRITICAL: Plugin is type-only export in V2',
  },
  {
    oldImport: '{ Provider }',
    newImport: 'type { Provider }',
    description: 'CRITICAL: Provider is type-only export in V2',
  },
  {
    oldImport: '{ Memory }',
    newImport: 'type { Memory }',
    description: 'CRITICAL: Memory is type-only export in V2',
  },
  {
    oldImport: '{ Action }',
    newImport: 'type { Action }',
    description: 'CRITICAL: Action is type-only export in V2',
  },
  
  // CRITICAL Mixed Import Separations (Common Patterns)
  {
    oldImport: '{ Service, type IAgentRuntime }',
    newImport: '{ Service } from "@elizaos/core";\nimport type { IAgentRuntime }',
    description: 'CRITICAL: Separate mixed imports - Service is value, IAgentRuntime is type',
  },
  {
    oldImport: '{ Memory, type State }',
    newImport: '{ Memory } from "@elizaos/core";\nimport type { State }',
    description: 'CRITICAL: Separate mixed imports - Memory is value, State is type',
  },
  {
    oldImport: '{ ActionExample, Content }',
    newImport: 'type { ActionExample, Content }',
    description: 'CRITICAL: Both ActionExample and Content are type-only in V2',
  },
  {
    oldImport: '{ HandlerCallback, IAgentRuntime }',
    newImport: 'type { HandlerCallback, IAgentRuntime }',
    description: 'CRITICAL: Both HandlerCallback and IAgentRuntime are type-only in V2',
  },
  
  // NEW: Complex mixed import patterns that need separation
  {
    oldImport: '{ Service, type Provider, type Action }',
    newImport: '{ Service } from "@elizaos/core";\nimport type { Provider, Action }',
    description: 'CRITICAL: Separate Service (value) from Provider, Action (types)',
  },
  {
    oldImport: '{ logger, ModelType, type Memory, type State }',
    newImport: '{ logger, ModelType } from "@elizaos/core";\nimport type { Memory, State }',
    description: 'CRITICAL: Separate values (logger, ModelType) from types (Memory, State)',
  },
  {
    oldImport: '{ createUniqueUuid, type UUID, type Content }',
    newImport: '{ createUniqueUuid } from "@elizaos/core";\nimport type { UUID, Content }',
    description: 'CRITICAL: Separate createUniqueUuid (value) from UUID, Content (types)',
  },
  
  // CRITICAL Removed Imports
  {
    oldImport: '{ AgentTest }',
    newImport: '',
    description: 'CRITICAL: AgentTest does not exist in V2 - remove completely',
  },
  
  // NEW: Import patterns that frequently cause issues
  {
    oldImport: /import\s*{\s*([^}]*),\s*type\s+([^}]*)\s*}\s*from\s*["']@elizaos\/core["']/g,
    newImport: 'import { $1 } from "@elizaos/core";\nimport type { $2 } from "@elizaos/core"',
    description: 'CRITICAL: Auto-split all mixed imports from @elizaos/core',
  },
  
  // NEW: Common value imports that should remain value imports
  {
    oldImport: 'type { Service }',
    newImport: '{ Service }',
    description: 'CRITICAL: Service is a value import, not type-only',
  },
  {
    oldImport: 'type { ModelType }',
    newImport: '{ ModelType }',
    description: 'CRITICAL: ModelType is a value import, not type-only',
  },
  {
    oldImport: 'type { logger }',
    newImport: '{ logger }',
    description: 'CRITICAL: logger is a value import, not type-only',
  },
  {
    oldImport: 'type { createUniqueUuid }',
    newImport: '{ createUniqueUuid }',
    description: 'CRITICAL: createUniqueUuid is a value import, not type-only',
  },
  {
    oldImport: 'type { MemoryType }',
    newImport: '{ MemoryType }',
    description: 'CRITICAL: MemoryType is a value import, not type-only',
  },
];

/**
 * Model type mappings from the mega prompt and plugin-news analysis
 */
export const MODEL_TYPE_MAPPINGS: ModelTypeMapping[] = [
  { v1: 'ModelClass.SMALL', v2: 'ModelType.TEXT_SMALL', description: 'Small text model' },
  { v1: 'ModelClass.LARGE', v2: 'ModelType.TEXT_LARGE', description: 'Large text model' },
  { v1: 'ModelClass', v2: 'ModelType', description: 'Class renamed to Type' },
  { v1: 'stop', v2: 'stopSequences', description: 'Parameter name change' },
  { v1: 'max_tokens', v2: 'maxTokens', description: 'Parameter name change' },
  { v1: 'frequency_penalty', v2: 'frequencyPenalty', description: 'Parameter name change' },
  { v1: 'context', v2: 'prompt', description: 'Context parameter renamed to prompt in useModel' },
  { v1: 'model:', v2: '', description: 'Model type passed as first argument, not in options' },
  // Method changes
  { v1: 'runtime.language.generateText', v2: 'runtime.useModel', description: 'API method change' },
  { v1: 'runtime.messageManager.createMemory', v2: 'runtime.createMemory', description: 'Memory API change' },
  { v1: 'runtime.memory.create', v2: 'runtime.createMemory', description: 'Memory API change' },
  // Additional mappings from plugin-news
  { v1: 'presence_penalty', v2: 'presencePenalty', description: 'Parameter name change' },
  { v1: 'top_p', v2: 'topP', description: 'Parameter name change' },
  { v1: 'response_format', v2: 'responseFormat', description: 'Parameter name change' },
  { v1: 'seed', v2: 'seed', description: 'Parameter remains the same' },
  { v1: 'user', v2: 'name', description: 'ActionExample field name change' },
  { v1: 'role', v2: 'name', description: 'Message role field renamed' },
  { v1: 'Account', v2: 'Entity', description: 'Type renamed' },
  { v1: 'userId', v2: 'entityId', description: 'Field renamed' },
  { v1: 'accountId', v2: 'entityId', description: 'Field renamed' },
];

/**
 * Critical architecture issues from the mega prompt and plugin-news analysis
 */
export const ARCHITECTURE_ISSUES: ArchitectureIssue[] = [
  {
    type: 'missing-service',
    severity: 'critical',
    pattern: 'Service Layer Required (ONLY if plugin had service in V1)',
    solution: 'CRITICAL: Only create service if the plugin had a service in V1. Most plugins do NOT need services. Check main branch first.',
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
} from "@elizaos/core";`,
      correct: `import {
    type ActionExample,
    ModelType,
    type Content,
} from "@elizaos/core";`,
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
  
  // NEW: Additional handler signature patterns
  {
    type: 'handler-promise-boolean',
    severity: 'critical',
    pattern: 'Handler returns Promise<boolean>',
    solution: 'Remove Promise<boolean> return type from handler - V2 handlers do not return boolean',
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
      correct: 'handler: async (runtime, message, state, _options, callback) => { callback(content); }',
    },
  },
  
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
  
  // NEW: Additional memory patterns that cause issues
  {
    type: 'memory-upsert-pattern',
    severity: 'high',
    pattern: 'Using runtime.memory.upsert pattern',
    solution: 'Replace with runtime.createMemory or runtime.updateMemory',
    codeExample: {
      wrong: 'await runtime.memory.upsert({ ... });',
      correct: 'await runtime.createMemory({ ... }, \'messages\');',
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
      correct: 'await runtime.createMemory(memory, \'messages\');',
    },
  },
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
  // Test-specific issues from plugin-news analysis
  {
    type: 'test-import-issue',
    severity: 'critical',
    pattern: 'TestSuite import as value instead of type',
    solution: 'Import TestSuite as type-only import',
    codeExample: {
      wrong: `import { TestSuite } from "@elizaos/core";`,
      correct: `import type { TestSuite } from "@elizaos/core";`,
    },
  },
  {
    type: 'test-runtime-mock',
    severity: 'critical',
    pattern: 'Mock runtime missing V2 methods',
    solution: 'Add useModel and createMemory to mock runtime',
    codeExample: {
      wrong: `const runtime: IAgentRuntime = {
    // ... other properties
    language: {
        generateText: async () => "test",
    },
    ...overrides,
};`,
      correct: `const runtime = {
    // ... other properties
    useModel: async () => "test response",
    createMemory: async (memory: Memory, tableName: string) => {
        const id = memory.id || (uuidv4() as UUID);
        memories.set(id, { ...memory, id });
        return id;
    },
    language: {
        generateText: async () => "test",
    },
    ...overrides,
} as IAgentRuntime;`,
    },
  },
  {
    type: 'test-state-object',
    severity: 'high',
    pattern: 'Empty objects passed as State parameter',
    solution: 'Create proper State objects with required fields',
    codeExample: {
      wrong: 'await action.handler(runtime, message, {}, options, callback);',
      correct: `await action.handler(runtime, message, {
    values: {},
    data: {},
    text: ""
}, options, callback);`,
    },
  },
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
  // Additional test-specific patterns from plugin-news migration
  {
    type: 'test-command-issue',
    severity: 'critical',
    pattern: 'Using bun test instead of bun run test',
    solution: 'Use bun run test to invoke package.json script, not bun test',
    codeExample: {
      wrong: 'bun test',
      correct: 'bun run test # Runs "elizaos test" from package.json',
    },
  },
  {
    type: 'test-export-name',
    severity: 'high',
    pattern: 'Test suite export name mismatch',
    solution: 'Export test suite with consistent naming',
    codeExample: {
      wrong: `export const testSuite: TestSuite = { ... };
// or
export default testSuite;`,
      correct: `export const test: TestSuite = { ... };
export default test;`,
    },
  },
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
 * Break down the mega prompt into executable chunks
 */
export function parseIntoChunks(): PromptChunk[] {
  return [
    {
      id: 'phase1-file-structure',
      title: 'Phase 1: Outside Structure & Build System Migration',
      phase: 'file-structure-migration',
      content: `Update package.json to V2 structure with proper exports, repository info, and scripts.
Remove V1 configuration files (biome.json, vitest.config.ts, jest.config.js).
Update tsconfig.json and create tsconfig.build.json.
Update tsup.config.ts for proper ESM build.
Create CI/CD pipeline (.github/workflows/npm-deploy.yml).
Create images structure with README.md.
Update .gitignore and create .npmignore.`,
      criticalPoints: [
        'Package must be type: "module"',
        'Use ESM exports in package.json',
        'Remove all V1 test configs',
        'Create build-specific tsconfig',
        'Package name must follow @elizaos/plugin-{name} pattern',
      ],
    },
    {
      id: 'phase2-service-layer',
      title: 'Phase 2: Service Layer (CONDITIONAL - Check V1 First)',
      phase: 'core-structure-migration',
      content: `CRITICAL DECISION: Check if V1 plugin had a service/provider class.
      
If V1 plugin had NO service/provider:
- Set services: [] in plugin definition
- Skip service creation entirely
- Most plugins fall into this category

If V1 plugin had a service/provider:
- Create Service class extending base Service
- Implement static serviceType property (no explicit typing)
- Implement static start() method
- Implement stop() method for cleanup
- Implement capabilityDescription getter
- Add proper constructor with runtime parameter`,
      criticalPoints: [
        'CRITICAL: Check V1 plugin first - most plugins do NOT need services',
        'If no service in V1, use services: [] in plugin definition',
        'Only create service if V1 had one',
        'Remove explicit ServiceType annotation (just string literal)',
        'Services auto-register from services array',
      ],
    },
    {
      id: 'phase3-configuration',
      title: 'Phase 3: Configuration Migration',
      phase: 'configuration-migration',
      content: `Create config.ts with Zod validation.
Replace environment.ts usage.
Use runtime.getSetting() for configuration.
Add validation at plugin init.
Use z.coerce.number() for numeric environment variables.`,
      criticalPoints: [
        'Use Zod for schema validation',
        'runtime.getSetting() instead of process.env',
        'Validate config in service constructor',
        'Use z.coerce.number() for ALL numeric fields from env',
      ],
    },
    {
      id: 'phase4-file-migration',
      title: 'Phase 4: File-by-File Code Migration',
      phase: 'actions-migration',
      content: `Process each file completely before moving to the next.
Migrate service files if they exist.
Migrate all action files with V2 patterns.
Migrate provider files to standard interface.
Update all imports and fix all V1 patterns.
Fix all type imports to use type-only syntax.
Update all model API calls.
Fix all parameter names.`,
      criticalPoints: [
        'Process files one by one',
        'Fix all issues in each file completely',
        'Don\'t edit service if not needed',
        'Clean up unnecessary files after migration',
        'Separate type imports from value imports',
        'Use runtime.useModel not language.generateText',
        'Update all ActionExample role to name',
      ],
    },
    {
      id: 'phase5-testing',
      title: 'Phase 5: Test Infrastructure Creation',
      phase: 'testing-infrastructure',
      content: `Delete V1 __tests__ directory completely.
Delete all V1 test configurations.
Create V2 test structure (src/test/).
Copy utils.ts from plugin-coinmarketcap.
Create comprehensive test suite.
Register test suite in plugin definition.
Fix all test type imports.
Update mock runtime for V2.`,
      criticalPoints: [
        'V1 __tests__/ → V2 src/test/',
        'Follow plugin-coinmarketcap structure EXACTLY',
        'Use createMemory not memory.create in mocks',
        'No stubs - full implementation',
        'TestSuite is type-only import',
        'Add useModel to mock runtime',
        'Create proper State objects',
      ],
    },
    {
      id: 'phase6-documentation',
      title: 'Phase 6: Documentation Structure',
      phase: 'documentation-assets',
      content: `Create comprehensive README.md.
Add images/ directory with required assets.
Document configuration requirements.
Document usage examples.
Add development instructions.
Update package name in all documentation.`,
      criticalPoints: [
        'Include installation instructions',
        'Document all environment variables',
        'Add usage examples',
        'Include development commands',
        'Use correct @elizaos/plugin-{name} pattern',
      ],
    },
  ];
}










