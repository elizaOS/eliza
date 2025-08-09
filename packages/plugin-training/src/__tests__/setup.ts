import { mock, spyOn, beforeEach, afterAll } from 'bun:test';

// Global test setup for the custom reasoning service

// Mock crypto for UUID generation
Object.defineProperty(global, 'crypto', {
  value: {
    randomUUID: mock().mockReturnValue('test-uuid-123'),
  },
});

// Mock process.cwd for file paths
spyOn(process, 'cwd').mockReturnValue('/test/project/path');

// Mock Date.now for consistent timestamps
const mockNow = 1642608000000; // Fixed timestamp
spyOn(Date, 'now').mockReturnValue(mockNow);

// Global console override for cleaner test output
const originalConsole = global.console;
global.console = {
  ...originalConsole,
  debug: mock(),
  log: originalConsole.log,
  warn: originalConsole.warn,
  error: originalConsole.error,
  info: originalConsole.info,
};

// Mock fetch for HTTP requests
(global as any).fetch = mock().mockResolvedValue({
  ok: true,
  status: 200,
  json: mock().mockResolvedValue({}),
  text: mock().mockResolvedValue(''),
  headers: new Map(),
  statusText: 'OK',
});

// Mock WebSocket for real-time connections
(global as any).WebSocket = mock().mockImplementation(() => ({
  send: mock(),
  close: mock(),
  addEventListener: mock(),
  removeEventListener: mock(),
  readyState: 1, // OPEN
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
}));

// Setup test environment variables
process.env.NODE_ENV = 'test';
process.env.REASONING_SERVICE_ENABLED = 'true';
process.env.TOGETHER_AI_API_KEY = 'test-together-api-key';

// Clean up after each test
beforeEach(() => {
  mock.restore();
});

// Restore mocks after all tests
afterAll(() => {
  mock.restore();
});
