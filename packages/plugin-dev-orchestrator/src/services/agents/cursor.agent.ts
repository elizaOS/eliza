/**
 * CursorAgent - Executes coding tasks using Cursor CLI
 *
 * ============================================================================
 * EXPERIMENTAL AGENT - CLI command unverified, use with caution
 * ============================================================================
 *
 * WHY THIS IS MARKED EXPERIMENTAL:
 * 1. UNVERIFIED CLI - The `cursor --prompt` command is a PLACEHOLDER
 *    We don't know the actual Cursor CLI API. Run `cursor --help` to verify.
 * 2. NO AUTO-APPROVAL - Unlike Claude Code's --no-confirm, we don't know if
 *    Cursor supports unattended execution. If it requires manual approval,
 *    it CANNOT work in the orchestrator's automated workflow.
 * 3. UNTESTED - This implementation hasn't been validated with real Cursor.
 *
 * WHY WE INCLUDE IT ANYWAY:
 * - Some users prefer Cursor's IDE-integrated approach
 * - The interface is ready for when someone verifies the CLI API
 * - Demonstrates how to add new agents to the registry
 *
 * WHAT NEEDS TO BE DONE:
 * 1. Install Cursor and run `cursor --help` to see actual CLI flags
 * 2. Find the equivalent of --no-confirm for auto-approval
 * 3. Test end-to-end with a real task
 * 4. Update isStable=true and isRecommended if it works well
 *
 * WHY Bun.spawn INSTEAD OF child_process:
 * Per CLAUDE.md/elizaOS guidelines, we must use Bun.spawn for all process
 * execution. Node.js child_process.exec() has compatibility issues with Bun.
 *
 * CURRENT (PLACEHOLDER) CLI COMMAND:
 * ```bash
 * cursor --prompt "task prompt"
 * # Missing: working directory, auto-approval flag
 * ```
 */

import { logger } from '@elizaos/core';
import type { IAgentRuntime } from '@elizaos/core';
import type { ICodingAgent, Task, AgentResult } from '../../interfaces/ICodingAgent';

/**
 * Execute a command using Bun.spawn
 */
async function execCommand(
    command: string,
    args: string[],
    options: { cwd: string; timeout?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn([command, ...args], {
        cwd: options.cwd,
        stdout: 'pipe',
        stderr: 'pipe',
    });

    // Set timeout if specified
    const timeoutMs = options.timeout || 300000; // Default 5 minutes
    const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Command timed out')), timeoutMs)
    );

    try {
        const [stdout, stderr] = await Promise.race([
            Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
            ]),
            timeoutPromise,
        ]);

        const exitCode = await proc.exited;

        return { stdout, stderr, exitCode };
    } catch (error) {
        proc.kill();
        throw error;
    }
}

/**
 * Check if a command exists in PATH
 */
async function commandExists(command: string): Promise<boolean> {
    try {
        const result = await execCommand('which', [command], { cwd: '/' });
        return result.exitCode === 0;
    } catch {
        return false;
    }
}

export class CursorAgent implements ICodingAgent {
    getName(): string {
        return 'cursor';
    }

    async execute(task: Task, runtime: IAgentRuntime): Promise<AgentResult> {
        logger.info(`[CursorAgent] Executing task: ${task.id}`);
        logger.debug(`[CursorAgent] Prompt: ${task.prompt}`);

        try {
            // Check if cursor CLI is available
            const cursorExists = await commandExists('cursor');
            if (!cursorExists) {
                logger.error('[CursorAgent] Cursor CLI not found in PATH');
                return {
                    success: false,
                    error: 'Cursor CLI not found. Please install Cursor and ensure the CLI is in your PATH.',
                };
            }

            // Execute cursor with the prompt
            // Note: Actual Cursor CLI API may differ - adjust as needed
            logger.debug(`[CursorAgent] Executing Cursor with task prompt`);

            const result = await execCommand(
                'cursor',
                ['--prompt', task.prompt],
                {
                    cwd: task.projectPath,
                    timeout: 300000, // 5 minute timeout
                }
            );

            const output = result.stdout + (result.stderr ? `\n${result.stderr}` : '');

            if (result.exitCode !== 0) {
                logger.error(`[CursorAgent] Cursor execution failed with exit code: ${result.exitCode}`);
                return {
                    success: false,
                    error: result.stderr || 'Cursor execution failed',
                    output: result.stdout,
                };
            }

            logger.info('[CursorAgent] Task execution completed successfully');

            // Modified files will be detected via git diff
            const modifiedFiles: string[] = [];

            return {
                success: true,
                modifiedFiles,
                output,
            };
        } catch (error: any) {
            logger.error('[CursorAgent] Task execution failed:', error);

            return {
                success: false,
                error: error.message || 'Unknown error',
                output: '',
            };
        }
    }

    async fixError(error: string, task: Task, runtime: IAgentRuntime): Promise<AgentResult> {
        logger.info(`[CursorAgent] Fixing error for task: ${task.id}`);
        logger.debug(`[CursorAgent] Error: ${error}`);

        // Create a new prompt that includes the error context
        const fixPrompt = `The previous attempt to complete the following task failed:

**Original Task:**
${task.prompt}

**Error Encountered:**
\`\`\`
${error}
\`\`\`

Please analyze the error, fix the issue, and complete the task successfully.`;

        // Execute with the fix prompt
        const fixTask: Task = {
            ...task,
            prompt: fixPrompt,
        };

        return this.execute(fixTask, runtime);
    }
}
