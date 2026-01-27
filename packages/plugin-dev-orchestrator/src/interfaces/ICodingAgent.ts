import type { IAgentRuntime } from '@elizaos/core';

export interface Task {
    id: string;
    status: 'pending' | 'running' | 'review' | 'approved' | 'rejected' | 'needs_manual_resolution';
    projectPath: string;
    gitRepo: string;
    prompt: string;
    agentType?: string; // 'cursor' | 'claude-code' | etc.
    branch?: string;
    createdAt: Date;
    modifiedFiles?: string[];
    error?: string;
    buildAttempts?: number;
}

export interface AgentResult {
    success: boolean;
    modifiedFiles?: string[];
    error?: string;
    output?: string;
}

export interface ICodingAgent {
    /**
     * Execute a coding task
     */
    execute(task: Task, runtime: IAgentRuntime): Promise<AgentResult>;

    /**
     * Fix an error from a previous execution
     */
    fixError(error: string, task: Task, runtime: IAgentRuntime): Promise<AgentResult>;

    /**
     * Get the name of this agent
     */
    getName(): string;
}

