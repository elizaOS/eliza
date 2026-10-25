#!/usr/bin/env bun
/**
 * Runs a fail-closed account-deletion canary against the exact staging Cloud
 * deployment and a disposable Steward tenant. The canary creates fresh target
 * and control identities, accelerates only the target's exact deletion receipt,
 * waits for the normal scheduled Worker, and emits identifier-free evidence.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readDatabaseIdentityReceipt } from "./preflight-database-identity";

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: JsonObject[] }>;
}

const { Client } = createRequire(import.meta.url)("pg") as {
  Client: new (config: {
    application_name: string;
    connectionString: string;
    ssl: { rejectUnauthorized: boolean };
  }) => PgClient;
};
const CLOUD_STAGING_BASE_URL = "https://api-staging.eliza.app";
const CLOUD_STAGING_ORIGIN = "https://cloud-staging.eliza.app";
const STEWARD_STAGING_BASE_URL = "https://steward-api-staging.up.railway.app";
const STAGING_DATABASE_HOST = "switchback.proxy.rlwy.net";
const STAGING_DATABASE_PORT = "49295";
const STAGING_DATABASE_NAME = "eliza_staging";
const TENANT_PREFIX = "eliza-account-deletion-canary-";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RUN_SUFFIX_PATTERN = /^r[1-9]\d{7,19}a[1-9]\d{0,3}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 80 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const EVIDENCE_PATH = "reports/account-deletion-staging-canary.json";

type JsonObject = Record<string, unknown>;
type Fetch = typeof globalThis.fetch;
type Phase =
  | "config"
  | "cloud_deploy"
  | "database_identity"
  | "provider_probe"
  | "provision"
  | "cloud_sync"
  | "request"
  | "immediate"
  | "accelerate"
  | "scheduled_worker"
  | "final"
  | "cleanup"
  | "internal";

interface StewardCredentials {
  email: string;
  otp: string;
}

interface StewardSession {
  refreshToken: string;
  token: string;
  userId: string;
}

interface CloudSession {
  cookie: string;
  stewardUserId: string;
  userId: string;
}

interface CloudIdentity {
  organizationId: string;
  stewardUserId: string;
  userId: string;
}

interface DeletionReceipt {
  requestId: string;
}

export interface AccountDeletionStagingCanaryConfig {
  cloudBaseUrl: typeof CLOUD_STAGING_BASE_URL;
  cloudOrigin: typeof CLOUD_STAGING_ORIGIN;
  completionTimeoutMs: number;
  databaseUrl: string;
  evidencePath: string;
  expectedAuthoritySha256: string;
  expectedCloudCommit: string;
  expectedClusterSha256: string;
  platformKey: string;
  pollIntervalMs: number;
  runSuffix: string;
  stewardBaseUrl: typeof STEWARD_STAGING_BASE_URL;
}

export interface AccountDeletionStagingCanaryEvidence {
  schemaVersion: 1;
  verdict: "pass" | "fail";
  cloudCommit: string | null;
  database: {
    identityVerified: boolean;
    postgresMajor: number | null;
  };
  path: {
    providerPersonalLifecycle: boolean;
    targetSessionExchange: boolean;
    controlSessionExchange: boolean;
    scheduled: boolean;
    immediateDeactivation: boolean;
    scheduledWorkerCompleted: boolean;
    cloudErasure: boolean;
    providerErasure: boolean;
    controlPreserved: boolean;
  };
  cleanup: {
    status: "not-required" | "passed" | "failed";
    possibleResidue: boolean;
  };
  timingsMs: Partial<Record<Phase | "total", number>>;
  failure: { phase: Phase; code: string } | null;
}

class CanaryFailure extends Error {
  constructor(
    readonly phase: Phase,
    readonly code: string,
  ) {
    super(`${phase}:${code}`);
    this.name = "CanaryFailure";
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredEnv(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value)
    throw new CanaryFailure("config", `missing_${name.toLowerCase()}`);
  return value;
}

function stewardPlatformKey(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const value =
    environment.STEWARD_PLATFORM_KEY?.trim() ||
    environment.STEWARD_PLATFORM_KEYS?.split(",")[0]?.trim();
  if (!value) throw new CanaryFailure("config", "missing_steward_platform_key");
  return value;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CanaryFailure("config", `invalid_${name.toLowerCase()}`);
  }
  return parsed;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = positiveInteger(value, fallback, name);
  if (parsed < minimum || parsed > maximum) {
    throw new CanaryFailure("config", `invalid_${name.toLowerCase()}`);
  }
  return parsed;
}

export function isExactAccountDeletionStagingDatabaseUrl(
  value: string,
): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname === STAGING_DATABASE_HOST &&
      url.port === STAGING_DATABASE_PORT &&
      url.pathname === `/${STAGING_DATABASE_NAME}` &&
      Boolean(url.username) &&
      Boolean(url.password) &&
      url.searchParams.size === 1 &&
      url.searchParams.get("sslmode") === "require" &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** Reads the explicit staging-only authority without logging any secret value. */
export function readAccountDeletionStagingCanaryConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AccountDeletionStagingCanaryConfig {
  if (environment.ELIZA_ACCOUNT_DELETION_STAGING_CANARY !== "1") {
    throw new CanaryFailure("config", "explicit_opt_in_required");
  }
  const cloudBaseUrl = requiredEnv(
    environment,
    "ELIZA_ACCOUNT_DELETION_STAGING_CLOUD_BASE_URL",
  );
  const cloudOrigin = requiredEnv(
    environment,
    "ELIZA_ACCOUNT_DELETION_STAGING_CLOUD_ORIGIN",
  );
  const stewardBaseUrl = requiredEnv(
    environment,
    "ELIZA_ACCOUNT_DELETION_STAGING_STEWARD_BASE_URL",
  );
  if (cloudBaseUrl !== CLOUD_STAGING_BASE_URL) {
    throw new CanaryFailure("config", "non_staging_cloud_target");
  }
  if (cloudOrigin !== CLOUD_STAGING_ORIGIN) {
    throw new CanaryFailure("config", "non_staging_cloud_origin");
  }
  if (stewardBaseUrl !== STEWARD_STAGING_BASE_URL) {
    throw new CanaryFailure("config", "non_staging_steward_target");
  }

  const databaseUrl = requiredEnv(environment, "DATABASE_URL");
  if (!isExactAccountDeletionStagingDatabaseUrl(databaseUrl)) {
    throw new CanaryFailure("config", "non_staging_database_target");
  }
  if (
    environment.ELIZA_ACCOUNT_DELETION_STAGING_ALLOW_RAILWAY_SELF_SIGNED_TLS !==
    "1"
  ) {
    throw new CanaryFailure("config", "railway_tls_opt_in_required");
  }

  const expectedCloudCommit = requiredEnv(
    environment,
    "ELIZA_ACCOUNT_DELETION_STAGING_EXPECTED_CLOUD_COMMIT",
  ).toLowerCase();
  const expectedClusterSha256 = requiredEnv(
    environment,
    "ELIZA_ACCOUNT_DELETION_STAGING_EXPECTED_CLUSTER_SHA256",
  ).toLowerCase();
  const expectedAuthoritySha256 = requiredEnv(
    environment,
    "ELIZA_ACCOUNT_DELETION_STAGING_EXPECTED_AUTHORITY_SHA256",
  ).toLowerCase();
  if (!COMMIT_PATTERN.test(expectedCloudCommit)) {
    throw new CanaryFailure("config", "invalid_expected_cloud_commit");
  }
  if (!SHA256_PATTERN.test(expectedClusterSha256)) {
    throw new CanaryFailure("config", "invalid_expected_cluster_receipt");
  }
  if (!SHA256_PATTERN.test(expectedAuthoritySha256)) {
    throw new CanaryFailure("config", "invalid_expected_authority_receipt");
  }

  const runSuffix = requiredEnv(
    environment,
    "ELIZA_ACCOUNT_DELETION_STAGING_RUN_SUFFIX",
  ).toLowerCase();
  if (!RUN_SUFFIX_PATTERN.test(runSuffix)) {
    throw new CanaryFailure("config", "invalid_run_suffix");
  }
  const evidencePath =
    environment.ELIZA_ACCOUNT_DELETION_STAGING_EVIDENCE_PATH?.trim() ||
    EVIDENCE_PATH;
  if (evidencePath !== EVIDENCE_PATH) {
    throw new CanaryFailure("config", "invalid_evidence_path");
  }

  return {
    cloudBaseUrl,
    cloudOrigin,
    completionTimeoutMs: boundedInteger(
      environment.ELIZA_ACCOUNT_DELETION_STAGING_COMPLETION_TIMEOUT_MS,
      DEFAULT_COMPLETION_TIMEOUT_MS,
      "completion_timeout_ms",
      65 * 60_000,
      90 * 60_000,
    ),
    databaseUrl,
    evidencePath,
    expectedAuthoritySha256,
    expectedCloudCommit,
    expectedClusterSha256,
    platformKey: stewardPlatformKey(environment),
    pollIntervalMs: boundedInteger(
      environment.ELIZA_ACCOUNT_DELETION_STAGING_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      "poll_interval_ms",
      5_000,
      60_000,
    ),
    runSuffix,
    stewardBaseUrl,
  };
}

function freshEvidence(): AccountDeletionStagingCanaryEvidence {
  return {
    schemaVersion: 1,
    verdict: "fail",
    cloudCommit: null,
    database: { identityVerified: false, postgresMajor: null },
    path: {
      providerPersonalLifecycle: false,
      targetSessionExchange: false,
      controlSessionExchange: false,
      scheduled: false,
      immediateDeactivation: false,
      scheduledWorkerCompleted: false,
      cloudErasure: false,
      providerErasure: false,
      controlPreserved: false,
    },
    cleanup: { status: "not-required", possibleResidue: false },
    timingsMs: {},
    failure: null,
  };
}

function fixedFailure(error: unknown): CanaryFailure {
  return error instanceof CanaryFailure
    ? error
    : new CanaryFailure("internal", "unexpected_error");
}

async function timed<T>(
  evidence: AccountDeletionStagingCanaryEvidence,
  phase: Phase,
  now: () => number,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = now();
  try {
    return await operation();
  } finally {
    evidence.timingsMs[phase] = Math.max(0, now() - startedAt);
  }
}

async function fetchWithTimeout(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch {
    throw new CanaryFailure("internal", "request_failed");
  }
}

async function responseJson(
  response: Response,
  phase: Phase,
): Promise<JsonObject> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CanaryFailure(phase, "invalid_json_response");
  }
  if (!isRecord(body)) throw new CanaryFailure(phase, "invalid_response_shape");
  return body;
}

function dataRecord(body: JsonObject, phase: Phase): JsonObject {
  if (!isRecord(body.data))
    throw new CanaryFailure(phase, "invalid_response_shape");
  return body.data;
}

function requiredString(record: JsonObject, key: string, phase: Phase): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new CanaryFailure(phase, "invalid_response_shape");
  }
  return value.trim();
}

function platformHeaders(platformKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-steward-platform-key": platformKey,
  };
}

async function expectStatus(
  response: Response,
  allowed: readonly number[],
  phase: Phase,
  code: string,
): Promise<Response> {
  if (!allowed.includes(response.status)) throw new CanaryFailure(phase, code);
  return response;
}

class StewardClient {
  constructor(
    private readonly config: AccountDeletionStagingCanaryConfig,
    private readonly fetchImpl: Fetch,
  ) {}

  private url(path: string): string {
    return `${this.config.stewardBaseUrl}${path}`;
  }

  async assertTenantAbsent(tenantId: string): Promise<void> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.url(`/platform/tenants/${encodeURIComponent(tenantId)}`),
      { headers: platformHeaders(this.config.platformKey) },
    );
    if (response.status !== 404) {
      throw new CanaryFailure("provision", "canary_tenant_already_exists");
    }
  }

  async createTenant(tenantId: string): Promise<void> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.url("/platform/tenants"),
      {
        method: "POST",
        headers: platformHeaders(this.config.platformKey),
        body: JSON.stringify({
          id: tenantId,
          name: "Account deletion staging canary",
        }),
      },
    );
    await expectStatus(response, [201], "provision", "tenant_create_failed");
    const data = dataRecord(
      await responseJson(response, "provision"),
      "provision",
    );
    if (requiredString(data, "id", "provision") !== tenantId) {
      throw new CanaryFailure("provision", "tenant_identity_mismatch");
    }
  }

  async addSentinelOwner(tenantId: string, email: string): Promise<string> {
    await this.assertEmailAbsent(email);
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.url(`/platform/tenants/${encodeURIComponent(tenantId)}/members`),
      {
        method: "POST",
        headers: platformHeaders(this.config.platformKey),
        body: JSON.stringify({ email, role: "owner" }),
      },
    );
    await expectStatus(response, [201], "provision", "sentinel_create_failed");
    const data = dataRecord(
      await responseJson(response, "provision"),
      "provision",
    );
    const userId = requiredString(data, "userId", "provision");
    if (!UUID_PATTERN.test(userId) || data.role !== "owner") {
      throw new CanaryFailure("provision", "sentinel_identity_mismatch");
    }
    return userId;
  }

  async assertEmailAbsent(email: string): Promise<void> {
    const url = new URL(this.url("/platform/users/lookup"));
    url.searchParams.set("email", email);
    const response = await fetchWithTimeout(this.fetchImpl, url.toString(), {
      headers: platformHeaders(this.config.platformKey),
    });
    await expectStatus(response, [200], "provision", "user_lookup_failed");
    const data = dataRecord(
      await responseJson(response, "provision"),
      "provision",
    );
    if (data.user !== null)
      throw new CanaryFailure("provision", "generated_identity_exists");
  }

  async rotateTestAccount(tenantId: string): Promise<StewardCredentials> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.url(
        `/platform/tenants/${encodeURIComponent(tenantId)}/test-account`,
      ),
      { method: "POST", headers: platformHeaders(this.config.platformKey) },
    );
    await expectStatus(
      response,
      [200],
      "provision",
      "test_account_rotation_failed",
    );
    const data = dataRecord(
      await responseJson(response, "provision"),
      "provision",
    );
    if (!isRecord(data.testAccount)) {
      throw new CanaryFailure("provision", "invalid_test_account_shape");
    }
    const email = requiredString(data.testAccount, "email", "provision");
    const otp = requiredString(data.testAccount, "otp", "provision");
    if (!/^test-\d{6}@steward\.test$/.test(email) || !/^\d{6}$/.test(otp)) {
      throw new CanaryFailure("provision", "invalid_test_account_shape");
    }
    await this.assertEmailAbsent(email);
    return { email, otp };
  }

  async exchangeTestAccount(
    tenantId: string,
    credentials: StewardCredentials,
  ): Promise<StewardSession> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.url("/auth/test/token"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-steward-tenant": tenantId,
        },
        body: JSON.stringify({
          tenantId,
          email: credentials.email,
          otp: credentials.otp,
        }),
      },
    );
    await expectStatus(
      response,
      [200],
      "provision",
      "test_account_exchange_failed",
    );
    const body = await responseJson(response, "provision");
    if (!isRecord(body.user))
      throw new CanaryFailure("provision", "invalid_session_shape");
    const userId = requiredString(body.user, "id", "provision");
    const token = requiredString(body, "token", "provision");
    const refreshToken = requiredString(body, "refreshToken", "provision");
    if (!UUID_PATTERN.test(userId) || token.split(".").length !== 3) {
      throw new CanaryFailure("provision", "invalid_session_shape");
    }
    return { userId, token, refreshToken };
  }

  async setDeactivated(userId: string, deactivated: boolean): Promise<void> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.url(`/platform/users/${encodeURIComponent(userId)}/deactivate`),
      {
        method: "PATCH",
        headers: platformHeaders(this.config.platformKey),
        body: JSON.stringify({ deactivated }),
      },
    );
    await expectStatus(
      response,
      [200],
      "provider_probe",
      "provider_deactivation_failed",
    );
  }

  async deleteUser(userId: string, phase: Phase = "cleanup"): Promise<void> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.url(`/platform/users/${encodeURIComponent(userId)}`),
      { method: "DELETE", headers: platformHeaders(this.config.platformKey) },
    );
    await expectStatus(
      response,
      [200, 404],
      phase,
      "provider_user_delete_failed",
    );
  }

  async assertUserPresent(
    userId: string,
    expectedDeactivated: boolean,
  ): Promise<void> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.url(`/platform/users/${encodeURIComponent(userId)}`),
      { headers: platformHeaders(this.config.platformKey) },
    );
    await expectStatus(response, [200], "immediate", "provider_user_missing");
    const data = dataRecord(
      await responseJson(response, "immediate"),
      "immediate",
    );
    const deactivated = typeof data.deactivatedAt === "string";
    if (deactivated !== expectedDeactivated) {
      throw new CanaryFailure("immediate", "provider_deactivation_mismatch");
    }
  }

  async assertUserAbsent(userId: string, phase: Phase): Promise<void> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.url(`/platform/users/${encodeURIComponent(userId)}`),
      { headers: platformHeaders(this.config.platformKey) },
    );
    if (response.status !== 404)
      throw new CanaryFailure(phase, "provider_user_not_erased");
  }

  async assertTenantMissing(tenantId: string, phase: Phase): Promise<void> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.url(`/platform/tenants/${encodeURIComponent(tenantId)}`),
      { headers: platformHeaders(this.config.platformKey) },
    );
    if (response.status !== 404)
      throw new CanaryFailure(phase, "personal_tenant_not_erased");
  }

  async disableTestAccount(tenantId: string): Promise<void> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.url(
        `/platform/tenants/${encodeURIComponent(tenantId)}/test-account`,
      ),
      { method: "DELETE", headers: platformHeaders(this.config.platformKey) },
    );
    await expectStatus(
      response,
      [200, 404],
      "cleanup",
      "test_account_disable_failed",
    );
  }

  async deleteTenant(
    tenantId: string,
    phase: Phase = "cleanup",
  ): Promise<void> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.url(`/platform/tenants/${encodeURIComponent(tenantId)}`),
      { method: "DELETE", headers: platformHeaders(this.config.platformKey) },
    );
    await expectStatus(response, [200, 404], phase, "tenant_delete_failed");
  }
}

function cookieHeader(response: Response): string {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies = headers.getSetCookie?.() ?? [];
  const source =
    setCookies.length > 0
      ? setCookies
      : [response.headers.get("set-cookie") ?? ""];
  const pairs = source
    .map((value) => value.match(/^([^=;,\s]+)=([^;,]*)/)?.slice(1, 3))
    .filter((pair): pair is [string, string] => Boolean(pair))
    .map(([name, value]) => `${name}=${value}`);
  if (pairs.length < 2)
    throw new CanaryFailure("cloud_sync", "session_cookie_missing");
  return pairs.join("; ");
}

class CloudClient {
  constructor(
    private readonly config: AccountDeletionStagingCanaryConfig,
    private readonly fetchImpl: Fetch,
  ) {}

  async assertExactDeployment(): Promise<string> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      `${this.config.cloudBaseUrl}/api/health`,
      { headers: { "user-agent": "eliza-account-deletion-staging-canary/1" } },
    );
    await expectStatus(response, [200], "cloud_deploy", "cloud_health_failed");
    const body = await responseJson(response, "cloud_deploy");
    const commit = requiredString(body, "commit", "cloud_deploy").toLowerCase();
    if (
      body.environment !== "staging" ||
      commit !== this.config.expectedCloudCommit
    ) {
      throw new CanaryFailure("cloud_deploy", "deployed_commit_mismatch");
    }
    return commit;
  }

  async exchangeSession(steward: StewardSession): Promise<CloudSession> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      `${this.config.cloudBaseUrl}/api/auth/steward-session`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: this.config.cloudOrigin,
        },
        body: JSON.stringify({
          token: steward.token,
          refreshToken: steward.refreshToken,
        }),
      },
    );
    await expectStatus(
      response,
      [200],
      "cloud_sync",
      "cloud_session_exchange_failed",
    );
    const body = await responseJson(response, "cloud_sync");
    const userId = requiredString(body, "userId", "cloud_sync");
    const stewardUserId = requiredString(body, "stewardUserId", "cloud_sync");
    if (
      !UUID_PATTERN.test(userId) ||
      stewardUserId !== steward.userId ||
      body.ok !== true
    ) {
      throw new CanaryFailure("cloud_sync", "cloud_identity_mismatch");
    }
    return { cookie: cookieHeader(response), userId, stewardUserId };
  }

  async requestDeletion(session: CloudSession): Promise<DeletionReceipt> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      `${this.config.cloudBaseUrl}/api/v1/me/account-deletion`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          origin: this.config.cloudOrigin,
        },
        body: JSON.stringify({ confirmation: "DELETE" }),
      },
    );
    await expectStatus(response, [202], "request", "deletion_request_failed");
    const body = await responseJson(response, "request");
    if (!isRecord(body.request))
      throw new CanaryFailure("request", "invalid_response_shape");
    const requestId = requiredString(body.request, "requestId", "request");
    if (!UUID_PATTERN.test(requestId) || body.request.status !== "scheduled") {
      throw new CanaryFailure("request", "deletion_not_scheduled");
    }
    return { requestId };
  }
}

interface CloudDatabaseSnapshot {
  activeApiKeys: number;
  apiKeys: number;
  organizationActive: boolean;
  userActive: boolean;
}

class CanaryDatabase {
  constructor(private readonly client: PgClient) {}

  async verifyIdentity(
    config: AccountDeletionStagingCanaryConfig,
  ): Promise<number> {
    const receipt = await readDatabaseIdentityReceipt(this.client, "staging");
    if (
      receipt.clusterSha256 !== config.expectedClusterSha256 ||
      receipt.authoritySha256 !== config.expectedAuthoritySha256
    ) {
      throw new CanaryFailure(
        "database_identity",
        "database_identity_mismatch",
      );
    }
    const schema = await this.client.query(
      `SELECT to_regclass('public.account_deletion_requests')::text AS relation`,
    );
    if (schema.rows[0]?.relation !== "account_deletion_requests") {
      throw new CanaryFailure(
        "database_identity",
        "account_deletion_schema_missing",
      );
    }
    return receipt.postgresMajor;
  }

  async assertStewardIdentityAbsent(stewardUserId: string): Promise<void> {
    const result = await this.client.query(
      "SELECT count(*)::int AS count FROM users WHERE steward_user_id = $1",
      [stewardUserId],
    );
    if (result.rows[0]?.count !== 0) {
      throw new CanaryFailure("cloud_sync", "cloud_identity_already_exists");
    }
  }

  async assertCloudEmailAbsent(email: string): Promise<void> {
    const result = await this.client.query(
      "SELECT count(*)::int AS count FROM users WHERE lower(email) = lower($1)",
      [email],
    );
    if (result.rows[0]?.count !== 0) {
      throw new CanaryFailure("cloud_sync", "cloud_email_already_exists");
    }
  }

  async loadFreshIdentity(
    session: CloudSession,
    startedAt: Date,
  ): Promise<CloudIdentity> {
    const result = await this.client.query(
      `SELECT id::text, organization_id::text, steward_user_id, created_at
       FROM users
       WHERE id = $1 AND steward_user_id = $2`,
      [session.userId, session.stewardUserId],
    );
    if (result.rows.length !== 1)
      throw new CanaryFailure("cloud_sync", "cloud_row_missing");
    const row = result.rows[0];
    const userId = requiredString(row, "id", "cloud_sync");
    const organizationId = requiredString(row, "organization_id", "cloud_sync");
    const stewardUserId = requiredString(row, "steward_user_id", "cloud_sync");
    const createdAt = row.created_at;
    const createdAtMs =
      createdAt instanceof Date ||
      typeof createdAt === "string" ||
      typeof createdAt === "number"
        ? new Date(createdAt).getTime()
        : Number.NaN;
    if (
      !UUID_PATTERN.test(userId) ||
      !UUID_PATTERN.test(organizationId) ||
      !Number.isFinite(createdAtMs) ||
      createdAtMs < startedAt.getTime() - 60_000
    ) {
      throw new CanaryFailure("cloud_sync", "cloud_row_not_fresh");
    }
    const members = await this.client.query(
      "SELECT count(*)::int AS count FROM users WHERE organization_id = $1",
      [organizationId],
    );
    if (members.rows[0]?.count !== 1) {
      throw new CanaryFailure("cloud_sync", "cloud_personal_org_not_isolated");
    }
    return {
      userId,
      organizationId,
      stewardUserId,
    };
  }

  async snapshot(identity: CloudIdentity): Promise<CloudDatabaseSnapshot> {
    const result = await this.client.query(
      `SELECT
         u.is_active AS user_active,
         o.is_active AS organization_active,
         count(k.id)::int AS api_keys,
         count(k.id) FILTER (WHERE k.is_active)::int AS active_api_keys
       FROM users u
       JOIN organizations o ON o.id = u.organization_id
       LEFT JOIN api_keys k ON k.user_id = u.id AND k.organization_id = o.id
       WHERE u.id = $1 AND u.organization_id = $2 AND u.steward_user_id = $3
       GROUP BY u.is_active, o.is_active`,
      [identity.userId, identity.organizationId, identity.stewardUserId],
    );
    if (result.rows.length !== 1)
      throw new CanaryFailure("immediate", "cloud_row_missing");
    const row = result.rows[0];
    return {
      userActive: row.user_active === true,
      organizationActive: row.organization_active === true,
      apiKeys: Number(row.api_keys),
      activeApiKeys: Number(row.active_api_keys),
    };
  }

  async verifyInitial(identity: CloudIdentity): Promise<void> {
    const snapshot = await this.snapshot(identity);
    if (
      !snapshot.userActive ||
      !snapshot.organizationActive ||
      snapshot.apiKeys < 1
    ) {
      throw new CanaryFailure("cloud_sync", "cloud_initial_state_invalid");
    }
    if (snapshot.activeApiKeys !== snapshot.apiKeys) {
      throw new CanaryFailure("cloud_sync", "cloud_initial_key_state_invalid");
    }
  }

  async verifyImmediate(
    identity: CloudIdentity,
    requestId: string,
  ): Promise<void> {
    const snapshot = await this.snapshot(identity);
    if (
      snapshot.userActive ||
      snapshot.organizationActive ||
      snapshot.activeApiKeys !== 0
    ) {
      throw new CanaryFailure("immediate", "cloud_deactivation_incomplete");
    }
    const receipt = await this.client.query(
      `SELECT status, identity_deactivated_at IS NOT NULL AS deactivated
       FROM account_deletion_requests
       WHERE id = $1 AND user_id = $2 AND organization_id = $3 AND steward_user_id = $4`,
      [
        requestId,
        identity.userId,
        identity.organizationId,
        identity.stewardUserId,
      ],
    );
    if (
      receipt.rows.length !== 1 ||
      receipt.rows[0].status !== "scheduled" ||
      receipt.rows[0].deactivated !== true
    ) {
      throw new CanaryFailure("immediate", "deletion_receipt_mismatch");
    }
  }

  async accelerate(identity: CloudIdentity, requestId: string): Promise<void> {
    await this.client.query("BEGIN");
    try {
      await this.client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`account_deletion_canary_${requestId}`],
      );
      const result = await this.client.query(
        `UPDATE account_deletion_requests
         SET execute_after = clock_timestamp() - interval '1 minute', updated_at = clock_timestamp()
         WHERE id = $1 AND user_id = $2 AND organization_id = $3 AND steward_user_id = $4
           AND status = 'scheduled' AND completed_at IS NULL
         RETURNING id`,
        [
          requestId,
          identity.userId,
          identity.organizationId,
          identity.stewardUserId,
        ],
      );
      if (result.rows.length !== 1) {
        throw new CanaryFailure("accelerate", "exact_receipt_update_refused");
      }
      await this.client.query("COMMIT");
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  async deletionStatus(requestId: string): Promise<string | null> {
    const result = await this.client.query(
      "SELECT status FROM account_deletion_requests WHERE id = $1",
      [requestId],
    );
    return typeof result.rows[0]?.status === "string"
      ? result.rows[0].status
      : null;
  }

  async verifyCompleted(
    identity: CloudIdentity,
    requestId: string,
  ): Promise<void> {
    const receipt = await this.client.query(
      `SELECT status, completed_at IS NOT NULL AS completed,
              user_id, organization_id, steward_user_id
       FROM account_deletion_requests WHERE id = $1`,
      [requestId],
    );
    const row = receipt.rows[0];
    if (
      receipt.rows.length !== 1 ||
      row.status !== "completed" ||
      row.completed !== true ||
      row.user_id !== null ||
      row.organization_id !== null ||
      row.steward_user_id !== null
    ) {
      throw new CanaryFailure("final", "completed_receipt_invalid");
    }
    const user = await this.client.query("SELECT 1 FROM users WHERE id = $1", [
      identity.userId,
    ]);
    const organization = await this.client.query(
      "SELECT 1 FROM organizations WHERE id = $1",
      [identity.organizationId],
    );
    if (user.rows.length !== 0 || organization.rows.length !== 0) {
      throw new CanaryFailure("final", "cloud_identity_not_erased");
    }
  }

  async verifyControl(identity: CloudIdentity): Promise<void> {
    const snapshot = await this.snapshot(identity);
    if (
      !snapshot.userActive ||
      !snapshot.organizationActive ||
      snapshot.activeApiKeys < 1
    ) {
      throw new CanaryFailure("final", "control_identity_changed");
    }
    const request = await this.client.query(
      `SELECT count(*)::int AS count FROM account_deletion_requests
       WHERE user_id = $1 OR organization_id = $2 OR steward_user_id = $3`,
      [identity.userId, identity.organizationId, identity.stewardUserId],
    );
    if (request.rows[0]?.count !== 0) {
      throw new CanaryFailure("final", "control_deletion_receipt_created");
    }
  }

  async cleanupExact(identity: CloudIdentity): Promise<void> {
    await this.client.query("BEGIN");
    try {
      await this.client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`account_deletion_canary_cleanup_${identity.userId}`],
      );
      const members = await this.client.query(
        `SELECT id::text, steward_user_id FROM users
         WHERE organization_id = $1 FOR UPDATE`,
        [identity.organizationId],
      );
      if (members.rows.length === 0) {
        await this.client.query(
          "DELETE FROM organizations WHERE id = $1 RETURNING id",
          [identity.organizationId],
        );
        await this.client.query("COMMIT");
        return;
      }
      if (
        members.rows.length !== 1 ||
        members.rows[0].id !== identity.userId ||
        members.rows[0].steward_user_id !== identity.stewardUserId
      ) {
        throw new CanaryFailure("cleanup", "cloud_cleanup_scope_mismatch");
      }
      await this.client.query(
        `DELETE FROM account_deletion_requests
         WHERE user_id = $1 AND organization_id = $2 AND steward_user_id = $3
           AND completed_at IS NULL`,
        [identity.userId, identity.organizationId, identity.stewardUserId],
      );
      const deleted = await this.client.query(
        "DELETE FROM organizations WHERE id = $1 RETURNING id",
        [identity.organizationId],
      );
      if (deleted.rows.length !== 1) {
        throw new CanaryFailure("cleanup", "cloud_cleanup_delete_failed");
      }
      await this.client.query("COMMIT");
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }
}

function stagingPgClient(databaseUrl: string): PgClient {
  const url = new URL(databaseUrl);
  url.searchParams.delete("sslmode");
  return new Client({
    connectionString: url.toString(),
    application_name: "eliza_account_deletion_staging_canary",
    ssl: { rejectUnauthorized: false },
  });
}

async function runProviderPersonalLifecycleProbe(
  steward: StewardClient,
  tenantId: string,
): Promise<void> {
  const credentials = await steward.rotateTestAccount(tenantId);
  const session = await steward.exchangeTestAccount(tenantId, credentials);
  await steward.setDeactivated(session.userId, true);
  await steward.assertUserPresent(session.userId, true);
  await steward.setDeactivated(session.userId, false);
  await steward.assertUserPresent(session.userId, false);
  await steward.deleteTenant(`personal-${session.userId}`, "provider_probe");
  await steward.deleteUser(session.userId, "provider_probe");
  await steward.assertUserAbsent(session.userId, "provider_probe");
  await steward.assertTenantMissing(
    `personal-${session.userId}`,
    "provider_probe",
  );
}

async function waitForCompletion(
  database: CanaryDatabase,
  requestId: string,
  timeoutMs: number,
  pollIntervalMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const status = await database.deletionStatus(requestId);
    if (status === "completed") return;
    if (status === "action_required" || status === null) {
      throw new CanaryFailure("scheduled_worker", "deletion_worker_failed");
    }
    await sleep(pollIntervalMs);
  }
  throw new CanaryFailure("scheduled_worker", "deletion_worker_timeout");
}

async function cleanupProviderUser(
  steward: StewardClient,
  userId: string,
): Promise<void> {
  await steward.deleteTenant(`personal-${userId}`);
  await steward.deleteUser(userId);
}

export interface AccountDeletionStagingCanaryOptions {
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Executes only after all exact-target and database-identity gates pass. */
export async function runAccountDeletionStagingCanary(
  config: AccountDeletionStagingCanaryConfig,
  options: AccountDeletionStagingCanaryOptions = {},
): Promise<AccountDeletionStagingCanaryEvidence> {
  const evidence = freshEvidence();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const totalStartedAt = now();
  const startedAt = new Date(totalStartedAt);
  const tenantId = `${TENANT_PREFIX}${config.runSuffix}`;
  const sentinelEmail = `${config.runSuffix}-sentinel@steward.test`;
  const steward = new StewardClient(config, fetchImpl);
  const cloud = new CloudClient(config, fetchImpl);
  const pgClient = stagingPgClient(config.databaseUrl);
  const database = new CanaryDatabase(pgClient);
  let databaseConnected = false;
  let tenantCreated = false;
  let sentinelUserId: string | null = null;
  let targetStewardUserId: string | null = null;
  let controlStewardUserId: string | null = null;
  let targetCloud: CloudIdentity | null = null;
  let controlCloud: CloudIdentity | null = null;

  try {
    evidence.cloudCommit = await timed(evidence, "cloud_deploy", now, () =>
      cloud.assertExactDeployment(),
    );
    await pgClient.connect();
    databaseConnected = true;
    evidence.database.postgresMajor = await timed(
      evidence,
      "database_identity",
      now,
      () => database.verifyIdentity(config),
    );
    evidence.database.identityVerified = true;

    await timed(evidence, "provision", now, async () => {
      await steward.assertTenantAbsent(tenantId);
      await steward.createTenant(tenantId);
      tenantCreated = true;
      sentinelUserId = await steward.addSentinelOwner(tenantId, sentinelEmail);
    });

    await timed(evidence, "provider_probe", now, () =>
      runProviderPersonalLifecycleProbe(steward, tenantId),
    );
    evidence.path.providerPersonalLifecycle = true;

    const targetCredentials = await steward.rotateTestAccount(tenantId);
    const targetSteward = await steward.exchangeTestAccount(
      tenantId,
      targetCredentials,
    );
    targetStewardUserId = targetSteward.userId;
    await database.assertStewardIdentityAbsent(targetSteward.userId);
    await database.assertCloudEmailAbsent(targetCredentials.email);
    const targetSession = await timed(evidence, "cloud_sync", now, () =>
      cloud.exchangeSession(targetSteward),
    );
    evidence.path.targetSessionExchange = true;
    targetCloud = await database.loadFreshIdentity(targetSession, startedAt);
    await database.verifyInitial(targetCloud);

    const controlCredentials = await steward.rotateTestAccount(tenantId);
    const controlSteward = await steward.exchangeTestAccount(
      tenantId,
      controlCredentials,
    );
    controlStewardUserId = controlSteward.userId;
    if (controlSteward.userId === targetSteward.userId) {
      throw new CanaryFailure("provision", "target_control_identity_collision");
    }
    await database.assertStewardIdentityAbsent(controlSteward.userId);
    await database.assertCloudEmailAbsent(controlCredentials.email);
    const controlSession = await cloud.exchangeSession(controlSteward);
    evidence.path.controlSessionExchange = true;
    controlCloud = await database.loadFreshIdentity(controlSession, startedAt);
    await database.verifyInitial(controlCloud);

    const receipt = await timed(evidence, "request", now, () =>
      cloud.requestDeletion(targetSession),
    );
    evidence.path.scheduled = true;

    await timed(evidence, "immediate", now, async () => {
      if (!targetCloud || !controlCloud) {
        throw new CanaryFailure("immediate", "identity_state_missing");
      }
      await database.verifyImmediate(targetCloud, receipt.requestId);
      await steward.assertUserPresent(targetSteward.userId, true);
      await database.verifyControl(controlCloud);
      await steward.assertUserPresent(controlSteward.userId, false);
    });
    evidence.path.immediateDeactivation = true;
    evidence.path.controlPreserved = true;

    await timed(evidence, "accelerate", now, async () => {
      if (!targetCloud)
        throw new CanaryFailure("accelerate", "identity_state_missing");
      await database.accelerate(targetCloud, receipt.requestId);
    });
    await timed(evidence, "scheduled_worker", now, () =>
      waitForCompletion(
        database,
        receipt.requestId,
        config.completionTimeoutMs,
        config.pollIntervalMs,
        now,
        sleep,
      ),
    );
    evidence.path.scheduledWorkerCompleted = true;

    await timed(evidence, "final", now, async () => {
      if (!targetCloud || !controlCloud) {
        throw new CanaryFailure("final", "identity_state_missing");
      }
      await database.verifyCompleted(targetCloud, receipt.requestId);
      evidence.path.cloudErasure = true;
      await steward.assertUserAbsent(targetSteward.userId, "final");
      await steward.assertTenantMissing(
        `personal-${targetSteward.userId}`,
        "final",
      );
      evidence.path.providerErasure = true;
      await database.verifyControl(controlCloud);
      await steward.assertUserPresent(controlSteward.userId, false);
      evidence.path.controlPreserved = true;
    });

    evidence.verdict = "pass";
  } catch (error) {
    const failure = fixedFailure(error);
    evidence.failure = { phase: failure.phase, code: failure.code };
  } finally {
    const cleanupStartedAt = now();
    const cleanupErrors: unknown[] = [];
    if (controlStewardUserId) {
      await cleanupProviderUser(steward, controlStewardUserId).catch((error) =>
        cleanupErrors.push(error),
      );
    }
    if (targetStewardUserId) {
      await cleanupProviderUser(steward, targetStewardUserId).catch((error) =>
        cleanupErrors.push(error),
      );
    }
    if (controlCloud) {
      await database
        .cleanupExact(controlCloud)
        .catch((error) => cleanupErrors.push(error));
    }
    if (targetCloud) {
      await database
        .cleanupExact(targetCloud)
        .catch((error) => cleanupErrors.push(error));
    }
    if (tenantCreated) {
      await steward
        .disableTestAccount(tenantId)
        .catch((error) => cleanupErrors.push(error));
      await steward
        .deleteTenant(tenantId)
        .catch((error) => cleanupErrors.push(error));
    }
    if (sentinelUserId) {
      await steward
        .deleteUser(sentinelUserId)
        .catch((error) => cleanupErrors.push(error));
    }
    if (databaseConnected) {
      await pgClient.end().catch((error) => cleanupErrors.push(error));
    }
    evidence.timingsMs.cleanup = Math.max(0, now() - cleanupStartedAt);
    evidence.cleanup = {
      status:
        cleanupErrors.length === 0
          ? tenantCreated || targetCloud || controlCloud
            ? "passed"
            : "not-required"
          : "failed",
      possibleResidue: cleanupErrors.length > 0,
    };
    if (cleanupErrors.length > 0) {
      evidence.verdict = "fail";
      evidence.failure ??= { phase: "cleanup", code: "cleanup_incomplete" };
    }
    evidence.timingsMs.total = Math.max(0, now() - totalStartedAt);
  }

  return evidence;
}

export function validateAccountDeletionStagingCanaryEvidence(
  value: unknown,
): value is AccountDeletionStagingCanaryEvidence {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  const exactKeys = (record: JsonObject, keys: readonly string[]) =>
    Object.keys(record).sort().join("\0") === [...keys].sort().join("\0");
  if (
    !exactKeys(value, [
      "schemaVersion",
      "verdict",
      "cloudCommit",
      "database",
      "path",
      "cleanup",
      "timingsMs",
      "failure",
    ]) ||
    !isRecord(value.database) ||
    !isRecord(value.path) ||
    !isRecord(value.cleanup) ||
    !isRecord(value.timingsMs)
  ) {
    return false;
  }
  const database = value.database;
  const path = value.path;
  const cleanup = value.cleanup;
  const timingsMs = value.timingsMs;
  const pathKeys = [
    "providerPersonalLifecycle",
    "targetSessionExchange",
    "controlSessionExchange",
    "scheduled",
    "immediateDeactivation",
    "scheduledWorkerCompleted",
    "cloudErasure",
    "providerErasure",
    "controlPreserved",
  ] as const;
  const timingKeys = new Set<Phase | "total">([
    "config",
    "cloud_deploy",
    "database_identity",
    "provider_probe",
    "provision",
    "cloud_sync",
    "request",
    "immediate",
    "accelerate",
    "scheduled_worker",
    "final",
    "cleanup",
    "internal",
    "total",
  ]);
  const requiredPassTimings: readonly (Phase | "total")[] = [
    "cloud_deploy",
    "database_identity",
    "provider_probe",
    "provision",
    "cloud_sync",
    "request",
    "immediate",
    "accelerate",
    "scheduled_worker",
    "final",
    "cleanup",
    "total",
  ];
  const failurePhases = new Set<Phase>([
    "config",
    "cloud_deploy",
    "database_identity",
    "provider_probe",
    "provision",
    "cloud_sync",
    "request",
    "immediate",
    "accelerate",
    "scheduled_worker",
    "final",
    "cleanup",
    "internal",
  ]);
  if (
    !exactKeys(database, ["identityVerified", "postgresMajor"]) ||
    typeof database.identityVerified !== "boolean" ||
    !(
      database.postgresMajor === null ||
      (Number.isSafeInteger(database.postgresMajor) &&
        Number(database.postgresMajor) >= 10)
    ) ||
    !exactKeys(path, pathKeys) ||
    !pathKeys.every((key) => typeof path[key] === "boolean") ||
    !exactKeys(cleanup, ["status", "possibleResidue"]) ||
    !["not-required", "passed", "failed"].includes(String(cleanup.status)) ||
    typeof cleanup.possibleResidue !== "boolean" ||
    !Object.entries(timingsMs).every(
      ([key, timing]) =>
        timingKeys.has(key as Phase | "total") &&
        typeof timing === "number" &&
        Number.isFinite(timing) &&
        timing >= 0 &&
        timing <= 2 * 60 * 60_000,
    )
  ) {
    return false;
  }
  if (value.failure !== null) {
    if (
      !isRecord(value.failure) ||
      !exactKeys(value.failure, ["phase", "code"]) ||
      !failurePhases.has(value.failure.phase as Phase) ||
      typeof value.failure.code !== "string" ||
      !/^[a-z0-9_]{1,80}$/.test(value.failure.code)
    ) {
      return false;
    }
  }
  if (value.verdict === "pass") {
    if (
      value.failure !== null ||
      value.cloudCommit === null ||
      database.identityVerified !== true ||
      !pathKeys.every((key) => path[key] === true) ||
      cleanup.status !== "passed" ||
      cleanup.possibleResidue !== false ||
      !requiredPassTimings.every((key) => key in timingsMs)
    ) {
      return false;
    }
  } else if (value.verdict === "fail") {
    if (value.failure === null) return false;
  } else {
    return false;
  }
  const serialized = JSON.stringify(value);
  if (
    /@steward\.test|postgres(?:ql)?:|switchback|steward-api|api-staging|[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(
      serialized,
    )
  ) {
    return false;
  }
  return (
    value.cloudCommit === null ||
    (typeof value.cloudCommit === "string" &&
      COMMIT_PATTERN.test(value.cloudCommit))
  );
}

async function main(): Promise<void> {
  let evidence = freshEvidence();
  let evidencePath = "reports/account-deletion-staging-canary.json";
  try {
    const config = readAccountDeletionStagingCanaryConfig();
    evidencePath = config.evidencePath;
    evidence = await runAccountDeletionStagingCanary(config);
  } catch (error) {
    const failure = fixedFailure(error);
    evidence.failure = { phase: failure.phase, code: failure.code };
  }
  if (!validateAccountDeletionStagingCanaryEvidence(evidence)) {
    evidence = freshEvidence();
    evidence.failure = {
      phase: "internal",
      code: "evidence_validation_failed",
    };
  }
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  process.exitCode = evidence.verdict === "pass" ? 0 : 1;
}

if (import.meta.main) await main();
