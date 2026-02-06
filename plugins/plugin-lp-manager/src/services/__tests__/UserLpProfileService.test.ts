/// <reference types="vitest/globals" />
import { IAgentRuntime } from '@elizaos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IUserLpProfileService, TrackedLpPositionInput, UserLpProfile } from '../../types.ts';
import { UserLpProfileService } from '../UserLpProfileService.ts';

import type { UUID } from '@elizaos/core';

/**
 * Create a minimal test runtime for service testing.
 * The UserLpProfileService primarily uses in-memory storage
 * and doesn't require most runtime methods.
 */
const testRuntime: IAgentRuntime = {
  agentId: "test-agent-id" as UUID,
  getService: () => null,
  getSetting: () => null,
} as unknown as IAgentRuntime;

describe('UserLpProfileService', () => {
    let service: IUserLpProfileService;

    beforeEach(() => {
        service = new UserLpProfileService();
    });

    it('should ensure a profile is created', async () => {
        const profile = await service.ensureProfile('test-user', 'test-pk', 'test-sk');
        expect(profile).toBeDefined();
        expect(profile.userId).toBe('test-user');
        expect(profile.vaultPublicKey).toBe('test-pk');
    });

    it('should get a profile', async () => {
        await service.ensureProfile('test-user', 'test-pk', 'test-sk');
        const profile = await service.getProfile('test-user');
        expect(profile).toBeDefined();
        expect(profile?.userId).toBe('test-user');
    });

    it('should update a profile', async () => {
        await service.ensureProfile('test-user', 'test-pk', 'test-sk');
        const updatedProfile = await service.updateProfile('test-user', { 
          autoRebalanceConfig: { 
            enabled: true,
            minGainThresholdPercent: 0.5,
            maxSlippageBps: 50,
            cycleIntervalHours: 1,
          } 
        });
        expect(updatedProfile.autoRebalanceConfig.enabled).toBe(true);
    });
});

describe('UserLpProfileService with In-Memory Storage', () => {
  let profileService: IUserLpProfileService;
  const testUserId1 = 'userMemoryTest1';
  const testVaultPk1 = 'vaultMemoryPk1';
  const testEncryptedKey1 = 'encKeyMemory1';
  const now = new Date().toISOString();
  const defaultAutoRebalanceConfig: UserLpProfile['autoRebalanceConfig'] = { enabled: false, minGainThresholdPercent: 0.5, maxSlippageBps: 50, preferredDexes:[], cycleIntervalHours:1, maxGasFeeLamports:'100000' };

  beforeEach(async () => {
    vi.clearAllMocks();
    profileService = new UserLpProfileService();
    await profileService.start(testRuntime);
  });

  afterEach(async () => {
    await profileService.stop();
  });

  describe('getProfile', () => {
    it('should return profile from in-memory storage', async () => {
      // First create a profile
      await profileService.ensureProfile(testUserId1, testVaultPk1, testEncryptedKey1);
      const profile = await profileService.getProfile(testUserId1);
      expect(profile).toBeDefined();
      expect(profile?.userId).toBe(testUserId1);
      expect(profile?.vaultPublicKey).toBe(testVaultPk1);
    });

    it('should return null for non-existent profile', async () => {
      const profile = await profileService.getProfile('non-existent-user');
      expect(profile).toBeNull();
    });
  });

  describe('ensureProfile', () => {
    it('should create a new profile if one does not exist', async () => {
      const profile = await profileService.ensureProfile(testUserId1, testVaultPk1, testEncryptedKey1);
      expect(profile).toBeDefined();
      expect(profile.userId).toBe(testUserId1);
      expect(profile.vaultPublicKey).toBe(testVaultPk1);
      expect(profile.encryptedSecretKey).toBe(testEncryptedKey1);
      expect(profile.autoRebalanceConfig.enabled).toBe(false);
    });

    it('should update an existing profile if found', async () => {
        // First create a profile
        await profileService.ensureProfile(testUserId1, testVaultPk1, testEncryptedKey1);
        
        // Then ensure with new data
        const updatedProfile = await profileService.ensureProfile(testUserId1, 'newPk', 'newKey', { enabled: true });
        expect(updatedProfile.vaultPublicKey).toBe('newPk');
        expect(updatedProfile.encryptedSecretKey).toBe('newKey');
        expect(updatedProfile.autoRebalanceConfig.enabled).toBe(true);
    });
  });

  describe('updateProfile', () => {
    it('should update profile and merge autoRebalanceConfig', async () => {
        // First create a profile with auto-rebalance enabled and specific cycle interval
        const initialProfile = await profileService.ensureProfile(testUserId1, testVaultPk1, testEncryptedKey1, { enabled: true, cycleIntervalHours: 2 });
        
        // Get the initial config to verify the starting values
        expect(initialProfile.autoRebalanceConfig.enabled).toBe(true);
        expect(initialProfile.autoRebalanceConfig.cycleIntervalHours).toBe(2);
        
        // Update with a complete config - the service should merge values
        // Note: We provide a complete config to satisfy the type, but the service
        // internally merges with existing values (see lines 88-92 in service implementation)
        const updatedProfile = await profileService.updateProfile(testUserId1, { 
            autoRebalanceConfig: { 
                enabled: true, // Keep same as initial
                minGainThresholdPercent: 1.5, // New value
                maxSlippageBps: initialProfile.autoRebalanceConfig.maxSlippageBps, // Preserve
                cycleIntervalHours: 3 // Update from 2 to 3
            }
        });
        
        expect(updatedProfile.version).toBe(2);
        expect(updatedProfile.autoRebalanceConfig.enabled).toBe(true); // Should be preserved
        expect(updatedProfile.autoRebalanceConfig.minGainThresholdPercent).toBe(1.5); // Should be updated
        expect(updatedProfile.autoRebalanceConfig.cycleIntervalHours).toBe(3); // Should be updated
    });

    it('should throw if profile not found', async () => {
        await expect(profileService.updateProfile('non-existent', { version: 2 }))
            .rejects.toThrow('User profile not found.');
    });
  });

  describe('addTrackedPosition', () => {
    it('should add a new position and call updateProfile', async () => {
        // First create a profile
        await profileService.ensureProfile(testUserId1, testVaultPk1, testEncryptedKey1);
        
        const newPos: TrackedLpPositionInput = {positionIdentifier: 'p1', dex:'d1', poolAddress:'pa1'};
        const updatedProfile = await profileService.addTrackedPosition(testUserId1, newPos);
        
        expect(updatedProfile.trackedPositions).toBeDefined();
        expect(updatedProfile.trackedPositions!.length).toBe(1);
        expect(updatedProfile.trackedPositions![0].positionIdentifier).toBe('p1');
        expect(updatedProfile.trackedPositions![0].dex).toBe('d1');
    });

    it('should throw if profile not found', async () => {
        const newPos: TrackedLpPositionInput = {positionIdentifier: 'p1', dex:'d1', poolAddress:'pa1'};
        await expect(profileService.addTrackedPosition('non-existent', newPos))
            .rejects.toThrow('User profile not found.');
    });
  });

  describe('removeTrackedPosition', () => {
    it('should remove a tracked position', async () => {
        // First create a profile and add a position
        await profileService.ensureProfile(testUserId1, testVaultPk1, testEncryptedKey1);
        const newPos: TrackedLpPositionInput = {positionIdentifier: 'p1', dex:'d1', poolAddress:'pa1'};
        await profileService.addTrackedPosition(testUserId1, newPos);
        
        // Then remove it
        const updatedProfile = await profileService.removeTrackedPosition(testUserId1, 'p1');
        expect(updatedProfile.trackedPositions).toBeDefined();
        expect(updatedProfile.trackedPositions!.length).toBe(0);
    });
  });

  describe('getTrackedPositions', () => {
    it('should return tracked positions for a user', async () => {
        // First create a profile and add positions
        await profileService.ensureProfile(testUserId1, testVaultPk1, testEncryptedKey1);
        const pos1: TrackedLpPositionInput = {positionIdentifier: 'p1', dex:'d1', poolAddress:'pa1'};
        const pos2: TrackedLpPositionInput = {positionIdentifier: 'p2', dex:'d2', poolAddress:'pa2'};
        await profileService.addTrackedPosition(testUserId1, pos1);
        await profileService.addTrackedPosition(testUserId1, pos2);
        
        const positions = await profileService.getTrackedPositions(testUserId1);
        expect(positions.length).toBe(2);
        expect(positions.map(p => p.positionIdentifier)).toContain('p1');
        expect(positions.map(p => p.positionIdentifier)).toContain('p2');
    });

    it('should return empty array for user with no positions', async () => {
        await profileService.ensureProfile(testUserId1, testVaultPk1, testEncryptedKey1);
        const positions = await profileService.getTrackedPositions(testUserId1);
        expect(positions).toEqual([]);
    });
  });

  describe('getAllProfilesWithAutoRebalanceEnabled', () => {
    it('should fetch all profiles and filter them correctly', async () => {
        // Create profiles with different auto-rebalance settings
        await profileService.ensureProfile('userEnabled', 'pk1', 'sk1', { enabled: true });
        await profileService.ensureProfile('userDisabled', 'pk2', 'sk2', { enabled: false });
        await profileService.ensureProfile('userEnabled2', 'pk3', 'sk3', { enabled: true });
        
        const result = await profileService.getAllProfilesWithAutoRebalanceEnabled();
        
        expect(result).toBeInstanceOf(Array);
        expect(result.length).toBe(2);
        expect(result.map(p => p.userId)).toContain('userEnabled');
        expect(result.map(p => p.userId)).toContain('userEnabled2');
        expect(result.map(p => p.userId)).not.toContain('userDisabled');
        expect(result.every(p => p.autoRebalanceConfig.enabled)).toBe(true);
    });

    it('should return empty array when no profiles have auto-rebalance enabled', async () => {
        await profileService.ensureProfile('user1', 'pk1', 'sk1', { enabled: false });
        await profileService.ensureProfile('user2', 'pk2', 'sk2', { enabled: false });
        
        const result = await profileService.getAllProfilesWithAutoRebalanceEnabled();
        expect(result).toEqual([]);
    });
  });
}); 