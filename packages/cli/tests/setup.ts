/**
 * Global test setup for CLI package
 * This file runs before all tests to set up mocks and globals
 */

import { mock } from 'bun:test';


// Mock the entire @elizaos/server package
mock.module('@elizaos/server', () => ({
  AgentServer: mock(() => ({
    initialize: mock(),
    startAgent: mock(),
    stopAgent: mock(),
    loadCharacterTryPath: mock(),
    jsonToCharacter: mock(),
  })),
  expandTildePath: mock((path: string) => path),
  resolvePgliteDir: mock((dir?: string) => dir || './.elizadb'),
}));

// Mock fs module to ensure all exports are available for Node.js v23 compatibility
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
    // Core fs functions
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
    // Promises interface
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

// Mock both fs and node:fs to handle different import styles
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

// Mock fs-extra to prevent createWriteStream issues
mock.module('fs-extra', () => {
  const fs = createFsMock();
  return {
    // Re-export all fs methods
    ...fs,
    // Additional fs-extra methods
    copy: mock((src: string, dest: string) => Promise.resolve()),
    ensureDir: mock((path: string) => Promise.resolve()),
    emptyDir: mock((path: string) => Promise.resolve()),
    remove: mock((path: string) => Promise.resolve()),
    move: mock((src: string, dest: string) => Promise.resolve()),
    outputFile: mock((file: string, data: any) => Promise.resolve()),
    readJson: mock((file: string) => Promise.resolve({})),
    writeJson: mock((file: string, object: any) => Promise.resolve()),
    pathExists: mock((path: string) => Promise.resolve(false)),
    // Sync versions
    copySync: mock((src: string, dest: string) => {}),
    ensureDirSync: mock((path: string) => {}),
    emptyDirSync: mock((path: string) => {}),
    removeSync: mock((path: string) => {}),
    moveSync: mock((src: string, dest: string) => {}),
    outputFileSync: mock((file: string, data: any) => {}),
    readJsonSync: mock((file: string) => ({})),
    writeJsonSync: mock((file: string, object: any) => {}),
    pathExistsSync: mock((path: string) => false),
  };
});

// Mock socket.io to prevent server startup issues in tests
mock.module('socket.io', () => ({
  Server: mock(() => ({
    on: mock(),
    emit: mock(),
    use: mock(),
    engine: {
      on: mock(),
    },
  })),
}));

// Mock express to prevent server startup issues
mock.module('express', () => {
  const mockApp = {
    use: mock(),
    get: mock(),
    post: mock(),
    put: mock(),
    delete: mock(),
    listen: mock(),
    set: mock(),
  };

  const mockExpress = mock(() => mockApp);
  mockExpress.static = mock();
  mockExpress.json = mock();
  mockExpress.urlencoded = mock();
  mockExpress.Router = mock(() => ({
    use: mock(),
    get: mock(),
    post: mock(),
    put: mock(),
    delete: mock(),
  }));

  return {
    default: mockExpress,
    ...mockExpress,
  };
});

// Mock body-parser to prevent server startup issues
mock.module('body-parser', () => ({
  json: mock(() => (req: any, res: any, next: any) => next()),
  urlencoded: mock(() => (req: any, res: any, next: any) => next()),
  text: mock(() => (req: any, res: any, next: any) => next()),
  raw: mock(() => (req: any, res: any, next: any) => next()),
}));

// Mock helmet for security headers
mock.module('helmet', () => {
  const helmet = mock(() => (req: any, res: any, next: any) => next());
  return {
    default: helmet,
    ...helmet,
  };
});

// Mock cors
mock.module('cors', () => {
  const cors = mock(() => (req: any, res: any, next: any) => next());
  return {
    default: cors,
    ...cors,
  };
});

// Ensure logger is available globally
global.console = {
  ...console,
  debug: console.log,
  trace: console.log,
};
