import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  logger,
  type ActionExample,
  createUniqueUuid,
} from '@elizaos/core';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * Package Action - Actually manages npm/bun packages
 * Supports install, update, add, remove, list operations
 */
export const packageManagementAction: Action = {
  name: 'PACKAGE_MANAGEMENT',
  similes: ['NPM_INSTALL', 'BUN_ADD', 'PACKAGE_UPDATE', 'INSTALL_DEPS'],
  description: 'Manages npm/bun packages - install, update, add, remove',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';
    return (
      text.includes('install') ||
      text.includes('npm') ||
      text.includes('bun') ||
      text.includes('package') ||
      text.includes('dependency') ||
      (text.includes('update') && text.includes('dep'))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ): Promise<void> => {
    if (!callback) return;

    try {
      const text = message.content.text || '';
      let operation = '';
      let packageManager = 'npm'; // Default to npm
      let packages: string[] = [];
      let flags = '';

      // Detect package manager
      if (text.includes('bun')) {
        packageManager = 'bun';
      } else if (text.includes('yarn')) {
        packageManager = 'yarn';
      } else if (text.includes('pnpm')) {
        packageManager = 'pnpm';
      }

      // Determine operation
      if (text.includes('install') && !text.includes('package')) {
        operation = 'install'; // Install all dependencies
      } else if (text.includes('add') || (text.includes('install') && text.includes('package'))) {
        operation = 'add';
        // Extract package names
        const pkgMatch = text.match(/(?:add|install)\s+(?:packages?\s+)?([^\s]+(?:\s+[^\s]+)*)/i);
        if (pkgMatch) {
          packages = pkgMatch[1].split(/\s+/).filter((p) => !p.startsWith('-'));
        }
      } else if (text.includes('remove') || text.includes('uninstall')) {
        operation = 'remove';
        const pkgMatch = text.match(/(?:remove|uninstall)\s+([^\s]+(?:\s+[^\s]+)*)/i);
        if (pkgMatch) {
          packages = pkgMatch[1].split(/\s+/);
        }
      } else if (text.includes('update') || text.includes('upgrade')) {
        operation = 'update';
        if (text.includes('all')) {
          // Update all packages
        } else {
          // Extract specific packages to update
          const pkgMatch = text.match(/(?:update|upgrade)\s+([^\s]+(?:\s+[^\s]+)*)/i);
          if (pkgMatch) {
            packages = pkgMatch[1].split(/\s+/);
          }
        }
      } else if (text.includes('list') || text.includes('show')) {
        operation = 'list';
      } else {
        operation = 'install'; // Default operation
      }

      // Add dev flag if mentioned
      if (text.includes('--dev') || text.includes('dev dep')) {
        flags = packageManager === 'bun' ? '--dev' : '--save-dev';
      }

      let command = '';
      let output = '';

      // Check if package.json exists
      const packageJsonPath = path.join(process.cwd(), 'package.json');
      const hasPackageJson = await fs
        .access(packageJsonPath)
        .then(() => true)
        .catch(() => false);

      if (!hasPackageJson && operation !== 'list') {
        // Initialize package.json if it doesn't exist
        await execAsync(`${packageManager} init -y`);
        output += 'Initialized new package.json\n\n';
      }

      switch (operation) {
        case 'install':
          command = packageManager === 'bun' ? 'bun install' : `${packageManager} install`;
          const { stdout: installOut, stderr: installErr } = await execAsync(command, {
            timeout: 120000, // 2 minute timeout
          });
          output += installOut || installErr;

          // Count installed packages
          if (hasPackageJson) {
            const pkgJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
            const depCount = Object.keys(pkgJson.dependencies || {}).length;
            const devDepCount = Object.keys(pkgJson.devDependencies || {}).length;
            output += `\n\nInstalled ${depCount} dependencies and ${devDepCount} dev dependencies`;
          }
          break;

        case 'add':
          if (packages.length === 0) {
            throw new Error('No packages specified to install');
          }

          if (packageManager === 'bun') {
            command = `bun add ${packages.join(' ')} ${flags}`;
          } else if (packageManager === 'yarn') {
            command = `yarn add ${packages.join(' ')} ${flags}`;
          } else {
            command = `npm install ${packages.join(' ')} ${flags}`;
          }

          const { stdout: addOut, stderr: addErr } = await execAsync(command, {
            timeout: 120000,
          });
          output += addOut || addErr;
          break;

        case 'remove':
          if (packages.length === 0) {
            throw new Error('No packages specified to remove');
          }

          if (packageManager === 'bun') {
            command = `bun remove ${packages.join(' ')}`;
          } else if (packageManager === 'yarn') {
            command = `yarn remove ${packages.join(' ')}`;
          } else {
            command = `npm uninstall ${packages.join(' ')}`;
          }

          const { stdout: removeOut, stderr: removeErr } = await execAsync(command);
          output += removeOut || removeErr;
          break;

        case 'update':
          if (packages.length > 0) {
            // Update specific packages
            if (packageManager === 'bun') {
              command = `bun update ${packages.join(' ')}`;
            } else if (packageManager === 'yarn') {
              command = `yarn upgrade ${packages.join(' ')}`;
            } else {
              command = `npm update ${packages.join(' ')}`;
            }
          } else {
            // Update all packages
            if (packageManager === 'bun') {
              command = 'bun update';
            } else if (packageManager === 'yarn') {
              command = 'yarn upgrade';
            } else {
              command = 'npm update';
            }
          }

          const { stdout: updateOut, stderr: updateErr } = await execAsync(command, {
            timeout: 120000,
          });
          output += updateOut || updateErr;
          break;

        case 'list':
          if (packageManager === 'bun') {
            command = 'bun pm ls';
          } else if (packageManager === 'yarn') {
            command = 'yarn list --depth=0';
          } else {
            command = 'npm list --depth=0';
          }

          const { stdout: listOut } = await execAsync(command);
          output = listOut;
          break;
      }

      // Store package operation in memory
      await runtime.createMemory(
        {
          id: createUniqueUuid(runtime, 'package-op'),
          content: {
            text: `Package operation: ${operation}`,
            data: {
              operation,
              packageManager,
              packages,
              command,
              output,
              timestamp: new Date().toISOString(),
            },
          },
          roomId: message.roomId,
          worldId: message.worldId,
          agentId: runtime.agentId,
          entityId: runtime.agentId,
          createdAt: Date.now(),
        },
        'knowledge'
      );

      // Provide the result
      const thought = `I executed the ${packageManager} ${operation} command successfully.`;
      const responseText = `Package operation completed using ${packageManager}:

Command: \`${command}\`

Output:
\`\`\`
${output.trim()}
\`\`\``;

      await callback({
        text: responseText,
        thought,
        actions: ['PACKAGE_MANAGEMENT'],
        source: message.content.source,
        data: {
          operation,
          packageManager,
          packages,
          success: true,
        },
      });
    } catch (error) {
      logger.error('Error in packageManagement handler:', error);
      await callback({
        text: `Package operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        actions: ['PACKAGE_MANAGEMENT_ERROR'],
        source: message.content.source,
      });
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: {
          text: 'Install the express and cors packages',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Package operation completed using npm:\n\nCommand: `npm install express cors`\n\nOutput:\n```\nadded 64 packages in 2.3s\n```',
          actions: ['PACKAGE_MANAGEMENT'],
        },
      },
    ],
  ] as ActionExample[][],
};
