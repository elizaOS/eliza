/**
 * Usage tracking service for recording and querying AI operation usage.
 */

import {
  type NewUsageRecord,
  type UsageRecord,
  type UsageStats,
  usageRecordsRepository,
} from "@/db/repositories";

/**
 * Service for tracking and querying usage records.
 */
export class UsageService {
  async getById(id: string): Promise<UsageRecord | undefined> {
    return await usageRecordsRepository.findById(id);
  }

  async listByOrganization(organizationId: string, limit?: number): Promise<UsageRecord[]> {
    return await usageRecordsRepository.listByOrganization(organizationId, limit);
  }

  async listByOrganizationAndDateRange(
    organizationId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<UsageRecord[]> {
    return await usageRecordsRepository.listByOrganizationAndDateRange(
      organizationId,
      startDate,
      endDate,
    );
  }

  async getStatsByOrganization(
    organizationId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<UsageStats> {
    return await usageRecordsRepository.getStatsByOrganization(organizationId, startDate, endDate);
  }

  async create(data: NewUsageRecord): Promise<UsageRecord> {
    return await usageRecordsRepository.create(data);
  }

  async trackUsage(data: NewUsageRecord): Promise<UsageRecord> {
    return await this.create(data);
  }

  async getByModel(
    organizationId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<
    Array<{
      model: string | null;
      provider: string | null;
      count: number;
      totalCost: number;
    }>
  > {
    return await usageRecordsRepository.getByModel(organizationId, startDate, endDate);
  }

  /**
   * Marks a deployment usage record as failed.
   * This should be called when a container deployment fails after initial record creation.
   */
  async markDeploymentFailed(
    containerId: string,
    organizationId: string,
    errorMessage: string,
  ): Promise<UsageRecord | undefined> {
    return await usageRecordsRepository.markDeploymentFailed(
      containerId,
      organizationId,
      errorMessage,
    );
  }

  /**
   * Marks a deployment usage record as successful.
   * This should be called when a container deployment completes successfully.
   */
  async markDeploymentSuccessful(
    containerId: string,
    organizationId: string,
    durationMs?: number,
  ): Promise<UsageRecord | undefined> {
    return await usageRecordsRepository.markDeploymentSuccessful(
      containerId,
      organizationId,
      durationMs,
    );
  }
}

// Export singleton instance
export const usageService = new UsageService();
