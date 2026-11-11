/**
 * Two boundaries of the phone's one-sign-in purchase:
 *  - a verified session whose first-sign-in provisioning failed is a retryable
 *    `account_not_ready` 503, never an authentication failure;
 *  - subscription checkout accepts the organization owner's or admin's
 *    acknowledged mobile credential, and no other programmatic credential.
 */
import { afterEach, expect, spyOn, test } from "bun:test";

process.env.MOCK_REDIS = "1";

const stewardClient = await import("./steward-client");
const auth = await import("./workers-hono-auth");
const { usersService } = await import("../services/users");
const { usersRepository } = await import("../../db/repositories/users");
const { apiKeysService } = await import("../services/api-keys");
const stewardSync = await import("../steward-sync");
const lifecycle = await import("../services/account-lifecycle-authority");
const { ApiError } = await import("../api/cloud-worker-errors");
const { apiKeysRepository } = await import("../../db/repositories/api-keys");
const { ElizaError } = await import("@elizaos/core");

type Context = Parameters<typeof auth.requireUser>[0];
type ManagedUser = NonNullable<
  Awaited<ReturnType<typeof usersRepository.findWithOrganizationForWrite>>
>;
type Credential = NonNullable<Awaited<ReturnType<typeof apiKeysService.validateApiKey>>>;

const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
const MOBILE_KEY = `eliza_mobile_${"a".repeat(64)}`;

const spies: ReturnType<typeof spyOn>[] = [];
function restore(): void {
  for (const spy of spies.splice(0)) spy.mockRestore();
}
afterEach(restore);

function context(headers: Record<string, string>): Context {
  const values = new Map<string, unknown>();
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    env: {},
    req: { header: (name: string) => lower[name.toLowerCase()] },
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => values.set(key, value),
  } as unknown as Context;
}

async function failure(run: () => Promise<unknown>): Promise<InstanceType<typeof ApiError>> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected an ApiError");
}

function member(overrides: Record<string, unknown> = {}): ManagedUser {
  return {
    id: USER_ID,
    steward_user_id: "steward-a",
    organization_id: ORG_ID,
    role: "owner",
    is_active: true,
    is_anonymous: false,
    deleted_at: null,
    expires_at: null,
    created_at: new Date("2026-10-01T00:00:00Z"),
    organization: { id: ORG_ID, name: "A", is_active: true },
    ...overrides,
  } as unknown as ManagedUser;
}

function credential(overrides: Record<string, unknown> = {}): Credential {
  return {
    id: "00000000-0000-4000-8000-0000000000c1",
    user_id: USER_ID,
    organization_id: ORG_ID,
    source_app_id: "00000000-0000-4000-8000-0000000000d1",
    is_active: true,
    expires_at: new Date(Date.now() + 86_400_000),
    ...overrides,
  } as unknown as Credential;
}

function mobileCaller(key: Credential | null, user: ManagedUser | undefined) {
  const validate = spyOn(apiKeysService, "validateApiKey").mockResolvedValue(key);
  spies.push(
    validate,
    spyOn(usersRepository, "findWithOrganizationForWrite").mockResolvedValue(user),
    spyOn(lifecycle, "readOrganizationLifecycleAuthority").mockResolvedValue(
      {} as Awaited<ReturnType<typeof lifecycle.readOrganizationLifecycleAuthority>>,
    ),
    spyOn(lifecycle, "organizationLifecycleAllowsNewWork").mockReturnValue(true),
  );
  return validate;
}

async function firstSignInFailingWith(syncError: unknown) {
  spies.push(
    spyOn(stewardClient, "verifyStewardTokenCached").mockResolvedValue({
      userId: "steward-new",
      issuedAt: 1,
      expiration: 2,
    }),
    spyOn(usersService, "getByStewardId").mockResolvedValue(undefined),
    spyOn(stewardSync, "syncUserFromSteward").mockRejectedValue(syncError),
  );
  const c = context({ authorization: "Bearer aaa.bbb.ccc" });
  // Optional-auth callers always see an anonymous request.
  expect(await auth.getCurrentUser(c)).toBeNull();
  const error = await failure(() => auth.requireUser(c));
  restore();
  return error;
}

test("an outage during first-sign-in provisioning is a retryable 503", async () => {
  const outages = [
    Object.assign(new Error("terminating connection"), { code: "57P01" }),
    Object.assign(new Error("too many connections"), { code: "53300" }),
    Object.assign(new Error("connection failure"), { code: "08006" }),
    Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    new Error("Failed query", {
      cause: Object.assign(new Error("closed"), { code: "CONNECTION_CLOSED" }),
    }),
    new ElizaError("Fresh Steward binding activation is temporarily unavailable", {
      code: "INFERENCE_CREDENTIAL_REVOCATION_UNAVAILABLE",
    }),
  ];
  for (const outage of outages) {
    const error = await firstSignInFailingWith(outage);
    expect(error.status).toBe(503);
    expect(error.toJSON()).toMatchObject({
      success: false,
      code: "account_not_ready",
      retryAfterSeconds: 5,
    });
  }
});

test("an identity conflict during first-sign-in provisioning is a 409, never a retry loop", async () => {
  const conflicts = [
    new stewardSync.StewardPhoneAccountConflictError("verified_phone_unique_conflict"),
    new stewardSync.StewardTelegramAccountClaimError("identity_projection_conflict"),
    new ElizaError("Email is held by another account; retry sign-in", {
      code: "STEWARD_EMAIL_CLAIM_CONFLICT",
    }),
    // A conflict wins over an outage code on a wrapping error.
    Object.assign(new Error("wrapped"), {
      code: "57P01",
      cause: new stewardSync.StewardPhoneAccountConflictError("verified_phone_mismatch"),
    }),
  ];
  for (const conflict of conflicts) {
    const error = await firstSignInFailingWith(conflict);
    expect(error.status).toBe(409);
    expect(error.code).toBe("identity_conflict");
    expect(error.toJSON()).not.toHaveProperty("retryAfterSeconds");
  }
});

test("any other provisioning failure stays an authentication failure", async () => {
  const others = [
    new Error("Cannot generate organization slug for Steward user steward-new"),
    Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
    Object.assign(new Error('column "x" does not exist'), { code: "42703" }),
    new TypeError("undefined is not an object"),
  ];
  for (const other of others) {
    const error = await firstSignInFailingWith(other);
    expect(error.status).toBe(401);
    expect(error.code).toBe("authentication_required");
  }
});

test("an invalid session is still an authentication failure", async () => {
  spies.push(spyOn(stewardClient, "verifyStewardTokenCached").mockResolvedValue(null));
  const error = await failure(() =>
    auth.requireUser(context({ authorization: "Bearer aaa.bbb.ccc" })),
  );
  expect(error.status).toBe(401);
  expect(error.code).toBe("authentication_required");
});

test("the owner's acknowledged mobile credential is billing authority, read from primary storage", async () => {
  const validate = mobileCaller(credential(), member());
  const c = context({ authorization: `Bearer ${MOBILE_KEY}` });
  const first = await auth.requireCurrentBillingManager(c);
  expect(first.user).toMatchObject({ id: USER_ID, organization_id: ORG_ID, role: "owner" });
  expect(first.mobileCredential?.id).toBe(credential().id);
  expect(c.get("authMethod")).toBe("api_key");
  // Reauthorization before a provider write validates the secret again.
  await auth.requireCurrentBillingManager(c);
  expect(validate).toHaveBeenCalledTimes(2);
  expect(validate).toHaveBeenLastCalledWith(MOBILE_KEY);
});

test("an admin's mobile credential qualifies and a member's does not", async () => {
  mobileCaller(credential(), member({ role: "admin" }));
  const admin = await auth.requireCurrentBillingManager(
    context({ authorization: `Bearer ${MOBILE_KEY}` }),
  );
  expect(admin.user.role).toBe("admin");
  restore();
  mobileCaller(credential(), member({ role: "member" }));
  const error = await failure(() =>
    auth.requireCurrentBillingManager(context({ "x-api-key": MOBILE_KEY })),
  );
  expect(error.status).toBe(403);
});

test("a standard API key never manages billing", async () => {
  const validate = mobileCaller(credential(), member());
  const error = await failure(() =>
    auth.requireCurrentBillingManager(context({ authorization: `Bearer eliza_${"b".repeat(64)}` })),
  );
  expect(error.status).toBe(401);
  expect(error.code).toBe("session_auth_required");
  expect(validate).not.toHaveBeenCalled();
});

test("a revoked, unacknowledged, expired or foreign-organization mobile credential is refused", async () => {
  const refused: Array<[Credential | null, ManagedUser | undefined, number]> = [
    [null, member(), 401],
    [credential({ is_active: false }), member(), 403],
    [credential({ expires_at: new Date(Date.now() - 1000) }), member(), 401],
    [credential({ expires_at: null }), member(), 401],
    [credential({ source_app_id: null }), member(), 401],
    // The owner moved to another organization after the credential was issued.
    [credential(), member({ organization_id: "00000000-0000-4000-8000-0000000000b2" }), 403],
    [credential(), member({ is_active: false }), 403],
    [credential(), undefined, 401],
  ];
  for (const [key, user, status] of refused) {
    mobileCaller(key, user);
    const error = await failure(() =>
      auth.requireCurrentBillingManager(context({ authorization: `Bearer ${MOBILE_KEY}` })),
    );
    expect(error.status).toBe(status);
    restore();
  }
});

test("a key that was exchanged but never acknowledged is refused by the real validation path", async () => {
  // The stored row of an exchanged, unacknowledged credential: inactive, with its
  // sealed secret still held for redelivery. Nothing is stubbed between the header
  // and that row, so `validateApiKey` and `isUsableMobileApiKey` decide.
  type StoredKey = Awaited<ReturnType<typeof apiKeysRepository.findByHashConsistent>>;
  const lookup = spyOn(apiKeysRepository, "findByHashConsistent").mockResolvedValue(
    credential({
      is_active: false,
      deleted_at: null,
      key_ciphertext: "sealed",
      key_nonce: "nonce",
      key_auth_tag: "tag",
    }) as StoredKey,
  );
  const membership = spyOn(usersRepository, "findWithOrganizationForWrite").mockResolvedValue(
    member(),
  );
  spies.push(lookup, membership);
  const key = `eliza_mobile_${"c".repeat(64)}`;
  const error = await failure(() =>
    auth.requireCurrentBillingManager(context({ authorization: `Bearer ${key}` })),
  );
  expect(error.status).toBe(401);
  expect(error.code).toBe("authentication_required");
  expect(lookup).toHaveBeenCalledTimes(1);
  // Refused before any membership read.
  expect(membership).not.toHaveBeenCalled();

  // The same row once acknowledged (active, sealed secret released) is accepted.
  lookup.mockResolvedValue(credential({ deleted_at: null }) as StoredKey);
  spies.push(
    spyOn(lifecycle, "readOrganizationLifecycleAuthority").mockResolvedValue(
      {} as Awaited<ReturnType<typeof lifecycle.readOrganizationLifecycleAuthority>>,
    ),
    spyOn(lifecycle, "organizationLifecycleAllowsNewWork").mockReturnValue(true),
  );
  const accepted = await auth.requireCurrentBillingManager(
    context({ authorization: `Bearer ${key}` }),
  );
  expect(accepted.mobileCredential?.id).toBe(credential().id);
});
