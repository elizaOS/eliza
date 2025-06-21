/**
 * TESTING PATTERNS MODULE
 *
 * Responsibilities:
 * - Test-specific migration patterns
 * - Test structure validation
 * - Mock runtime patterns
 * - Test command and execution patterns
 * - Test suite configuration
 * - Provider-specific testing patterns
 */

import type { ArchitectureIssue, TestingPattern } from '../types.js';

/**
 * Test-specific patterns and issues from plugin-news analysis
 */
export const TESTING_PATTERNS: ArchitectureIssue[] = [
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
    type: 'test-file-location',
    severity: 'high',
    pattern: 'Wrong test file location or naming',
    solution: 'Test files must be in src/test/ directory with proper naming',
    codeExample: {
      wrong: `__tests__/plugin.test.ts
src/test.test.ts
test/unit.test.ts`,
      correct: `src/test/test.ts
src/test/utils.ts`,
    },
  },
  {
    type: 'test-directory-structure',
    severity: 'high',
    pattern: 'V1 test directory structure',
    solution: 'Migrate from __tests__ to src/test/ structure',
    codeExample: {
      wrong: `__tests__/
  actions/
    action.test.ts
  services/
    service.test.ts
  setup.ts`,
      correct: `src/test/
  test.ts
  utils.ts`,
    },
  },
  {
    type: 'test-vitest-config',
    severity: 'critical',
    pattern: 'Vitest configuration present',
    solution: 'Remove all vitest configurations - use ElizaOS test framework only',
    codeExample: {
      wrong: `vitest.config.ts
jest.config.js
"test": "vitest"`,
      correct: `# No vitest config files
"test": "elizaos test"`,
    },
  },
  {
    type: 'test-mock-memory-creation',
    severity: 'high',
    pattern: 'Mock using old memory creation API',
    solution: 'Update mock to use V2 memory creation API',
    codeExample: {
      wrong: `createMemory: async (memory: Memory) => {
    return runtime.messageManager.createMemory(memory);
}`,
      correct: `createMemory: async (memory: Memory, tableName: string) => {
    const id = memory.id || (uuidv4() as UUID);
    memories.set(id, { ...memory, id });
    return id;
}`,
    },
  },
  {
    type: 'test-mock-use-model',
    severity: 'high',
    pattern: 'Mock missing useModel method',
    solution: 'Add useModel method to mock runtime',
    codeExample: {
      wrong: `const runtime = {
    language: { generateText: async () => "test" },
    // missing useModel
} as IAgentRuntime;`,
      correct: `const runtime = {
    useModel: async (modelType: ModelType, prompt: string) => "test response",
    language: { generateText: async () => "test" },
} as IAgentRuntime;`,
    },
  },
  {
    type: 'test-registration-in-plugin',
    severity: 'high',
    pattern: 'Missing test suite registration in plugin',
    solution: 'Add test suite to plugin definition',
    codeExample: {
      wrong: `const myPlugin: Plugin = {
    name: 'my-plugin',
    actions: [...],
    providers: [...],
    // missing tests
};`,
      correct: `import testSuite from "./test/test.js";

const myPlugin: Plugin = {
    name: 'my-plugin',
    actions: [...],
    providers: [...],
    tests: [testSuite],
};`,
    },
  },
  {
    type: 'test-import-extension',
    severity: 'high',
    pattern: 'Wrong import extension for test files',
    solution: 'Use .js extension when importing test files',
    codeExample: {
      wrong: `import testSuite from "./test/test.ts";
import { createMockRuntime } from "./test/utils.ts";`,
      correct: `import testSuite from "./test/test.js";
import { createMockRuntime } from "./test/utils.js";`,
    },
  },
  {
    type: 'test-suite-class-vs-object',
    severity: 'medium',
    pattern: 'Using class instead of object for test suite',
    solution: 'Use object literal for test suite, not class',
    codeExample: {
      wrong: `export class MyTestSuite implements TestSuite {
    name = 'my-test';
    tests = [...];
}`,
      correct: `export const test: TestSuite = {
    name: 'my-test',
    description: 'Test description',
    tests: [...],
};`,
    },
  },
  {
    type: 'test-memory-interface',
    severity: 'high',
    pattern: 'Incomplete Memory objects in tests',
    solution: 'Use complete Memory interface with all required fields',
    codeExample: {
      wrong: `const testMessage = {
    content: { text: "test" },
    id: "test-id"
};`,
      correct: `const testMessage: Memory = {
    id: "test-id" as UUID,
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: "test-room" as UUID,
    content: { text: "test", source: "test" },
    createdAt: Date.now()
};`,
    },
  },
  {
    type: 'test-callback-missing',
    severity: 'high',
    pattern: 'Missing callback parameter in test handlers',
    solution: 'Include callback parameter in all handler tests',
    codeExample: {
      wrong: `await action.handler(runtime, message, state, options);`,
      correct: `const callback = vi.fn();
await action.handler(runtime, message, state, options, callback);
expect(callback).toHaveBeenCalled();`,
    },
  },
  {
    type: 'test-async-without-await',
    severity: 'medium',
    pattern: 'Async test functions not awaited',
    solution: 'Ensure all async operations in tests are properly awaited',
    codeExample: {
      wrong: `fn: async (runtime: IAgentRuntime) => {
    action.validate(runtime, message, state); // Missing await
}`,
      correct: `fn: async (runtime: IAgentRuntime) => {
    await action.validate(runtime, message, state);
}`,
    },
  },
  {
    type: 'test-handler-signature',
    severity: 'critical',
    pattern: 'Test handler signature does not match V2 requirements',
    solution: 'Update test handler calls to match V2 signature with all required parameters',
    codeExample: {
      wrong: `await action.handler(runtime, message, state);`,
      correct: `const callback = vi.fn();
await action.handler(runtime, message, state, {}, callback);
expect(callback).toHaveBeenCalled();`,
    },
  },
  {
    type: 'test-mock-compose-state',
    severity: 'high',
    pattern: 'Mock runtime missing composeState method with V2 signature',
    solution: 'Add composeState method to mock runtime with enhanced signature',
    codeExample: {
      wrong: `const runtime = {
    composeState: async (message: Memory) => ({ values: {}, data: {}, text: "" }),
} as IAgentRuntime;`,
      correct: `const runtime = {
    composeState: async (message: Memory, providers?: string[], allowEmpty?: boolean) => ({ 
        values: {}, 
        data: {}, 
        text: "" 
    }),
} as IAgentRuntime;`,
    },
  },
  {
    type: 'test-model-type-usage',
    severity: 'critical',
    pattern: 'Test using ModelClass instead of ModelType',
    solution: 'Update test mocks to use ModelType instead of ModelClass',
    codeExample: {
      wrong: `useModel: async (modelClass: ModelClass, options: any) => "test"`,
      correct: `useModel: async (modelType: ModelType, options: { prompt: string }) => "test response"`,
    },
  },
];

/**
 * Critical testing patterns for V1 to V2 migration
 */
export const CRITICAL_TESTING_PATTERNS: TestingPattern[] = [
  {
    name: 'action-test-template',
    template: `import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelType, type IAgentRuntime, type Memory } from '@elizaos/core';
import type { TestSuite } from '@elizaos/core/test';
import { myAction } from '../actions/myAction.js';

describe('MyAction Tests', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock runtime with V2 methods
    mockRuntime = {
      agentId: 'test-agent',
      composeState: vi.fn().mockResolvedValue({
        userId: 'test-user',
        userName: 'TestUser',
        agentName: 'TestAgent',
        roomId: 'test-room',
        bio: 'Test bio',
        recentMessages: [],
        recentMessagesData: [],
      }),
      useModel: vi.fn().mockResolvedValue('<response>Success</response>'),
      createMemory: vi.fn().mockResolvedValue(undefined),
      getService: vi.fn().mockReturnValue(null),
      getSetting: vi.fn().mockReturnValue(undefined),
    } as any;

    mockMessage = {
      id: 'test-message-id',
      entityId: 'test-user',
      agentId: 'test-agent',
      roomId: 'test-room',
      content: { text: 'Test message', source: 'test' },
      createdAt: Date.now(),
    };

    mockCallback = vi.fn();
  });

  it('should validate successfully for valid input', async () => {
    const result = await myAction.validate(mockRuntime, mockMessage, {});
    expect(result).toBe(true);
  });

  it('should execute handler successfully', async () => {
    await myAction.handler(mockRuntime, mockMessage, {}, {}, mockCallback);
    
    expect(mockCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.any(String),
        source: expect.any(String),
      })
    );
  });
});

const testSuite: TestSuite = {
  name: 'MyAction Integration Test',
  description: 'Integration test for MyAction with live runtime',
  testFunction: async (runtime: IAgentRuntime) => {
    const message = {
      id: 'test-message',
      entityId: 'test-user',
      agentId: runtime.agentId,
      roomId: 'test-room',
      content: { text: 'Test action', source: 'test' },
      createdAt: Date.now(),
    };

    // Test validation
    const isValid = await myAction.validate(runtime, message, {});
    if (!isValid) {
      throw new Error('Action validation failed');
    }

    // Test execution
    let callbackResult: any;
    const callback = (result: any) => {
      callbackResult = result;
    };

    await myAction.handler(runtime, message, {}, {}, callback);

    if (!callbackResult) {
      throw new Error('Action handler did not call callback');
    }

    return callbackResult;
  },
};

export default testSuite;`,
    requiredImports: [
      "import { beforeEach, describe, expect, it, vi } from 'vitest';",
      "import { ModelType, type IAgentRuntime, type Memory } from '@elizaos/core';",
      "import type { TestSuite } from '@elizaos/core/test';",
    ],
  },

  // PROVIDER-SPECIFIC TESTING PATTERNS
  {
    name: 'provider-test-template',
    template: `import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type IAgentRuntime, type Memory, type State } from '@elizaos/core';
import type { TestSuite } from '@elizaos/core/test';
import { walletProvider } from '../providers/wallet.js';
import { WALLET_SERVICE_NAME } from '../constants.js';

describe('WalletProvider Tests', () => {
  let mockRuntime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;
  let mockWalletService: any;

  beforeEach(() => {
    // Mock wallet service
    mockWalletService = {
      getCachedData: vi.fn().mockResolvedValue({
        address: '0x1234567890123456789012345678901234567890',
        balances: [
          { chain: 'ethereum', balance: '1.5', symbol: 'ETH', name: 'Ethereum' },
          { chain: 'base', balance: '100.0', symbol: 'USDC', name: 'Base' },
        ],
      }),
    };

    // Mock runtime with provider-specific methods
    mockRuntime = {
      agentId: 'test-agent',
      getService: vi.fn().mockImplementation((serviceName: string) => {
        if (serviceName === WALLET_SERVICE_NAME) {
          return mockWalletService;
        }
        return null;
      }),
      getCache: vi.fn().mockResolvedValue(null),
      setCache: vi.fn().mockResolvedValue(undefined),
      getSetting: vi.fn().mockImplementation((key: string) => {
        const settings: Record<string, any> = {
          'WALLET_PRIVATE_KEY': '0xtest123',
          'ETHEREUM_RPC_URL': 'https://eth.llamarpc.com',
          'BASE_RPC_URL': 'https://base.llamarpc.com',
        };
        return settings[key];
      }),
    } as any;

    mockMessage = {
      id: 'test-message-id',
      entityId: 'test-user',
      agentId: 'test-agent',
      roomId: 'test-room',
      content: { text: 'Get wallet balance', source: 'test' },
      createdAt: Date.now(),
    };

    mockState = {
      userId: 'test-user',
      userName: 'TestUser',
      agentName: 'TestAgent',
      roomId: 'test-room',
      bio: 'Test bio',
      recentMessages: [],
      recentMessagesData: [],
    } as State;
  });

  it('should return provider result with service integration', async () => {
    const result = await walletProvider.get(mockRuntime, mockMessage, mockState);
    
           expect(result).toMatchObject({
         text: expect.stringContaining("TestAgent's Wallet Data"),
      data: {
        address: '0x1234567890123456789012345678901234567890',
        balances: expect.arrayContaining([
          expect.objectContaining({
            chain: 'ethereum',
            balance: '1.5',
            symbol: 'ETH',
          }),
        ]),
      },
      values: {
        address: '0x1234567890123456789012345678901234567890',
        balances: expect.any(String),
      },
    });
  });

  it('should fallback to direct fetching when service unavailable', async () => {
    // Mock service as unavailable
    mockRuntime.getService = vi.fn().mockReturnValue(null);
    
    const result = await walletProvider.get(mockRuntime, mockMessage, mockState);
    
    expect(result).toMatchObject({
      text: expect.any(String),
      data: expect.any(Object),
      values: expect.any(Object),
    });
  });

  it('should handle service errors gracefully', async () => {
    // Mock service to throw error
    mockWalletService.getCachedData = vi.fn().mockRejectedValue(new Error('Service error'));
    
    const result = await walletProvider.get(mockRuntime, mockMessage, mockState);
    
    expect(result).toMatchObject({
      text: expect.stringContaining("Error getting wallet provider"),
      data: {},
      values: {},
    });
  });
});

const testSuite: TestSuite = {
  name: 'WalletProvider Integration Test',
  description: 'Integration test for WalletProvider with live runtime and service',
  testFunction: async (runtime: IAgentRuntime) => {
    const message = {
      id: 'test-message',
      entityId: 'test-user',
      agentId: runtime.agentId,
      roomId: 'test-room',
      content: { text: 'Get wallet balance', source: 'test' },
      createdAt: Date.now(),
    };

    const state = await runtime.composeState(message, ['RECENT_MESSAGES']);

    // Test provider execution
    const result = await walletProvider.get(runtime, message, state);

    if (!result || typeof result !== 'object') {
      throw new Error('Provider did not return valid result object');
    }

    if (!result.text || !result.data || !result.values) {
      throw new Error('Provider result missing required properties (text, data, values)');
    }

    return result;
  },
};

export default testSuite;`,
    requiredImports: [
      "import { beforeEach, describe, expect, it, vi } from 'vitest';",
      "import { type IAgentRuntime, type Memory, type State } from '@elizaos/core';",
      "import type { TestSuite } from '@elizaos/core/test';",
    ],
  },

  {
    name: 'service-test-template',
    template: `import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type IAgentRuntime } from '@elizaos/core';
import type { TestSuite } from '@elizaos/core/test';
import { MyService } from '../service.js';

describe('MyService Tests', () => {
  let mockRuntime: IAgentRuntime;
  let service: MyService;

  beforeEach(async () => {
    mockRuntime = {
      agentId: 'test-agent',
      getSetting: vi.fn().mockImplementation((key: string) => {
        const settings: Record<string, any> = {
          'MY_API_KEY': 'test-api-key',
          'MY_CONFIG': { timeout: 5000 },
        };
        return settings[key];
      }),
      getCache: vi.fn().mockResolvedValue(null),
      setCache: vi.fn().mockResolvedValue(undefined),
    } as any;

    service = await MyService.start(mockRuntime) as MyService;
  });

  it('should initialize service correctly', () => {
    expect(service).toBeInstanceOf(MyService);
    expect(MyService.serviceType).toBe('my-service');
  });

  it('should have capability description', () => {
    const description = service.capabilityDescription;
    expect(description).toBe('Service capability description');
  });

  it('should handle cached data retrieval', async () => {
    const mockData = { test: 'data' };
    service.config = { apiKey: 'test-key' }; // Ensure config is accessible
    
    // Mock cache miss then hit
    mockRuntime.getCache = vi.fn()
      .mockResolvedValueOnce(null)  // First call returns null (cache miss)
      .mockResolvedValueOnce(mockData); // Second call returns data (cache hit)

    const result1 = await service.getCachedData();
    const result2 = await service.getCachedData();

    expect(result2).toEqual(mockData);
  });

  it('should stop cleanly', async () => {
    await service.stop();
    // Service should cleanup resources
  });
});

const testSuite: TestSuite = {
  name: 'MyService Integration Test',
  description: 'Integration test for MyService with live runtime',
  testFunction: async (runtime: IAgentRuntime) => {
    const service = await MyService.start(runtime);

    if (!service) {
      throw new Error('Service failed to start');
    }

    if (typeof service.capabilityDescription !== 'string') {
      throw new Error('Service missing capability description');
    }

    // Test service functionality
    const result = await service.getCachedData();
    
    // Cleanup
    await service.stop();

    return { serviceStarted: true, capabilityDescription: service.capabilityDescription };
  },
};

export default testSuite;`,
    requiredImports: [
      "import { beforeEach, describe, expect, it, vi } from 'vitest';",
      "import { type IAgentRuntime } from '@elizaos/core';",
      "import type { TestSuite } from '@elizaos/core/test';",
    ],
  },

  // PROVIDER CONFIGURATION TESTING
  {
    name: 'provider-config-test-template',
    template: `import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type IAgentRuntime } from '@elizaos/core';
import { genConfigFromRuntime, initWalletProvider } from '../providers/wallet.js';

describe('Provider Configuration Tests', () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mockRuntime = {
      agentId: 'test-agent',
      character: {
        settings: {
          chains: ['ethereum', 'base'],
        },
      },
      getSetting: vi.fn().mockImplementation((key: string) => {
        const settings: Record<string, any> = {
          'ETHEREUM_RPC_URL': 'https://eth.llamarpc.com',
          'BASE_RPC_URL': 'https://base.llamarpc.com',
          'WALLET_PRIVATE_KEY': '0xtest123',
          'TEE_MODE': 'OFF',
        };
        return settings[key];
      }),
    } as any;
  });

  it('should generate configuration from runtime settings', () => {
    const config = genConfigFromRuntime(mockRuntime);
    
    expect(config).toHaveProperty('ethereum');
    expect(config).toHaveProperty('base');
    expect(config.ethereum).toMatchObject({
      name: expect.any(String),
      rpcUrl: 'https://eth.llamarpc.com',
    });
  });

  it('should handle missing chain configuration gracefully', () => {
    mockRuntime.character.settings.chains = ['ethereum', 'unsupported-chain'];
    
    const config = genConfigFromRuntime(mockRuntime);
    
    expect(config).toHaveProperty('ethereum');
    expect(config).not.toHaveProperty('unsupported-chain');
  });

  it('should fallback to default chains when none configured', () => {
    mockRuntime.character.settings.chains = [];
    
    const config = genConfigFromRuntime(mockRuntime);
    
    expect(config).toHaveProperty('ethereum');
    expect(config).toHaveProperty('base');
  });

  it('should initialize provider with configuration', async () => {
    const provider = await initWalletProvider(mockRuntime);
    
    expect(provider).toBeDefined();
    expect(provider.configuration).toMatchObject({
      ethereum: expect.any(Object),
      base: expect.any(Object),
    });
  });
});`,
    requiredImports: [
      "import { beforeEach, describe, expect, it, vi } from 'vitest';",
      "import { type IAgentRuntime } from '@elizaos/core';",
    ],
  },

  // Existing patterns continue here...
  {
    name: 'plugin-test-template',
    template: `import { beforeEach, describe, expect, it } from 'vitest';
import { type IAgentRuntime } from '@elizaos/core';
import type { TestSuite } from '@elizaos/core/test';
import myPlugin from '../index.js';

describe('MyPlugin Tests', () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mockRuntime = {
      agentId: 'test-agent',
      getSetting: () => undefined,
    } as any;
  });

  it('should have correct plugin structure', () => {
    expect(myPlugin.name).toBe('my-plugin');
    expect(myPlugin.description).toBeDefined();
    expect(Array.isArray(myPlugin.actions)).toBe(true);
    expect(Array.isArray(myPlugin.providers)).toBe(true);
    expect(Array.isArray(myPlugin.tests)).toBe(true);
  });

  it('should initialize correctly', async () => {
    if (myPlugin.init) {
      await expect(myPlugin.init({}, mockRuntime)).resolves.not.toThrow();
    }
  });
});

const testSuite: TestSuite = {
  name: 'MyPlugin Integration Test',
  description: 'Integration test for MyPlugin with live runtime',
  testFunction: async (runtime: IAgentRuntime) => {
    if (myPlugin.init) {
      await myPlugin.init({}, runtime);
    }
    
    return { pluginLoaded: true, name: myPlugin.name };
  },
};

export default testSuite;`,
    requiredImports: [
      "import { beforeEach, describe, expect, it } from 'vitest';",
      "import { type IAgentRuntime } from '@elizaos/core';",
      "import type { TestSuite } from '@elizaos/core/test';",
    ],
  },

  // ... existing patterns continue ...
];

/**
 * Get all testing patterns
 */
export function getTestingPatterns(): ArchitectureIssue[] {
  return TESTING_PATTERNS;
}

/**
 * Find testing pattern by type
 */
export function findTestingPattern(type: string): ArchitectureIssue | undefined {
  return TESTING_PATTERNS.find((pattern) => pattern.type === type);
}

/**
 * Get patterns by severity
 */
export function getTestingPatternsBySeverity(
  severity: 'critical' | 'high' | 'medium'
): ArchitectureIssue[] {
  return TESTING_PATTERNS.filter((pattern) => pattern.severity === severity);
}

/**
 * Get patterns by category
 */
export function getTestingPatternsByCategory() {
  return {
    imports: TESTING_PATTERNS.filter((p) => p.type.includes('import')),
    structure: TESTING_PATTERNS.filter(
      (p) => p.type.includes('structure') || p.type.includes('directory')
    ),
    mocking: TESTING_PATTERNS.filter((p) => p.type.includes('mock')),
    execution: TESTING_PATTERNS.filter(
      (p) => p.type.includes('command') || p.type.includes('export')
    ),
    objects: TESTING_PATTERNS.filter((p) => p.type.includes('memory') || p.type.includes('state')),
    registration: TESTING_PATTERNS.filter((p) => p.type.includes('registration')),
  };
}

/**
 * Check if code needs testing pattern fixes
 */
export function checkForTestingIssues(code: string): ArchitectureIssue[] {
  return TESTING_PATTERNS.filter((pattern) => {
    if (pattern.codeExample?.wrong) {
      // Check if code contains patterns that match the wrong examples
      const wrongPattern = pattern.codeExample.wrong.replace(/\s+/g, ' ').trim();
      const codeNormalized = code.replace(/\s+/g, ' ').trim();
      return codeNormalized.includes(wrongPattern.slice(0, 30)); // Check first 30 chars
    }
    return false;
  });
}

/**
 * Get critical testing issues that must be fixed
 */
export function getCriticalTestingIssues(): ArchitectureIssue[] {
  return TESTING_PATTERNS.filter((pattern) => pattern.severity === 'critical');
}
