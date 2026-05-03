/**
 * Service for managing usage quotas and limits.
 */

import { usageQuotasRepository } from "@/db/repositories";
import type { NewUsageQuota, UsageQuota } from "@/db/schemas/usage-quotas";
import { logger } from "@/lib/utils/logger";

/**
 * Parameters for creating a usage quota.
 */
export interface CreateQuotaParams {
  organization_id: string;
  quota_type: "global" | "model_specific";
  model_name?: string;
  credits_limit: number;
}

/**
 * Result of checking a quota.
 */
export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  currentUsage: number;
  limit: number;
  remaining: number;
}

/**
 * Service for managing usage quotas and checking quota limits.
 */
class UsageQuotasService {
  async getById(id: string): Promise<UsageQuota | undefined> {
    return await usageQuotasRepository.findById(id);
  }

  async getQuotasByOrganization(organizationId: string): Promise<UsageQuota[]> {
    return await usageQuotasRepository.findByOrganization(organizationId);
  }

  async getActiveQuotasByOrganization(organizationId: string): Promise<UsageQuota[]> {
    return await usageQuotasRepository.findActiveByOrganization(organizationId);
  }

  async createQuota(params: CreateQuotaParams): Promise<UsageQuota> {
    const { organization_id, quota_type, model_name, credits_limit } = params;

    const { weekStart, weekEnd } = this.calculateWeekDates();

    const quotaData: NewUsageQuota = {
      organization_id,
      quota_type,
      model_name: model_name || null,
      period_type: "weekly",
      credits_limit: String(credits_limit),
      current_usage: "0.00",
      period_start: weekStart,
      period_end: weekEnd,
      is_active: true,
    };

    return await usageQuotasRepository.create(quotaData);
  }

  async updateQuota(
    id: string,
    updates: {
      credits_limit?: number;
      is_active?: boolean;
    },
  ): Promise<UsageQuota | undefined> {
    const updateData: Partial<NewUsageQuota> = {};

    if (updates.credits_limit !== undefined) {
      updateData.credits_limit = String(updates.credits_limit);
    }

    if (updates.is_active !== undefined) {
      updateData.is_active = updates.is_active;
    }

    return await usageQuotasRepository.update(id, updateData);
  }

  async deleteQuota(id: string): Promise<void> {
    return await usageQuotasRepository.delete(id);
  }

  async checkQuota(
    organizationId: string,
    amount: number,
    modelName?: string,
  ): Promise<QuotaCheckResult> {
    if (modelName) {
      const modelQuota = await usageQuotasRepository.findByOrganizationAndType(
        organizationId,
        "model_specific",
        modelName,
      );

      if (modelQuota) {
        const currentUsage = Number(modelQuota.current_usage);
        const limit = Number(modelQuota.credits_limit);
        const newUsage = currentUsage + amount;

        if (newUsage > limit) {
          return {
            allowed: false,
            reason: `Weekly quota exceeded for model ${modelName}`,
            currentUsage,
            limit,
            remaining: Math.max(0, limit - currentUsage),
          };
        }
      }
    }

    const globalQuota = await usageQuotasRepository.findByOrganizationAndType(
      organizationId,
      "global",
      null,
    );

    if (globalQuota) {
      const currentUsage = Number(globalQuota.current_usage);
      const limit = Number(globalQuota.credits_limit);
      const newUsage = currentUsage + amount;

      if (newUsage > limit) {
        return {
          allowed: false,
          reason: "Weekly quota exceeded for all models",
          currentUsage,
          limit,
          remaining: Math.max(0, limit - currentUsage),
        };
      }
    }

    return {
      allowed: true,
      currentUsage: 0,
      limit: 0,
      remaining: 0,
    };
  }

  async trackUsage(organizationId: string, amount: number, modelName?: string): Promise<void> {
    if (modelName) {
      const modelQuota = await usageQuotasRepository.findByOrganizationAndType(
        organizationId,
        "model_specific",
        modelName,
      );

      if (modelQuota) {
        await usageQuotasRepository.incrementUsage(modelQuota.id, amount);
      }
    }

    const globalQuota = await usageQuotasRepository.findByOrganizationAndType(
      organizationId,
      "global",
      null,
    );

    if (globalQuota) {
      await usageQuotasRepository.incrementUsage(globalQuota.id, amount);
    }
  }

  async getCurrentUsage(organizationId: string): Promise<{
    global: { used: number; limit: number | null; periodEnd: string | null };
    modelSpecific: Record<string, { used: number; limit: number; periodEnd: string }>;
  }> {
    const quotas = await usageQuotasRepository.findActiveByOrganization(organizationId);

    const result = {
      global: {
        used: 0,
        limit: null as number | null,
        periodEnd: null as string | null,
      },
      modelSpecific: {} as Record<string, { used: number; limit: number; periodEnd: string }>,
    };

    for (const quota of quotas) {
      if (quota.quota_type === "global") {
        result.global.used = Number(quota.current_usage);
        result.global.limit = Number(quota.credits_limit);
        result.global.periodEnd = quota.period_end.toISOString();
      } else if (quota.quota_type === "model_specific" && quota.model_name) {
        result.modelSpecific[quota.model_name] = {
          used: Number(quota.current_usage),
          limit: Number(quota.credits_limit),
          periodEnd: quota.period_end.toISOString(),
        };
      }
    }

    return result;
  }

  async resetWeeklyQuotas(): Promise<void> {
    const expiredQuotas = await usageQuotasRepository.listExpiredQuotas();

    const { weekStart, weekEnd } = this.calculateWeekDates();

    for (const quota of expiredQuotas) {
      await usageQuotasRepository.updatePeriod(quota.id, weekStart, weekEnd);
    }

    logger.info(`Reset ${expiredQuotas.length} expired weekly quotas`);
  }

  calculateWeekDates(): { weekStart: Date; weekEnd: Date } {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);

    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7);
    weekEnd.setHours(23, 59, 59, 999);

    return { weekStart, weekEnd };
  }
}

export const usageQuotasService = new UsageQuotasService();
