/**
 * Validates untrusted Eliza Cloud JSON consumed by project read actions.
 *
 * The SDK types describe the intended wire contract but cannot prove parsed
 * JSON at runtime. These readers return only validated fields and throw typed
 * errors so malformed success envelopes surface as failures, never healthy
 * project analytics, user lists, or publication state.
 */

import type {
  AppAnalyticsResponse,
  AppDeploymentStatus,
  AppUserDto,
  ListAppUsersResponse,
} from "@elizaos/cloud-sdk";
import { ElizaError } from "@elizaos/core";

const APP_DEPLOYMENT_STATUSES = new Set<string>([
  "draft",
  "building",
  "deploying",
  "deployed",
  "failed",
]);
const FRONTEND_DEPLOYMENT_STATUSES = new Set([
  "pending",
  "uploading",
  "ready",
  "active",
  "superseded",
  "failed",
]);
const ANALYTICS_PERIODS = new Set(["hourly", "daily", "monthly"]);
const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
type AnalyticsPeriod = AppAnalyticsResponse["period"]["type"];

export interface ProjectAppIdentity {
  id: string;
  name: string;
  slug: string;
}

export interface ProjectPublicationApp extends ProjectAppIdentity {
  isActive: boolean;
  deploymentStatus: AppDeploymentStatus;
  appUrl: string;
  productionUrl: string | null;
}

export interface ProjectFrontendDeployment {
  id: string;
  status: string;
}

export interface ProjectFrontendState {
  activeDeploymentId: string | null;
  publicUrl: string | null;
  deployments: ProjectFrontendDeployment[];
}

export interface ProjectEarningsSummary {
  totalLifetimeEarnings: number;
  pendingBalance: number;
  withdrawableBalance: number;
  totalWithdrawn: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAppDeploymentStatus(value: unknown): value is AppDeploymentStatus {
  return typeof value === "string" && APP_DEPLOYMENT_STATUSES.has(value);
}

function isAnalyticsPeriod(value: unknown): value is AnalyticsPeriod {
  return typeof value === "string" && ANALYTICS_PERIODS.has(value);
}

function invalid(
  code: string,
  message: string,
  context?: Record<string, unknown>,
): never {
  throw new ElizaError(message, {
    code,
    context,
    severity: "fatal",
  });
}

function nonEmptyString(
  record: Record<string, unknown>,
  key: string,
  code: string,
  path: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(code, `Cloud response is missing ${path}`, { path });
  }
  return value;
}

function nullableString(
  record: Record<string, unknown>,
  key: string,
  code: string,
  path: string,
): string | null {
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    invalid(code, `Cloud response has invalid ${path}`, { path });
  }
  return value;
}

function nonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  code: string,
  path: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalid(code, `Cloud response has invalid ${path}`, { path });
  }
  return value;
}

function decimalString(
  record: Record<string, unknown>,
  key: string,
  code: string,
  path: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || !NON_NEGATIVE_DECIMAL.test(value)) {
    invalid(code, `Cloud response has invalid ${path}`, { path });
  }
  return value;
}

function nullableDecimalString(
  record: Record<string, unknown>,
  key: string,
  code: string,
  path: string,
): string | null {
  const value = record[key];
  if (
    value !== null &&
    (typeof value !== "string" || !NON_NEGATIVE_DECIMAL.test(value))
  ) {
    invalid(code, `Cloud response has invalid ${path}`, { path });
  }
  return value;
}

function timestamp(
  record: Record<string, unknown>,
  key: string,
  code: string,
  path: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    invalid(code, `Cloud response has invalid ${path}`, { path });
  }
  return value;
}

function appRecord(
  response: unknown,
  expectedAppId: string,
): Record<string, unknown> {
  if (
    !isRecord(response) ||
    response.success !== true ||
    !isRecord(response.app)
  ) {
    invalid(
      "CLOUD_APP_RESPONSE_INVALID",
      "Cloud returned an invalid app response",
      {
        expectedAppId,
      },
    );
  }
  const id = nonEmptyString(
    response.app,
    "id",
    "CLOUD_APP_RESPONSE_INVALID",
    "app.id",
  );
  if (id !== expectedAppId) {
    invalid(
      "CLOUD_APP_RESPONSE_INVALID",
      "Cloud returned an app other than the bound project app",
      { expectedAppId, receivedAppId: id },
    );
  }
  return response.app;
}

/** Validate the app identity fields used by analytics and user-list actions. */
export function readProjectAppIdentity(
  response: unknown,
  expectedAppId: string,
): ProjectAppIdentity {
  const app = appRecord(response, expectedAppId);
  return projectAppIdentity(app, expectedAppId);
}

function projectAppIdentity(
  app: Record<string, unknown>,
  expectedAppId: string,
): ProjectAppIdentity {
  return {
    id: expectedAppId,
    name: nonEmptyString(app, "name", "CLOUD_APP_RESPONSE_INVALID", "app.name"),
    slug: nonEmptyString(app, "slug", "CLOUD_APP_RESPONSE_INVALID", "app.slug"),
  };
}

/** Validate the additional app fields consumed by publication-state reads. */
export function readProjectPublicationApp(
  response: unknown,
  expectedAppId: string,
): ProjectPublicationApp {
  const app = appRecord(response, expectedAppId);
  const identity = projectAppIdentity(app, expectedAppId);
  const deploymentStatus = app.deployment_status;
  if (!isAppDeploymentStatus(deploymentStatus)) {
    invalid(
      "CLOUD_APP_RESPONSE_INVALID",
      "Cloud returned an invalid app deployment status",
      { expectedAppId, path: "app.deployment_status" },
    );
  }
  if (typeof app.is_active !== "boolean") {
    invalid(
      "CLOUD_APP_RESPONSE_INVALID",
      "Cloud returned invalid app activity state",
      {
        expectedAppId,
        path: "app.is_active",
      },
    );
  }
  return {
    ...identity,
    isActive: app.is_active,
    deploymentStatus,
    appUrl: nonEmptyString(
      app,
      "app_url",
      "CLOUD_APP_RESPONSE_INVALID",
      "app.app_url",
    ),
    productionUrl: nullableString(
      app,
      "production_url",
      "CLOUD_APP_RESPONSE_INVALID",
      "app.production_url",
    ),
  };
}

function analyticsPoint(
  value: unknown,
  index: number,
): AppAnalyticsResponse["analytics"][number] {
  const code = "CLOUD_ANALYTICS_INVALID";
  if (!isRecord(value)) {
    invalid(code, "Cloud returned an invalid analytics point", { index });
  }
  const periodStart = timestamp(
    value,
    "period_start",
    code,
    `analytics[${index}].period_start`,
  );
  return {
    period_start: periodStart,
    total_requests: nonNegativeInteger(
      value,
      "total_requests",
      code,
      `analytics[${index}].total_requests`,
    ),
    unique_users: nonNegativeInteger(
      value,
      "unique_users",
      code,
      `analytics[${index}].unique_users`,
    ),
    new_users: nonNegativeInteger(
      value,
      "new_users",
      code,
      `analytics[${index}].new_users`,
    ),
    total_cost: decimalString(
      value,
      "total_cost",
      code,
      `analytics[${index}].total_cost`,
    ),
  };
}

/** Validate analytics totals, period, and every time-series point. */
export function readProjectAnalytics(response: unknown): AppAnalyticsResponse {
  const code = "CLOUD_ANALYTICS_INVALID";
  if (
    !isRecord(response) ||
    response.success !== true ||
    !Array.isArray(response.analytics) ||
    !isRecord(response.totalStats) ||
    !isRecord(response.period)
  ) {
    invalid(code, "Cloud returned an invalid analytics response");
  }
  const periodType = response.period.type;
  if (!isAnalyticsPeriod(periodType)) {
    invalid(code, "Cloud returned an invalid analytics period", {
      path: "period.type",
    });
  }
  const periodStart = timestamp(response.period, "start", code, "period.start");
  const periodEnd = timestamp(response.period, "end", code, "period.end");
  if (Date.parse(periodStart) > Date.parse(periodEnd)) {
    invalid(code, "Cloud returned an inverted analytics period", {
      periodStart,
      periodEnd,
    });
  }
  return {
    success: true,
    analytics: response.analytics.map(analyticsPoint),
    totalStats: {
      totalRequests: nonNegativeInteger(
        response.totalStats,
        "totalRequests",
        code,
        "totalStats.totalRequests",
      ),
      totalUsers: nonNegativeInteger(
        response.totalStats,
        "totalUsers",
        code,
        "totalStats.totalUsers",
      ),
      totalCreditsUsed: decimalString(
        response.totalStats,
        "totalCreditsUsed",
        code,
        "totalStats.totalCreditsUsed",
      ),
    },
    period: {
      type: periodType,
      start: periodStart,
      end: periodEnd,
    },
  };
}

function nullableUserString(
  record: Record<string, unknown>,
  key: string,
  index: number,
): string | null {
  return nullableString(
    record,
    key,
    "CLOUD_APP_USERS_INVALID",
    `users[${index}].${key}`,
  );
}

function appUser(
  value: unknown,
  index: number,
  expectedAppId: string,
): AppUserDto {
  const code = "CLOUD_APP_USERS_INVALID";
  if (!isRecord(value)) {
    invalid(code, "Cloud returned an invalid app user", { index });
  }
  const appId = nonEmptyString(value, "app_id", code, `users[${index}].app_id`);
  if (appId !== expectedAppId) {
    invalid(code, "Cloud returned a user for another app", {
      index,
      expectedAppId,
      receivedAppId: appId,
    });
  }
  const firstSeenAt = timestamp(
    value,
    "first_seen_at",
    code,
    `users[${index}].first_seen_at`,
  );
  const lastSeenAt = timestamp(
    value,
    "last_seen_at",
    code,
    `users[${index}].last_seen_at`,
  );
  if (Date.parse(firstSeenAt) > Date.parse(lastSeenAt)) {
    invalid(code, "Cloud returned an inverted app-user activity window", {
      index,
      firstSeenAt,
      lastSeenAt,
    });
  }
  if (!isRecord(value.metadata)) {
    invalid(code, "Cloud returned invalid app-user metadata", {
      index,
      path: `users[${index}].metadata`,
    });
  }
  return {
    id: nonEmptyString(value, "id", code, `users[${index}].id`),
    app_id: appId,
    user_id: nonEmptyString(value, "user_id", code, `users[${index}].user_id`),
    signup_source: nullableUserString(value, "signup_source", index),
    referral_code_used: nullableUserString(value, "referral_code_used", index),
    ip_address: nullableUserString(value, "ip_address", index),
    user_agent: nullableUserString(value, "user_agent", index),
    total_requests: nonNegativeInteger(
      value,
      "total_requests",
      code,
      `users[${index}].total_requests`,
    ),
    total_credits_used: nullableDecimalString(
      value,
      "total_credits_used",
      code,
      `users[${index}].total_credits_used`,
    ),
    first_seen_at: firstSeenAt,
    last_seen_at: lastSeenAt,
    metadata: value.metadata,
  };
}

/** Validate user rows and pagination before privacy-safe projection. */
export function readProjectAppUsers(
  response: unknown,
  expectedAppId: string,
  expectedLimit: number,
): ListAppUsersResponse {
  const code = "CLOUD_APP_USERS_INVALID";
  if (
    !isRecord(response) ||
    response.success !== true ||
    !Array.isArray(response.users) ||
    !isRecord(response.pagination)
  ) {
    invalid(code, "Cloud returned an invalid app-user response", {
      expectedAppId,
    });
  }
  const users = response.users.map((value, index) =>
    appUser(value, index, expectedAppId),
  );
  const total = nonNegativeInteger(
    response.pagination,
    "total",
    code,
    "pagination.total",
  );
  const limit = nonNegativeInteger(
    response.pagination,
    "limit",
    code,
    "pagination.limit",
  );
  if (limit !== expectedLimit || users.length > limit || total < users.length) {
    invalid(code, "Cloud returned inconsistent app-user pagination", {
      expectedLimit,
      limit,
      total,
      returned: users.length,
    });
  }
  return {
    success: true,
    users,
    pagination: { total, limit },
  };
}

/** Validate managed-frontend fields used to derive publication state. */
export function readProjectFrontendState(
  response: unknown,
  expectedAppId: string,
): ProjectFrontendState {
  const code = "CLOUD_FRONTEND_RESPONSE_INVALID";
  if (
    !isRecord(response) ||
    response.success !== true ||
    !Array.isArray(response.deployments)
  ) {
    invalid(code, "Cloud returned an invalid frontend response", {
      expectedAppId,
    });
  }
  const activeDeploymentId = nullableString(
    response,
    "active_deployment_id",
    code,
    "active_deployment_id",
  );
  const publicUrl = nullableString(response, "public_url", code, "public_url");
  const ids = new Set<string>();
  const deployments = response.deployments.map((value, index) => {
    if (!isRecord(value)) {
      invalid(code, "Cloud returned an invalid frontend deployment", {
        expectedAppId,
        index,
      });
    }
    const id = nonEmptyString(value, "id", code, `deployments[${index}].id`);
    const appId = nonEmptyString(
      value,
      "app_id",
      code,
      `deployments[${index}].app_id`,
    );
    const status = nonEmptyString(
      value,
      "status",
      code,
      `deployments[${index}].status`,
    );
    if (
      appId !== expectedAppId ||
      !FRONTEND_DEPLOYMENT_STATUSES.has(status) ||
      ids.has(id)
    ) {
      invalid(code, "Cloud returned an inconsistent frontend deployment", {
        expectedAppId,
        receivedAppId: appId,
        deploymentId: id,
        status,
        index,
      });
    }
    ids.add(id);
    return { id, status };
  });
  const activeDeployments = deployments.filter(
    (deployment) => deployment.status === "active",
  );
  const selected = activeDeploymentId
    ? deployments.find((deployment) => deployment.id === activeDeploymentId)
    : undefined;
  if (
    (activeDeploymentId === null && activeDeployments.length !== 0) ||
    (activeDeploymentId !== null &&
      (selected?.status !== "active" || activeDeployments.length !== 1))
  ) {
    invalid(code, "Cloud returned inconsistent active frontend state", {
      expectedAppId,
      activeDeploymentId,
      activeDeploymentCount: activeDeployments.length,
    });
  }
  return { activeDeploymentId, publicUrl, deployments };
}

function finiteEarningsNumber(
  record: Record<string, unknown>,
  key: keyof ProjectEarningsSummary,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(
      "CLOUD_EARNINGS_INVALID",
      `Cloud earnings summary is missing ${key}`,
      {
        key,
      },
    );
  }
  return value;
}

/** Validate the earnings fields surfaced by publication-state reads. */
export function readProjectEarnings(
  response: unknown,
): ProjectEarningsSummary | null {
  if (
    !isRecord(response) ||
    response.success !== true ||
    !isRecord(response.earnings)
  ) {
    invalid(
      "CLOUD_EARNINGS_INVALID",
      "Cloud earnings envelope is missing earnings",
    );
  }
  const summary = response.earnings.summary;
  if (summary === null) return null;
  if (!isRecord(summary)) {
    invalid(
      "CLOUD_EARNINGS_INVALID",
      "Cloud earnings envelope is missing summary state",
    );
  }
  return {
    totalLifetimeEarnings: finiteEarningsNumber(
      summary,
      "totalLifetimeEarnings",
    ),
    pendingBalance: finiteEarningsNumber(summary, "pendingBalance"),
    withdrawableBalance: finiteEarningsNumber(summary, "withdrawableBalance"),
    totalWithdrawn: finiteEarningsNumber(summary, "totalWithdrawn"),
  };
}
