import type { PromptChunk, ImportMapping, ModelTypeMapping, ArchitectureIssue, TestingPattern } from './types.js';

/**
 * Critical import mappings from the mega prompt
 */
export const IMPORT_MAPPINGS: ImportMapping[] = [
  {
    oldImport: 'ModelClass',
    newImport: 'ModelType',
    description: 'ModelClass is renamed to ModelType in V2',
  },
  {
    oldImport: 'elizaLogger',
    newImport: 'logger',
    description: 'elizaLogger is renamed to logger in V2',
  },
  {
    oldImport: /user:\s*["']{{user\d+}}["']/g,
    newImport: 'name: "{{user1}}"',
    description: 'ActionExample field "user" renamed to "name"',
  },
];

/**
 * Model type mappings from the mega prompt
 */
export const MODEL_TYPE_MAPPINGS: ModelTypeMapping[] = [
  { v1: 'ModelClass.SMALL', v2: 'ModelType.TEXT_SMALL', description: 'Small text model' },
  { v1: 'ModelClass.LARGE', v2: 'ModelType.TEXT_LARGE', description: 'Large text model' },
  { v1: 'stop', v2: 'stopSequences', description: 'Parameter name change' },
  { v1: 'max_tokens', v2: 'maxTokens', description: 'Parameter name change' },
  { v1: 'frequency_penalty', v2: 'frequencyPenalty', description: 'Parameter name change' },
];

/**
 * Critical architecture issues from the mega prompt
 */
export const ARCHITECTURE_ISSUES: ArchitectureIssue[] = [
  {
    type: 'missing-service',
    severity: 'critical',
    pattern: 'Missing Service Layer',
    solution: 'Create Service class extending base Service with lifecycle methods',
    codeExample: {
      wrong: `export const myPlugin: Plugin = {
    name: "plugin-name",
    actions: actions,
    evaluators: [] // Outdated pattern
};`,
      correct: `export class MyService extends Service {
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

const myPlugin: Plugin = {
    name: 'my-plugin',
    description: 'Plugin description',
    services: [MyService],
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
    solution: 'Update handler to correct V2 signature',
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
    _options: any,
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
});`,
      correct: `export const ConfigSchema = z.object({
    MAX_FILE_SIZE: z.coerce.number().default(10485760), // 10MB default
    TIMEOUT: z.coerce.number().optional(),
    // For required numbers without defaults:
    REQUIRED_NUMBER: z.coerce.number().min(1),
});`,
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
      ],
    },
    {
      id: 'phase2-service-layer',
      title: 'Phase 2: Service Layer Creation',
      phase: 'core-structure-migration',
      content: `Create Service class extending base Service.
Implement static serviceType property.
Implement static start() method.
Implement stop() method for cleanup.
Implement capabilityDescription getter.
Add proper constructor with runtime parameter.`,
      criticalPoints: [
        'Only if plugin requires service',
        'Must extend base Service class',
        'Proper lifecycle methods required',
        'Service registration in plugin definition',
      ],
    },
    {
      id: 'phase3-configuration',
      title: 'Phase 3: Configuration Migration',
      phase: 'configuration-migration',
      content: `Create config.ts with Zod validation.
Replace environment.ts usage.
Use runtime.getSetting() for configuration.
Add validation at plugin init.`,
      criticalPoints: [
        'Use Zod for schema validation',
        'runtime.getSetting() instead of process.env',
        'Validate config in service constructor',
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
Update all imports and fix all V1 patterns.`,
        criticalPoints: [
          'Process files one by one',
          'Fix all issues in each file completely',
          'Don\'t edit service if not needed',
          'Clean up unnecessary files after migration',
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
Register test suite in plugin definition.`,
      criticalPoints: [
        'V1 __tests__/ → V2 src/test/',
        'Follow plugin-coinmarketcap structure',
        'Use createMemory not memory.create',
        'No stubs - full implementation',
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
Add development instructions.`,
      criticalPoints: [
        'Include installation instructions',
        'Document all environment variables',
        'Add usage examples',
        'Include development commands',
      ],
    },
  ];
}

/**
 * Get critical patterns to avoid
 */
export function getCriticalPatternsToAvoid(): string[] {
  return [
    'Do NOT store complex objects in Memory',
    'Do NOT use custom error classes',
    'Do NOT perform direct file operations',
    'Do NOT skip entity/room management',
    'Do NOT add non-standard fields to Content interface',
    'Do NOT use vitest - only elizaos test',
    'Do NOT create temporary files for iteration',
  ];
}

/**
 * Get V2 code quality standards
 */
export function getCodeQualityStandards(): string[] {
  return [
    'Use double quotes consistently',
    'Proper parameter formatting with line breaks',
    'Consistent trailing commas',
    'Group type imports together',
    'Run npm run format after changes',
  ];
}

/**
 * Get success metrics checklist
 */
export function getSuccessMetrics(): string[] {
  return [
    'Clean build with no TypeScript errors',
    'All imports and exports type correctly',
    'Service registers and starts correctly',
    'Actions validate and execute properly',
    'Tests pass with elizaos test',
    'Memory operations use V2 patterns',
    'No custom Content fields',
  ];
}

/**
 * Get testing patterns from the mega prompt
 */
export function getTestingPatterns(): TestingPattern[] {
  return [
    {
      name: 'ElizaOS Test Framework',
      template: 'elizaos test',
      requiredImports: [
        '@elizaos/core',
        './utils',
        '../index'
      ],
    },
    {
      name: 'Test File Templates',
      template: 'Use exact utils.ts and dynamic test.ts templates',
      requiredImports: [
        '@elizaos/core',
        './utils',
        '../index',
        'uuid'
      ],
    },
  ];
}
