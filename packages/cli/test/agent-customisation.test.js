import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
const { spawn } = require('child_process');



const execAsync = promisify(exec);

describe('Custom Component Integration Tests', () => {
  const testDir = path.join(os.tmpdir(), 'elizaos-test-' + Date.now());
  const cliCommand = 'elizaos';  // Assumes elizaos is in PATH
  let childProcess;

  beforeEach(async () => {
    await fsPromises.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup processes
    if (childProcess) {
      try {
        process.kill(-childProcess.pid, 'SIGKILL');
      } catch (e) {
        console.log('Cleanup warning:', e.message);
      }
    }
    await fsPromises.rm(testDir, { recursive: true, force: true });
  });

  describe('Custom Action Workflow', () => {

    it('should create valid custom action file', async () => {
      const actionContent = `
        import { Action } from '@elizaos/core';

        export const customAction: Action = {
          name: 'test-action',
          description: 'Test action for integration testing',
          validate: () => true,
          handler: async (runtime, message, state, options, callback) => {
            if (callback) {
              callback({ text: 'Action executed successfully' });
            }
            return true;
          }
        };
      `;

      const actionPath = path.join(testDir, 'customAction.ts');
      await fsPromises.writeFile(actionPath, actionContent);

      // Verify file structure
      const stats = await fsPromises.stat(actionPath);
      expect(stats.isFile()).toBe(true);

      // Basic content validation
      const content = await fsPromises.readFile(actionPath, 'utf-8');
      expect(content).toContain('export const customAction: Action');
      expect(content).toContain('name: \'test-action\'');
    }, 30000);

    it('B) should register custom action via plugin', async () => {

      const actionContent = `
        import { Action } from '@elizaos/core';

        export const customAction: Action = {
          name: 'test-action',
          description: 'Test action for integration testing',
          validate: () => true,
          handler: async (runtime, message, state, options, callback) => {
            if (callback) {
              callback({ text: 'Action executed successfully' });
            }
            return true;
          }
        };
      `;


      // Create minimal plugin
      const pluginContent = `
        import { Plugin } from '@elizaos/core';
        import { customAction } from './customAction';

        export default {
          name: 'TestPlugin',
          description: 'Test plugin for action registration',
          actions: [customAction]
        } as Plugin;
      `;

      const characterContent = `
      {
        "name": "TestAgent",
        "plugins": ["./test-plugin.ts"],
        "system": "Test agent for action registration",
        "secrets": {}
      }
      `;

      const projectRoot = path.resolve(__dirname, '../../..');
      const pluginFilePath = path.join(testDir, `test-plugin.ts`);
      const characterFilePath = path.join(testDir, `test-agent.character.json`);
      const actionPath = path.join(testDir, 'customAction.ts');

      await fsPromises.writeFile(actionPath, actionContent);
      await fsPromises.writeFile(pluginFilePath, pluginContent);
      await fsPromises.writeFile(characterFilePath, characterContent);

      let child;

      try {
        // Act - Use spawn with detached process
        const command = 'bun';
        const args = ['start', '--character', characterFilePath];

        child = spawn(command, args, {
          cwd: projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true // Allows proper process tree management
        });

        // Create promise to wait for expected output
        const outputPromise = new Promise((resolve, reject) => {
          let stdoutData = '';

          child.stdout.on('data', (data) => {
            const output = data.toString();
            stdoutData += output;
            console.log(output);
            if (stdoutData.includes(`Successfully loaded character from : ${characterFilePath}`)) {
              resolve(stdoutData);
            }
          });

          child.on('error', (error) => {
            console.error('Child process error:', error);
            reject(error);
          });

          child.stderr.on('data', (data) => {
            console.error('Stderr:', data.toString()); // Log all stderr data
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
        console.log(stdout);

        // Assert
        expect(stdout).toContain(`Successfully loaded character from: ${characterFilePath}`);

      } finally {
        // Cleanup - kill entire process tree
        if (child) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (e) {
            // Process might already be dead
          }
        }
      }

    }, 40000);
  });

  describe('Custom Provider Workflow', () => {
    it('C) should create valid custom provider file', async () => {
      const providerContent = `
        import { Provider } from '@elizaos/core';

        export const customProvider: Provider = {
          name: 'test-provider',
          get: async () => { return {text : 'Provider Success'};}
        };
      `;

      const providerPath = path.join(testDir, 'customProvider.ts');
      await fsPromises.writeFile(providerPath, providerContent);

      const stats = await fsPromises.stat(providerPath);
      expect(stats.isFile()).toBe(true);

      const content = await fsPromises.readFile(providerPath, 'utf-8');
      expect(content).toContain('export const customProvider: Provider');
      expect(content).toContain('name: \'test-provider\'');
    }, 30000);

    it('D) should register custom provider via plugin', async () => {
      // Create provider plugin
      const pluginContent = `
        import { Plugin } from '@elizaos/core';
        import { customProvider } from './customProvider';

        export default {
          name: 'TestProviderPlugin',
          description: 'Test plugin for provider registration',
          providers: [customProvider]
        } as Plugin;
      `;

      const characterContent = `
      {
        "name": "TestAgent",
        "plugins": ["./test-provider-plugin.ts"],
        "system": "Test agent for provider registration"
      }
      `;

      const providerContent = `
        import { Provider } from '@elizaos/core';

        export const customProvider: Provider = {
          name: 'test-provider',
          get: async () => { return {text : 'Provider Success'};}
        };
      `;

      const projectRoot = path.resolve(__dirname, '../../..');
      const pluginFilePath = path.join(testDir, `test-provider-plugin.ts`);
      const characterFilePath = path.join(testDir, `test-agent.character.json`);



      await fsPromises.writeFile(pluginFilePath, pluginContent);
      await fsPromises.writeFile(characterFilePath, characterContent);

      let child;


      try {
        // Act - Use spawn with detached process
        const command = 'bun';
        const args = ['start', '--character', characterFilePath];

        child = spawn(command, args, {
          cwd: projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true // Allows proper process tree management
        });

        // Create promise to wait for expected output
        const outputPromise = new Promise((resolve, reject) => {
          let stdoutData = '';

          child.stdout.on('data', (data) => {
            const output = data.toString();
            stdoutData += output;
            console.log(output);
            if (stdoutData.includes(`Successfully loaded character from: ${characterFilePath}`)) {
              resolve(stdoutData);
            }
          });

          child.on('error', (error) => {
            console.error('Child process error:', error);
            reject(error);
          });

          child.stderr.on('data', (data) => {
            console.error('Stderr:', data.toString()); // Log all stderr data
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
        console.log(stdout);

        // Assert
        expect(stdout).toContain(`Successfully loaded character from: ${characterFilePath}`);

      } finally {
        // Cleanup - kill entire process tree
        if (child) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (e) {
            // Process might already be dead
          }
        }
      }

    }, 40000);
  });
});