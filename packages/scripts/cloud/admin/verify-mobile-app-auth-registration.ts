/**
 * Release preflight for the server-owned first-party mobile App Auth client.
 * It proves the environment UUID resolves to a least-privilege app row before
 * deployment and can also verify the canonical public metadata endpoint after
 * the Worker is live. Database credentials are accepted only through env.
 */
import pg from "pg";

const { Client } = pg;

export const MOBILE_APP_AUTH_CLIENT_ID = "ai.elizaos.app";
export const MOBILE_APP_AUTH_REDIRECT_URI = "https://eliza.app/auth/callback";
export const MOBILE_APP_AUTH_REDIRECT_ORIGIN = "https://eliza.app";
export const MOBILE_APP_AUTH_SCOPE = "cloud:user";
export const MOBILE_APP_AUTH_CONFIG_MAX_BYTES = 16_384;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class MobileAppAuthPreflightError extends Error {
  override readonly name = "MobileAppAuthPreflightError";
}

export type MobileAppAuthDeploymentEnvironment = "staging" | "production";
export type MobileAppAuthFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface MobileAppAuthRegistrationRow {
  id: string;
  app_url: string;
  allowed_origins: unknown;
  is_active: boolean;
  is_approved: boolean;
  organization_exists: boolean;
  organization_is_active: boolean;
  creator_exists: boolean;
  creator_is_active: boolean;
  creator_matches_organization: boolean;
  creator_role: string | null;
  has_api_key_id: boolean;
  api_key_row_absent: boolean;
  api_key_row_revoked: boolean;
  api_key_ownership_matches: boolean;
  matching_active_approved_registration_count: number;
}

export type MobileAppAuthRegistrationQuery = (
  text: string,
  values: [appId: string, redirectUri: string],
) => Promise<{ rows: MobileAppAuthRegistrationRow[] }>;

const MOBILE_APP_AUTH_REGISTRATION_QUERY = `
WITH matching_registrations AS MATERIALIZED (
  SELECT duplicate.id
    FROM apps AS duplicate
   WHERE duplicate.is_active = TRUE
     AND duplicate.is_approved = TRUE
     AND duplicate.allowed_origins @> jsonb_build_array($2::text)
   LIMIT 2
)
SELECT app.id::text,
       app.app_url,
       app.allowed_origins,
       app.is_active,
       app.is_approved,
       organization.id IS NOT NULL AS organization_exists,
       COALESCE(organization.is_active, FALSE) AS organization_is_active,
       creator.id IS NOT NULL AS creator_exists,
       COALESCE(creator.is_active AND creator.deleted_at IS NULL, FALSE) AS creator_is_active,
       COALESCE(creator.organization_id = app.organization_id, FALSE) AS creator_matches_organization,
       creator.role AS creator_role,
       app.api_key_id IS NOT NULL AS has_api_key_id,
       generated_key.id IS NULL AS api_key_row_absent,
       COALESCE(NOT generated_key.is_active AND generated_key.deleted_at IS NOT NULL, FALSE)
         AS api_key_row_revoked,
       COALESCE(
         generated_key.organization_id = app.organization_id
           AND generated_key.user_id = app.created_by_user_id,
         FALSE
       ) AS api_key_ownership_matches,
       (SELECT count(*)::integer FROM matching_registrations)
         AS matching_active_approved_registration_count
  FROM apps AS app
  LEFT JOIN organizations AS organization ON organization.id = app.organization_id
  LEFT JOIN users AS creator ON creator.id = app.created_by_user_id
  LEFT JOIN api_keys AS generated_key ON generated_key.id = app.api_key_id
 WHERE app.id = $1::uuid
 LIMIT 1`;

interface MobileAppAuthConfigPayload {
  success: true;
  clientId: typeof MOBILE_APP_AUTH_CLIENT_ID;
  environment: MobileAppAuthDeploymentEnvironment;
  redirectUri: typeof MOBILE_APP_AUTH_REDIRECT_URI;
  codeChallengeMethod: "S256";
  scopes: [typeof MOBILE_APP_AUTH_SCOPE];
  app: {
    name: string;
    description: string | null;
    logoUrl: string | null;
    websiteUrl: string | null;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isBoundedNullableString(
  value: unknown,
  maxLength: number,
): value is string | null {
  return value === null || isBoundedString(value, maxLength);
}

function fail(message: string): never {
  throw new MobileAppAuthPreflightError(message);
}

function readEnvironmentVariable(name: string): string | undefined {
  return process.env[name];
}

export function requireMobileAppAuthAppId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail(
      "ELIZA_MOBILE_APP_AUTH_APP_ID must be a registered app UUID in the selected GitHub Environment",
    );
  }
  return value;
}

export function requireMobileAppAuthEnabled(value: unknown): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fail(
    "ELIZA_MOBILE_APP_AUTH_ENABLED must be exactly true or false in the selected GitHub Environment",
  );
}

export function requireMobileAppAuthEnvironment(
  value: unknown,
): MobileAppAuthDeploymentEnvironment {
  if (value !== "staging" && value !== "production") {
    return fail(
      "ELIZA_MOBILE_APP_AUTH_ENVIRONMENT must be exactly staging or production",
    );
  }
  return value;
}

function requireExactFirstPartyHttpsUrl(
  value: unknown,
  field: string,
  expected: string,
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty HTTPS URL`);
  }
  if (value.includes("*")) {
    fail(`${field} must not contain a wildcard`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // error-policy:J3 database registration URLs are untrusted operator input.
    fail(`${field} must be a valid HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    fail(`${field} must be an HTTPS URL without embedded credentials`);
  }
  if (parsed.origin !== MOBILE_APP_AUTH_REDIRECT_ORIGIN) {
    fail(
      `${field} must use the exact ${MOBILE_APP_AUTH_REDIRECT_ORIGIN} origin`,
    );
  }
  if (value !== expected) {
    fail(`${field} must be exactly ${expected}`);
  }
}

export function validateMobileAppAuthRegistrationRow(
  row: MobileAppAuthRegistrationRow | undefined,
  expectedAppId: string,
): void {
  if (!row) {
    fail(
      "ELIZA_MOBILE_APP_AUTH_APP_ID does not resolve to an apps registration",
    );
  }
  if (row.id !== expectedAppId) {
    fail(
      "The mobile App Auth registration did not match the configured app UUID",
    );
  }
  if (row.is_active !== true || row.is_approved !== true) {
    fail("The mobile App Auth registration must be active and approved");
  }

  requireExactFirstPartyHttpsUrl(
    row.app_url,
    "apps.app_url",
    MOBILE_APP_AUTH_REDIRECT_ORIGIN,
  );
  if (!Array.isArray(row.allowed_origins)) {
    fail("apps.allowed_origins must be a JSON array");
  }
  if (row.allowed_origins.length !== 1) {
    fail(
      "apps.allowed_origins must contain only the first-party mobile callback",
    );
  }
  requireExactFirstPartyHttpsUrl(
    row.allowed_origins[0],
    "apps.allowed_origins[0]",
    MOBILE_APP_AUTH_REDIRECT_URI,
  );

  if (!row.organization_exists || !row.organization_is_active) {
    fail(
      "The mobile App Auth registration organization must exist and be active",
    );
  }
  if (!row.creator_exists || !row.creator_is_active) {
    fail("The mobile App Auth registration creator must exist and be active");
  }
  if (!row.creator_matches_organization) {
    fail(
      "The mobile App Auth registration creator must belong to its organization",
    );
  }
  if (row.creator_role !== "owner" && row.creator_role !== "admin") {
    fail("The mobile App Auth registration creator must be an owner or admin");
  }
  if (!row.has_api_key_id) {
    fail(
      "The mobile App Auth registration must retain its generated key reference",
    );
  }
  if (
    !row.api_key_row_absent &&
    (!row.api_key_row_revoked || !row.api_key_ownership_matches)
  ) {
    fail(
      "The mobile App Auth registration generated key must be absent or revoked for the same owner",
    );
  }
  if (row.matching_active_approved_registration_count !== 1) {
    fail(
      "Exactly one active and approved app may claim the first-party mobile callback",
    );
  }
}

export async function queryMobileAppAuthRegistration(
  query: MobileAppAuthRegistrationQuery,
  appId: string,
): Promise<MobileAppAuthRegistrationRow | undefined> {
  const result = await query(MOBILE_APP_AUTH_REGISTRATION_QUERY, [
    appId,
    MOBILE_APP_AUTH_REDIRECT_URI,
  ]);
  return result.rows[0];
}

export function mobileAppAuthConfigUrl(
  environment: MobileAppAuthDeploymentEnvironment,
): URL {
  const apiOrigin =
    environment === "production"
      ? "https://api.elizacloud.ai"
      : "https://api-staging.elizacloud.ai";
  const url = new URL("/api/v1/app-auth/mobile/config", apiOrigin);
  url.searchParams.set("clientId", MOBILE_APP_AUTH_CLIENT_ID);
  url.searchParams.set("environment", environment);
  url.searchParams.set("redirectUri", MOBILE_APP_AUTH_REDIRECT_URI);
  return url;
}

export function validateMobileAppAuthConfigPayload(
  value: unknown,
  environment: MobileAppAuthDeploymentEnvironment,
): asserts value is MobileAppAuthConfigPayload {
  if (!isRecord(value)) {
    fail("The public mobile App Auth config response must be a JSON object");
  }
  const expectedTopLevelKeys = new Set([
    "success",
    "clientId",
    "environment",
    "redirectUri",
    "codeChallengeMethod",
    "scopes",
    "app",
  ]);
  if (
    Object.keys(value).some((key) => !expectedTopLevelKeys.has(key)) ||
    value.success !== true ||
    value.clientId !== MOBILE_APP_AUTH_CLIENT_ID ||
    value.environment !== environment ||
    value.redirectUri !== MOBILE_APP_AUTH_REDIRECT_URI ||
    value.codeChallengeMethod !== "S256" ||
    !Array.isArray(value.scopes) ||
    value.scopes.length !== 1 ||
    value.scopes[0] !== MOBILE_APP_AUTH_SCOPE
  ) {
    fail(
      "The public mobile App Auth config response is not the release contract",
    );
  }
  if (!isRecord(value.app)) {
    fail("The public mobile App Auth config response is missing app metadata");
  }
  const expectedAppKeys = new Set([
    "name",
    "description",
    "logoUrl",
    "websiteUrl",
  ]);
  if (
    Object.keys(value.app).some((key) => !expectedAppKeys.has(key)) ||
    !isBoundedString(value.app.name, 120) ||
    value.app.name.trim().length === 0 ||
    !isBoundedNullableString(value.app.description, 1_000) ||
    !isBoundedNullableString(value.app.logoUrl, 2_048) ||
    !isBoundedNullableString(value.app.websiteUrl, 2_048)
  ) {
    fail("The public mobile App Auth config response has invalid app metadata");
  }
}

export function validateDisabledMobileAppAuthConfigPayload(
  value: unknown,
): void {
  const expectedKeys = new Set([
    "success",
    "error",
    "errorDescription",
    "retryable",
  ]);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !expectedKeys.has(key)) ||
    value.success !== false ||
    value.error !== "server_configuration_error" ||
    value.errorDescription !==
      "Mobile App Auth is disabled for this environment" ||
    value.retryable !== false
  ) {
    fail(
      "The disabled mobile App Auth config response is not the release contract",
    );
  }
}

async function readBoundedJsonResponse(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      fail(
        "The public mobile App Auth config response has an invalid Content-Length",
      );
    }
    if (Number(contentLength) > MOBILE_APP_AUTH_CONFIG_MAX_BYTES) {
      fail("The public mobile App Auth config response exceeds the size limit");
    }
  }
  if (!response.body) {
    fail("The public mobile App Auth config response body is missing");
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MOBILE_APP_AUTH_CONFIG_MAX_BYTES) {
      await reader.cancel();
      fail("The public mobile App Auth config response exceeds the size limit");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    // error-policy:J3 the deployment probe treats non-UTF-8 bytes as invalid input.
    return fail(
      "The public mobile App Auth config response is not valid UTF-8",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // error-policy:J3 the deployment probe reports malformed JSON without fabricating data.
    return fail("The public mobile App Auth config response is not valid JSON");
  }
}

export async function verifyLiveMobileAppAuthConfig(
  environment: MobileAppAuthDeploymentEnvironment,
  fetchImpl: MobileAppAuthFetch = fetch,
  enabled = true,
): Promise<void> {
  const url = mobileAppAuthConfigUrl(environment);
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.url !== url.toString()) {
    fail("The public mobile App Auth config endpoint changed the final URL");
  }
  const expectedStatus = enabled ? 200 : 503;
  if (response.status !== expectedStatus) {
    fail(
      `The public mobile App Auth config endpoint returned HTTP ${response.status}`,
    );
  }
  if (response.headers.get("content-type") !== "application/json") {
    fail(
      "The public mobile App Auth config endpoint must return exactly application/json",
    );
  }
  if (response.headers.get("cache-control") !== "no-store") {
    fail(
      "The public mobile App Auth config endpoint must return exactly Cache-Control: no-store",
    );
  }
  const payload = await readBoundedJsonResponse(response);
  if (enabled) {
    validateMobileAppAuthConfigPayload(payload, environment);
  } else {
    validateDisabledMobileAppAuthConfigPayload(payload);
  }
}

async function closeDatabaseClient(client: pg.Client): Promise<void> {
  try {
    await client.end();
  } catch (error) {
    // error-policy:J2 database teardown failures remain redacted at the CLI boundary.
    throw new Error("Mobile App Auth database connection cleanup failed", {
      cause: error,
    });
  }
}

export async function verifyDatabaseMobileAppAuthRegistration(
  databaseUrl: string,
  appId: string,
): Promise<void> {
  let client: pg.Client | undefined;
  let row: MobileAppAuthRegistrationRow | undefined;

  try {
    const { enforceTlsForRemote } = await import(
      "@elizaos/cloud-shared/db/client"
    );
    const { url, ssl } = enforceTlsForRemote(databaseUrl);
    const connectedClient = new Client({
      connectionString: url,
      ...(ssl ? { ssl } : {}),
    });
    client = connectedClient;
    await connectedClient.connect();
    row = await queryMobileAppAuthRegistration(
      async (text, values) =>
        await connectedClient.query<MobileAppAuthRegistrationRow>(text, values),
      appId,
    );
  } catch (error) {
    // error-policy:J2 hide connection material while retaining the database cause.
    throw new Error("Mobile App Auth database registration preflight failed", {
      cause: error,
    });
  } finally {
    if (client) {
      await closeDatabaseClient(client);
    }
  }
  validateMobileAppAuthRegistrationRow(row, appId);
}

interface CliOptions {
  skipDatabase: boolean;
  verifyLive: boolean;
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = { skipDatabase: false, verifyLive: false };
  for (const arg of args) {
    if (arg === "--skip-database") {
      options.skipDatabase = true;
    } else if (arg === "--verify-live") {
      options.verifyLive = true;
    } else {
      return fail(`Unknown argument: ${arg}`);
    }
  }
  if (options.skipDatabase && !options.verifyLive) {
    return fail("--skip-database is valid only with --verify-live");
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const enabled = requireMobileAppAuthEnabled(
    readEnvironmentVariable("ELIZA_MOBILE_APP_AUTH_ENABLED"),
  );
  const appId = enabled
    ? requireMobileAppAuthAppId(
        readEnvironmentVariable("ELIZA_MOBILE_APP_AUTH_APP_ID"),
      )
    : undefined;

  if (enabled && !options.skipDatabase) {
    if (!appId) {
      fail("Enabled mobile App Auth preflight lost its registration UUID");
    }
    const databaseUrl = readEnvironmentVariable("DATABASE_URL");
    if (!databaseUrl) {
      fail("DATABASE_URL is required for the mobile App Auth preflight");
    }
    await verifyDatabaseMobileAppAuthRegistration(databaseUrl, appId);
    console.log("[MobileAppAuthPreflight] Database registration is valid.");
  } else if (!enabled) {
    console.log(
      "[MobileAppAuthPreflight] Mobile App Auth is explicitly disabled.",
    );
  }

  if (options.verifyLive) {
    const environment = requireMobileAppAuthEnvironment(
      readEnvironmentVariable("ELIZA_MOBILE_APP_AUTH_ENVIRONMENT"),
    );
    await verifyLiveMobileAppAuthConfig(environment, fetch, enabled);
    console.log(
      `[MobileAppAuthPreflight] ${environment} public config is valid.`,
    );
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // error-policy:J1 CLI boundary reports a redacted failure and exits non-zero.
    const message =
      error instanceof Error ? error.message : "Unknown preflight failure";
    console.error(`[MobileAppAuthPreflight] ${message}`);
    process.exitCode = 1;
  });
}
