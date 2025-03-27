import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
const { spawn } = require('child_process');
import { existsSync } from 'fs';
import { elizaLogger } from '@elizaos/core';
import { cliCommand, agentName, agent1Name, agent2Name, characters } from './utils/constants'; // Import constants

const execAsync = promisify(exec);
const projectRoot = path.resolve(__dirname, '../../..');
const testDir = path.join(os.tmpdir(), 'elizaos-test-' + Date.now());

describe('Agent Lifecycle Tests', () => {
  beforeEach(async () => {
    // Create test directory if it doesn't exist
    await fsPromises.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up processes
    try {
      await execAsync('elizaos stop', { reject: false });
    } catch (e) {
      // Server might not be running
      elizaLogger.error('ERROR:', e);
    }

    // Give time for processes to clean up
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Remove test directory recursively
    if (existsSync(testDir)) {
      await fsPromises.rm(testDir, { recursive: true, force: true });
    }
  });

  it('Start Agent - Start Agent with Character File', async () => {
    // Arrange

    const characterContent = JSON.stringify({
      name: agentName,
      system: 'You are a test agent.',
      bio: ['A test agent for integration testing.'],
      plugins: [],
    });
    const projectRoot = path.resolve(__dirname, '../../..');
    const characterFilePath = path.join(testDir, `${agentName}.character.json`);
    await fsPromises.writeFile(characterFilePath, characterContent);
    let child;

    try {
      // Act - Use spawn with detached process
      const command = 'bun';
      const args = ['start', '--character', characterFilePath];

      child = spawn(command, args, {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // Allows proper process tree management
      });

      // Create promise to wait for expected output
      const outputPromise = new Promise((resolve, reject) => {
        let stdoutData = '';

        child.stdout.on('data', (data) => {
          const output = data.toString();
          stdoutData += output;
          elizaLogger.log(output);
          if (stdoutData.includes(`Successfully loaded character from : ${characterFilePath}`)) {
            resolve(stdoutData);
          }
        });

        child.on('error', (error) => {
          elizaLogger.error('Child process error::', error);
          reject(error);
        });

        child.stderr.on('data', (data) => {
          elizaLogger.error('Stderr:', data.toString());
        });
      });

      // Set timeout with cleanup
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          if (child) {
            process.kill(-child.pid, 'SIGKILL'); // Kill entire process group
          }
          reject(new Error('Test timed out after 15 seconds'));
        }, 15000);
      });

      // Wait for output or timeout
      const stdout = await Promise.race([outputPromise, timeoutPromise]);
      elizaLogger.log(stdout);

      // Assert
      expect(stdout).toContain(`Successfully loaded character from: ${characterFilePath}`);
      expect(stdout).toContain(agentName);
    } finally {
      // Cleanup - kill entire process tree
      if (child) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (e) {
          // Process might already be dead
          elizaLogger.error('ERROR:', e);
        }
      }
    }
  }, 30000);

  it('Start Agent - Start Multiple Agents', async () => {
    // Arrange

    // Create character files
    const projectRoot = path.resolve(__dirname, '../../..');
    const characterFile1Path = path.join(testDir, `${agent1Name}.character.json`);
    const characterFile2Path = path.join(testDir, `${agent2Name}.character.json`);
    await fsPromises.writeFile(characterFile1Path, JSON.stringify(characters[0]));
    await fsPromises.writeFile(characterFile2Path, JSON.stringify(characters[1]));

    let child;
    try {
      // Act - Start multiple agents
      child = spawn(
        'bun',
        ['start', '--characters', `${characterFile1Path} , ${characterFile2Path}`],
        {
          cwd: projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        }
      );

      const outputPromise = new Promise((resolve, reject) => {
        let stdoutData = '';
        let initializedAgents = new Set();

        child.stdout.on('data', (data) => {
          const output = data.toString();
          stdoutData += output;

          // Check for both agent initializations
          if (output.includes('Successfully loaded character from')) {
            if (output.includes(agent1Name)) initializedAgents.add(agent1Name);
            if (output.includes(agent2Name)) initializedAgents.add(agent2Name);

            if (initializedAgents.size === 2) {
              resolve(stdoutData);
            }
          }
        });

        child.stderr.on('data', (data) => {
          elizaLogger.error('MultiAgent Stderr:', data.toString());
        });

        child.on('error', reject);
        child.on('exit', (code) => {
          if (code !== 0) {
            reject(new Error(`Process exited with code ${code}`));
          }
        });
      });

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('Multi-agent test timed out after 40 seconds'));
        }, 40000);
      });

      const stdout = await Promise.race([outputPromise, timeoutPromise]);

      // Assert
      expect(stdout).toContain('Successfully loaded character from');
      expect(stdout).toContain(agent1Name);
      expect(stdout).toContain(agent2Name);
    } finally {
      if (child) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (e) {
          elizaLogger.log('Multi-agent cleanup warning:', e.message);
        }
      }
    }
  }, 45000);

  it('Stop Agent - Stop Running Agent', async () => {
    // Arrange
    const agentName = 'test-agent-stop';
    const characterContent = JSON.stringify({
      name: agentName,
      system: 'You are a stoppable test agent.',
      bio: ['A test agent for shutdown testing.'],
      plugins: [],
    });

    const projectRoot = path.resolve(__dirname, '../../..');
    const characterFilePath = path.join(testDir, `${agentName}.character.json`);
    await fsPromises.writeFile(characterFilePath, characterContent);

    let child;
    try {
      // Start the agent
      child = spawn('bun', ['start', '--character', characterFilePath], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      // Wait for initialization
      await new Promise((resolve, reject) => {
        child.stdout.on('data', (data) => {
          if (
            data.toString().includes(`Successfully loaded character from: ${characterFilePath}`)
          ) {
            resolve();
          }
        });
        setTimeout(() => reject(new Error('Agent failed to initialize for stop test')), 15000);
      });

      // Act - Send stop command
      const stopResult = await execAsync(`elizaos agent stop -n ${agentName}`, {
        cwd: projectRoot,
      });

      elizaLogger.log('stopResult: ', stopResult);
      // Assert
      expect(stopResult.stderr).toBe('');
      expect(stopResult.stdout).toContain('Server shutdown complete');
    } finally {
      if (child) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (e) {
          elizaLogger.error('Stop test cleanup warning:', e.message);
        }
      }
    }
  }, 30000);

  it('Start Agent - Invalid Character File Path', async () => {
    // Arrange
    const invalidFilePath = path.join(testDir, 'non-existent-character.json');

    let child;
    try {
      // Act - Attempt to start agent with invalid character file path
      child = spawn('bun', ['start', '--character', invalidFilePath], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      const outputPromise = new Promise((resolve, reject) => {
        let stderrData = '';
        let stdoutData = '';

        child.stdout.on('data', (data) => {
          const output = data.toString();
          stdoutData += output;
          elizaLogger.log('Stdout:', output);
        });

        child.stderr.on('data', (data) => {
          const errorOutput = data.toString();
          stderrData += errorOutput;
          elizaLogger.error('Stderr:', errorOutput);
          if (stderrData.includes('Error: ENOENT')) {
            resolve({ stdout: stdoutData, stderr: stderrData });
          }
        });

        child.on('error', reject);
        child.on('exit', (code) => {
          if (code !== 0) {
            resolve({ stdout: stdoutData, stderr: stderrData });
          }
        });
      });

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('Test timed out after 15 seconds'));
        }, 15000);
      });

      const result = await Promise.race([outputPromise, timeoutPromise]);

      // Assert
      expect(result.stderr).toContain('error: script "start" exited with code 1\n');
      expect(result.stdout).not.toContain('Successfully loaded character');
    } finally {
      if (child) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (e) {
          elizaLogger.log('Cleanup warning:', e.message);
        }
      }
    }
  }, 30000);
});
