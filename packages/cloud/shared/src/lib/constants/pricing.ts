/** Daily container hosting prices; only metered resource-scaled rates are advertised. */

import { ElizaError } from "@elizaos/core";
import { PLATFORM_MARKUP_MULTIPLIER } from "../pricing-constants";

// Base provider cost (before 20% markup)
const BASE_CONTAINER_PRICING = {
  // Recurring cost - DAILY BILLING
  // AWS ECS Fargate costs roughly $16.67/month, we add margin
  DAILY_RUNNING_COST: 0.56, // ~$0.56/day per container (AWS cost)
} as const;

export const CONTAINER_PRICING = {
  // Recurring cost - DAILY BILLING (with 20% markup)
  DAILY_RUNNING_COST:
    Math.round(BASE_CONTAINER_PRICING.DAILY_RUNNING_COST * PLATFORM_MARKUP_MULTIPLIER * 100) / 100, // $0.67/day per container

  // Warning thresholds (not pricing, keep as-is)
  SHUTDOWN_WARNING_HOURS: 48, // Hours before shutdown warning
} as const;

/**
 * Calculate daily container cost based on configuration
 * Cost includes 20% platform markup.
 */
export function calculateDailyContainerCost(config?: {
  desiredCount?: number;
  cpu?: number;
  memory?: number;
}): number {
  const baseCost = CONTAINER_PRICING.DAILY_RUNNING_COST;
  const instanceCount = config?.desiredCount || 1;

  // Base cost for first instance
  let totalCost = baseCost;

  // Additional instances cost the same daily rate
  if (instanceCount > 1) {
    totalCost += (instanceCount - 1) * baseCost;
  }

  // Premium for higher CPU (>1 vCPU = 1024 units)
  if (config?.cpu && config.cpu > 1024) {
    const cpuMultiplier = config.cpu / 1024;
    totalCost *= cpuMultiplier;
  }

  // Premium for higher memory (>2GB = 2048 MB)
  if (config?.memory && config.memory > 2048) {
    const memoryMultiplier = config.memory / 2048;
    totalCost *= Math.sqrt(memoryMultiplier); // Sub-linear scaling for memory
  }

  return Math.round(totalCost * 100) / 100; // Round to 2 decimal places
}

/**
 * Canonical storage price catalogue (#22956, ratified by the owner as the
 * current prices). Every storage charge and every storage price shown to a
 * customer or operator reads these values; `service_pricing` rows for the
 * `storage` service are a read-only mirror kept in sync by migration 0503 and
 * cannot be edited through the admin pricing API.
 *
 * Values are exact decimal USD strings so no binary float can drift a price.
 * PUT is billed as `put + put_per_byte × bytes`; every other operation is a
 * flat per-request price. DELETE is free. Stored bytes count toward the one
 * organization storage quota (plan `storageGiB`); there is no per-GB fee.
 */
export const STORAGE_PRICING = Object.freeze({
  put: "0.0001",
  put_per_byte: "0.000000001",
  get: "0.00005",
  head: "0.00005",
  list: "0.00005",
  presign: "0.00005",
  delete: "0",
} as const);

export type StoragePricedOperation = keyof typeof STORAGE_PRICING;

export const STORAGE_PRICED_OPERATIONS = Object.freeze(
  Object.keys(STORAGE_PRICING) as StoragePricedOperation[],
);

/** Exact catalogue price for one storage operation, in USD. */
export function storageOperationPriceUsd(operation: StoragePricedOperation): number {
  const price = STORAGE_PRICING[operation];
  if (price === undefined) {
    throw new ElizaError("Unknown storage operation", {
      code: "UNKNOWN_STORAGE_OPERATION",
      context: { operation },
    });
  }
  return Number(price);
}

export const CONTAINER_LIMITS = {
  // Free tier
  FREE_TIER_CONTAINERS: 1,
  FREE_TIER_MAX_INSTANCES: 1,

  // Paid tiers (based on org settings)
  STARTER_MAX_CONTAINERS: 5,
  PRO_MAX_CONTAINERS: 25,
  ENTERPRISE_MAX_CONTAINERS: 100,

  // Technical limits
  MAX_IMAGE_SIZE_BYTES: 2 * 1024 * 1024 * 1024, // 2GB
  MAX_INSTANCES_PER_CONTAINER: 10,
  MAX_ENV_VARS: 50,
  MAX_ENV_VAR_SIZE: 32 * 1024, // 32KB
} as const;

export type ContainerLimitSource =
  | "organization_config.settings.max_containers"
  | "organizations.credit_balance";

export interface ContainerLimitResolution {
  limit: number;
  source: ContainerLimitSource;
}

function containerQuotaSourceError(
  kind: "missing" | "invalid",
  source: string,
  message: string,
): ElizaError {
  return new ElizaError(message, {
    code: kind === "missing" ? "MISSING_CONTAINER_QUOTA_SOURCE" : "INVALID_CONTAINER_QUOTA_SOURCE",
    context: { source },
    severity: "fatal",
  });
}

function readMaxContainersOverride(orgSettings: unknown): number | undefined {
  if (orgSettings === undefined) return undefined;
  if (orgSettings === null || typeof orgSettings !== "object" || Array.isArray(orgSettings)) {
    throw containerQuotaSourceError(
      "invalid",
      "organization_config.settings",
      "Container quota settings must be a JSON object",
    );
  }

  const settings = orgSettings as Record<string, unknown>;
  if (!Object.hasOwn(settings, "max_containers")) return undefined;

  const value = settings.max_containers;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw containerQuotaSourceError(
      "invalid",
      "organization_config.settings.max_containers",
      "Container quota override must be a positive safe integer",
    );
  }
  return value;
}

/** Resolve the container ceiling together with the authoritative source used. */
export function resolveMaxContainersForOrg(
  creditBalance: unknown,
  orgSettings?: unknown,
): ContainerLimitResolution {
  if (creditBalance === undefined || creditBalance === null) {
    throw containerQuotaSourceError(
      "missing",
      "organizations.credit_balance",
      "Container quota credit balance is missing",
    );
  }
  if (typeof creditBalance !== "number" || !Number.isFinite(creditBalance)) {
    throw containerQuotaSourceError(
      "invalid",
      "organizations.credit_balance",
      "Container quota credit balance must be a finite number",
    );
  }

  const customLimit = readMaxContainersOverride(orgSettings);
  if (customLimit !== undefined) {
    return {
      limit: customLimit,
      source: "organization_config.settings.max_containers",
    };
  }

  if (creditBalance >= 100.0) {
    return {
      limit: CONTAINER_LIMITS.ENTERPRISE_MAX_CONTAINERS,
      source: "organizations.credit_balance",
    };
  }
  if (creditBalance >= 10.0) {
    return {
      limit: CONTAINER_LIMITS.PRO_MAX_CONTAINERS,
      source: "organizations.credit_balance",
    };
  }
  if (creditBalance >= 1.0) {
    return {
      limit: CONTAINER_LIMITS.STARTER_MAX_CONTAINERS,
      source: "organizations.credit_balance",
    };
  }
  return {
    limit: CONTAINER_LIMITS.FREE_TIER_CONTAINERS,
    source: "organizations.credit_balance",
  };
}

/**
 * Gets the maximum number of containers allowed for an organization.
 *
 * @param creditBalance - Organization credit balance in USD.
 * @param orgSettings - Optional organization settings with custom limit.
 * @returns Maximum number of containers allowed.
 */
export function getMaxContainersForOrg(creditBalance: unknown, orgSettings?: unknown): number {
  return resolveMaxContainersForOrg(creditBalance, orgSettings).limit;
}
