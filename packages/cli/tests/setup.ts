import { beforeEach, afterEach } from 'vitest';

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.ELIZA_NO_AUTO_INSTALL = 'true';
process.env.NO_COLOR = '1';

// Silence console output during tests
beforeEach(() => {
  // You can uncomment these if you want to suppress console output during tests
  // global.console.log = vi.fn();
  // global.console.warn = vi.fn();
  // global.console.info = vi.fn();
});

afterEach(() => {
  // Clean up any global state
}); 