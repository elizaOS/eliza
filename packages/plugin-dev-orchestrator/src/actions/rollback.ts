import { Action, HandlerCallback, IAgentRuntime, Memory, State } from '@elizaos/core';
import { GitServiceLegacy } from '../services/git-legacy.service';
import { AuthorizationService } from '../services/authorization.service';

/**
 * Execute a git command using Bun.spawn
 */
async function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(['git', ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
    });

    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
}

export const rollbackAction: Action = {
    name: 'ROLLBACK_CHANGES',
    similes: ['UNDO_CHANGES', 'REVERT_CHANGES', 'GIT_RESET'],
    description: 'Rollback uncommitted changes in a project',

    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const text = message.content.text.toLowerCase();
        return (
            (text.includes('rollback') || text.includes('undo') || text.includes('revert')) &&
            (text.includes('changes') || text.includes('code'))
        );
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        // Check authorization
        const authService = new AuthorizationService(runtime);
        if (!authService.isAuthorized(message)) {
            await callback({
                text: authService.getUnauthorizedMessage('ROLLBACK_CHANGES'),
            });
            return;
        }
        // Extract project path from message
        const text = message.content.text;
        const pathMatch = text.match(/(?:in|for|at)\s+([\/\w\-\.]+)/i);
        const projectPath = pathMatch ? pathMatch[1] : process.cwd();

        try {
            const gitService = new GitServiceLegacy();

            // Check if there are uncommitted changes
            const isClean = await gitService.isClean(projectPath);
            if (isClean) {
                await callback({
                    text: `No uncommitted changes to rollback in ${projectPath}`,
                });
                return;
            }

            // Get diff before rollback
            const diff = await gitService.getDiff(projectPath);

            // Perform rollback (git reset --hard HEAD) using Bun.spawn
            const result = await execGit(['reset', '--hard', 'HEAD'], projectPath);

            if (result.exitCode !== 0) {
                throw new Error(result.stderr || 'Failed to rollback changes');
            }

            await callback({
                text: `✅ Rolled back changes in ${projectPath}\n\nReverted ${diff.files.length} file(s):\n${diff.files.join('\n')}`,
            });
        } catch (error) {
            await callback({
                text: `Failed to rollback changes: ${error}`,
            });
        }
    },

    examples: [
        [
            {
                name: '{{user1}}',
                content: { text: 'Rollback changes in /home/user/myproject' },
            },
            {
                name: '{{agentName}}',
                content: { text: 'Changes rolled back!', action: 'ROLLBACK_CHANGES' },
            },
        ],
    ],
};

