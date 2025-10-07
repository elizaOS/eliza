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
