import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { requestElevationAction } from '../requestElevation';
import type { IAgentRuntime, Memory, State, UUID } from '@elizaos/core';
import { ChannelType } from '@elizaos/core';

const createMockRuntime = (): IAgentRuntime =>
  ({
    agentId: 'test-agent' as any,
    getSetting: vi.fn(),
    log: vi.fn(),
    getService: vi.fn(),
  } as any);

const createMockMemory = (text: string, entityId: UUID): Memory =>
  ({
    entityId,
    content: {
      text,
      channelType: ChannelType.DM,
    },
  } as Memory);

const createMockState = (text: string): State =>
  ({
    text,
    values: {},
  } as State);

describe('requestElevationAction', () => {
  let runtime: IAgentRuntime;
  let mockPermissionSystem: any;
  const testEntityId = 'user-1' as UUID;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createMockRuntime();
    mockPermissionSystem = {
      requestElevation: vi.fn(),
    };
    
    (runtime.getService as Mock).mockReturnValue(mockPermissionSystem);
  });

  describe('handler', () => {
    it('should approve elevation for a high-trust user', async () => {
      const message = createMockMemory('{"action": "manage_roles", "justification": "I need to help moderate the channel"}', testEntityId);
      const state = createMockState(message.content.text!);
      const callback = vi.fn();

      // Mock trust engine
      const mockTrustEngine = {
        evaluateTrust: vi.fn().mockResolvedValue({
          overallTrust: 85,
        }),
      };
      (runtime.getService as Mock).mockImplementation((serviceName: string) => {
        if (serviceName === 'contextual-permissions') return mockPermissionSystem;
        if (serviceName === 'trust-engine') return mockTrustEngine;
        return null;
      });

      // Mock successful elevation
      (mockPermissionSystem.requestElevation as Mock).mockResolvedValue({
        approved: true,
        reason: 'High trust user - elevation approved',
        expiresAt: Date.now() + 3600000,
        elevationId: 'elevation-123',
        grantedPermissions: ['manage_roles'],
      });

      const result = await requestElevationAction.handler!(runtime, message, state, {}, callback);

      expect(mockPermissionSystem.requestElevation).toHaveBeenCalledWith({
        entityId: testEntityId,
        requestedPermission: {
          action: 'manage_roles',
          resource: '*',
        },
        justification: expect.any(String),
        context: expect.any(Object),
        duration: expect.any(Number),
      });

      expect(result).toBeTruthy();
      if (result && typeof result === 'object' && 'text' in result) {
        expect(result.text).toContain('Elevation approved');
        expect(result.data?.approved).toBe(true);
      }
    });

    it('should deny elevation for a low-trust user', async () => {
      const message = createMockMemory('{"action": "admin_access", "justification": "Give me admin access now!"}', testEntityId);
      const state = createMockState(message.content.text!);
      const callback = vi.fn();

      // Mock trust engine
      const mockTrustEngine = {
        evaluateTrust: vi.fn().mockResolvedValue({
          overallTrust: 30,
        }),
      };
      (runtime.getService as Mock).mockImplementation((serviceName: string) => {
        if (serviceName === 'contextual-permissions') return mockPermissionSystem;
        if (serviceName === 'trust-engine') return mockTrustEngine;
        return null;
      });

      // Mock denied elevation
      (mockPermissionSystem.requestElevation as Mock).mockResolvedValue({
        approved: false,
        reason: 'Insufficient trust for elevation',
        trustDeficit: 40,
        requiredTrust: 70,
      });

      const result = await requestElevationAction.handler!(runtime, message, state, {}, callback);

      expect(result).toBeTruthy();
      if (result && typeof result === 'object' && 'text' in result) {
        expect(result.text).toContain('Elevation request denied');
        expect(result.text).toContain('Insufficient trust');
        expect(result.data?.approved).toBe(false);
      }
    });

    it('should handle missing permission system gracefully', async () => {
      const message = createMockMemory('I need admin access', testEntityId);
      const state = createMockState(message.content.text!);
      const callback = vi.fn();

      // Mock missing service
      (runtime.getService as Mock).mockReturnValue(null);

      await expect(
        requestElevationAction.handler!(runtime, message, state, {}, callback)
      ).rejects.toThrow('Required services not available');
    });
  });

  describe('validate', () => {
    it('should validate if permission system is available', async () => {
      const message = createMockMemory('I need admin privileges', testEntityId);
      const state = createMockState(message.content.text!);

      // Mock permission system exists
      (runtime.getService as Mock).mockReturnValue(mockPermissionSystem);

      const result = await requestElevationAction.validate!(runtime, message, state);
      expect(result).toBe(true);
    });

    it('should not validate if permission system is not available', async () => {
      const message = createMockMemory('I need admin privileges', testEntityId);
      const state = createMockState(message.content.text!);

      // Mock no permission system
      (runtime.getService as Mock).mockReturnValue(null);

      const result = await requestElevationAction.validate!(runtime, message, state);
      expect(result).toBe(false);
    });
  });
}); 