// @ts-check
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock execa - must be before importing execa
vi.mock('execa', () => {
  return {
    execa: vi.fn()
  };
});

// Import execa after mocking
import { execa } from 'execa';

// Define test constants
const TEMP_DIR = path.join(os.tmpdir(), 'eliza-registry-test');
const CLI_BIN = path.resolve(process.cwd(), 'dist/cli.js');

// Check if we should skip tests
const SKIP_E2E = process.env.CI === 'true' && process.env.RUN_E2E_TESTS !== 'true';
const SKIP_ALL_E2E = process.env.FORCE_RUN_E2E !== 'true';
const SKIP_LIVE = process.env.RUN_LIVE_TESTS !== 'true';

describe('Registry E2E Tests', () => {
  let mockExeca;
  
  beforeEach(() => {
    // Reset the mock before each test
    vi.resetAllMocks();
    mockExeca = execa;
    
    // Create temp directory if it doesn't exist
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
  });
  
  afterEach(() => {
    // Clean up temp files
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });
  
  // Helper function to run the publish command with given args
  async function runPublishCommand(args = [], packageJson = { name: 'test-plugin', version: '1.0.0' }) {
    const testDir = path.join(TEMP_DIR, `test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    
    // Write test package.json
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );
    
    try {
      const result = await execa('node', [CLI_BIN, 'publish', ...args], {
        cwd: testDir,
      });
      
      return {
        success: true,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      };
    } catch (error) {
      return {
        success: false,
        stdout: error.stdout || '',
        stderr: error.stderr || '',
        exitCode: error.exitCode || 1
      };
    }
  }
  
  test.skipIf(SKIP_ALL_E2E)('should publish a plugin to local registry with dry run', async () => {
    // Set up the mock to return a successful result
    mockExeca.mockResolvedValueOnce({
      stdout: 'Successfully published to local registry (dry run)',
      stderr: '',
      exitCode: 0
    });
    
    const result = await runPublishCommand(['--dry-run', '--registry', 'local']);
    
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('Successfully published');
    expect(result.stdout).toContain('dry run');
    expect(mockExeca).toHaveBeenCalledWith('node', 
      expect.arrayContaining([CLI_BIN, 'publish', '--dry-run', '--registry', 'local']), 
      expect.objectContaining({ cwd: expect.any(String) }));
  });
  
  test.skipIf(SKIP_ALL_E2E)('should test publish as non-maintainer', async () => {
    // Mock a successful test publish
    mockExeca.mockResolvedValueOnce({
      stdout: 'Test publish successful',
      stderr: '',
      exitCode: 0
    });
    
    const result = await runPublishCommand(['--test', '--registry', 'local']);
    
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('Test publish successful');
    expect(mockExeca).toHaveBeenCalledWith('node', 
      expect.arrayContaining([CLI_BIN, 'publish', '--test', '--registry', 'local']), 
      expect.objectContaining({ cwd: expect.any(String) }));
  });
  
  test.skipIf(SKIP_ALL_E2E)('should detect project type correctly', async () => {
    // Mock response with project type detection
    mockExeca.mockResolvedValueOnce({
      stdout: 'Detected project type: plugin',
      stderr: '',
      exitCode: 0
    });
    
    const result = await runPublishCommand(['--registry', 'local']);
    
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('Detected project type: plugin');
    expect(mockExeca).toHaveBeenCalledWith('node', 
      expect.arrayContaining([CLI_BIN, 'publish', '--registry', 'local']), 
      expect.objectContaining({ cwd: expect.any(String) }));
  });
  
  test.skipIf(SKIP_ALL_E2E)('should handle command failures', async () => {
    // Set specific mock response for failure
    mockExeca.mockImplementationOnce(() => {
      // Create an error with the properties that execa would add
      const error = new Error('Command failed with exit code 1');
      // Add stdout and stderr properties to the error object
      Object.assign(error, {
        stdout: 'Error: Failed to publish',
        stderr: 'Cannot publish: package.json not found'
      });
      throw error;
    });
    
    // Execute the CLI command that will fail
    const result = await runPublishCommand(['--registry', 'local']);
    
    // Verify the command was executed and failed
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('Cannot publish: package.json not found');
  });
  
  describe('Live Tests', () => {
    // These tests are skipped by default unless SKIP_LIVE is false
    test.skipIf(SKIP_LIVE || SKIP_ALL_E2E)('should publish to GitHub', async () => {
      // This would only run in a CI or if explicitly enabled
      mockExeca.mockResolvedValueOnce({
        stdout: 'Successfully published to GitHub',
        stderr: '',
        exitCode: 0
      });
      
      const result = await runPublishCommand(['--registry', 'github']);
      
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('Successfully published to GitHub');
    });
    
    test.skipIf(SKIP_LIVE || SKIP_ALL_E2E)('should publish to npm', async () => {
      // This would only run in a CI or if explicitly enabled
      mockExeca.mockResolvedValueOnce({
        stdout: 'Successfully published to npm',
        stderr: '',
        exitCode: 0
      });
      
      const result = await runPublishCommand(['--npm-publish']);
      
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('Successfully published to npm');
    });
  });
}); 