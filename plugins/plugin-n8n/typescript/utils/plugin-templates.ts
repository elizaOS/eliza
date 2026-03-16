import type { PluginSpecification } from "../types";

export const generateActionCode = (
  name: string,
  description: string,
  parameters?: Record<string, string>
): string => {
  const camelCaseName = name.charAt(0).toLowerCase() + name.slice(1);

  return `import {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  type ActionExample
} from "@elizaos/core";

export const ${camelCaseName}Action: Action = {
  name: "${name}",
  description: "${description}",
  similes: [
    "${name.toLowerCase()}",
    "${description.toLowerCase().split(" ").slice(0, 3).join(" ")}"
  ],
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Please ${name.toLowerCase()}"
        }
      } as ActionExample,
      {
        name: "agent", 
        content: {
          text: "I'll ${description.toLowerCase()} for you."
        }
      } as ActionExample
    ]
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ): Promise<boolean> => {
    return message.content.text.length > 0;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: string },
    callback?: HandlerCallback
  ): Promise<string> => {
    try {
      ${
        parameters
          ? `
      // Expected parameters: ${JSON.stringify(parameters, null, 2)}
      `
          : ""
      }
      
      const result = "Successfully executed ${name}";
      
      if (callback) {
        await callback({
          text: result,
          type: "text"
        });
      }
      
      return result;
    } catch (error) {
      const errorMessage = \`Failed to execute ${name}: \${(error as Error).message}\`;
      if (callback) {
        await callback({
          text: errorMessage,
          type: "error"
        });
      }
      return errorMessage;
    }
  }
};
`;
};

export const generateProviderCode = (
  name: string,
  description: string,
  dataStructure?: Record<string, string>
): string => {
  const camelCaseName = name.charAt(0).toLowerCase() + name.slice(1);

  return `import {
  Provider,
  IAgentRuntime,
  Memory,
  State,
  ProviderResult
} from "@elizaos/core";

export const ${camelCaseName}Provider: Provider = {
  name: "${name}",
  description: "${description}",
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
  ): Promise<ProviderResult> => {
    try {
      ${
        dataStructure
          ? `
      // Expected data structure: ${JSON.stringify(dataStructure, null, 2)}
      `
          : ""
      }
      
      const data = {
        timestamp: new Date().toISOString(),
        source: "${name}"
      };
      
      return {
        text: \`${name} data: \${JSON.stringify(data)}\`,
        data: data
      };
    } catch (error) {
      return {
        text: \`${name} provider error: \${(error as Error).message}\`,
        data: { error: (error as Error).message }
      };
    }
  }
};
`;
};

export const generateServiceCode = (
  name: string,
  description: string,
  methods?: string[]
): string => {
  const className = name.charAt(0).toUpperCase() + name.slice(1);

  return `import { Service, IAgentRuntime, logger } from "@elizaos/core";

declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    ${name.toUpperCase()}: "${name.toLowerCase()}";
  }
}

export class ${className} extends Service {
  static serviceType: "${name.toLowerCase()}" = "${name.toLowerCase()}";
  
  public readonly capabilityDescription: string = "${description}";
  
  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }
  
  async stop(): Promise<void> {
    logger.info(\`Stopping ${className}\`);
  }
  
  static async start(runtime: IAgentRuntime): Promise<${className}> {
    const service = new ${className}(runtime);
    await service.initialize(runtime);
    return service;
  }
  
  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    logger.info(\`Initializing ${className}\`);
  }
  
  ${
    methods
      ? methods
          .map(
            (method) => `
  async ${method}(...args: unknown[]): Promise<unknown> {
    logger.info(\`${className}.${method} called\`);
    return null;
  }
  `
          )
          .join("\n")
      : ""
  }
}
`;
};

export const generateEvaluatorCode = (
  name: string,
  description: string,
  triggers?: string[]
): string => {
  const camelCaseName = name.charAt(0).toLowerCase() + name.slice(1);

  return `import {
  Evaluator,
  IAgentRuntime,
  Memory,
  State,
  logger
} from "@elizaos/core";

export const ${camelCaseName}Evaluator: Evaluator = {
  name: "${name}",
  description: "${description}",
  similes: [
    "${name.toLowerCase()}",
    "${description.toLowerCase().split(" ").slice(0, 3).join(" ")}"
  ],
  examples: [
    {
      context: "When evaluating ${name.toLowerCase()}",
      messages: [
        {
          name: "user",
          content: {
            text: "Analyze this for ${name.toLowerCase()}"
          }
        }
      ],
      expectedOutcome: "Should trigger ${name} evaluation"
    }
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ): Promise<boolean> => {
    ${
      triggers && triggers.length > 0
        ? `
    // Configured triggers: ${triggers.join(", ")}
    `
        : ""
    }
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ): Promise<string> => {
    try {
      logger.info(\`Running ${name} evaluator\`);
      
      const content = message.content.text;
      
      const result = {
        evaluated: true,
        score: 0.5,
        details: "Evaluation result"
      };
      
      return \`${name} evaluation complete: \${JSON.stringify(result)}\`;
    } catch (error) {
      logger.error(\`${name} evaluator error:\`, error);
      return \`${name} evaluation failed: \${(error as Error).message}\`;
    }
  }
};
`;
};

export const generatePluginIndex = (
  pluginName: string,
  specification: PluginSpecification
): string => {
  const cleanPluginName = pluginName.replace(/^@[^/]+\//, "").replace(/[-_]/g, "");
  const pluginClassName = `${cleanPluginName.charAt(0).toUpperCase()}${cleanPluginName.slice(1)}Plugin`;

  const imports: string[] = [];
  const exports: string[] = [];

  if (specification.actions?.length) {
    specification.actions.forEach((action) => {
      const camelCaseName = action.name.charAt(0).toLowerCase() + action.name.slice(1);
      imports.push(`import { ${camelCaseName}Action } from './actions/${action.name}';`);
      exports.push(`${camelCaseName}Action`);
    });
  }

  if (specification.providers?.length) {
    specification.providers.forEach((provider) => {
      const camelCaseName = provider.name.charAt(0).toLowerCase() + provider.name.slice(1);
      imports.push(`import { ${camelCaseName}Provider } from './providers/${provider.name}';`);
      exports.push(`${camelCaseName}Provider`);
    });
  }

  if (specification.services?.length) {
    specification.services.forEach((service) => {
      imports.push(`import { ${service.name} } from './services/${service.name}';`);
      exports.push(`${service.name}`);
    });
  }

  if (specification.evaluators?.length) {
    specification.evaluators.forEach((evaluator) => {
      const camelCaseName = evaluator.name.charAt(0).toLowerCase() + evaluator.name.slice(1);
      imports.push(`import { ${camelCaseName}Evaluator } from './evaluators/${evaluator.name}';`);
      exports.push(`${camelCaseName}Evaluator`);
    });
  }

  return `import { Plugin } from "@elizaos/core";
${imports.join("\n")}

export const ${pluginClassName}: Plugin = {
  name: "${pluginName}",
  description: "${specification.description}",
  ${
    specification.actions?.length
      ? `
  actions: [
    ${specification.actions.map((a) => `${a.name.charAt(0).toLowerCase() + a.name.slice(1)}Action`).join(",\n    ")}
  ],`
      : ""
  }
  ${
    specification.providers?.length
      ? `
  providers: [
    ${specification.providers.map((p) => `${p.name.charAt(0).toLowerCase() + p.name.slice(1)}Provider`).join(",\n    ")}
  ],`
      : ""
  }
  ${
    specification.services?.length
      ? `
  services: [
    ${specification.services.map((s) => `${s.name}`).join(",\n    ")}
  ],`
      : ""
  }
  ${
    specification.evaluators?.length
      ? `
  evaluators: [
    ${specification.evaluators.map((e) => `${e.name.charAt(0).toLowerCase() + e.name.slice(1)}Evaluator`).join(",\n    ")}
  ]`
      : ""
  }
};

export {
  ${exports.join(",\n  ")}
};

export default ${pluginClassName};
`;
};

export const generateTestCode = (componentName: string, componentType: string): string => {
  const camelCaseName = componentName.charAt(0).toLowerCase() + componentName.slice(1);
  const typeLower = componentType.toLowerCase();

  return `import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ${camelCaseName}${componentType} } from '../${typeLower}s/${componentName}';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';

async function createTestRuntime(): Promise<{
  runtime: IAgentRuntime;
  cleanup: () => Promise<void>;
}> {
  const sqlPlugin = await import('@elizaos/plugin-sql');
  const { AgentRuntime, createCharacter } = await import('@elizaos/core');
  const { v4: uuidv4 } = await import('uuid');

  const agentId = uuidv4();
  const adapter = sqlPlugin.createDatabaseAdapter({ dataDir: 'memory://' }, agentId);
  await adapter.init();

  const runtime = new AgentRuntime({
    agentId,
    character: createCharacter({
      name: 'Test Agent',
      bio: ['A test agent'],
      system: 'You are a helpful assistant.',
      plugins: [],
      settings: {},
      messageExamples: [],
      postExamples: [],
      topics: ['testing'],
      adjectives: ['helpful'],
      knowledge: [],
      secrets: {},
      templates: {},
      style: { all: [], chat: [], post: [] },
    }),
    adapter,
    plugins: [],
  });

  await runtime.initialize();

  const cleanup = async () => {
    try {
      await runtime.stop();
      await adapter.close();
    } catch {
      // Ignore cleanup errors
    }
  };

  return { runtime, cleanup };
}

function createTestMemory(text: string, agentId: string): Memory {
  return {
    id: crypto.randomUUID(),
    content: { text },
    userId: 'test-user',
    roomId: 'test-room',
    entityId: 'test-entity',
    agentId,
    createdAt: Date.now()
  } as Memory;
}

describe('${componentName}${componentType}', () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;
  let testState: State;
  
  beforeEach(async () => {
    const result = await createTestRuntime();
    runtime = result.runtime;
    cleanup = result.cleanup;
    testState = { values: {}, data: {}, text: "" };
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanup();
  });
  
  it('should be properly defined', () => {
    expect(${camelCaseName}${componentType}).toBeDefined();
    expect(${camelCaseName}${componentType}.name).toBe('${componentName}');
  });
  
  ${
    componentType === "Action"
      ? `
  describe('validate', () => {
    it('should validate valid input', async () => {
      const message = createTestMemory('test input', runtime.agentId);
      const result = await ${camelCaseName}${componentType}.validate(runtime, message, testState);
      expect(result).toBe(true);
    });
    
    it('should reject empty input', async () => {
      const message = createTestMemory('', runtime.agentId);
      const result = await ${camelCaseName}${componentType}.validate(runtime, message, testState);
      expect(result).toBe(false);
    });
  });
  
  describe('handler', () => {
    it('should handle valid request', async () => {
      const message = createTestMemory('test request', runtime.agentId);
      const result = await ${camelCaseName}${componentType}.handler(runtime, message, testState);
      expect(result).toContain('Successfully');
    });
  });
  `
      : ""
  }
  
  ${
    componentType === "Provider"
      ? `
  describe('get', () => {
    it('should provide data', async () => {
      const message = createTestMemory('test', runtime.agentId);
      const result = await ${camelCaseName}${componentType}.get(runtime, message, testState);
      expect(result).toBeDefined();
      expect(result.text).toBeDefined();
      expect(result.data).toBeDefined();
    });
  });
  `
      : ""
  }
  
  ${
    componentType === "Evaluator"
      ? `
  describe('validate', () => {
    it('should validate when appropriate', async () => {
      const message = createTestMemory('test evaluation', runtime.agentId);
      const result = await ${camelCaseName}${componentType}.validate(runtime, message, testState);
      expect(typeof result).toBe('boolean');
    });
  });
  
  describe('handler', () => {
    it('should evaluate messages', async () => {
      const message = createTestMemory('test evaluation', runtime.agentId);
      const result = await ${camelCaseName}${componentType}.handler(runtime, message, testState);
      expect(result).toContain('evaluation');
    });
  });
  `
      : ""
  }
});
`;
};
