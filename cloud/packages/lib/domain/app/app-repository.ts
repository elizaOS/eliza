import type { App, NewApp } from "@/lib/domain/app/app";

/**
 * Subset of the legacy `appsRepository` API required by Hono-scope use
 * cases. Analytics-shaped methods (getRequestStats, getRecentRequests,
 * getTopVisitors, getRequestsOverTime, getAnalytics, getTotalStats,
 * trackPageView, getAppUsers) are kept loosely typed via `unknown` —
 * the analytics surface is large and read-mostly; we'll narrow it later
 * when the analytics aggregate gets its own pass.
 */
export interface AppRepository {
  findById(id: string): Promise<App | undefined>;
  findByApiKeyId(apiKeyId: string): Promise<App | undefined>;
  listByOrganization(organizationId: string): Promise<App[]>;
  checkNameAvailability(
    name: string,
  ): Promise<{ available: boolean; reason?: string }>;
  update(id: string, data: Partial<NewApp>): Promise<App | undefined>;

  // Analytics surface — opaque on the read side. Implementations forward
  // to existing appsRepository methods. We accept any input/output shape;
  // routes consume the results directly.
  getRequestStats(
    appId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<unknown>;
  getRecentRequests(
    appId: string,
    options?: {
      limit?: number;
      offset?: number;
      requestType?: string;
      source?: string;
      startDate?: Date;
      endDate?: Date;
    },
  ): Promise<unknown>;
  getTopVisitors(
    appId: string,
    limit?: number,
    startDate?: Date,
    endDate?: Date,
  ): Promise<unknown>;
  getRequestsOverTime(
    appId: string,
    granularity: "hour" | "day",
    startDate?: Date,
    endDate?: Date,
  ): Promise<unknown>;
  getAppUsers(appId: string, limit?: number): Promise<unknown>;
  getAnalytics(
    appId: string,
    periodType: "hourly" | "daily" | "monthly",
    startDate: Date,
    endDate: Date,
  ): Promise<unknown>;
  getTotalStats(appId: string): Promise<unknown>;
  trackPageView(appId: string, payload: unknown): Promise<unknown>;

  invalidateCache(
    appId: string,
    apiKeyId?: string | null,
    slug?: string | null,
  ): Promise<void>;
}
