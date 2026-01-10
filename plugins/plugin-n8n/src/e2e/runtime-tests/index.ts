/**
 * N8n Plugin E2E Tests with Real ElizaOS Runtime
 *
 * This exports all test suites for the n8n plugin to be run
 * by the ElizaOS test runner with real API integrations
 */

export { n8nScenariosSuite } from './n8n-scenarios.ts';
export { n8nPersistenceSuite } from './n8n-persistence.ts';
export { n8nActionsSuite } from './n8n-actions.ts';
export { n8nPluginCreationSuite } from './n8n-plugin-creation.ts';

// Re-export test utilities for use by other tests
export * from './test-utils.ts';
