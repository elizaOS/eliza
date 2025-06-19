/**
 * Global setup that runs before any tests to handle module mocking
 * This runs at the very beginning to prevent dependency loading issues
 */

import { mock } from 'bun:test';

// Set up global environment variables for testing
process.env.NODE_ENV = 'test';
process.env.ELIZA_NONINTERACTIVE = 'true';

// Mock fs modules IMMEDIATELY before any other imports
const createFsMock = () => {
  const mockWriteStream = {
    write: mock(),
    end: mock(),
    on: mock(),
    once: mock(),
    emit: mock(),
    destroy: mock(),
    path: '',
  };

  const mockReadStream = {
    read: mock(),
    on: mock(),
    once: mock(),
    emit: mock(),
    destroy: mock(),
    path: '',
  };

  return {
    createWriteStream: mock((path: string, options?: any) => {
      mockWriteStream.path = path;
      return mockWriteStream;
    }),
    createReadStream: mock((path: string, options?: any) => {
      mockReadStream.path = path;
      return mockReadStream;
    }),
    rmSync: mock((path: string, options?: any) => {}),
    rm: mock((path: string, options: any, callback: Function) => callback()),
    existsSync: mock((path: string) => false),
    readFileSync: mock((path: string) => ''),
    writeFileSync: mock((path: string, data: any) => {}),
    statSync: mock((path: string) => ({ isDirectory: () => false, isFile: () => true })),
    readdirSync: mock((path: string) => []),
    mkdirSync: mock((path: string, options?: any) => {}),
    readFile: mock((path: string, callback: Function) => callback(null, '')),
    writeFile: mock((path: string, data: any, callback: Function) => callback()),
    access: mock((path: string, callback: Function) => callback()),
    copyFile: mock((src: string, dest: string, callback: Function) => callback()),
    lstatSync: mock((path: string) => ({ isDirectory: () => false, isFile: () => true })),
    unlinkSync: mock((path: string) => {}),
    rmdirSync: mock((path: string, options?: any) => {}),
    chmodSync: mock((path: string, mode: any) => {}),
    promises: {
      readFile: mock((path: string) => Promise.resolve('')),
      writeFile: mock((path: string, data: any) => Promise.resolve()),
      mkdir: mock((path: string, options?: any) => Promise.resolve()),
      readdir: mock((path: string) => Promise.resolve([])),
      stat: mock((path: string) => Promise.resolve({ isDirectory: () => false, isFile: () => true })),
      access: mock((path: string) => Promise.resolve()),
      copyFile: mock((src: string, dest: string) => Promise.resolve()),
      rmdir: mock((path: string, options?: any) => Promise.resolve()),
      unlink: mock((path: string) => Promise.resolve()),
      lstat: mock((path: string) => Promise.resolve({ isDirectory: () => false, isFile: () => true })),
    },
  };
};

// Apply fs mocks immediately - both as function and object exports
mock.module('node:fs', () => {
  const fsMock = createFsMock();
  return {
    ...fsMock,
    default: fsMock,
  };
});

mock.module('fs', () => {
  const fsMock = createFsMock();
  return {
    ...fsMock,
    default: fsMock,
  };
});

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
