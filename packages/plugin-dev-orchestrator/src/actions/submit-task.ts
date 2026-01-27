import { Action, HandlerCallback, IAgentRuntime, Memory, State, logger } from '@elizaos/core';
import { DevOrchestratorService } from '../services/orchestrator.service';
import { AuthorizationService } from '../services/authorization.service';
import { getUserAgentPreference } from './set-agent-preference';
import { AgentRegistry } from '../services/agent-registry.service';

export const submitTaskAction: Action = {
    name: 'SUBMIT_CODE_TASK',
    similes: ['CODE_TASK', 'MODIFY_CODE', 'FIX_CODE', 'UPDATE_CODE'],
    description: 'Submit a coding task to be executed by an AI coding agent',
    
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const text = message.content.text.toLowerCase();
        return (
            (text.includes('fix') || text.includes('modify') || text.includes('update') || text.includes('change')) &&
            (text.includes('code') || text.includes('file') || text.includes('project') || text.includes('build'))
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
                text: authService.getUnauthorizedMessage('SUBMIT_CODE_TASK'),
            });
            return;
        }

        const orchestrator = runtime.getService('DEV_ORCHESTRATOR') as DevOrchestratorService;
        if (!orchestrator) {
            await callback({
                text: 'Dev orchestrator service is not available',
            });
            return;
        }

        // Extract project path, agent type, and prompt from message
        const text = message.content.text;

        // Try to extract project path
        const pathMatch = text.match(/(?:in|for|at)\s+([\/\w\-\.]+)/i);
        const projectPath = pathMatch ? pathMatch[1] : process.cwd();

        // Try to extract agent type from message using registry
        // Looks for patterns like "using X", "with X", "via X" where X is a registered agent or alias
        const registry = AgentRegistry.getInstance();
        const explicitAgent = registry.parseAgentFromInput(text);

        let agentType: string;

        if (explicitAgent) {
            // User explicitly specified agent in message
            agentType = explicitAgent;
            logger.info(`[SubmitTask] User explicitly requested agent: ${agentType}`);
        } else {
            // Use user's saved preference or auto-detect
            agentType = await getUserAgentPreference(
                runtime,
                message.entityId,
                message.worldId
            );
            logger.info(`[SubmitTask] Using preference/auto-detect agent: ${agentType}`);
        }

        // The rest is the prompt (remove path and agent references)
        // Build dynamic regex pattern from all registered agents and their aliases
        const allNames: string[] = [];
        for (const [name, registration] of registry.getAll().entries()) {
            allNames.push(name);
            if (registration.aliases) {
                allNames.push(...registration.aliases);
            }
        }
        const agentPattern = allNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const agentRegex = new RegExp(`\\b(?:using|with|via|in|on)\\s+(?:the\\s+)?(${agentPattern})(?:\\s+agent)?\\b`, 'gi');

        let prompt = text
            .replace(/(?:in|for|at)\s+[\/\w\-\.]+/i, '')
            .replace(agentRegex, '')
            .trim();

        if (!prompt || prompt.length < 10) {
            await callback({
                text: 'Please provide a clear description of what you want to change. Example: "Fix the build errors in /path/to/project"',
            });
            return;
        }

        try {
            const task = await orchestrator.submitTask(projectPath, prompt, agentType);

            const queueStatus = orchestrator.getQueueStatus();

            await callback({
                text: `✅ Task submitted: #${task.id}\n\nProject: ${projectPath}\nAgent: ${agentType}\nPrompt: ${prompt}\n\n📊 Queue: ${queueStatus.pending} waiting / ${queueStatus.running} running`,
            });
        } catch (error) {
            await callback({
                text: `Failed to submit task: ${error}`,
            });
        }
    },

    examples: [
        [
            {
                name: '{{user1}}',
                content: { text: 'Fix the build errors in /home/user/myproject' },
            },
            {
                name: '{{agentName}}',
                content: { text: 'Task submitted...', action: 'SUBMIT_CODE_TASK' },
            },
        ],
        [
            {
                name: '{{user1}}',
                content: { text: 'Update the API to use async/await in ./backend' },
            },
            {
                name: '{{agentName}}',
                content: { text: 'Task submitted...', action: 'SUBMIT_CODE_TASK' },
            },
        ],
    ],
};

export const queueStatusAction: Action = {
    name: 'QUEUE_STATUS',
    similes: ['TASK_STATUS', 'SHOW_QUEUE', 'LIST_TASKS'],
    description: 'Show the status of the task queue',
    
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const text = message.content.text.toLowerCase();
        return (
            (text.includes('queue') || text.includes('task') || text.includes('status')) &&
            (text.includes('show') || text.includes('list') || text.includes('what'))
        );
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        const orchestrator = runtime.getService('DEV_ORCHESTRATOR') as DevOrchestratorService;
        if (!orchestrator) {
            await callback({
                text: 'Dev orchestrator service is not available',
            });
            return;
        }

        try {
            const status = orchestrator.getQueueStatus();
            
            if (status.tasks.length === 0) {
                await callback({
                    text: '📊 Queue is empty',
                });
                return;
            }

            const taskList = status.tasks.map(task => {
                const statusEmoji = {
                    'pending': '⏳',
                    'running': '🔄',
                    'review': '👀',
                    'approved': '✅',
                    'rejected': '❌',
                    'needs_manual_resolution': '⚠️',
                }[task.status] || '❓';

                return `${statusEmoji} **#${task.id}** (${task.status})\n  Project: ${task.projectPath}\n  Prompt: ${task.prompt.substring(0, 50)}${task.prompt.length > 50 ? '...' : ''}`;
            }).join('\n\n');

            await callback({
                text: `📊 **Queue Status**\n\n${status.pending} waiting / ${status.running} running\n\n${taskList}`,
            });
        } catch (error) {
            await callback({
                text: `Failed to get queue status: ${error}`,
            });
        }
    },

    examples: [
        [
            {
                name: '{{user1}}',
                content: { text: 'Show me the task queue' },
            },
            {
                name: '{{agentName}}',
                content: { text: 'Here is the queue status...', action: 'QUEUE_STATUS' },
            },
        ],
    ],
};

