/**
 * Proves the inference API-key boundary resolves key, user, and organization
 * with one primary statement on PGlite (#30724) while keeping every credential
 * and account rejection, its error class, message, and ordering.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
setDefaultTimeout(120_000);

import { closeDatabaseConnectionsForTests, getPgliteClientForTests } from "../../db/client";
import { apiKeys } from "../../db/schemas/api-keys";
import { userModerationStatus } from "../../db/schemas/moderation-violations";
import { organizations } from "../../db/schemas/organizations";
import { users } from "../../db/schemas/users";
import { AuthenticationError, ForbiddenError } from "../api/errors";
import { mintStewardTokenFromClaims } from "../auth/steward-client";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import { requireInferenceApiKeyWithOrg } from "./inference-api-key-auth";
import { type InferenceAuthTelemetry, resolveInferenceAuthContext } from "./inference-auth-context";

const ORG = "81000000-0000-4000-8000-000000000001";
const INACTIVE_ORG = "81000000-0000-4000-8000-000000000002";
const USER = "82000000-0000-4000-8000-000000000001";
const INACTIVE_USER = "82000000-0000-4000-8000-000000000002";
const ORGLESS_USER = "82000000-0000-4000-8000-000000000003";
const INACTIVE_ORG_USER = "82000000-0000-4000-8000-000000000004";
const MISSING_USER = "82000000-0000-4000-8000-000000000009";

/** Schema-derived table without constraints; rows below supply every value read. */
async function createTable(table: PgTable): Promise<void> {
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => {
    const type = "enumValues" in column && column.enumValues ? "text" : column.getSQLType();
    return `"${column.name}" ${type}`;
  });
  await getPgliteClientForTests().exec(`CREATE TABLE "${config.name}" (${columns.join(", ")})`);
}

let keySequence = 0;
async function seedKey(values: {
  userId: string;
  organizationId: string;
  isActive?: boolean;
  deleted?: boolean;
  expired?: boolean;
}): Promise<string> {
  keySequence += 1;
  const rawKey = `eliza_test_inference_key_${keySequence}`;
  await getPgliteClientForTests().query(
    `INSERT INTO api_keys(id, name, key_hash, key_prefix, organization_id, user_id, is_active,
       deleted_at, expires_at, usage_count, rate_limit, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'eliza_te', $3, $4, $5, $6, $7, 0, 1000, now(), now())`,
    [
      `key-${keySequence}`,
      createHash("sha256").update(rawKey).digest("hex"),
      values.organizationId,
      values.userId,
      values.isActive ?? true,
      values.deleted ? new Date() : null,
      values.expired ? new Date(Date.now() - 60_000) : null,
    ],
  );
  return rawKey;
}

beforeAll(async () => {
  await createTable(organizations);
  await createTable(users);
  await createTable(apiKeys);
  await createTable(userModerationStatus);
  const db = getPgliteClientForTests();
  await db.query(
    `INSERT INTO organizations(id, name, slug, credit_balance, is_active)
     VALUES ($1, 'Active org', 'active-org', '5.000000', true),
            ($2, 'Inactive org', 'inactive-org', '5.000000', false)`,
    [ORG, INACTIVE_ORG],
  );
  await db.query(
    `INSERT INTO users(id, organization_id, is_active)
     VALUES ($1, $5, true), ($2, $5, false), ($3, NULL, true), ($4, $6, true)`,
    [USER, INACTIVE_USER, ORGLESS_USER, INACTIVE_ORG_USER, ORG, INACTIVE_ORG],
  );
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function rejection(rawKey: string) {
  const reasons: string[] = [];
  const identityLookups: number[] = [];
  const error = await requireInferenceApiKeyWithOrg(rawKey, {
    rejected: (reason) => reasons.push(reason),
    timing: { identityLookup: (durationMs) => identityLookups.push(durationMs) },
  }).then(
    () => null,
    (caught: unknown) => caught,
  );
  return { error, reasons, identityLookups };
}

describe("inference API-key identity", () => {
  test("one primary statement returns the key, user, and organization", async () => {
    const rawKey = await seedKey({ userId: USER, organizationId: ORG });
    const identityLookups: number[] = [];
    const result = await requireInferenceApiKeyWithOrg(rawKey, {
      timing: { identityLookup: (durationMs) => identityLookups.push(durationMs) },
    });
    expect(result.authMethod).toBe("api_key");
    expect(result.apiKey.user_id).toBe(USER);
    expect(result.user.id).toBe(USER);
    expect(result.user.organization_id).toBe(ORG);
    expect(result.user.organization).toMatchObject({ id: ORG, is_active: true });
    expect(result.user.organization.credit_balance).toBe("5.000000");
    // The combined read is timed once, not as separate key and user hops.
    expect(identityLookups).toHaveLength(1);
  });

  test("credential rejections keep their classes, messages, and reasons", async () => {
    const unknown = await rejection("eliza_test_inference_key_unknown");
    expect(unknown.error).toBeInstanceOf(AuthenticationError);
    expect((unknown.error as Error).message).toBe("Invalid or expired API key");
    expect(unknown.reasons).toEqual(["credential_invalid"]);
    expect(unknown.identityLookups).toHaveLength(1);

    const deleted = await rejection(
      await seedKey({ userId: USER, organizationId: ORG, deleted: true }),
    );
    expect(deleted.error).toBeInstanceOf(AuthenticationError);
    expect((deleted.error as Error).message).toBe("Invalid or expired API key");
    expect(deleted.reasons).toEqual(["credential_invalid"]);

    const expired = await rejection(
      await seedKey({ userId: USER, organizationId: ORG, expired: true }),
    );
    expect(expired.error).toBeInstanceOf(AuthenticationError);
    expect((expired.error as Error).message).toBe("API key has expired");
    expect(expired.reasons).toEqual(["credential_invalid"]);

    const inactive = await rejection(
      await seedKey({ userId: USER, organizationId: ORG, isActive: false }),
    );
    expect(inactive.error).toBeInstanceOf(ForbiddenError);
    expect((inactive.error as Error).message).toBe("API key is inactive");
    expect(inactive.reasons).toEqual(["credential_inactive"]);
  });

  test("account rejections keep their order after credential checks", async () => {
    const missing = await rejection(await seedKey({ userId: MISSING_USER, organizationId: ORG }));
    expect(missing.error).toBeInstanceOf(AuthenticationError);
    expect((missing.error as Error).message).toBe("User associated with API key not found");
    expect(missing.reasons).toEqual(["membership_missing"]);

    const inactiveUser = await rejection(
      await seedKey({ userId: INACTIVE_USER, organizationId: ORG }),
    );
    expect(inactiveUser.error).toBeInstanceOf(ForbiddenError);
    expect((inactiveUser.error as Error).message).toBe("User account is inactive");
    expect(inactiveUser.reasons).toEqual(["account_inactive"]);

    const orgless = await rejection(await seedKey({ userId: ORGLESS_USER, organizationId: ORG }));
    expect(orgless.error).toBeInstanceOf(ForbiddenError);
    expect(orgless.reasons).toEqual(["membership_missing"]);

    const inactiveOrg = await rejection(
      await seedKey({ userId: INACTIVE_ORG_USER, organizationId: INACTIVE_ORG }),
    );
    expect(inactiveOrg.error).toBeInstanceOf(ForbiddenError);
    expect((inactiveOrg.error as Error).message).toBe("Organization is inactive");
    expect(inactiveOrg.reasons).toEqual(["organization_inactive"]);

    // An inactive key on an inactive account still reports the key first.
    const both = await rejection(
      await seedKey({ userId: INACTIVE_USER, organizationId: ORG, isActive: false }),
    );
    expect(both.reasons).toEqual(["credential_inactive"]);
  });
});

describe("mobile credentials on the Worker inference boundary", () => {
  const qualifiedBindings = {
    INFERENCE_AUTH_CACHE_ENABLED: "true",
    INFERENCE_STRONG_REVOCATION_ENABLED: "true",
    INFERENCE_ADMISSION_GATES: {
      getByName() {
        return {
          async fetch() {
            return Response.json({ allowed: true });
          },
        };
      },
    },
  };
  function qualifiedResolve(
    request: Request,
    options?: Parameters<typeof resolveInferenceAuthContext>[1],
  ) {
    return runWithCloudBindings(qualifiedBindings, () =>
      resolveInferenceAuthContext(request, options),
    );
  }
  async function mobileKey(
    overrides: {
      active?: boolean;
      deleted?: boolean;
      expires?: Date | null;
      app?: string | null;
    } = {},
  ) {
    const rawKey = `eliza_mobile_${randomBytes(32).toString("hex")}`;
    await getPgliteClientForTests().query(
      `INSERT INTO api_keys(id,name,key_hash,key_prefix,organization_id,user_id,is_active,deleted_at,expires_at,source_app_id,usage_count,rate_limit,created_at,updated_at)
       VALUES(gen_random_uuid(),'mobile-test',$1,'eliza_mobile_',$2,$3,$4,$5,$6,$7,0,1000,now(),now())`,
      [
        createHash("sha256").update(rawKey).digest("hex"),
        ORG,
        USER,
        overrides.active ?? true,
        overrides.deleted ? new Date() : null,
        overrides.expires === undefined ? new Date(Date.now() + 60000) : overrides.expires,
        overrides.app === undefined ? "83000000-0000-4000-8000-000000000001" : overrides.app,
      ],
    );
    return rawKey;
  }
  function request(key: string) {
    return new Request("https://api.eliza.app/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
    });
  }
  // Mobile lifecycle keys share the combined cache: their revocations
  // invalidate the same key-hash entry. A Worker request therefore never
  // resolves them inline from the primary; the authoritative decision is
  // hydrated under `waitUntil` (covered end to end, with a primary tripwire,
  // in inference-auth-hot-path.pglite.test.ts).
  test("active mobile key on a Worker cold miss returns warming instead of an inline primary read", async () => {
    const key = await mobileKey();
    let trace: InferenceAuthTelemetry | undefined;
    const result = await qualifiedResolve(request(key), {
      cacheOnly: true,
      deferStrongCredentialCheck: true,
      executionCtx: { waitUntil() {} },
      onTelemetry(value) {
        trace = value;
      },
    });
    expect(result.kind).toBe("warming");
    expect(trace?.authoritative).toBe("not_run");
    expect(trace?.timings.identityLookupMs).toBeNull();
  });
  test("Worker chat answers a cold mobile key with the retryable warming shape and still rejects generic callers", async () => {
    const { handleChatCompletionsPOST } = await import("../../../../api/v1/chat/completions/route");
    const key = await mobileKey();
    const send = async (token: string) => {
      const deferred: Promise<unknown>[] = [];
      const response = await runWithCloudBindings(qualifiedBindings, () =>
        handleChatCompletionsPOST(
          new Request("https://api.eliza.app/api/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: "{}",
          }),
          {
            skipOrgRateLimit: true,
            executionCtx: {
              waitUntil(task) {
                deferred.push(task);
              },
            },
          },
        ),
      );
      await Promise.allSettled(deferred);
      return response;
    };
    const warming = await send(key);
    expect(warming.status).toBe(503);
    expect(warming.headers.get("Retry-After")).toBe("1");
    expect((await warming.json()).error.code).toBe("auth_cache_warming");
    const refused = await send("unrecognized-credential");
    expect(refused.status).toBe(401);
    expect((await refused.json()).error.code).toBe("authentication_required");
  });
  test("pending, expired, revoked and unbound mobile credentials never authorize", async () => {
    for (const state of [
      { active: false },
      { deleted: true },
      { expires: new Date(Date.now() - 1000) },
      { expires: null },
      { app: null },
    ]) {
      const key = await mobileKey(state);
      // The authoritative decision (what Worker hydration projects) rejects.
      await expect(resolveInferenceAuthContext(request(key))).rejects.toBeInstanceOf(Error);
      // A Worker request never authorizes a credential it has not cached.
      const worker = await qualifiedResolve(request(key), {
        cacheOnly: true,
        executionCtx: { waitUntil() {} },
      });
      expect(worker.kind).not.toBe("authorized");
    }
  });
  test("a non-API-key caller retains the generic slow path", async () => {
    const result = await qualifiedResolve(request("unrecognized-credential"), {
      cacheOnly: true,
      executionCtx: { waitUntil() {} },
    });
    expect(result).toEqual({ kind: "slow_path", reason: "non_api_key" });
  });
});

describe("verified bootstrap credential metadata", () => {
  const bindings = {
    INFERENCE_AUTH_CACHE_ENABLED: "false",
    INFERENCE_STRONG_REVOCATION_ENABLED: "false",
    STEWARD_SESSION_SECRET: "synthetic-bootstrap-secret-".repeat(3),
  };
  function request(token: string) {
    return new Request("https://api.eliza.app/api/v1/voice/speech/session", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  async function resolve(token: string, includeVerifiedCredential = true) {
    return await runWithCloudBindings(bindings, () =>
      resolveInferenceAuthContext(request(token), { includeVerifiedCredential }),
    );
  }
  async function rejectAtStrongBoundary(token: string, reason: string) {
    const checks: Record<string, unknown>[] = [];
    try {
      return await runWithCloudBindings(
        {
          ...bindings,
          INFERENCE_STRONG_REVOCATION_ENABLED: "true",
          INFERENCE_ADMISSION_GATES: {
            getByName(organizationId: string) {
              expect(organizationId).toBe(ORG);
              return {
                async fetch(req: Request) {
                  expect(new URL(req.url).pathname).toBe("/credential/check");
                  checks.push((await req.json()) as Record<string, unknown>);
                  return Response.json({ allowed: false, reason }, { status: 403 });
                },
              };
            },
          },
        },
        () => resolveInferenceAuthContext(request(token), { includeVerifiedCredential: true }),
      );
    } finally {
      expect(checks).toHaveLength(1);
      expect(JSON.stringify(checks)).not.toContain(token);
    }
  }
  test("API-key metadata requires ordinary authorization and does not enable caching", async () => {
    const key = await seedKey({ userId: USER, organizationId: ORG });
    const ordinary = await resolve(key, false);
    expect(ordinary.kind).toBe("authorized");
    expect("credential" in ordinary).toBe(false);
    let trace: InferenceAuthTelemetry | undefined;
    const included = await runWithCloudBindings(bindings, () =>
      resolveInferenceAuthContext(request(key), {
        includeVerifiedCredential: true,
        onTelemetry(value) {
          trace = value;
        },
      }),
    );
    expect(included.kind).toBe("authorized");
    if (included.kind !== "authorized") throw Error("Expected verified API key");
    expect(included.credential).toEqual({
      kind: "api_key",
      credentialId: included.ctx.apiKeyId,
      userId: USER,
      rateLimit: 1000,
      expiresAt: null,
    });
    expect(JSON.stringify(included.credential)).not.toContain(key);
    expect(trace?.cacheRead).toBe("not_run");
    expect(trace?.cacheWrite).toBe("not_run");
    expect(await rejectAtStrongBoundary(key, "credential_revoked")).toMatchObject({
      kind: "rejected",
      status: 401,
    });
    for (const values of [
      { userId: USER, organizationId: ORG, isActive: false },
      { userId: USER, organizationId: ORG, deleted: true },
      { userId: USER, organizationId: ORG, expired: true },
      { userId: INACTIVE_USER, organizationId: ORG },
      { userId: INACTIVE_ORG_USER, organizationId: INACTIVE_ORG },
    ]) {
      await expect(resolve(await seedKey(values))).rejects.toBeInstanceOf(Error);
    }
  });
  test("signed session metadata uses verified subject and issue time while revoked standing is denied", async () => {
    const subject = "synthetic-bootstrap-steward";
    await getPgliteClientForTests().query("UPDATE users SET steward_user_id=$1 WHERE id=$2", [
      subject,
      USER,
    ]);
    const issuedAt = Math.floor(Date.now() / 1000);
    const signed = await mintStewardTokenFromClaims(bindings, {
      userId: subject,
      issuedAt,
      expiration: issuedAt + 600,
    });
    if (!signed) throw Error("Synthetic session signer unavailable");
    const ordinary = await resolve(signed.token, false);
    expect(ordinary.kind).toBe("authorized");
    expect("credential" in ordinary).toBe(false);
    const included = await resolve(signed.token);
    expect(included.kind).toBe("authorized");
    if (included.kind !== "authorized") throw Error("Expected verified session");
    expect(included.credential).toEqual({
      kind: "steward_session",
      userId: USER,
      stewardUserId: subject,
      issuedAt,
    });
    expect(JSON.stringify(included.credential)).not.toContain(signed.token);
    await expect(rejectAtStrongBoundary(signed.token, "session_revoked")).rejects.toBeInstanceOf(
      Error,
    );
    const parts = signed.token.split(".");
    parts[2] = `${parts[2].startsWith("A") ? "B" : "A"}${parts[2].slice(1)}`;
    expect((await resolve(parts.join("."))).kind).toBe("rejected");
    await getPgliteClientForTests().query("UPDATE users SET is_active=false WHERE id=$1", [USER]);
    try {
      await expect(resolve(signed.token)).rejects.toBeInstanceOf(Error);
    } finally {
      await getPgliteClientForTests().query("UPDATE users SET is_active=true WHERE id=$1", [USER]);
    }
  });
  test("route bootstrap returns verified API and session metadata without a Worker context", async () => {
    const { requireGenerativeRouteCaller } = await import(
      "../../../../api/src/lib/generative-route-auth"
    );
    const key = await seedKey({ userId: USER, organizationId: ORG });
    const values = new Map<string, unknown>();
    const c = {
      req: { raw: request(key) },
      get: (name: string) => values.get(name),
      set: (name: string, value: unknown) => values.set(name, value),
    } as Parameters<typeof requireGenerativeRouteCaller>[0];
    const caller = await runWithCloudBindings(bindings, () =>
      requireGenerativeRouteCaller(c, { includeVerifiedCredential: true }),
    );
    expect(caller.credential).toMatchObject({ kind: "api_key", userId: USER });
    expect(caller.user.organization_id).toBe(ORG);
    expect(JSON.stringify(caller)).not.toContain(key);
    const issuedAt = Math.floor(Date.now() / 1000);
    const signed = await mintStewardTokenFromClaims(bindings, {
      userId: "synthetic-bootstrap-steward",
      issuedAt,
      expiration: issuedAt + 600,
    });
    if (!signed) throw Error("Synthetic session signer unavailable");
    c.req.raw = request(signed.token);
    const sessionCaller = await runWithCloudBindings(bindings, () =>
      requireGenerativeRouteCaller(c, { includeVerifiedCredential: true }),
    );
    expect(sessionCaller.credential).toEqual({
      kind: "steward_session",
      userId: USER,
      stewardUserId: "synthetic-bootstrap-steward",
      issuedAt,
    });
    expect(sessionCaller.apiKeyId).toBeNull();
    expect(JSON.stringify(sessionCaller)).not.toContain(signed.token);
  });
});
