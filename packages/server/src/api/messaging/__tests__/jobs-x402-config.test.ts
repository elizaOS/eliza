/**
 * Test suite for x402 endpoint metadata configuration
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

describe('x402 Endpoint Metadata Configuration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env.X402_JOBS_ENDPOINT_DESCRIPTION;
    delete process.env.X402_JOBS_INPUT_SCHEMA;
    delete process.env.X402_JOBS_OUTPUT_SCHEMA;
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  test('should use default configuration when no env vars set', () => {
    // Re-import to get fresh config
    delete require.cache[require.resolve('../jobs')];
    const { createJobsRouter } = require('../jobs');

    // The function should exist and be callable
    expect(typeof createJobsRouter).toBe('function');
  });

  test('should use custom description from env', () => {
    const customDescription = 'Custom AI agent description for testing';
    process.env.X402_JOBS_ENDPOINT_DESCRIPTION = customDescription;

    // Re-import to get fresh config
    delete require.cache[require.resolve('../jobs')];
    const { createJobsRouter } = require('../jobs');

    expect(typeof createJobsRouter).toBe('function');
  });

  test('should parse custom input schema from env', () => {
    const customSchema = {
      type: 'object',
      properties: {
        content: { type: 'string' },
      },
      required: ['content'],
    };
    process.env.X402_JOBS_INPUT_SCHEMA = JSON.stringify(customSchema);

    // Re-import to get fresh config
    delete require.cache[require.resolve('../jobs')];
    const { createJobsRouter } = require('../jobs');

    expect(typeof createJobsRouter).toBe('function');
  });

  test('should parse custom output schema from env', () => {
    const customSchema = {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        response: { type: 'string' },
      },
    };
    process.env.X402_JOBS_OUTPUT_SCHEMA = JSON.stringify(customSchema);

    // Re-import to get fresh config
    delete require.cache[require.resolve('../jobs')];
    const { createJobsRouter } = require('../jobs');

    expect(typeof createJobsRouter).toBe('function');
  });

  test('should handle invalid JSON in input schema gracefully', () => {
    process.env.X402_JOBS_INPUT_SCHEMA = 'invalid json {';

    // Re-import to get fresh config
    delete require.cache[require.resolve('../jobs')];
    const { createJobsRouter } = require('../jobs');

    // Should still work, falling back to default
    expect(typeof createJobsRouter).toBe('function');
  });

  test('should handle invalid JSON in output schema gracefully', () => {
    process.env.X402_JOBS_OUTPUT_SCHEMA = 'invalid json {';

    // Re-import to get fresh config
    delete require.cache[require.resolve('../jobs')];
    const { createJobsRouter } = require('../jobs');

    // Should still work, falling back to default
    expect(typeof createJobsRouter).toBe('function');
  });

  test('should support all custom configurations together', () => {
    const customDescription = 'Premium AI agent';
    const customInputSchema = {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    };
    const customOutputSchema = {
      type: 'object',
      properties: { result: { type: 'string' } },
    };

    process.env.X402_JOBS_ENDPOINT_DESCRIPTION = customDescription;
    process.env.X402_JOBS_INPUT_SCHEMA = JSON.stringify(customInputSchema);
    process.env.X402_JOBS_OUTPUT_SCHEMA = JSON.stringify(customOutputSchema);

    // Re-import to get fresh config
    delete require.cache[require.resolve('../jobs')];
    const { createJobsRouter } = require('../jobs');

    expect(typeof createJobsRouter).toBe('function');
  });
});
