/**
 * Global setup that runs before any tests to handle module mocking
 * This runs at the very beginning to prevent dependency loading issues
 */

import { mock } from 'bun:test';

// Set up global environment variables for testing
process.env.NODE_ENV = 'test';
process.env.ELIZA_NONINTERACTIVE = 'true';

// Mock problematic Node.js modules first
mock.module('multer', () => {
  console.log('Mocking multer module...');
  const mockMulter = () => ({
    single: () => (req: any, res: any, next: any) => next(),
    array: () => (req: any, res: any, next: any) => next(),
    fields: () => (req: any, res: any, next: any) => next(),
    none: () => (req: any, res: any, next: any) => next(),
    any: () => (req: any, res: any, next: any) => next(),
  });

  (mockMulter as any).diskStorage = () => ({});
  (mockMulter as any).memoryStorage = () => ({});

  return {
    default: mockMulter,
    diskStorage: (mockMulter as any).diskStorage,
    memoryStorage: (mockMulter as any).memoryStorage,
  };
});

// Alternative approach: Mock the entire server module to prevent multer loading
mock.module('@elizaos/server', () => {
  console.log('Mocking @elizaos/server module...');
  return {
    AgentServer: class MockAgentServer {
      constructor() {}
      async initialize() {}
      async startAgent() {
        return {};
      }
      stopAgent() {}
      async loadCharacterTryPath() {
        return {};
      }
      async jsonToCharacter() {
        return {};
      }
    },
    expandTildePath: (path: string) => path,
    resolvePgliteDir: (dir?: string) => dir || './.elizadb',
  };
});

console.log('Global setup completed - mocks are in place');
