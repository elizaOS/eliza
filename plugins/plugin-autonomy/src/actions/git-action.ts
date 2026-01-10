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
import * as path from 'path';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

/**
 * Git Action - Actually performs git operations
 * Supports clone, commit, push, pull, status, and more
 */
export const gitOperationAction: Action = {
  name: 'GIT_OPERATION',
  similes: ['GIT_CLONE', 'GIT_COMMIT', 'GIT_PUSH', 'GIT_PULL', 'GIT_STATUS'],
  description: 'Performs real git operations - clone, commit, push, pull, etc',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';
    return (
      text.includes('git') ||
      (text.includes('clone') && text.includes('repo')) ||
      text.includes('commit') ||
      text.includes('push') ||
      text.includes('pull')
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
      let repoUrl = '';
      let commitMessage = '';
      let targetPath = '';

      // Determine git operation
      if (text.includes('clone')) {
        operation = 'clone';
        // Extract repo URL
        const urlMatch = text.match(/(?:clone|get)\s+(?:repo(?:sitory)?\s+)?([^\s]+)/i);
        if (urlMatch && urlMatch[1].includes('github.com')) {
          repoUrl = urlMatch[1];
          if (!repoUrl.startsWith('http')) {
            repoUrl = `https://github.com/${repoUrl}`;
          }
        }
        // Default target path
        const repoName = repoUrl.split('/').pop()?.replace('.git', '') || 'repo';
        targetPath = path.join(process.env.HOME || '', 'autonomy-repos', repoName);
      } else if (text.includes('commit')) {
        operation = 'commit';
        // Extract commit message
        const msgMatch = text.match(/commit\s+(?:with\s+message\s+)?["`']?([^"`']+)["`']?/i);
        commitMessage = msgMatch?.[1] || 'Autonomous agent commit';
      } else if (text.includes('push')) {
        operation = 'push';
      } else if (text.includes('pull')) {
        operation = 'pull';
      } else if (text.includes('status')) {
        operation = 'status';
      } else {
        operation = 'status'; // Default to status
      }

      let output = '';
      let command = '';

      switch (operation) {
        case 'clone':
          if (!repoUrl) {
            throw new Error('No repository URL provided');
          }

          // Create target directory
          await fs.mkdir(path.dirname(targetPath), { recursive: true });

          command = `git clone ${repoUrl} ${targetPath}`;
          const { stdout: cloneOut, stderr: cloneErr } = await execAsync(command, {
            timeout: 60000, // 60 second timeout for clone
          });
          output = cloneOut || cloneErr;

          // Verify clone succeeded
          const stats = await fs.stat(targetPath);
          if (stats.isDirectory()) {
            output += `\n\nRepository cloned successfully to: ${targetPath}`;

            // List files in the repo
            const files = await fs.readdir(targetPath);
            output += `\n\nFiles in repository:\n${files.slice(0, 10).join('\n')}`;
            if (files.length > 10) {
              output += `\n... and ${files.length - 10} more files`;
            }
          }
          break;

        case 'status':
          command = 'git status --porcelain';
          const { stdout: statusOut } = await execAsync(command, {
            cwd: process.cwd(),
          });

          if (statusOut.trim()) {
            const lines = statusOut.trim().split('\n');
            output = `Git Status:\n\n`;
            lines.forEach((line) => {
              const [status, file] = line.split(/\s+/, 2);
              let statusText = '';
              if (status.includes('M')) statusText = 'Modified';
              else if (status.includes('A')) statusText = 'Added';
              else if (status.includes('D')) statusText = 'Deleted';
              else if (status.includes('?')) statusText = 'Untracked';
              output += `${statusText}: ${file}\n`;
            });
          } else {
            output = 'Working directory is clean - no changes to commit';
          }
          break;

        case 'commit':
          // First check if there are changes
          const { stdout: checkOut } = await execAsync('git status --porcelain');
          if (!checkOut.trim()) {
            output = 'No changes to commit';
            break;
          }

          // Add all changes
          await execAsync('git add -A');

          // Commit with message
          command = `git commit -m "${commitMessage}"`;
          const { stdout: commitOut } = await execAsync(command);
          output = commitOut;
          break;

        case 'push':
          command = 'git push';
          const { stdout: pushOut, stderr: pushErr } = await execAsync(command, {
            timeout: 30000,
          });
          output = pushOut || pushErr;
          break;

        case 'pull':
          command = 'git pull';
          const { stdout: pullOut, stderr: pullErr } = await execAsync(command, {
            timeout: 30000,
          });
          output = pullOut || pullErr;
          break;
      }

      // Store git operation in memory
      await runtime.createMemory(
        {
          id: createUniqueUuid(runtime, 'git-op'),
          content: {
            text: `Git operation: ${operation}`,
            data: {
              operation,
              command,
              output,
              repoUrl,
              targetPath,
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
      const thought = `I executed the git ${operation} operation successfully.`;
      const responseText = `Git ${operation} completed:

\`\`\`
${output.trim()}
\`\`\`

${operation === 'clone' ? `Repository is now available at: ${targetPath}` : ''}`;

      await callback({
        text: responseText,
        thought,
        actions: ['GIT_OPERATION'],
        source: message.content.source,
        data: {
          operation,
          success: true,
          repoUrl,
          targetPath,
        },
      });
    } catch (error) {
      logger.error('Error in gitOperation handler:', error);
      await callback({
        text: `Git operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        actions: ['GIT_OPERATION_ERROR'],
        source: message.content.source,
      });
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: {
          text: 'Clone the repository https://github.com/elizaos/eliza',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "Git clone completed:\n\n```\nCloning into 'eliza'...\nRepository cloned successfully to: /Users/username/autonomy-repos/eliza\n```",
          actions: ['GIT_OPERATION'],
        },
      },
    ],
  ] as ActionExample[][],
};
