import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { createLogger, logPrompt, logResponse } from './logger';
import * as fs from 'fs';
import * as path from 'path';

describe('logger', () => {
  const originalEnv = process.env;
  const testDir = path.join(process.cwd(), 'test-logs');
  
  beforeEach(() => {
    process.env = { ...originalEnv };
    // Create test directory
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir);
    }
  });

  afterEach(() => {
    process.env = originalEnv;
    // Clean up test files
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('creates logger with default level', () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('creates child logger with bindings', () => {
    const logger = createLogger();
    const child = logger.child({ component: 'test' });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe('function');
  });

  it('logPrompt returns a slug', () => {
    // Note: This test verifies the API without requiring LOG_FILE to be enabled
    const slug = logPrompt('TEXT_SMALL', 'test prompt', { agentName: 'test' });
    // When LOG_FILE is not set, returns empty string
    expect(typeof slug).toBe('string');
  });

  it('logResponse accepts promptSlug for correlation', () => {
    const slug = logResponse('TEXT_SMALL', 'test response', { 
      agentName: 'test',
      promptSlug: '#0001/test/TEXT_SMALL'
    });
    expect(typeof slug).toBe('string');
  });
});
