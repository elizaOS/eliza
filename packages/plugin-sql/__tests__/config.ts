/**
 * Configuration for integration tests
 */
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';

// Try to load test-specific env file first, then fall back to project root .env
const testEnvPath = join(process.cwd(), '.env.test');
const rootEnvPath = join(process.cwd(), '../../.env');

if (existsSync(testEnvPath)) {
  dotenvConfig({ path: testEnvPath });
} else {
  dotenvConfig({ path: rootEnvPath });
}

export const config = {
  // Use a test database URL - this should be set up as an environment variable in CI
  // or provided directly for local testing
  DATABASE_URL:
    process.env.POSTGRES_URL || 'postgresql://postgres:postgres@localhost:5432/eliza_test',
};
