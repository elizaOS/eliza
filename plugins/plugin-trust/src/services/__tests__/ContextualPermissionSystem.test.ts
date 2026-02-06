import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { ContextualPermissionSystem } from '../ContextualPermissionSystem';
import { SecurityModule } from '../SecurityModule';
import { TrustEngine } from '../TrustEngine';
import { type IAgentRuntime, Role, type UUID } from '@elizaos/core';
import * as core from '@elizaos/core';
import type { AccessRequest, PermissionContext } from '../../types/permissions';
import type { TrustProfile } from '../../types/trust';

// Create spy for getUserServerRole
const getUserServerRoleSpy = vi.spyOn(core, 'getUserServerRole');

// Mock runtime
const createMockRuntime = (): IAgentRuntime =>
  ({
    agentId: 'test-agent' as UUID,
    getService: vi.fn(),
    log: vi.fn(),
    getWorld: vi.fn(),
  } as any);

describe('ContextualPermissionSystem', () => {
  let runtime: IAgentRuntime;
  let permissionSystem: ContextualPermissionSystem;
  let mockTrustEngine: any;
  let mockSecurityModule: any;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createMockRuntime();

    // Create mock trust engine
    mockTrustEngine = {
      calculateTrust: vi.fn().mockResolvedValue({
        entityId: 'test-entity' as UUID,
        evaluatorId: 'test-evaluator' as UUID,
        overallTrust: 75,
        confidence: 80,
        dimensions: {
          reliability: 80,
          competence: 75,
          integrity: 70,
          benevolence: 75,
          transparency: 75,
        },
        evidence: [],
        lastCalculated: Date.now(),
        trendDirection: 'stable' as const,
        trendChangeRate: 0,
        interactionCount: 10,
        calculationMethod: 'weighted_average',
        trend: {
          direction: 'stable' as const,
          changeRate: 0,
          recentChanges: [],
          lastChangeAt: Date.now(),
        },
      } as TrustProfile),
    };

    // Create mock security module
    mockSecurityModule = {
      detectPromptInjection: vi.fn().mockResolvedValue({
        detected: false,
        confidence: 0,
        type: 'none',
        severity: 'low',
        action: 'allow',
      }),
    };

    // Create permission system and initialize it
    permissionSystem = new ContextualPermissionSystem();
    // Initialize with mocks
    permissionSystem.initialize(runtime, mockTrustEngine, mockSecurityModule);

    // Default mock for getUserServerRole
    getUserServerRoleSpy.mockResolvedValue(Role.NONE);
  });

  describe('checkAccess', () => {
    it('should allow access for owners', async () => {
      const request: AccessRequest = {
        entityId: 'user-1' as UUID,
        action: 'delete',
        resource: 'message:123',
        context: {
          worldId: 'world-1' as UUID,
        },
      };

      getUserServerRoleSpy.mockResolvedValue(Role.OWNER);

      const result = await permissionSystem.checkAccess(request);

      expect(result.allowed).toBe(true);
      expect(result.method).toBe('role-based');
    });

    it('should allow access for admins', async () => {
      const request: AccessRequest = {
        entityId: 'user-1' as UUID,
        action: 'moderate',
        resource: 'channel:general',
        context: {
          worldId: 'world-1' as UUID,
        },
      };

      getUserServerRoleSpy.mockResolvedValue(Role.ADMIN);

      const result = await permissionSystem.checkAccess(request);

      expect(result.allowed).toBe(true);
      expect(result.method).toBe('role-based');
    });

    it('should deny access for regular members', async () => {
      const request: AccessRequest = {
        entityId: 'user-1' as UUID,
        action: 'delete',
        resource: 'message:123',
        context: {
          worldId: 'world-1' as UUID,
        },
      };

      getUserServerRoleSpy.mockResolvedValue(Role.NONE);

      const result = await permissionSystem.checkAccess(request);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('No matching role permission');
    });

    it('should allow access based on high trust', async () => {
      const request: AccessRequest = {
        entityId: 'user-1' as UUID,
        action: 'moderate',
        resource: 'channel:general',
        context: {
          worldId: 'world-1' as UUID,
        },
      };

      getUserServerRoleSpy.mockResolvedValue(Role.NONE);

      const trustProfile = {
        ...mockTrustEngine.calculateTrust(),
        overallTrust: 85,
      };

      mockTrustEngine.calculateTrust.mockResolvedValue(trustProfile);

      const result = await permissionSystem.checkAccess(request);

      expect(result.allowed).toBe(true);
      expect(result.method).toBe('trust-based');
    });

    it('should block access when security threat detected', async () => {
      const request: AccessRequest = {
        entityId: 'user-1' as UUID,
        action: 'grant_admin',
        resource: 'system:permissions',
        context: {
          worldId: 'world-1' as UUID,
        },
      };

      getUserServerRoleSpy.mockResolvedValue(Role.ADMIN);
      mockSecurityModule.detectPromptInjection.mockResolvedValue({
        detected: true,
        type: 'prompt_injection',
        confidence: 0.9,
        severity: 'high',
        action: 'block',
        details: 'Prompt injection detected',
      });

      const result = await permissionSystem.checkAccess(request);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Security block');
    });
  });

  describe('requestElevation', () => {
    it('should approve elevation for high-trust user with elevated trust score', async () => {
      const trustProfile = {
        ...mockTrustEngine.calculateTrust(),
        overallTrust: 85,
      };

      mockTrustEngine.calculateTrust.mockResolvedValue(trustProfile);

      const result = await permissionSystem.requestElevation({
        entityId: 'user-1' as UUID,
        requestedPermission: {
          action: 'moderate_content',
          resource: 'messages',
        },
        justification: 'Need to help moderate spam in the channel',
        context: {
          worldId: 'world-1' as UUID,
        },
      });

      expect(result.allowed).toBe(true);
      expect(result.method).toBe('elevated');
      expect(result.reason).toContain('trust score');
    });

    it('should deny elevation for low trust users', async () => {
      const trustProfile = {
        ...mockTrustEngine.calculateTrust(),
        overallTrust: 40,
      };

      mockTrustEngine.calculateTrust.mockResolvedValue(trustProfile);

      const result = await permissionSystem.requestElevation({
        entityId: 'user-1' as UUID,
        requestedPermission: {
          action: 'admin:delete',
          resource: 'system:users',
        },
        justification: 'Need to remove spam accounts',
        context: {
          worldId: 'world-1' as UUID,
        },
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Insufficient trust');
    });
  });
}); 