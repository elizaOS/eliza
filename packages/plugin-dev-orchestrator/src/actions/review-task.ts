import { Action, HandlerCallback, IAgentRuntime, Memory, State } from '@elizaos/core';
import { DevOrchestratorService } from '../services/orchestrator.service';
import { AuthorizationService } from '../services/authorization.service';

export const approveTaskAction: Action = {
    name: 'APPROVE_TASK',
    similes: ['APPROVE_CODE', 'ACCEPT_TASK', 'APPROVE_CHANGES'],
    description: 'Approve a code task that is ready for review',
    
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const text = message.content.text.toLowerCase();
        return (
            (text.includes('approve') || text.includes('accept')) &&
            (text.includes('task') || text.includes('code') || text.includes('changes'))
        );
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        // Check authorization (admin only for approvals)
        const authService = new AuthorizationService(runtime);
        if (!authService.isAdmin(message)) {
            await callback({
                text: '🔒 Only administrators can approve code changes.',
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

        // Extract task ID from message
        const text = message.content.text;
        const match = text.match(/(?:approve|accept)\s+(?:task\s+)?#?([a-zA-Z0-9_-]+)/i);
        
        if (!match) {
            await callback({
                text: 'Please specify which task to approve. Example: "approve task #task-123"',
            });
            return;
        }

        const taskId = match[1];

        try {
            await orchestrator.approveTask(taskId);
            
            await callback({
                text: `✅ Task #${taskId} approved and changes committed!`,
            });
        } catch (error) {
            await callback({
                text: `Failed to approve task #${taskId}: ${error}`,
            });
        }
    },

    examples: [
        [
            {
                name: '{{user1}}',
                content: { text: 'Approve task #task-123' },
            },
            {
                name: '{{agentName}}',
                content: { text: 'Task approved!', action: 'APPROVE_TASK' },
            },
        ],
    ],
};

export const rejectTaskAction: Action = {
    name: 'REJECT_TASK',
    similes: ['REJECT_CODE', 'DECLINE_TASK', 'REJECT_CHANGES'],
    description: 'Reject a code task and rollback changes',
    
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const text = message.content.text.toLowerCase();
        return (
            (text.includes('reject') || text.includes('decline') || text.includes('rollback')) &&
            (text.includes('task') || text.includes('code') || text.includes('changes'))
        );
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        // Check authorization (admin only for rejections)
        const authService = new AuthorizationService(runtime);
        if (!authService.isAdmin(message)) {
            await callback({
                text: '🔒 Only administrators can reject code changes.',
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

        // Extract task ID from message
        const text = message.content.text;
        const match = text.match(/(?:reject|decline|rollback)\s+(?:task\s+)?#?([a-zA-Z0-9_-]+)/i);
        
        if (!match) {
            await callback({
                text: 'Please specify which task to reject. Example: "reject task #task-123"',
            });
            return;
        }

        const taskId = match[1];
        const reason = text.replace(/(?:reject|decline|rollback)\s+(?:task\s+)?#?[a-zA-Z0-9_-]+/i, '').trim();

        try {
            await orchestrator.rejectTask(taskId, reason || 'Rejected by user');
            
            await callback({
                text: `❌ Task #${taskId} rejected and changes rolled back.${reason ? `\nReason: ${reason}` : ''}`,
            });
        } catch (error) {
            await callback({
                text: `Failed to reject task #${taskId}: ${error}`,
            });
        }
    },

    examples: [
        [
            {
                name: '{{user1}}',
                content: { text: 'Reject task #task-123 because it broke the tests' },
            },
            {
                name: '{{agentName}}',
                content: { text: 'Task rejected and rolled back!', action: 'REJECT_TASK' },
            },
        ],
    ],
};

