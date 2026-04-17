// @ts-nocheck — mixin: type safety is enforced on the composed class
import {
  detectHealthBackend,
  getDailySummary,
  getDataPoints,
  getRecentSummaries,
  HealthBridgeError,
  type HealthBackend,
  type HealthBridgeConfig,
  type HealthDailySummary,
  type HealthDataPoint,
} from "./health-bridge.js";
import { LifeOpsServiceError } from "./service-types.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

function resolveHealthConfig(): HealthBridgeConfig {
  return {
    healthKitCliPath: process.env.ELIZA_HEALTHKIT_CLI_PATH,
    googleFitAccessToken: process.env.ELIZA_GOOGLE_FIT_ACCESS_TOKEN,
  };
}

function translateHealthError(error: unknown): never {
  if (error instanceof HealthBridgeError) {
    const status = error.backend === "none" ? 503 : 502;
    throw new LifeOpsServiceError(status, error.message);
  }
  throw error;
}

/** @internal */
export function withHealth<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsHealthServiceMixin extends Base {
    async getHealthConnectorStatus(): Promise<{
      available: boolean;
      backend: HealthBackend;
      lastCheckedAt: string;
    }> {
      const config = resolveHealthConfig();
      const backend = await detectHealthBackend(config);
      return {
        available: backend !== "none",
        backend,
        lastCheckedAt: new Date().toISOString(),
      };
    }

    async getHealthDailySummary(date: string): Promise<HealthDailySummary> {
      try {
        return await getDailySummary(date, resolveHealthConfig());
      } catch (error) {
        translateHealthError(error);
      }
    }

    async getHealthTrend(days: number): Promise<HealthDailySummary[]> {
      try {
        return await getRecentSummaries(days, resolveHealthConfig());
      } catch (error) {
        translateHealthError(error);
      }
    }

    async getHealthDataPoints(opts: {
      metric: HealthDataPoint["metric"];
      startAt: string;
      endAt: string;
    }): Promise<HealthDataPoint[]> {
      try {
        return await getDataPoints(opts, resolveHealthConfig());
      } catch (error) {
        translateHealthError(error);
      }
    }
  }

  return LifeOpsHealthServiceMixin;
}
