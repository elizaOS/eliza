/**
 * Test exports for the goals plugin
 * This file exports all test suites so they can be included in the plugin build
 */

// E2E Test Suites
export { GoalsPluginE2ETestSuite } from './__tests__/e2e/goals-plugin.js';

// Unit and Integration Test Suites
// Note: These are vitest test files, not traditional test suites
// They should be run via vitest command line tool
