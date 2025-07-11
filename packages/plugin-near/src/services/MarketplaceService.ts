import { elizaLogger, type IAgentRuntime } from '@elizaos/core';
import { BaseNearService } from './base/BaseService';
import { WalletService } from './WalletService';
import { StorageService } from './StorageService';
import { NearPluginError, NearErrorCode } from '../core/errors';
import { utils } from 'near-api-js';

/**
 * Simplified marketplace using direct transfers and storage service
 * Jobs are posted as entries in storage, payments are direct transfers
 */
export interface MarketplaceJob {
  id: string;
  title: string;
  description: string;
  requirements: string[];
  budget: string; // In NEAR
  deadline: number; // Timestamp
  poster: string; // Account ID
  status: 'open' | 'assigned' | 'submitted' | 'completed' | 'disputed';
  assignee?: string;
  submission?: {
    data: any;
    submittedAt: number;
  };
  createdAt: number;
  tags: string[];
}

export interface AgentProfile {
  agentId: string;
  name: string;
  description: string;
  capabilities: string[];
  reputation: {
    completedJobs: number;
    rating: number;
    reviews: Array<{
      jobId: string;
      rating: number;
      comment: string;
      reviewer: string;
    }>;
  };
  hourlyRate?: string; // In NEAR
  availability: 'available' | 'busy' | 'offline';
}

export class MarketplaceService extends BaseNearService {
  capabilityDescription = 'Enables agents to post jobs, find work, and collaborate';

  private walletService!: WalletService;
  private storageService!: StorageService;
  private profile?: AgentProfile;

  async onInitialize(): Promise<void> {
    const walletService = this.runtime.getService<WalletService>('near-wallet' as any);
    const storageService = this.runtime.getService<StorageService>('near-storage' as any);

    if (!walletService || !storageService) {
      throw new NearPluginError(NearErrorCode.UNKNOWN_ERROR, 'Required services not available');
    }

    this.walletService = walletService;
    this.storageService = storageService;

    // Initialize agent profile
    await this.initializeProfile();

    elizaLogger.info('Marketplace service initialized');
  }

  private async initializeProfile(): Promise<void> {
    // Try to load existing profile
    const existing = await this.storageService.get('agent:profile');

    if (!existing) {
      // Create default profile
      this.profile = {
        agentId: this.walletService.getAddress(),
        name: this.runtime.character.name || 'Unnamed Agent',
        description: Array.isArray(this.runtime.character.bio)
          ? this.runtime.character.bio.join(' ')
          : this.runtime.character.bio || '',
        capabilities: this.runtime.character.topics || [],
        reputation: {
          completedJobs: 0,
          rating: 0,
          reviews: [],
        },
        availability: 'available',
      };

      await this.storageService.set('agent:profile', this.profile);
    } else {
      this.profile = existing;
    }
  }

  /**
   * Post a new job to the marketplace
   */
  async postJob(
    job: Omit<MarketplaceJob, 'id' | 'poster' | 'status' | 'createdAt'>
  ): Promise<string> {
    try {
      const account = await this.walletService.getAccount();

      // Create job with metadata
      const jobData: MarketplaceJob = {
        ...job,
        id: `job-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        poster: account.accountId,
        status: 'open',
        createdAt: Date.now(),
      };

      // Store job in storage service
      await this.storageService.set(`marketplace:job:${jobData.id}`, jobData);

      // Add to open jobs list
      const openJobs = (await this.storageService.get('marketplace:jobs:open')) || [];
      openJobs.push(jobData.id);
      await this.storageService.set('marketplace:jobs:open', openJobs);

      elizaLogger.success(`Job posted: ${jobData.id} - ${jobData.title}`);
      return jobData.id;
    } catch (error) {
      throw new NearPluginError(NearErrorCode.TRANSACTION_FAILED, 'Failed to post job', error);
    }
  }

  /**
   * Browse available jobs
   */
  async browseJobs(filters?: {
    tags?: string[];
    minBudget?: string;
    maxBudget?: string;
    skills?: string[];
  }): Promise<MarketplaceJob[]> {
    try {
      // Get list of open jobs
      const openJobIds = (await this.storageService.get('marketplace:jobs:open')) || [];
      const jobs: MarketplaceJob[] = [];

      // Load each job
      for (const jobId of openJobIds) {
        const job = await this.storageService.get(`marketplace:job:${jobId}`);
        if (job && job.status === 'open') {
          // Apply filters
          if (filters) {
            if (filters.tags && !filters.tags.some((tag) => job.tags.includes(tag))) {
              continue;
            }
            if (filters.minBudget && parseFloat(job.budget) < parseFloat(filters.minBudget)) {
              continue;
            }
            if (filters.maxBudget && parseFloat(job.budget) > parseFloat(filters.maxBudget)) {
              continue;
            }
            if (
              filters.skills &&
              !filters.skills.some((skill) => job.requirements.includes(skill))
            ) {
              continue;
            }
          }

          jobs.push(job);
        }
      }

      return jobs.sort((a, b) => b.createdAt - a.createdAt);
    } catch (error) {
      elizaLogger.warn('Failed to browse jobs', error);
      return [];
    }
  }

  /**
   * Accept a job
   */
  async acceptJob(jobId: string): Promise<void> {
    try {
      const job = await this.storageService.get(`marketplace:job:${jobId}`);

      if (!job) {
        throw new NearPluginError(NearErrorCode.UNKNOWN_ERROR, 'Job not found');
      }

      if (job.status !== 'open') {
        throw new NearPluginError(NearErrorCode.UNKNOWN_ERROR, 'Job is not available');
      }

      // Update job status
      job.status = 'assigned';
      job.assignee = this.walletService.getAddress();

      await this.storageService.set(`marketplace:job:${jobId}`, job);

      // Update open jobs list
      const openJobs = (await this.storageService.get('marketplace:jobs:open')) || [];
      const index = openJobs.indexOf(jobId);
      if (index > -1) {
        openJobs.splice(index, 1);
        await this.storageService.set('marketplace:jobs:open', openJobs);
      }

      // Add to agent's active jobs
      const myJobs = (await this.storageService.get('agent:jobs:active')) || [];
      myJobs.push(jobId);
      await this.storageService.set('agent:jobs:active', myJobs);

      elizaLogger.success(`Accepted job: ${jobId}`);
    } catch (error) {
      throw new NearPluginError(NearErrorCode.TRANSACTION_FAILED, 'Failed to accept job', error);
    }
  }

  /**
   * Submit work for a job
   */
  async submitWork(jobId: string, workData: any): Promise<void> {
    try {
      const job = await this.storageService.get(`marketplace:job:${jobId}`);

      if (!job || job.assignee !== this.walletService.getAddress()) {
        throw new NearPluginError(NearErrorCode.UNKNOWN_ERROR, 'Job not assigned to this agent');
      }

      // Update job with submission
      job.status = 'submitted';
      job.submission = {
        data: workData,
        submittedAt: Date.now(),
      };

      await this.storageService.set(`marketplace:job:${jobId}`, job);

      elizaLogger.success(`Work submitted for job: ${jobId}`);
    } catch (error) {
      throw new NearPluginError(NearErrorCode.TRANSACTION_FAILED, 'Failed to submit work', error);
    }
  }

  /**
   * Complete a job and release payment
   */
  async completeJob(jobId: string, rating?: number, review?: string): Promise<void> {
    try {
      const account = await this.walletService.getAccount();
      const job = await this.storageService.get(`marketplace:job:${jobId}`);

      if (!job || job.poster !== account.accountId) {
        throw new NearPluginError(
          NearErrorCode.UNKNOWN_ERROR,
          'Only job poster can complete the job'
        );
      }

      if (job.status !== 'submitted') {
        throw new NearPluginError(NearErrorCode.UNKNOWN_ERROR, 'Job has not been submitted');
      }

      // Send payment to assignee
      await account.sendMoney(
        job.assignee!,
        BigInt(utils.format.parseNearAmount(job.budget) || '0')
      );

      // Update job status
      job.status = 'completed';
      await this.storageService.set(`marketplace:job:${jobId}`, job);

      // Update agent's reputation if rating provided
      if (job.assignee && rating) {
        const profileKey = `agent:profile:${job.assignee}`;
        const assigneeProfile =
          (await this.storageService.get(profileKey)) ||
          (await this.storageService.getShared('agent:profile', job.assignee));

        if (assigneeProfile) {
          assigneeProfile.reputation.completedJobs++;

          if (review) {
            assigneeProfile.reputation.reviews.push({
              jobId,
              rating,
              comment: review,
              reviewer: account.accountId,
            });
          }

          // Calculate new average rating
          const totalRating = assigneeProfile.reputation.reviews.reduce(
            (sum: number, r: { rating: number }) => sum + r.rating,
            0
          );
          assigneeProfile.reputation.rating =
            totalRating / assigneeProfile.reputation.reviews.length;

          await this.storageService.set(profileKey, assigneeProfile);
        }
      }

      elizaLogger.success(`Job completed: ${jobId}, payment sent: ${job.budget} NEAR`);
    } catch (error) {
      throw new NearPluginError(NearErrorCode.TRANSACTION_FAILED, 'Failed to complete job', error);
    }
  }

  /**
   * Get agent's profile
   */
  async getProfile(agentId?: string): Promise<AgentProfile | null> {
    try {
      if (!agentId) {
        return this.profile || null;
      }

      // Try to get from storage
      const profile =
        (await this.storageService.get(`agent:profile:${agentId}`)) ||
        (await this.storageService.getShared('agent:profile', agentId));

      return profile;
    } catch (error) {
      elizaLogger.warn(`Failed to get profile for ${agentId}`, error);
      return null;
    }
  }

  /**
   * Update agent's profile
   */
  async updateProfile(updates: Partial<AgentProfile>): Promise<void> {
    try {
      if (!this.profile) {
        throw new NearPluginError(NearErrorCode.UNKNOWN_ERROR, 'Profile not initialized');
      }

      this.profile = { ...this.profile, ...updates };
      await this.storageService.set('agent:profile', this.profile);

      // Share profile publicly
      await this.storageService.shareWith('agent:profile', '*');

      elizaLogger.success('Profile updated');
    } catch (error) {
      throw new NearPluginError(
        NearErrorCode.TRANSACTION_FAILED,
        'Failed to update profile',
        error
      );
    }
  }

  /**
   * Get agent's job history
   */
  async getJobHistory(): Promise<{
    active: MarketplaceJob[];
    completed: MarketplaceJob[];
  }> {
    try {
      const activeJobIds = (await this.storageService.get('agent:jobs:active')) || [];
      const completedJobIds = (await this.storageService.get('agent:jobs:completed')) || [];

      const active: MarketplaceJob[] = [];
      const completed: MarketplaceJob[] = [];

      for (const jobId of activeJobIds) {
        const job = await this.storageService.get(`marketplace:job:${jobId}`);
        if (job) {
          active.push(job);
        }
      }

      for (const jobId of completedJobIds) {
        const job = await this.storageService.get(`marketplace:job:${jobId}`);
        if (job) {
          completed.push(job);
        }
      }

      return { active, completed };
    } catch (error) {
      elizaLogger.warn('Failed to get job history', error);
      return { active: [], completed: [] };
    }
  }

  protected async checkHealth(): Promise<void> {
    // Service is healthy if wallet and storage are available
    await this.walletService.getAccount();
  }

  protected async onCleanup(): Promise<void> {
    // Update availability status
    if (this.profile) {
      this.profile.availability = 'offline';
      await this.storageService.set('agent:profile', this.profile).catch(() => {});
    }
  }

  static async start(runtime: IAgentRuntime): Promise<MarketplaceService> {
    const service = new MarketplaceService();
    await service.initialize(runtime);
    return service;
  }

  async stop(): Promise<void> {
    await this.cleanup();
  }
}
