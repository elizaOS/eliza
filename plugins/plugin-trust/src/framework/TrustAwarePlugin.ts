import { 
  type Plugin, 
  type IAgentRuntime, 
  type Action, 
  type Memory, 
  type State, 
  type UUID,
  logger 
} from '@elizaos/core';
import { TrustEngine } from '../services/TrustEngine';
import { ContextualPermissionSystem } from '../services/ContextualPermissionSystem';
import { SecurityModule } from '../services/SecurityModule';
import { type ActionPermission, PermissionUtils } from '../types/permissions';

/**
 * Base class for trust-aware plugins
 * Provides automatic trust checking and permission management
 */
export abstract class TrustAwarePlugin implements Plugin {
  protected trustEngine: TrustEngine | null = null;
  protected permissionSystem: ContextualPermissionSystem | null = null;
  protected securityModule: SecurityModule | null = null;
  
  /**
   * Define required trust levels for actions
   * Override in subclasses
   */
  protected abstract trustRequirements: Record<string, number>;
  
  /**
   * Define required permissions for actions
   * Override in subclasses
   */
  protected abstract permissions: Record<string, ActionPermission>;
  
     /**
    * Initialize trust-aware services
    */
   async init(config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    // Get trust services
    const trustService = runtime.getService('trust-engine');
    const permService = runtime.getService('contextual-permissions');
    const secService = runtime.getService('security-module');
    
    if (trustService) {
      this.trustEngine = (trustService as any).trustEngine;
    }
    if (permService) {
      this.permissionSystem = (permService as any).permissionSystem;
    }
    if (secService) {
      this.securityModule = (secService as any).securityModule;
    }
    
    // Wrap actions with trust checking
    if (this.actions) {
      this.actions = this.actions.map(action => this.wrapAction(action));
    }
  }
  
  /**
   * Wrap an action with trust and permission checking
   */
  protected wrapAction(action: Action): Action {
    const originalHandler = action.handler;
    const originalValidate = action.validate;
    
    return {
      ...action,
      validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        // Run original validation first
        if (originalValidate) {
          const valid = await originalValidate(runtime, message, state);
          if (!valid) return false;
        }
        
        // Check trust requirements
        const trustRequired = this.trustRequirements[action.name];
        if (trustRequired && this.trustEngine) {
          const trust = await this.trustEngine.calculateTrust(message.entityId, {
            evaluatorId: runtime.agentId,
            roomId: message.roomId
          });
          
          if (trust.overallTrust < trustRequired) {
            logger.warn(`[TrustAware] Insufficient trust for ${action.name}: ${trust.overallTrust} < ${trustRequired}`);
            return false;
          }
        }
        
        // Check permissions
        const permission = this.permissions[action.name];
        if (permission && this.permissionSystem) {
          const allowed = await this.checkPermission(runtime, message, permission);
          if (!allowed) {
            logger.warn(`[TrustAware] Permission denied for ${action.name}`);
            return false;
          }
        }
        
        return true;
      },
      
      handler: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        // Log action for audit
        logger.info(`[TrustAware] Audit: ${message.entityId} executing ${action.name}`);
        
        // Execute original handler
        const result = await originalHandler(runtime, message, state);
        
        // Update trust based on action outcome
        if (this.trustEngine && result) {
          // Success increases trust slightly
          await this.trustEngine.recordInteraction({
            sourceEntityId: message.entityId,
            targetEntityId: runtime.agentId,
            type: 'HELPFUL_ACTION' as any,
            timestamp: Date.now(),
            impact: 1,
            details: {
              action: action.name,
              success: true
            }
          });
        }
        
        return result;
      }
    };
  }
  
  /**
   * Check if user has permission to execute action
   */
  protected async checkPermission(
    runtime: IAgentRuntime,
    message: Memory,
    permission: ActionPermission
  ): Promise<boolean> {
    if (!this.permissionSystem) return true; // Fallback to allow if no permission system
    
    const context = {
      caller: message.entityId,
      action: permission.action,
      trust: 0,
      roles: [] as string[]
    };
    
    // Get user's trust score
    if (this.trustEngine) {
      const trust = await this.trustEngine.calculateTrust(message.entityId, {
        evaluatorId: runtime.agentId,
        roomId: message.roomId
      });
      context.trust = trust.overallTrust;
    }
    
    // Check unix-style permissions
    return PermissionUtils.canExecute(permission.unix, context);
  }
  
  /**
   * Get trust level for a user
   */
  protected async getTrustLevel(runtime: IAgentRuntime, userId: UUID): Promise<number> {
    if (!this.trustEngine) return 0;
    
    const trust = await this.trustEngine.calculateTrust(userId, {
      evaluatorId: runtime.agentId
    });
    
    return trust.overallTrust;
  }
  
  /**
   * Check if user is trusted (>= 80 trust score)
   */
  protected async isTrusted(runtime: IAgentRuntime, userId: UUID): Promise<boolean> {
    const trust = await this.getTrustLevel(runtime, userId);
    return trust >= 80;
  }
  
  /**
   * Check if user is admin
   */
  protected isAdmin(userId: UUID): boolean {
    // This is a simplified check - in real implementation would check actual roles
    return false;
  }
  
  /**
   * Check if user is system/agent
   */
  protected isSystem(userId: UUID): boolean {
    return false;
  }
  
  // Required Plugin properties
  abstract name: string;
  abstract description: string;
  abstract actions?: Action[];
  abstract providers?: any[];
  abstract evaluators?: any[];
  abstract services?: any[];
}

// Example usage
export const exampleTrustAwarePlugin: Plugin = {
  name: 'example-trust-aware',
  description: 'Example of trust-aware plugin',
  
  actions: [
    {
      name: 'sensitive-action',
      description: 'A sensitive action requiring trust',
      examples: [],
      validate: async (runtime, message) => {
        return true; // Simple validation
      },
      handler: async (runtime, message, state) => {
        const permSystem = runtime.getService('contextual-permissions') as any;
        if (!permSystem) {
          logger.error('Permission system not available');
          return;
        }
        
        // Check access
        const hasAccess = await permSystem.checkAccess({
          entityId: message.entityId,
          action: 'sensitive-action',
          resource: 'system',
          context: {
            roomId: message.roomId
          }
        });
        
        if (!hasAccess.allowed) {
          return;
        }
        
        // Execute action
        logger.info('Executing sensitive action');
        return;
      }
    }
  ]
}; 