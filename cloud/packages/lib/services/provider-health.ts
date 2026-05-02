/**
 * Service for tracking AI provider health and status.
 */

import {
  type NewProviderHealth,
  type ProviderHealth,
  providerHealthRepository,
} from "@/db/repositories";

/**
 * Service for managing provider health monitoring.
 */
export class ProviderHealthService {
  async listAll(): Promise<ProviderHealth[]> {
    return await providerHealthRepository.listAll();
  }

  async getByProvider(provider: string): Promise<ProviderHealth | undefined> {
    return await providerHealthRepository.findByProvider(provider);
  }

  async createOrUpdate(data: NewProviderHealth): Promise<ProviderHealth> {
    return await providerHealthRepository.createOrUpdate(data);
  }

  async updateStatus(
    provider: string,
    status: string,
    responseTime?: number,
    errorRate?: number,
  ): Promise<ProviderHealth | undefined> {
    return await providerHealthRepository.updateStatus(provider, status, responseTime, errorRate);
  }
}

// Export singleton instance
export const providerHealthService = new ProviderHealthService();
