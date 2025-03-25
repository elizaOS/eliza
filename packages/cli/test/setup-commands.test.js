import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import { existsSync } from 'fs';
import { elizaLogger } from '@elizaos/core';
import { invalidName, testDir, cliCommand, commands } from './utils/constants';

const execAsync = promisify(exec);

describe('CLI Command Structure Tests', () => {
  const projectName = 'test-project-cli';
  const pluginName = 'test-plugin-cli';
  const agentName = 'test-agent-cli';

  beforeEach(async () => {
    // Create test directory if it doesn't exist
    await fsPromises.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up processes
    try {
      await execAsync('elizaos stop', { reject: false });
    } catch (e) {
      elizaLogger.error('error: ', e);
      // Server might not be running
    }

    // Give time for processes to clean up
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Remove test directory recursively
    if (existsSync(testDir)) {
      await fsPromises.rm(testDir, { recursive: true, force: true });
    }
  });

  it('should display help text', async () => {
    // Run help command
    const result = await execAsync('elizaos help', {
      reject: false,
    });

    // Verify help output contains expected commands
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('Options:');
    expect(result.stdout).toContain('Commands:');

    // Check for key commands

    for (const cmd of commands) {
      expect(result.stdout).toContain(cmd);
    }
  }, 30000);

  it('should display version information', async () => {
    // Run version command
    const result = await execAsync(`${cliCommand} --version`, {
      reject: false,
    });

    // Verify version output format
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/); // Format like x.y.z
  }, 30000);

  it('should create a project with valid structure', async () => {
    // Arrange
    const projectName = 'test-project';
    const projectPath = path.join(testDir, projectName);

    // Act
    const command = `${cliCommand} create project ${projectName}`;

    // Use exec directly for this interactive command
    const execResult = await new Promise((resolve, reject) => {
      const child = exec(command, { cwd: testDir }, (error, stdout, stderr) => {
        if (error) {
          elizaLogger.error(`Command failed: ${command}`);
          elizaLogger.error(`Stdout: ${stdout}`);
          elizaLogger.error(`Stderr: ${stderr}`);
          reject(error);
        } else {
          setTimeout(() => resolve({ stdout, stderr }), 100);
        }
      });

      child.stdin.write('\n\n');
      child.stdin.end();
    });

    // Wait for creation of files
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Assert
    expect(execResult.stderr).toBe('');
    expect(existsSync(projectPath)).toBe(true);
  }, 30000);

  it('should create a plugin with valid structure', async () => {
    // Arrange
    const pluginName = 'test-plugin';

    // Act
    const command = `${cliCommand} create plugin ${pluginName}`;
    const result = await execAsync(command, {
      cwd: testDir,
      reject: false,
    });

    const pluginDir = path.join(testDir, pluginName);

    // Verify that at least the directory was created
    expect(existsSync(pluginDir)).toBe(true);

    // More specific assertions
    expect(existsSync(path.join(pluginDir, 'src'))).toBe(true);
    expect(existsSync(path.join(pluginDir, 'package.json'))).toBe(true);
    expect(existsSync(path.join(pluginDir, 'tsconfig.json'))).toBe(true);
  }, 30000);

  it('should create an agent with valid structure', async () => {
    // Arrange
    const agentName = 'test-agent';

    // Run create agent command and provide responses
    const result = await execAsync(`${cliCommand} create agent ${agentName}`, {
      cwd: testDir,
      reject: false,
    });

    // Verify file path
    const agentDir = path.join(testDir, agentName);

    expect(existsSync(agentDir)).toBe(true);

    // More specific assertions
    expect(existsSync(path.join(agentDir, 'src'))).toBe(true);
    expect(existsSync(path.join(agentDir, `${agentName}.character.json`))).toBe(true);
  }, 35000); // Increased timeout

  it('should handle invalid project name', async () => {
    // Use a project name with invalid characters

    // Run create project command with invalid name
    const result = await execAsync(`${cliCommand} create project ${invalidName}`, {
      cwd: testDir,
      reject: false,
    });

    // If we get an error code, that's expected
    if (result.exitCode !== 0) {
      expect(result.stdout).toMatch(/invalid|error|fail/i);
    } else {
      // If for some reason command "succeeded", make sure directory wasn't created
      const invalidDir = path.join(testDir, invalidName);
      expect(existsSync(invalidDir)).toBe(false);
    }
  }, 30000);
});
