import { logger } from '@elizaos/core';
import type { IAgentRuntime } from '@elizaos/core';

export interface CommandApprovalRequest {
    taskId: string;
    command: string;
    projectPath: string;
    timestamp: number;
}

export interface CommandApprovalResponse {
    approved: boolean;
    reason?: string;
}

export class CommandApprovalService {
    private defaultAllowlist: string[] = [
        'bun install',
        'npm install',
        'yarn install',
        'pnpm install',
        'bun run build',
        'npm run build',
        'yarn build',
        'pnpm build',
        'git status',
        'git diff',
        'git stash',
        'git add',
        'git commit',
    ];

    private dangerousPatterns: RegExp[] = [
        /rm\s+-rf/,
        /sudo/,
        />/,  // Shell redirects
        /curl.*\|.*sh/,  // Pipe to shell
        /wget.*\|.*sh/,
        /eval/,
        /exec/,
        /chmod\s+\+x/,
    ];

    private pendingApprovals: Map<string, CommandApprovalRequest> = new Map();
    private approvalCallbacks: Map<string, (response: CommandApprovalResponse) => void> = new Map();

    constructor(private runtime: IAgentRuntime) {}

    /**
     * Check if a command is safe to execute without approval
     */
    isCommandSafe(command: string): boolean {
        const allowlist = this.getCustomAllowlist();
        
        // Check if command is in allowlist
        for (const allowed of allowlist) {
            if (command.trim().startsWith(allowed)) {
                return true;
            }
        }

        // Check for dangerous patterns
        for (const pattern of this.dangerousPatterns) {
            if (pattern.test(command)) {
                logger.warn(`[CommandApprovalService] Dangerous pattern detected: ${pattern}`);
                return false;
            }
        }

        // If not in allowlist and no dangerous patterns, still require approval
        return false;
    }

    /**
     * Request approval for a command
     */
    async requestApproval(request: CommandApprovalRequest): Promise<CommandApprovalResponse> {
        logger.info(`[CommandApprovalService] Requesting approval for command: ${request.command}`);

        // Check if command is safe
        if (this.isCommandSafe(request.command)) {
            logger.info('[CommandApprovalService] Command is in allowlist, auto-approving');
            return { approved: true };
        }

        // Store the request
        this.pendingApprovals.set(request.taskId, request);

        // Emit event for approval request
        // TODO: Implement proper event emission for approval requests
        logger.info(`[CommandApprovalService] Approval request: ${request.command}`);

        // Wait for approval (with timeout)
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                this.pendingApprovals.delete(request.taskId);
                this.approvalCallbacks.delete(request.taskId);
                resolve({
                    approved: false,
                    reason: 'Approval timeout (5 minutes)',
                });
            }, 300000); // 5 minute timeout

            this.approvalCallbacks.set(request.taskId, (response) => {
                clearTimeout(timeoutId);
                this.pendingApprovals.delete(request.taskId);
                this.approvalCallbacks.delete(request.taskId);
                resolve(response);
            });
        });
    }

    /**
     * Approve a command
     */
    approveCommand(taskId: string): boolean {
        const callback = this.approvalCallbacks.get(taskId);
        if (callback) {
            callback({ approved: true });
            return true;
        }
        return false;
    }

    /**
     * Reject a command
     */
    rejectCommand(taskId: string, reason?: string): boolean {
        const callback = this.approvalCallbacks.get(taskId);
        if (callback) {
            callback({ approved: false, reason });
            return true;
        }
        return false;
    }

    /**
     * Get pending approval requests
     */
    getPendingApprovals(): CommandApprovalRequest[] {
        return Array.from(this.pendingApprovals.values());
    }

    /**
     * Get custom allowlist from settings
     */
    private getCustomAllowlist(): string[] {
        const customAllowlistStr = this.runtime.getSetting('DEV_ORCHESTRATOR_COMMAND_ALLOWLIST');
        if (customAllowlistStr && typeof customAllowlistStr === 'string') {
            try {
                const customAllowlist = JSON.parse(customAllowlistStr);
                if (Array.isArray(customAllowlist)) {
                    return [...this.defaultAllowlist, ...customAllowlist];
                }
            } catch (error) {
                logger.warn({ error }, '[CommandApprovalService] Failed to parse custom allowlist');
            }
        }
        return this.defaultAllowlist;
    }
}

