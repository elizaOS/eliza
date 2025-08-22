import { config } from 'dotenv';

// Load test environment variables
config({ path: '.env.test' });

// Mock console methods if needed
global.console = {
  ...console,
  // Uncomment to suppress logs during tests
  // log: jest.fn(),
  // debug: jest.fn(),
  // info: jest.fn(),
};