import { type IAgentRuntime, type UUID, elizaLogger } from '@elizaos/core';
import { randomUUID } from 'crypto';

/**
 * Create a mock runtime for CLI operations
 * Note: This is a simplified mock for CLI utilities, not a full runtime
 */
export async function createMockRuntime(): Promise<Partial<IAgentRuntime>> {
  return {
    agentId: (process.env.TRAINING_AGENT_ID || randomUUID()) as UUID,
    character: {
      name: 'Training Data Extractor',
      bio: ['Extracts training data from ElizaOS'],
      system: 'Extract high-quality training examples',
      messageExamples: [],
      postExamples: [],
      topics: [],
      knowledge: [],
      plugins: [],
    },

    // Mock database operations
    messageManager: {
      async getMemories() {
        elizaLogger.warn('Mock runtime: getMemories not implemented');
        return [];
      },

      async searchMemories() {
        elizaLogger.warn('Mock runtime: searchMemories not implemented');
        return [];
      },

      async createMemory() {
        elizaLogger.warn('Mock runtime: createMemory not implemented');
        return true;
      },

      async updateMemory() {
        elizaLogger.warn('Mock runtime: updateMemory not implemented');
        return true;
      },

      async deleteMemory() {
        elizaLogger.warn('Mock runtime: deleteMemory not implemented');
        return true;
      },

      async getLastMessages() {
        elizaLogger.warn('Mock runtime: getLastMessages not implemented');
        return [];
      },
    },

    // Mock other required methods
    getSetting: (key: string) => process.env[key] || null,

    logger: {
      info: (...args: any[]) => console.info(...args),
      warn: (...args: any[]) => console.warn(...args),
      error: (...args: any[]) => console.error(...args),
      debug: (...args: any[]) => console.debug(...args),
    },

    // Minimal mock implementations
    providers: [],
    actions: [],
    evaluators: [],
    plugins: [],
    services: new Map(),
    events: new Map(),
    routes: [],

    // Mock methods
    registerPlugin: async () => {},
    initialize: async () => {},
    getService: () => null,
    composeState: async () => ({ values: {}, data: {}, text: '' }),
    useModel: async () => 'mock response',
    processActions: async () => {},
    evaluate: async () => null,
    registerTaskWorker: () => {},
    getTaskWorker: () => undefined,
  } as Partial<IAgentRuntime>;
}
