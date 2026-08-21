/**
 * Drives native and legacy App Auth through real Hono routes, Drizzle
 * repositories, PGlite transactions, field encryption, and API-key auth.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "@/types/cloud-worker-env";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.ELIZA_KMS_BACKEND = "memory";
process.env.CACHE_BACKEND = "memory";
process.env.CACHE_ENABLED = "true";
delete process.env.ENVIRONMENT;

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORGANIZATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLIENT_ID = "ai.elizaos.app";
const REDIRECT_URI = "https://eliza.app/auth/callback";
const LEGACY_REDIRECT_URI = "https://legacy.example/callback";
const STATE = "state_abcdefghijklmnopqrstuvwxyz0123456789-._~";
const VERIFIER = "verifier_abcdefghijklmnopqrstuvwxyz0123456789-._~";

const interactiveUser = {
  id: USER_ID,
  organization_id: ORGANIZATION_ID,
  organization: {
    id: ORGANIZATION_ID,
    name: "Mobile auth test organization",
    is_active: true,
  },
  is_active: true,
  role: "owner",
};

const requireUserWithOrg = mock(async () => interactiveUser);
const requireUserOrApiKey = mock(async () => interactiveUser);
const requireUserOrApiKeyWithOrg = mock(async () => interactiveUser);

const authActual = await import("@/lib/auth/workers-hono-auth");
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...authActual,
  requireUserOrApiKey,
  requireUserOrApiKeyWithOrg,
  requireUserWithOrg,
}));

const [
  { default: connectRoute },
  { default: configRoute },
  { default: tokenRoute },
  { default: ackRoute },
  { default: currentCredentialRoute },
  { default: apiKeysRoute },
  { default: apiKeyRoute },
  { default: regenerateApiKeyRoute },
] = await Promise.all([
  import("../connect/route"),
  import("./config/route"),
  import("./token/route"),
  import("./ack/route"),
  import("../../api-keys/current/route"),
  import("../../api-keys/route"),
  import("../../api-keys/[id]/route"),
  import("../../api-keys/[id]/regenerate/route"),
]);

const { failureResponse } = await import("@/lib/api/cloud-worker-errors");
const { consumeAppAuthCode } = await import("@/lib/services/app-auth-codes");
const mobileAppAuth = await import("@/lib/services/mobile-app-auth");
const { apiKeysService } = await import("@/lib/services/api-keys");
const { apiKeysRepository } = await import("@/db/repositories/api-keys");
const { resetKmsClientForTests } = await import("@/db/crypto/kms-client");
const { closeDatabaseConnectionsForTests, dbWrite } = await import(
  "@/db/client"
);

const app = new Hono<AppEnv>();
app.route("/api/v1/app-auth/connect", connectRoute);
app.route("/api/v1/app-auth/mobile/config", configRoute);
app.route("/api/v1/app-auth/mobile/token", tokenRoute);
app.route("/api/v1/app-auth/mobile/ack", ackRoute);
app.route("/api/v1/api-keys/current", currentCredentialRoute);
app.route("/api/v1/api-keys", apiKeysRoute);
app.route("/api/v1/api-keys/:id", apiKeyRoute);
app.route("/api/v1/api-keys/:id/regenerate", regenerateApiKeyRoute);
app.get("/api/auth-probe", async (c) => {
  try {
    const credential = await authActual.requireApiKeyCredential(c);
    return c.json({
      success: true,
      credentialId: credential.id,
      sourceAppId: credential.source_app_id,
    });
  } catch (error) {
    // error-policy:J1 The test probe mirrors a real route's HTTP auth boundary.
    return failureResponse(c, error);
  }
});

// The mounted routes never touch object storage, but Hono's production binding
// type requires a complete R2 shape at every request boundary.
const unusedBlobBinding: Bindings["BLOB"] = {
  get: async () => null,
  put: async () => undefined,
  delete: async () => undefined,
};

const runtimeEnv: Bindings & { MOCK_REDIS: string } = {
  DATABASE_URL: "pglite://memory",
  BLOB: unusedBlobBinding,
  ENVIRONMENT: "staging",
  ELIZA_MOBILE_APP_AUTH_APP_ID: APP_ID,
  ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
  // Exercises the real limiter with its explicit repository-owned test backend.
  MOCK_REDIS: "1",
};

async function executeStatements(statements: string[]): Promise<void> {
  for (const statement of statements) await dbWrite.execute(statement);
}

async function requestJson(
  path: string,
  method: "DELETE" | "PATCH" | "POST",
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await app.request(
    path,
    {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    runtimeEnv,
  );
}

async function responseObject(
  response: Response,
): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function countRows(
  table: "api_keys" | "app_users" | "auth_events" | "mobile_app_auth_grants",
) {
  const result = await dbWrite.execute(
    `SELECT count(*)::int AS count FROM ${table}`,
  );
  return Number(result.rows[0]?.count);
}

beforeAll(async () => {
  await executeStatements([
    `CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      is_active boolean NOT NULL DEFAULT true
    )`,
    `CREATE TABLE users (
      id uuid PRIMARY KEY,
      organization_id uuid,
      is_active boolean NOT NULL DEFAULT true
    )`,
    `CREATE TABLE apps (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      description text,
      slug text NOT NULL UNIQUE,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      created_by_user_id uuid NOT NULL REFERENCES users(id),
      app_url text NOT NULL,
      allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb,
      api_key_id uuid,
      total_users integer NOT NULL DEFAULT 0,
      logo_url text,
      website_url text,
      is_active boolean NOT NULL DEFAULT true,
      is_approved boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE app_users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      signup_source text,
      referral_code_used text,
      ip_address text,
      user_agent text,
      total_requests integer NOT NULL DEFAULT 0,
      total_credits_used numeric(10, 2) DEFAULT '0.00',
      first_seen_at timestamp NOT NULL DEFAULT now(),
      last_seen_at timestamp NOT NULL DEFAULT now(),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE(app_id, user_id)
    )`,
    `CREATE TABLE managed_domains (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      domain text NOT NULL,
      app_id uuid REFERENCES apps(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'pending',
      verified boolean NOT NULL DEFAULT false
    )`,
    `CREATE TABLE api_keys (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      description text,
      key_hash text NOT NULL UNIQUE,
      key_prefix text NOT NULL,
      key_ciphertext text,
      key_nonce text,
      key_auth_tag text,
      key_kms_key_id text,
      key_kms_key_version integer,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      user_id uuid NOT NULL REFERENCES users(id),
      source_app_id uuid,
      rate_limit integer NOT NULL DEFAULT 1000,
      is_active boolean NOT NULL DEFAULT true,
      usage_count integer NOT NULL DEFAULT 0,
      expires_at timestamp,
      last_used_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(),
      deleted_at timestamp
    )`,
    `CREATE TABLE mobile_app_auth_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code_hash text NOT NULL UNIQUE,
      app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      client_id text NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      environment text NOT NULL,
      device_name text,
      redirect_uri text NOT NULL,
      state_hash text NOT NULL,
      code_challenge text NOT NULL,
      code_challenge_method text NOT NULL,
      scopes jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      credential_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
      expires_at timestamptz NOT NULL,
      exchanged_at timestamptz,
      acknowledged_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE auth_events (
      event_id uuid PRIMARY KEY,
      ts timestamptz NOT NULL DEFAULT now(),
      actor_type text NOT NULL,
      actor_id text NOT NULL,
      action text NOT NULL,
      result text NOT NULL,
      resource_type text,
      resource_id text,
      ip text,
      ua text,
      request_id text,
      org_id text,
      metadata jsonb,
      expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 years')
    )`,
  ]);
}, 60_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

beforeEach(async () => {
  requireUserWithOrg.mockClear();
  requireUserOrApiKey.mockClear();
  resetKmsClientForTests();
  await executeStatements([
    "DELETE FROM auth_events",
    "DELETE FROM app_users",
    "DELETE FROM mobile_app_auth_grants",
    "DELETE FROM api_keys",
    "DELETE FROM managed_domains",
    "DELETE FROM apps",
    "DELETE FROM users",
    "DELETE FROM organizations",
    `INSERT INTO organizations (id, is_active)
     VALUES ('${ORGANIZATION_ID}', true)`,
    `INSERT INTO users (id, organization_id, is_active)
     VALUES ('${USER_ID}', '${ORGANIZATION_ID}', true)`,
    `INSERT INTO apps (
       id, name, description, slug, organization_id, created_by_user_id,
       app_url, allowed_origins, logo_url, website_url, is_active, is_approved
     ) VALUES (
       '${APP_ID}', 'Eliza mobile', 'First-party native app', 'eliza-mobile',
       '${ORGANIZATION_ID}', '${USER_ID}', '${REDIRECT_URI}',
       '["${REDIRECT_URI}","${LEGACY_REDIRECT_URI}"]'::jsonb,
       'https://eliza.app/logo.png', 'https://eliza.app', true, true
     )`,
  ]);
});

describe("mobile App Auth real HTTP lifecycle", () => {
  test("explicit incident mode keeps the public mobile surface fail closed", async () => {
    const configQuery = new URLSearchParams({
      clientId: CLIENT_ID,
      environment: "staging",
      redirectUri: REDIRECT_URI,
    });
    const response = await app.request(
      `/api/v1/app-auth/mobile/config?${configQuery}`,
      {},
      {
        ...runtimeEnv,
        ELIZA_MOBILE_APP_AUTH_APP_ID: "",
        ELIZA_MOBILE_APP_AUTH_ENABLED: "false",
      },
    );
    expect(response.status).toBe(503);
    const responseBody: unknown = await response.json();
    expect(responseBody).toEqual({
      success: false,
      error: "server_configuration_error",
      errorDescription: "Mobile App Auth is disabled for this environment",
      retryable: false,
    });
  });

  test("config, approval, exchange, acknowledgement, auth, and exact revoke share one durable credential", async () => {
    const configQuery = new URLSearchParams({
      clientId: CLIENT_ID,
      environment: "staging",
      redirectUri: REDIRECT_URI,
    });
    const configResponse = await app.request(
      `/api/v1/app-auth/mobile/config?${configQuery}`,
      {},
      runtimeEnv,
    );
    expect(configResponse.status).toBe(200);
    const config = (await configResponse.json()) as Record<string, unknown>;
    expect(config).toMatchObject({
      success: true,
      clientId: CLIENT_ID,
      environment: "staging",
      redirectUri: REDIRECT_URI,
      codeChallengeMethod: "S256",
      scopes: ["cloud:user"],
    });
    expect(JSON.stringify(config)).not.toContain(APP_ID);

    const codeChallenge =
      mobileAppAuth.deriveMobileAppAuthS256Challenge(VERIFIER);
    const connectResponse = await requestJson(
      "/api/v1/app-auth/connect",
      "POST",
      {
        flow: "mobile_pkce",
        clientId: CLIENT_ID,
        environment: "staging",
        redirectUri: REDIRECT_URI,
        state: STATE,
        codeChallenge,
        codeChallengeMethod: "S256",
        deviceName: "Simulator iPhone",
      },
      { "user-agent": "Eliza-iOS-integration-test" },
    );
    expect(connectResponse.status).toBe(200);
    const approval = (await connectResponse.json()) as Record<string, unknown>;
    expect(approval).toMatchObject({
      success: true,
      codeType: "mobile_app_auth_code",
      expiresIn: 300,
    });
    expect(typeof approval.code).toBe("string");
    const code = String(approval.code);
    expect(code).toMatch(/^emac_[0-9a-f]{64}$/);
    expect(requireUserWithOrg).toHaveBeenCalledTimes(1);
    expect(requireUserOrApiKey).not.toHaveBeenCalled();
    expect(await countRows("app_users")).toBe(1);
    expect(await countRows("mobile_app_auth_grants")).toBe(1);
    expect(await countRows("api_keys")).toBe(0);

    const tokenRequest = {
      grantType: "authorization_code",
      clientId: CLIENT_ID,
      environment: "staging",
      redirectUri: REDIRECT_URI,
      state: STATE,
      code,
      codeVerifier: VERIFIER,
    };
    const tokenResponse = await requestJson(
      "/api/v1/app-auth/mobile/token",
      "POST",
      tokenRequest,
    );
    expect(tokenResponse.status).toBe(200);
    const exchange = (await tokenResponse.json()) as Record<string, unknown>;
    expect(exchange).toMatchObject({
      success: true,
      acknowledgementRequired: true,
      tokenType: "Bearer",
      scopes: ["cloud:user"],
    });
    expect(String(exchange.secret)).toMatch(/^eliza_mobile_[0-9a-f]{64}$/);
    expect(String(exchange.credentialId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
    );
    const secret = String(exchange.secret);
    const credentialId = String(exchange.credentialId);

    const inactiveCredential = await apiKeysRepository.findById(credentialId);
    expect(inactiveCredential).toMatchObject({
      id: credentialId,
      is_active: false,
      source_app_id: APP_ID,
    });
    expect(await apiKeysService.validateApiKey(secret)).toBeNull();

    const tokenRetry = await requestJson(
      "/api/v1/app-auth/mobile/token",
      "POST",
      tokenRequest,
    );
    expect(tokenRetry.status).toBe(200);
    expect(await responseObject(tokenRetry)).toEqual(exchange);
    expect(await countRows("api_keys")).toBe(1);

    const acknowledgementRequest = {
      clientId: CLIENT_ID,
      environment: "staging",
      redirectUri: REDIRECT_URI,
      state: STATE,
      code,
      codeVerifier: VERIFIER,
      credentialId,
      secret,
    };
    const acknowledgementResponse = await requestJson(
      "/api/v1/app-auth/mobile/ack",
      "POST",
      acknowledgementRequest,
    );
    expect(acknowledgementResponse.status).toBe(200);
    const acknowledgement = (await acknowledgementResponse.json()) as Record<
      string,
      unknown
    >;
    expect(acknowledgement).toMatchObject({
      success: true,
      credentialId,
      status: "acknowledged",
    });

    const acknowledgementRetry = await requestJson(
      "/api/v1/app-auth/mobile/ack",
      "POST",
      acknowledgementRequest,
    );
    expect(acknowledgementRetry.status).toBe(200);
    expect(await responseObject(acknowledgementRetry)).toEqual(acknowledgement);

    const authResponse = await app.request(
      "/api/auth-probe",
      { headers: { authorization: `Bearer ${secret}` } },
      runtimeEnv,
    );
    expect(authResponse.status).toBe(200);
    expect(await responseObject(authResponse)).toEqual({
      success: true,
      credentialId,
      sourceAppId: APP_ID,
    });

    const genericList = await app.request("/api/v1/api-keys", {}, runtimeEnv);
    expect(genericList.status).toBe(200);
    expect(await responseObject(genericList)).toEqual({ keys: [] });
    for (const mutation of [
      await requestJson(
        `/api/v1/api-keys/${credentialId}`,
        "PATCH",
        { is_active: false, expires_at: null },
        { authorization: `Bearer ${secret}` },
      ),
      await requestJson(
        `/api/v1/api-keys/${credentialId}`,
        "DELETE",
        undefined,
        { authorization: `Bearer ${secret}` },
      ),
      await requestJson(
        `/api/v1/api-keys/${credentialId}/regenerate`,
        "POST",
        undefined,
        { authorization: `Bearer ${secret}` },
      ),
    ]) {
      expect(mutation.status).toBe(404);
      expect(await responseObject(mutation)).toEqual({
        error: "API key not found",
      });
    }
    expect(await apiKeysRepository.findById(credentialId)).toMatchObject({
      is_active: true,
      source_app_id: APP_ID,
    });

    const revokeResponse = await requestJson(
      "/api/v1/api-keys/current",
      "DELETE",
      undefined,
      { authorization: `Bearer ${secret}` },
    );
    expect(revokeResponse.status).toBe(200);
    const receipt = (await revokeResponse.json()) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      success: true,
      credentialId,
      status: "revoked",
    });
    expect(Number.isFinite(Date.parse(String(receipt.revokedAt)))).toBe(true);
    const auditEvent = await dbWrite.execute(
      "SELECT actor_id, action, result, resource_id, org_id, metadata FROM auth_events",
    );
    expect(auditEvent.rows).toEqual([
      expect.objectContaining({
        actor_id: USER_ID,
        action: "api_key.revoke",
        result: "success",
        resource_id: credentialId,
        org_id: ORGANIZATION_ID,
        metadata: {
          key_id: credentialId,
          reason: "credential_self_revoke",
        },
      }),
    ]);

    const tombstone = await apiKeysRepository.findById(credentialId);
    expect(tombstone).toMatchObject({
      id: credentialId,
      is_active: false,
      source_app_id: APP_ID,
      key_ciphertext: null,
    });
    expect(tombstone?.deleted_at).toBeInstanceOf(Date);

    const responseLossRetry = await requestJson(
      "/api/v1/api-keys/current",
      "DELETE",
      undefined,
      { authorization: `Bearer ${secret}` },
    );
    expect(responseLossRetry.status).toBe(200);
    expect(await responseObject(responseLossRetry)).toEqual(receipt);
    expect(await countRows("auth_events")).toBe(1);
  }, 60_000);

  test("ordinary API keys keep authenticating and cannot enter mobile self-revocation", async () => {
    const generated = apiKeysService.generateApiKey();
    expect(generated.key).toMatch(/^eliza_[0-9a-f]{64}$/);
    expect(generated.key.startsWith("eliza_mobile_")).toBe(false);
    const ordinaryId = randomUUID();
    await apiKeysRepository.create({
      id: ordinaryId,
      name: "Unchanged ordinary API key",
      key_hash: generated.hash,
      key_prefix: generated.prefix,
      organization_id: ORGANIZATION_ID,
      user_id: USER_ID,
      source_app_id: null,
      is_active: true,
      expires_at: new Date(Date.now() + 60_000),
    });

    const authResponse = await app.request(
      "/api/auth-probe",
      { headers: { "x-api-key": generated.key } },
      runtimeEnv,
    );
    const authBody = await responseObject(authResponse);
    expect({ status: authResponse.status, body: authBody }).toEqual({
      status: 200,
      body: {
        success: true,
        credentialId: ordinaryId,
        sourceAppId: null,
      },
    });

    const mobileOnlyRevoke = await requestJson(
      "/api/v1/api-keys/current",
      "DELETE",
      undefined,
      { "x-api-key": generated.key },
    );
    expect(mobileOnlyRevoke.status).toBe(401);
    expect(await mobileOnlyRevoke.json()).toMatchObject({
      success: false,
      code: "authentication_required",
    });
    expect(await apiKeysRepository.findById(ordinaryId)).toMatchObject({
      id: ordinaryId,
      is_active: true,
      deleted_at: null,
      source_app_id: null,
    });
    expect(await countRows("auth_events")).toBe(0);
  });

  test("the legacy connect body still returns a consumable legacy code without mobile side effects", async () => {
    const response = await requestJson(
      "/api/v1/app-auth/connect",
      "POST",
      { appId: APP_ID, redirectUri: LEGACY_REDIRECT_URI },
      {
        "x-forwarded-for": "203.0.113.7",
        "user-agent": "legacy-web-client",
      },
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      success: true,
      codeType: "app_auth_code",
      expiresIn: 300,
    });
    expect(String(payload.code)).toMatch(/^eac_[0-9a-f]{64}$/);
    expect(requireUserOrApiKey).toHaveBeenCalledTimes(1);
    expect(requireUserWithOrg).not.toHaveBeenCalled();
    expect(await countRows("app_users")).toBe(1);
    expect(await countRows("mobile_app_auth_grants")).toBe(0);
    expect(await countRows("api_keys")).toBe(0);

    const consumed = await consumeAppAuthCode(String(payload.code));
    expect(consumed).toMatchObject({ appId: APP_ID, userId: USER_ID });
    expect(await consumeAppAuthCode(String(payload.code))).toBeNull();
  });
});
