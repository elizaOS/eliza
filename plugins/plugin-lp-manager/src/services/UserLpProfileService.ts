import { IAgentRuntime, Service } from '@elizaos/core';
import { UserLpProfile, TrackedLpPosition, TrackedLpPositionInput, IUserLpProfileService } from '../types.ts';

export class UserLpProfileService extends Service implements IUserLpProfileService {
    public static readonly serviceType = 'UserLpProfileService';
    public readonly capabilityDescription = 'Manages user profiles and preferences for LP management.';
    private profiles: Map<string, UserLpProfile> = new Map();

    constructor(runtime?: IAgentRuntime) {
        super(runtime);
    }

    async start(runtime?: IAgentRuntime): Promise<void> {
        // No-op
    }

    async stop(runtime?: IAgentRuntime): Promise<void> {
        // No-op
    }

    // Static methods required by ElizaOS Service architecture
    static async start(runtime: IAgentRuntime): Promise<UserLpProfileService> {
        const service = new UserLpProfileService(runtime);
        await service.start(runtime);
        return service;
    }

    static async stop(runtime: IAgentRuntime): Promise<void> {
        // No cleanup needed for static stop
    }

    public async ensureProfile(userId: string, vaultPublicKey: string, encryptedSecretKey: string, initialConfig?: Partial<UserLpProfile['autoRebalanceConfig']>): Promise<UserLpProfile> {
        let profile = await this.getProfile(userId);
        if (profile) {
            // Update existing profile if vault details or config have changed
            const updates: Partial<UserLpProfile> = {};
            if (profile.vaultPublicKey !== vaultPublicKey) {
                updates.vaultPublicKey = vaultPublicKey;
            }
            if (profile.encryptedSecretKey !== encryptedSecretKey) {
                updates.encryptedSecretKey = encryptedSecretKey;
            }
            if (initialConfig) {
                updates.autoRebalanceConfig = {
                    ...profile.autoRebalanceConfig,
                    ...initialConfig,
                };
            }
            if (Object.keys(updates).length > 0) {
                return this.updateProfile(userId, updates);
            }
            return profile;
        }

        const newProfile: UserLpProfile = {
            userId,
            vaultPublicKey,
            encryptedSecretKey,
            autoRebalanceConfig: {
                enabled: false,
                minGainThresholdPercent: 1.0,
                maxSlippageBps: 50,
                cycleIntervalHours: 24,
                ...initialConfig,
            },
            trackedPositions: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: 1,
        };

        this.profiles.set(userId, newProfile);
        return newProfile;
    }

    public async getProfile(userId: string): Promise<UserLpProfile | null> {
        return this.profiles.get(userId) || null;
    }

    public async updateProfile(userId: string, updates: Partial<Omit<UserLpProfile, 'userId' | 'createdAt' | 'version'>>): Promise<UserLpProfile> {
        const profile = await this.getProfile(userId);
        if (!profile) {
            throw new Error('User profile not found.');
        }

        // Handle autoRebalanceConfig merging
        let finalUpdates = { ...updates };
        if (updates.autoRebalanceConfig && profile.autoRebalanceConfig) {
            finalUpdates.autoRebalanceConfig = {
                ...profile.autoRebalanceConfig,
                ...updates.autoRebalanceConfig,
            };
        }

        const updatedProfile: UserLpProfile = { 
            ...profile, 
            ...finalUpdates, 
            updatedAt: new Date().toISOString(),
            version: (profile.version || 1) + 1,
        };

        this.profiles.set(userId, updatedProfile);
        return updatedProfile;
    }

    public async addTrackedPosition(userId: string, position: TrackedLpPositionInput): Promise<UserLpProfile> {
        const profile = await this.getProfile(userId);
        if (!profile) {
          throw new Error('User profile not found.');
        }

        const newPosition: TrackedLpPosition = {
          ...position,
          trackedAt: new Date().toISOString(),
        };

        const updatedPositions = [...(profile.trackedPositions || []), newPosition];
        return this.updateProfile(userId, { trackedPositions: updatedPositions });
    }

    public async removeTrackedPosition(userId: string, positionIdentifier: string): Promise<UserLpProfile> {
        const profile = await this.getProfile(userId);
        if (!profile) {
          throw new Error('User profile not found.');
        }
        const updatedPositions = (profile.trackedPositions || []).filter(p => p.positionIdentifier !== positionIdentifier);
        return this.updateProfile(userId, { trackedPositions: updatedPositions });
    }

    public async getTrackedPositions(userId: string): Promise<TrackedLpPosition[]> {
        const profile = await this.getProfile(userId);
        return profile?.trackedPositions || [];
    }

    async getAllProfilesWithAutoRebalanceEnabled(): Promise<UserLpProfile[]> {
        const allProfiles = Array.from(this.profiles.values());
        return allProfiles.filter(p => p.autoRebalanceConfig.enabled);
    }
} 