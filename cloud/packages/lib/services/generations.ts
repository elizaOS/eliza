/**
 * Service for managing AI generation records (images, videos, etc.).
 */

import {
  type Generation,
  type GenerationSummary,
  generationsRepository,
  type NewGeneration,
} from "@/db/repositories";

/**
 * Service for tracking and managing AI generation jobs.
 */
export class GenerationsService {
  async getById(id: string): Promise<Generation | undefined> {
    return await generationsRepository.findById(id);
  }

  async getByJobId(jobId: string): Promise<Generation | undefined> {
    return await generationsRepository.findByJobId(jobId);
  }

  async listByOrganization(organizationId: string, limit?: number): Promise<Generation[]> {
    return await generationsRepository.listByOrganization(organizationId, limit);
  }

  async listByOrganizationSummary(
    organizationId: string,
    limit?: number,
  ): Promise<GenerationSummary[]> {
    return await generationsRepository.listByOrganizationSummary(organizationId, limit);
  }

  async listByOrganizationAndType(
    organizationId: string,
    type: string,
    limit?: number,
  ): Promise<Generation[]> {
    return await generationsRepository.listByOrganizationAndType(organizationId, type, limit);
  }

  async listByOrganizationAndTypeSummary(
    organizationId: string,
    type: string,
    limit?: number,
  ): Promise<GenerationSummary[]> {
    return await generationsRepository.listByOrganizationAndTypeSummary(
      organizationId,
      type,
      limit,
    );
  }

  async listByOrganizationAndStatus(
    organizationId: string,
    status: string,
    options?: {
      userId?: string;
      type?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<Generation[]> {
    return await generationsRepository.listByOrganizationAndStatus(organizationId, status, options);
  }

  async listByOrganizationAndStatusSummary(
    organizationId: string,
    status: string,
    options?: {
      userId?: string;
      type?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<GenerationSummary[]> {
    return await generationsRepository.listByOrganizationAndStatusSummary(
      organizationId,
      status,
      options,
    );
  }

  async create(data: NewGeneration): Promise<Generation> {
    return await generationsRepository.create(data);
  }

  async update(id: string, data: Partial<NewGeneration>): Promise<Generation | undefined> {
    return await generationsRepository.update(id, data);
  }

  async updateStatus(id: string, status: string, error?: string): Promise<Generation | undefined> {
    const updateData: Partial<NewGeneration> = {
      status,
      error,
    };

    if (status === "completed") {
      updateData.completed_at = new Date();
    }

    return await this.update(id, updateData);
  }

  async delete(id: string): Promise<void> {
    await generationsRepository.delete(id);
  }

  async listRandomPublicImages(limit: number = 20): Promise<Generation[]> {
    return await generationsRepository.listRandomPublicImages(limit);
  }

  async listRandomPublicImageSummaries(limit: number = 20): Promise<GenerationSummary[]> {
    return await generationsRepository.listRandomPublicImageSummaries(limit);
  }

  async getStats(
    organizationId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<{
    totalGenerations: number;
    completedGenerations: number;
    failedGenerations: number;
    pendingGenerations: number;
    totalCredits: number;
    byType: Array<{
      type: string;
      count: number;
      totalCredits: number;
    }>;
  }> {
    return await generationsRepository.getStats(organizationId, startDate, endDate);
  }
}

// Export singleton instance
export const generationsService = new GenerationsService();
