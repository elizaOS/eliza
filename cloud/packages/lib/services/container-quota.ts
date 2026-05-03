/**
 * Container Quota Service
 * Uses containers repository for quota management
 */

import { containersRepository } from "@/db/repositories/containers";

// Re-export types and errors from repository
export type { QuotaCheckResult } from "@/db/repositories/containers";

export {
  DuplicateContainerNameError,
  QuotaExceededError,
} from "@/db/repositories/containers";

/**
 * Service for container quota management and checks.
 */
export class ContainerQuotaService {
  async checkQuota(organizationId: string) {
    return await containersRepository.checkQuota(organizationId);
  }

  async createContainerWithQuotaCheck(
    data: Parameters<typeof containersRepository.createWithQuotaCheck>[0],
    transaction?: Parameters<typeof containersRepository.createWithQuotaCheck>[1],
  ) {
    return await containersRepository.createWithQuotaCheck(data, transaction);
  }
}

// Export singleton instance
export const containerQuotaService = new ContainerQuotaService();
