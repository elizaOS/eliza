import { logger } from '@elizaos/core';
import type { IAgentRuntime, Memory } from '@elizaos/core';

export interface AuthorizationConfig {
    authorizedUsers?: string[];
    authorizedRoles?: string[];
    adminUsers?: string[];
    requireApprovalForAll?: boolean;
}

export class AuthorizationService {
    private config: AuthorizationConfig;

    constructor(private runtime: IAgentRuntime) {
        this.config = this.loadConfig();
    }

    private loadConfig(): AuthorizationConfig {
        const configStr = this.runtime.getSetting('DEV_ORCHESTRATOR_AUTHORIZED_USERS');
        const rolesStr = this.runtime.getSetting('DEV_ORCHESTRATOR_AUTHORIZED_ROLES');
        const adminStr = this.runtime.getSetting('DEV_ORCHESTRATOR_ADMIN_USERS');
        const requireApproval = this.runtime.getSetting('DEV_ORCHESTRATOR_REQUIRE_APPROVAL') === 'true';

        return {
            authorizedUsers: configStr ? JSON.parse(configStr) : [],
            authorizedRoles: rolesStr ? JSON.parse(rolesStr) : ['admin', 'developer'],
            adminUsers: adminStr ? JSON.parse(adminStr) : [],
            requireApprovalForAll: requireApproval || false,
        };
    }

    /**
     * Check if a user is authorized to execute dev actions
     */
    isAuthorized(message: Memory): boolean {
        const userId = message.userId;
        const username = this.getUsernameFromMessage(message);

        // Check if user is in admin list (full access)
        if (this.config.adminUsers && this.config.adminUsers.length > 0) {
            if (this.config.adminUsers.includes(userId) || 
                this.config.adminUsers.includes(username)) {
                logger.info(`[AuthorizationService] Admin user authorized: ${username || userId}`);
                return true;
            }
        }

        // Check if user is in authorized users list
        if (this.config.authorizedUsers && this.config.authorizedUsers.length > 0) {
            if (this.config.authorizedUsers.includes(userId) || 
                this.config.authorizedUsers.includes(username)) {
                logger.info(`[AuthorizationService] User authorized: ${username || userId}`);
                return true;
            }
        }

        // Check user roles (if available in message metadata)
        if (this.config.authorizedRoles && this.config.authorizedRoles.length > 0) {
            const userRoles = this.getUserRoles(message);
            const hasAuthorizedRole = userRoles.some(role => 
                this.config.authorizedRoles?.includes(role)
            );
            if (hasAuthorizedRole) {
                logger.info(`[AuthorizationService] User authorized by role: ${username || userId}`);
                return true;
            }
        }

        // If no authorization lists are configured, allow all (backwards compatible)
        if ((!this.config.authorizedUsers || this.config.authorizedUsers.length === 0) &&
            (!this.config.authorizedRoles || this.config.authorizedRoles.length === 0) &&
            (!this.config.adminUsers || this.config.adminUsers.length === 0)) {
            logger.warn('[AuthorizationService] No authorization configured, allowing all users');
            return true;
        }

        logger.warn(`[AuthorizationService] User not authorized: ${username || userId}`);
        return false;
    }

    /**
     * Check if a user is an admin (can approve tasks, bypass restrictions)
     */
    isAdmin(message: Memory): boolean {
        const userId = message.userId;
        const username = this.getUsernameFromMessage(message);

        if (this.config.adminUsers && this.config.adminUsers.length > 0) {
            return this.config.adminUsers.includes(userId) || 
                   this.config.adminUsers.includes(username);
        }

        // If no admin list configured, fall back to authorized check
        return this.isAuthorized(message);
    }

    /**
     * Check if a specific action requires approval
     */
    requiresApproval(actionName: string): boolean {
        // If global approval is required, all actions need approval
        if (this.config.requireApprovalForAll) {
            return true;
        }

        // High-risk actions always require approval
        const highRiskActions = [
            'SUBMIT_CODE_TASK',
            'APPROVE_TASK',
            'PM2_RESTART',
            'ROLLBACK_CHANGES',
        ];

        return highRiskActions.includes(actionName);
    }

    /**
     * Get username from message
     */
    private getUsernameFromMessage(message: Memory): string {
        // Try different possible locations for username
        return (
            (message.content as any)?.username ||
            (message.content as any)?.author?.username ||
            (message as any)?.username ||
            ''
        );
    }

    /**
     * Get user roles from message metadata
     */
    private getUserRoles(message: Memory): string[] {
        // Try to extract roles from message metadata
        const roles = (message.content as any)?.roles || 
                     (message as any)?.roles || 
                     [];
        
        return Array.isArray(roles) ? roles : [];
    }

    /**
     * Get authorization error message
     */
    getUnauthorizedMessage(actionName: string): string {
        return `🔒 You are not authorized to use ${actionName}.\n\nThis action is restricted to authorized users only. Please contact an administrator if you need access.`;
    }

    /**
     * Get configuration summary for debugging
     */
    getConfigSummary(): string {
        return `Authorization Config:
- Authorized Users: ${this.config.authorizedUsers?.length || 0}
- Authorized Roles: ${this.config.authorizedRoles?.join(', ') || 'none'}
- Admin Users: ${this.config.adminUsers?.length || 0}
- Require Approval: ${this.config.requireApprovalForAll}`;
    }
}

