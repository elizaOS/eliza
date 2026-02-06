import {
  type IAgentRuntime,
  type UUID,
  logger,
  type Memory,
  Role,
  stringToUuid,
} from '@elizaos/core';

import {
  type Permission,
  type PermissionContext,
  type AccessRequest,
  type AccessDecision,
  type ElevationRequest,
  type ContextualRole,
  type PermissionDelegation,
  type PermissionDecision as IPermissionDecision,
} from '../types/permissions';
import { type TrustProfile, type TrustRequirements } from '../types/trust';
import { TrustEngine } from './TrustEngine';
import { SecurityModule } from './SecurityModule';
import { getUserServerRole } from '@elizaos/core';

export class ContextualPermissionSystem {
  private runtime!: IAgentRuntime;
  private trustEngine!: TrustEngine;
  private securityModule!: SecurityModule;

  private permissionCache = new Map<string, { decision: AccessDecision; expiry: number }>();
  private contextualRoles = new Map<string, ContextualRole[]>();
  private delegations = new Map<string, PermissionDelegation[]>();
  private elevations = new Map<string, ElevationRequest & { expiresAt: number }>();

  constructor() {}

  async initialize(
    runtime: IAgentRuntime,
    trustEngine: TrustEngine,
    securityModule: SecurityModule
  ): Promise<void> {
    this.runtime = runtime;
    this.trustEngine = trustEngine;
    this.securityModule = securityModule;
  }

  async hasPermission(
    entityId: UUID,
    permission: Permission,
    context: PermissionContext
  ): Promise<boolean> {
    const decision = await this.checkAccess({
      entityId,
      action: permission.action,
      resource: permission.resource,
      context,
    });
    return decision.allowed;
  }

  async checkAccess(request: AccessRequest): Promise<AccessDecision> {
    const startTime = Date.now();
    const cacheKey = JSON.stringify(request);
    const cached = this.permissionCache.get(cacheKey);
    if (cached && cached.expiry > startTime) {
      return cached.decision;
    }

    // Security Module Checks
    const content = `${request.action} on ${request.resource}`;
    const injectionCheck = await this.securityModule.detectPromptInjection(content, {
      ...request.context,
      entityId: request.entityId,
      requestedAction: content,
    });
    if (injectionCheck.detected && injectionCheck.action === 'block') {
      return this.createDecision(request, {
        allowed: false,
        method: 'denied',
        reason: `Security block: ${injectionCheck.details}`,
      });
    }

    // Role-based check
    const roleDecision = await this.checkRolePermissions(request);
    if (roleDecision.allowed) {
      return this.createDecision(request, roleDecision);
    }

    // Trust-based check
    const trustDecision = await this.checkTrustPermissions(request);
    if (trustDecision.allowed) {
      return this.createDecision(request, trustDecision);
    }

    // Delegation check
    const delegationDecision = await this.checkDelegatedPermissions(request);
    if (delegationDecision.allowed) {
      return this.createDecision(request, delegationDecision);
    }

    const reason = this.generateDenialReason(roleDecision, trustDecision, delegationDecision);
    return this.createDecision(request, { allowed: false, method: 'denied', reason });
  }

  private async checkRolePermissions(request: AccessRequest): Promise<IPermissionDecision> {
    const roles = await this.getEntityRoles(request.entityId, request.context);
    for (const role of roles) {
      if (this.roleHasPermission(role, request.action, request.resource)) {
        return { allowed: true, method: 'role-based', reason: `Allowed by role: ${role}` };
      }
    }
    return { allowed: false, method: 'denied', reason: 'No matching role permission' };
  }

  private async checkTrustPermissions(request: AccessRequest): Promise<IPermissionDecision> {
    const trustProfile = await this.trustEngine.calculateTrust(request.entityId, {
      ...request.context,
      evaluatorId: this.runtime.agentId,
    });
    // Define some logic for trust-based access (trust scores are 0-100)
    if (trustProfile.overallTrust > 80) {
      return {
        allowed: true,
        method: 'trust-based',
        reason: `Allowed by high trust score: ${trustProfile.overallTrust.toFixed(2)}`,
      };
    }
    return { allowed: false, method: 'denied', reason: 'Insufficient trust' };
  }

  private async checkDelegatedPermissions(request: AccessRequest): Promise<IPermissionDecision> {
    const delegations = this.delegations.get(request.entityId) || [];
    // ... logic for checking delegations
    return { allowed: false, method: 'denied', reason: 'No valid delegation found' };
  }

  async requestElevation(request: ElevationRequest): Promise<AccessDecision> {
    const trustProfile = await this.trustEngine.calculateTrust(request.entityId, {
      ...request.context,
      evaluatorId: this.runtime.agentId,
    });
    if (trustProfile.overallTrust > 70) {
      const elevationId = stringToUuid(JSON.stringify(request));
      const expiresAt = Date.now() + (request.duration || 5 * 60) * 1000;
      this.elevations.set(elevationId, { ...request, expiresAt });
      return this.createDecision(
        {
          action: request.requestedPermission.action,
          resource: request.requestedPermission.resource,
          ...request,
        },
        {
          allowed: true,
          method: 'elevated',
          reason: `Elevation granted based on trust score ${trustProfile.overallTrust.toFixed(2)}`,
        }
      );
    }
    return this.createDecision(
      {
        action: request.requestedPermission.action,
        resource: request.requestedPermission.resource,
        ...request,
      },
      { allowed: false, method: 'denied', reason: 'Insufficient trust for elevation' }
    );
  }

  private createDecision(
    request: AccessRequest,
    partialDecision: Partial<AccessDecision>
  ): AccessDecision {
    const decision: AccessDecision = {
      request,
      allowed: partialDecision.allowed || false,
      method: partialDecision.method || 'denied',
      reason: partialDecision.reason || '',
      evaluatedAt: Date.now(),
      ...partialDecision,
    };
    if (decision.allowed) {
      const cacheKey = JSON.stringify(request);
      this.permissionCache.set(cacheKey, {
        decision,
        expiry: Date.now() + (decision.ttl || 300000),
      });
    }
    return decision;
  }

  private roleHasPermission(roleName: Role | string, action: string, resource: string): boolean {
    // This is a simplified stand-in for the complex role checking logic
    return roleName === Role.OWNER || roleName === Role.ADMIN;
  }

  private async getEntityRoles(entityId: UUID, context: PermissionContext): Promise<string[]> {
    if (context.worldId) {
      const role = await getUserServerRole(this.runtime, entityId, context.worldId);
      return role ? [role] : [];
    }
    return [];
  }

  private generateDenialReason(
    roleDecision: IPermissionDecision,
    trustDecision: IPermissionDecision,
    delegationDecision: IPermissionDecision
  ): string {
    return `Access denied. Role check: ${roleDecision.reason}. Trust check: ${trustDecision.reason}. Delegation check: ${delegationDecision.reason}.`;
  }
}
