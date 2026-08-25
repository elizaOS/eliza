/**
 * Exercises the first-party mobile PKCE lifecycle against real Drizzle
 * repositories, transactions, PGlite persistence, and field encryption.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.ELIZA_KMS_BACKEND = "memory";
process.env.CACHE_BACKEND = "memory";
delete process.env.ENVIRONMENT;

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORGANIZATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VERIFIER = "verifier_abcdefghijklmnopqrstuvwxyz0123456789-._~";
const WRONG_VERIFIER = "different_abcdefghijklmnopqrstuvwxyz0123456789-._~";
const STATE = "state_abcdefghijklmnopqrstuvwxyz0123456789-._~";
const WRONG_STATE = "other_abcdefghijklmnopqrstuvwxyz0123456789-._~";
const START = new Date(Date.now() + 60_000);

let dbWrite: typeof import("../../db/client").dbWrite;
let closeDatabaseConnectionsForTests:
  | typeof import("../../db/client").closeDatabaseConnectionsForTests
  | undefined;
let resetKmsClientForTests: typeof import("../../db/crypto/kms-client").resetKmsClientForTests;
let service: typeof import("./mobile-app-auth");
let apiKeysService: typeof import("./api-keys").apiKeysService;
let apiKeysRepository: typeof import("../../db/repositories/api-keys").apiKeysRepository;
let mobileAppAuthGrantsRepository: typeof import("../../db/repositories/mobile-app-auth-grants").mobileAppAuthGrantsRepository;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite } = await import("../../db/client"));
  await dbWrite.execute(`CREATE TABLE organizations (
    id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true
  )`);
  await dbWrite.execute(`CREATE TABLE users (
    id uuid PRIMARY KEY, organization_id uuid, is_active boolean NOT NULL DEFAULT true
  )`);
  await dbWrite.execute(`CREATE TABLE apps (
    id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true,
    is_approved boolean NOT NULL DEFAULT true
  )`);
  await dbWrite.execute(`CREATE TABLE api_keys (
    id uuid PRIMARY KEY, name text NOT NULL, description text, key_hash text NOT NULL UNIQUE,
    key_prefix text NOT NULL, key_ciphertext text, key_nonce text, key_auth_tag text,
    key_kms_key_id text, key_kms_key_version integer, organization_id uuid NOT NULL,
    user_id uuid NOT NULL, rate_limit integer NOT NULL DEFAULT 1000,
    is_active boolean NOT NULL DEFAULT true, usage_count integer NOT NULL DEFAULT 0,
    expires_at timestamp, last_used_at timestamp, created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(), deleted_at timestamp,
    source_app_id uuid
  )`);
  await dbWrite.execute(`CREATE TABLE mobile_app_auth_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code_hash text NOT NULL UNIQUE,
    app_id uuid NOT NULL, client_id text NOT NULL, user_id uuid NOT NULL,
    organization_id uuid NOT NULL, environment text NOT NULL, device_name text,
    redirect_uri text NOT NULL,
    state_hash text NOT NULL, code_challenge text NOT NULL,
    code_challenge_method text NOT NULL, scopes jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    credential_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
    expires_at timestamptz NOT NULL, exchanged_at timestamptz,
    acknowledged_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await dbWrite.execute(`CREATE TABLE jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id uuid REFERENCES api_keys(id)
  )`);
  ({ resetKmsClientForTests } = await import("../../db/crypto/kms-client"));
  ({ mobileAppAuthGrantsRepository } = await import(
    "../../db/repositories/mobile-app-auth-grants"
  ));
  ({ apiKeysRepository } = await import("../../db/repositories/api-keys"));
  ({ apiKeysService } = await import("./api-keys"));
  service = await import("./mobile-app-auth");
}, 60_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

beforeEach(async () => {
  await dbWrite.execute("DELETE FROM jobs");
  await dbWrite.execute("DELETE FROM mobile_app_auth_grants");
  await dbWrite.execute("DELETE FROM api_keys");
  await dbWrite.execute("DELETE FROM apps");
  await dbWrite.execute("DELETE FROM users");
  await dbWrite.execute("DELETE FROM organizations");
  await dbWrite.execute(
    `INSERT INTO organizations (id, is_active) VALUES ('${ORGANIZATION_ID}', true)`,
  );
  await dbWrite.execute(
    `INSERT INTO users (id, organization_id, is_active)
     VALUES ('${USER_ID}', '${ORGANIZATION_ID}', true)`,
  );
  await dbWrite.execute(
    `INSERT INTO apps (id, is_active, is_approved) VALUES ('${APP_ID}', true, true)`,
  );
  resetKmsClientForTests();
});

const registration = {
  appId: APP_ID,
  clientId: "ai.elizaos.app" as const,
  environment: "staging" as const,
  redirectUri: "https://eliza.app/auth/callback" as const,
  scopes: ["cloud:user"] as const,
};

function binding(state = STATE) {
  return {
    clientId: registration.clientId,
    environment: registration.environment,
    redirectUri: registration.redirectUri,
    state,
  };
}

async function issue(now = START, deviceName?: string) {
  return await service.issueMobileAppAuthCode({
    registration,
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    binding: {
      ...binding(),
      codeChallenge: service.deriveMobileAppAuthS256Challenge(VERIFIER),
      codeChallengeMethod: "S256",
      deviceName,
    },
    now,
  });
}

async function rowCounts(): Promise<{ grants: number; keys: number }> {
  const grants = await dbWrite.execute("SELECT count(*)::int AS count FROM mobile_app_auth_grants");
  const keys = await dbWrite.execute("SELECT count(*)::int AS count FROM api_keys");
  return {
    grants: Number(grants.rows[0]?.count),
    keys: Number(keys.rows[0]?.count),
  };
}

async function expectProtocolError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "MobileAppAuthProtocolError",
    protocolCode: code,
  });
}

describe("mobile App Auth PKCE lifecycle with real persistence", () => {
  test("resolves only the fixed server registration and standard S256 PKCE", () => {
    expect(
      service.resolveMobileAppAuthRegistration({
        ENVIRONMENT: "staging",
        ELIZA_MOBILE_APP_AUTH_APP_ID: APP_ID,
        ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
      }),
    ).toEqual(registration);
    expect(
      service.deriveMobileAppAuthS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(() =>
      service.resolveMobileAppAuthRegistration({
        ENVIRONMENT: "local",
        ELIZA_MOBILE_APP_AUTH_APP_ID: APP_ID,
        ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
      }),
    ).toThrow("exact staging or production");
    expect(() =>
      service.resolveMobileAppAuthRegistration({
        ENVIRONMENT: "staging",
        ELIZA_MOBILE_APP_AUTH_APP_ID: "client-controlled",
        ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
      }),
    ).toThrow("registered app UUID");
    expect(() =>
      service.resolveMobileAppAuthRegistration({
        ENVIRONMENT: "staging",
        ELIZA_MOBILE_APP_AUTH_ENABLED: "false",
      }),
    ).toThrow("disabled for this environment");
    expect(() =>
      service.resolveMobileAppAuthRegistration({
        ENVIRONMENT: "staging",
        ELIZA_MOBILE_APP_AUTH_APP_ID: APP_ID,
      }),
    ).toThrow("must be exactly true or false");
  });

  test("consent creates only a short-lived grant and no credential", async () => {
    const authorization = await issue(START, "Nubs' iPhone");

    expect(authorization.code).toMatch(/^emac_[0-9a-f]{64}$/);
    expect(authorization.expiresIn).toBe(300);
    expect(await rowCounts()).toEqual({ grants: 1, keys: 0 });
    const rows = await dbWrite.execute(
      "SELECT code_hash, state_hash, status, credential_id, device_name FROM mobile_app_auth_grants",
    );
    expect(rows.rows[0]).toMatchObject({
      status: "pending",
      credential_id: null,
      device_name: "Nubs' iPhone",
    });
    expect(rows.rows[0]?.code_hash).not.toBe(authorization.code);
    expect(rows.rows[0]?.state_hash).not.toBe(STATE);
  });

  test("consent rejects empty, control-character, and oversized device labels", async () => {
    for (const deviceName of ["   ", "iPhone\nspoofed", "x".repeat(81)]) {
      await expectProtocolError(issue(START, deviceName), "invalid_request");
    }
    expect(await rowCounts()).toEqual({ grants: 0, keys: 0 });
  });

  test("generic API-key CRUD cannot list, manage, mutate, or delete a mobile credential", async () => {
    const authorization = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    await service.acknowledgeMobileAppAuthCredential({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      credentialId: exchanged.credentialId,
      secret: exchanged.secret,
      now: new Date(START.getTime() + 2_000),
    });

    const ordinary = apiKeysService.generateApiKey();
    const ordinaryId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await apiKeysRepository.create({
      id: ordinaryId,
      name: "Ordinary API key",
      key_hash: ordinary.hash,
      key_prefix: ordinary.prefix,
      organization_id: ORGANIZATION_ID,
      user_id: USER_ID,
      is_active: true,
      expires_at: null,
    });

    expect((await apiKeysService.listByOrganization(ORGANIZATION_ID)).map((key) => key.id)).toEqual(
      [ordinaryId],
    );
    await expect(apiKeysService.getManageableById(exchanged.credentialId)).resolves.toBeUndefined();
    await expect(
      apiKeysService.update(exchanged.credentialId, {
        is_active: false,
        expires_at: null,
      }),
    ).rejects.toThrow("mobile authorization lifecycle");
    await expect(apiKeysService.delete(exchanged.credentialId)).rejects.toThrow(
      "mobile authorization lifecycle",
    );

    await expect(
      apiKeysRepository.update(exchanged.credentialId, {
        is_active: false,
        expires_at: null,
      }),
    ).resolves.toBeUndefined();
    await apiKeysRepository.delete(exchanged.credentialId);

    await expect(apiKeysService.validateApiKey(exchanged.secret)).resolves.toMatchObject({
      id: exchanged.credentialId,
      is_active: true,
      source_app_id: APP_ID,
    });
  });

  test("mobile validation requires a finite future expiry", async () => {
    const generated = apiKeysService.generateMobileApiKey();
    const credentialId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await apiKeysRepository.create({
      id: credentialId,
      name: "Mobile expiry guard",
      key_hash: generated.hash,
      key_prefix: generated.prefix,
      organization_id: ORGANIZATION_ID,
      user_id: USER_ID,
      source_app_id: APP_ID,
      is_active: true,
      expires_at: null,
    });

    await expect(apiKeysService.validateApiKey(generated.key)).resolves.toBeNull();
    await dbWrite.execute(
      `UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id = '${credentialId}'`,
    );
    await expect(apiKeysService.validateApiKey(generated.key)).resolves.toBeNull();
    const future = apiKeysService.generateMobileApiKey();
    const futureCredentialId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await apiKeysRepository.create({
      id: futureCredentialId,
      name: "Mobile future expiry control",
      key_hash: future.hash,
      key_prefix: future.prefix,
      organization_id: ORGANIZATION_ID,
      user_id: USER_ID,
      source_app_id: APP_ID,
      is_active: true,
      expires_at: new Date(Date.now() + 60_000),
    });
    await expect(apiKeysService.validateApiKey(future.key)).resolves.toMatchObject({
      id: futureCredentialId,
    });
  });

  test("acknowledgement activates the primary credential without depending on cache health", async () => {
    const authorization = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    const invalidate = spyOn(apiKeysService, "invalidateCache").mockRejectedValue(
      new Error("configured cache backend is unavailable"),
    );

    try {
      await expect(
        service.acknowledgeMobileAppAuthCredential({
          registration,
          binding: binding(),
          code: authorization.code,
          codeVerifier: VERIFIER,
          credentialId: exchanged.credentialId,
          secret: exchanged.secret,
          now: new Date(START.getTime() + 2_000),
        }),
      ).resolves.toMatchObject({
        status: "acknowledged",
        credentialId: exchanged.credentialId,
      });
      expect(invalidate).not.toHaveBeenCalled();
      await expect(apiKeysService.validateApiKey(exchanged.secret)).resolves.toMatchObject({
        id: exchanged.credentialId,
        is_active: true,
      });
    } finally {
      invalidate.mockRestore();
    }
  });

  test("an inactive app cannot issue, exchange, or acknowledge mobile authorization", async () => {
    const exchangeGrant = await issue();
    await dbWrite.execute(`UPDATE apps SET is_active = false WHERE id = '${APP_ID}'`);

    await expectProtocolError(issue(), "invalid_client");
    await expectProtocolError(
      service.exchangeMobileAppAuthCode({
        registration,
        binding: binding(),
        code: exchangeGrant.code,
        codeVerifier: VERIFIER,
        now: new Date(START.getTime() + 1_000),
      }),
      "invalid_client",
    );
    expect(await rowCounts()).toEqual({ grants: 1, keys: 0 });

    await dbWrite.execute(`UPDATE apps SET is_active = true WHERE id = '${APP_ID}'`);
    const acknowledgementGrant = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: acknowledgementGrant.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    await dbWrite.execute(`UPDATE apps SET is_active = false WHERE id = '${APP_ID}'`);

    await expectProtocolError(
      service.acknowledgeMobileAppAuthCredential({
        registration,
        binding: binding(),
        code: acknowledgementGrant.code,
        codeVerifier: VERIFIER,
        credentialId: exchanged.credentialId,
        secret: exchanged.secret,
        now: new Date(START.getTime() + 2_000),
      }),
      "credential_proof_invalid",
    );
    const key = await dbWrite.execute("SELECT is_active FROM api_keys");
    expect(key.rows[0]?.is_active).toBe(false);
  });

  test("exchange persistence rejects a credential attributed to a different source app", async () => {
    const authorization = await issue();
    const codeChallenge = service.deriveMobileAppAuthS256Challenge(VERIFIER);

    await expect(
      mobileAppAuthGrantsRepository.exchange(
        {
          codeHash: service.sha256Hex(authorization.code),
          appId: APP_ID,
          clientId: registration.clientId,
          environment: registration.environment,
          redirectUri: registration.redirectUri,
          stateHash: service.sha256Hex(STATE),
          codeChallenge,
        },
        {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          name: "Invalid source attribution",
          key_hash: "d".repeat(64),
          key_prefix: "eliza_invalid",
          organization_id: ORGANIZATION_ID,
          user_id: USER_ID,
          source_app_id: USER_ID,
          is_active: false,
          expires_at: new Date(START.getTime() + 60_000),
        },
        new Date(START.getTime() + 1_000),
      ),
    ).rejects.toThrow("source app does not match");
    expect(await rowCounts()).toEqual({ grants: 1, keys: 0 });
  });

  test("lost exchange responses reveal one identical inactive credential until ACK", async () => {
    const authorization = await issue();
    const exchangeInput = {
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    };

    const [first, concurrent] = await Promise.all([
      service.exchangeMobileAppAuthCode(exchangeInput),
      service.exchangeMobileAppAuthCode(exchangeInput),
    ]);
    expect(concurrent).toEqual(first);
    const retry = await service.exchangeMobileAppAuthCode(exchangeInput);
    expect(retry).toEqual(first);
    expect(first.secret).toMatch(/^eliza_mobile_[0-9a-f]{64}$/);
    expect(first.acknowledgementRequired).toBe(true);
    expect(await rowCounts()).toEqual({ grants: 1, keys: 1 });

    const beforeAck = await dbWrite.execute(
      "SELECT id, is_active, expires_at, source_app_id FROM api_keys",
    );
    expect(beforeAck.rows[0]).toMatchObject({
      id: first.credentialId,
      is_active: false,
      source_app_id: APP_ID,
    });
    expect(new Date(String(beforeAck.rows[0]?.expires_at)).getTime()).toBeGreaterThan(
      START.getTime(),
    );
    expect(await apiKeysService.validateApiKey(first.secret)).toBeNull();

    const acknowledgeInput = {
      ...exchangeInput,
      credentialId: first.credentialId,
      secret: first.secret,
      now: new Date(START.getTime() + 2_000),
    };
    const [acknowledged, concurrentAck] = await Promise.all([
      service.acknowledgeMobileAppAuthCredential(acknowledgeInput),
      service.acknowledgeMobileAppAuthCredential(acknowledgeInput),
    ]);
    expect(concurrentAck).toEqual(acknowledged);
    expect(acknowledged.status).toBe("acknowledged");

    const afterAck = await dbWrite.execute(
      "SELECT id, is_active, key_ciphertext, key_nonce, key_auth_tag, key_kms_key_id, key_kms_key_version FROM api_keys",
    );
    expect(afterAck.rows[0]?.id).toBe(first.credentialId);
    expect(afterAck.rows[0]?.is_active).toBe(true);
    expect(afterAck.rows[0]).toMatchObject({
      key_ciphertext: null,
      key_nonce: null,
      key_auth_tag: null,
      key_kms_key_id: null,
      key_kms_key_version: null,
    });
    expect(await apiKeysService.validateApiKey(first.secret)).toMatchObject({
      id: first.credentialId,
      is_active: true,
    });

    const retryAfterOriginalCodeExpiry = await service.acknowledgeMobileAppAuthCredential({
      ...exchangeInput,
      credentialId: first.credentialId,
      secret: first.secret,
      now: new Date(START.getTime() + 6 * 60_000),
    });
    expect(retryAfterOriginalCodeExpiry).toEqual(acknowledged);
    await expectProtocolError(
      service.exchangeMobileAppAuthCode({
        ...exchangeInput,
        now: new Date(START.getTime() + 6 * 60_000),
      }),
      "authorization_complete",
    );
  });

  test("deactivation between KMS decrypt and primary confirmation prevents reveal", async () => {
    const authorization = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    const originalConfirm = mobileAppAuthGrantsRepository.confirmRevealable;
    mobileAppAuthGrantsRepository.confirmRevealable = async (input) => {
      await dbWrite.execute(`UPDATE apps SET is_active = false WHERE id = '${APP_ID}'`);
      return await originalConfirm.call(mobileAppAuthGrantsRepository, input);
    };

    try {
      await expectProtocolError(
        service.exchangeMobileAppAuthCode({
          registration,
          binding: binding(),
          code: authorization.code,
          codeVerifier: VERIFIER,
          now: new Date(START.getTime() + 2_000),
        }),
        "invalid_client",
      );
    } finally {
      mobileAppAuthGrantsRepository.confirmRevealable = originalConfirm;
    }
    expect(exchanged.secret).toMatch(/^eliza_mobile_[0-9a-f]{64}$/);
    expect(await rowCounts()).toEqual({ grants: 1, keys: 1 });
  });

  test("wrong verifier, state, environment, client, and redirect never mint a key", async () => {
    const authorization = await issue();
    const common = {
      registration,
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    };

    await expectProtocolError(
      service.exchangeMobileAppAuthCode({
        ...common,
        binding: binding(),
        codeVerifier: WRONG_VERIFIER,
      }),
      "invalid_code_verifier",
    );
    await expectProtocolError(
      service.exchangeMobileAppAuthCode({ ...common, binding: binding(WRONG_STATE) }),
      "binding_mismatch",
    );
    await expectProtocolError(
      service.exchangeMobileAppAuthCode({
        ...common,
        binding: { ...binding(), environment: "production" },
      }),
      "binding_mismatch",
    );
    await expectProtocolError(
      service.exchangeMobileAppAuthCode({
        ...common,
        binding: { ...binding(), clientId: "malicious.client" },
      }),
      "invalid_client",
    );
    await expectProtocolError(
      service.exchangeMobileAppAuthCode({
        ...common,
        binding: { ...binding(), redirectUri: "https://attacker.example/callback" },
      }),
      "binding_mismatch",
    );
    expect(await rowCounts()).toEqual({ grants: 1, keys: 0 });
  });

  test("wrong acknowledgement proof is stable and leaves the key inactive", async () => {
    const authorization = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });

    await expectProtocolError(
      service.acknowledgeMobileAppAuthCredential({
        registration,
        binding: binding(),
        code: authorization.code,
        codeVerifier: VERIFIER,
        credentialId: exchanged.credentialId,
        secret: `eliza_mobile_${"0".repeat(64)}`,
        now: new Date(START.getTime() + 2_000),
      }),
      "credential_proof_invalid",
    );
    const key = await dbWrite.execute("SELECT id, is_active FROM api_keys");
    expect(key.rows[0]?.id).toBe(exchanged.credentialId);
    expect(key.rows[0]?.is_active).toBe(false);
  });

  test("acknowledgement rejects a credential whose source attribution drifted", async () => {
    const authorization = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    await dbWrite.execute(
      `UPDATE api_keys SET source_app_id = '${USER_ID}' WHERE id = '${exchanged.credentialId}'`,
    );

    await expect(
      service.acknowledgeMobileAppAuthCredential({
        registration,
        binding: binding(),
        code: authorization.code,
        codeVerifier: VERIFIER,
        credentialId: exchanged.credentialId,
        secret: exchanged.secret,
        now: new Date(START.getTime() + 2_000),
      }),
    ).rejects.toThrow("credential ownership mismatch");
    const key = await dbWrite.execute("SELECT is_active FROM api_keys");
    expect(key.rows[0]?.is_active).toBe(false);
  });

  test.each([
    ["name", "name = 'Not the issued mobile credential'"],
    ["description", "description = 'Not the issued mobile provenance'"],
  ])(
    "acknowledgement rejects a credential whose %s provenance drifted",
    async (_field, assignment) => {
      const authorization = await issue();
      const exchanged = await service.exchangeMobileAppAuthCode({
        registration,
        binding: binding(),
        code: authorization.code,
        codeVerifier: VERIFIER,
        now: new Date(START.getTime() + 1_000),
      });
      await dbWrite.execute(
        `UPDATE api_keys SET ${assignment} WHERE id = '${exchanged.credentialId}'`,
      );

      await expect(
        service.acknowledgeMobileAppAuthCredential({
          registration,
          binding: binding(),
          code: authorization.code,
          codeVerifier: VERIFIER,
          credentialId: exchanged.credentialId,
          secret: exchanged.secret,
          now: new Date(START.getTime() + 2_000),
        }),
      ).rejects.toThrow("credential provenance mismatch");
      const key = await dbWrite.execute("SELECT is_active FROM api_keys");
      expect(key.rows[0]?.is_active).toBe(false);
    },
  );

  test("expiry tombstones an inactive credential, preserves its exact receipt, and clears its grant", async () => {
    const authorization = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    await dbWrite.execute(`INSERT INTO jobs (api_key_id) VALUES ('${exchanged.credentialId}')`);

    expect(await rowCounts()).toEqual({ grants: 1, keys: 1 });
    expect(
      await service.cleanupExpiredMobileAppAuthGrants(
        new Date(START.getTime() + service.MOBILE_APP_AUTH_CODE_TTL_SECONDS * 1_000),
      ),
    ).toEqual({
      grantsDeleted: 1,
      grantsScanned: 1,
      inactiveCredentialsTombstoned: 1,
      acknowledgedCredentialsTombstoned: 0,
      integrityViolations: 0,
      batchesProcessed: 1,
      batchSize: 250,
      maxBatches: 8,
      scanCapacity: 2000,
      remainingExpiredGrants: 0,
      remainingWork: false,
    });
    expect(await rowCounts()).toEqual({ grants: 0, keys: 1 });
    const tombstone = await dbWrite.execute(`SELECT id, is_active, deleted_at,
      key_ciphertext, key_nonce, key_auth_tag, key_kms_key_id, key_kms_key_version
      FROM api_keys`);
    expect(tombstone.rows[0]).toMatchObject({
      id: exchanged.credentialId,
      is_active: false,
      key_ciphertext: null,
      key_nonce: null,
      key_auth_tag: null,
      key_kms_key_id: null,
      key_kms_key_version: null,
    });
    expect(Number.isFinite(Date.parse(String(tombstone.rows[0]?.deleted_at)))).toBe(true);
    await expect(
      apiKeysService.revokePresentedMobileCredential(exchanged.secret),
    ).resolves.toMatchObject({
      receipt: {
        credentialId: exchanged.credentialId,
        status: "revoked",
      },
      revokedNow: false,
    });
    const jobs = await dbWrite.execute("SELECT api_key_id FROM jobs");
    expect(jobs.rows).toEqual([{ api_key_id: exchanged.credentialId }]);
  });

  test("natural expiry tombstones an acknowledged credential for an offline app and retries idempotently", async () => {
    const authorization = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    await service.acknowledgeMobileAppAuthCredential({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      credentialId: exchanged.credentialId,
      secret: exchanged.secret,
      now: new Date(START.getTime() + 2_000),
    });
    await dbWrite.execute(`INSERT INTO jobs (api_key_id) VALUES ('${exchanged.credentialId}')`);

    const expiresAt = new Date(exchanged.expiresAt);
    expect(await service.cleanupExpiredMobileAppAuthGrants(expiresAt)).toEqual({
      grantsDeleted: 1,
      grantsScanned: 1,
      inactiveCredentialsTombstoned: 0,
      acknowledgedCredentialsTombstoned: 1,
      integrityViolations: 0,
      batchesProcessed: 1,
      batchSize: 250,
      maxBatches: 8,
      scanCapacity: 2000,
      remainingExpiredGrants: 0,
      remainingWork: false,
    });

    const tombstone = await dbWrite.execute(`SELECT id, is_active, deleted_at,
      key_ciphertext, key_nonce, key_auth_tag, key_kms_key_id, key_kms_key_version
      FROM api_keys`);
    expect(tombstone.rows[0]).toMatchObject({
      id: exchanged.credentialId,
      is_active: false,
      key_ciphertext: null,
      key_nonce: null,
      key_auth_tag: null,
      key_kms_key_id: null,
      key_kms_key_version: null,
    });
    expect(Number.isFinite(Date.parse(String(tombstone.rows[0]?.deleted_at)))).toBe(true);
    expect(await apiKeysService.validateApiKey(exchanged.secret)).toBeNull();
    await expect(
      apiKeysService.revokePresentedMobileCredential(exchanged.secret),
    ).resolves.toMatchObject({
      receipt: { credentialId: exchanged.credentialId, status: "revoked" },
      revokedNow: false,
    });
    expect((await dbWrite.execute("SELECT api_key_id FROM jobs")).rows).toEqual([
      { api_key_id: exchanged.credentialId },
    ]);

    expect(await service.cleanupExpiredMobileAppAuthGrants(expiresAt)).toEqual({
      grantsDeleted: 0,
      grantsScanned: 0,
      inactiveCredentialsTombstoned: 0,
      acknowledgedCredentialsTombstoned: 0,
      integrityViolations: 0,
      batchesProcessed: 0,
      batchSize: 250,
      maxBatches: 8,
      scanCapacity: 2000,
      remainingExpiredGrants: 0,
      remainingWork: false,
    });
  });

  test("concurrent acknowledged-expiry cleanup claims one grant and credential exactly once", async () => {
    const authorization = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    await service.acknowledgeMobileAppAuthCredential({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      credentialId: exchanged.credentialId,
      secret: exchanged.secret,
      now: new Date(START.getTime() + 2_000),
    });

    const expiresAt = new Date(exchanged.expiresAt);
    const results = await Promise.all([
      mobileAppAuthGrantsRepository.cleanupExpired(expiresAt, 10),
      mobileAppAuthGrantsRepository.cleanupExpired(expiresAt, 10),
    ]);
    expect(results.reduce((sum, result) => sum + result.grantsDeleted, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.acknowledgedCredentialsTombstoned, 0)).toBe(
      1,
    );
    expect(results.reduce((sum, result) => sum + result.integrityViolations, 0)).toBe(0);
    expect(await rowCounts()).toEqual({ grants: 0, keys: 1 });
    const key = await dbWrite.execute("SELECT is_active, deleted_at, key_ciphertext FROM api_keys");
    expect(key.rows[0]).toMatchObject({ is_active: false, key_ciphertext: null });
    expect(Number.isFinite(Date.parse(String(key.rows[0]?.deleted_at)))).toBe(true);
  });

  test("acknowledged expiry retains every mobile provenance mismatch across retries", async () => {
    const acknowledged: Array<{ credentialId: string; secret: string }> = [];
    for (let index = 0; index < 3; index++) {
      const authorization = await issue();
      const exchanged = await service.exchangeMobileAppAuthCode({
        registration,
        binding: binding(),
        code: authorization.code,
        codeVerifier: VERIFIER,
        now: new Date(START.getTime() + 1_000),
      });
      await service.acknowledgeMobileAppAuthCredential({
        registration,
        binding: binding(),
        code: authorization.code,
        codeVerifier: VERIFIER,
        credentialId: exchanged.credentialId,
        secret: exchanged.secret,
        now: new Date(START.getTime() + 2_000),
      });
      acknowledged.push(exchanged);
    }
    const [sourceMismatch, nameMismatch, descriptionMismatch] = acknowledged;
    if (!sourceMismatch || !nameMismatch || !descriptionMismatch) {
      throw new Error("Failed to create every acknowledged provenance fixture");
    }
    await dbWrite.execute(
      `UPDATE api_keys SET source_app_id = '${USER_ID}' WHERE id = '${sourceMismatch.credentialId}'`,
    );
    await dbWrite.execute(
      `UPDATE api_keys SET name = 'Not a mobile lifecycle credential' WHERE id = '${nameMismatch.credentialId}'`,
    );
    await dbWrite.execute(
      `UPDATE api_keys SET description = 'Wrong provenance' WHERE id = '${descriptionMismatch.credentialId}'`,
    );

    const expiresAt = new Date(
      START.getTime() + 1_000 + service.MOBILE_APP_AUTH_CREDENTIAL_TTL_SECONDS * 1_000,
    );
    const expectedCleanup = {
      grantsDeleted: 0,
      grantsScanned: 3,
      inactiveCredentialsTombstoned: 0,
      acknowledgedCredentialsTombstoned: 0,
      integrityViolations: 3,
      batchesProcessed: 1,
      batchSize: 250,
      maxBatches: 8,
      scanCapacity: 2000,
      remainingExpiredGrants: 3,
      remainingWork: true,
    };
    expect(await service.cleanupExpiredMobileAppAuthGrants(expiresAt)).toEqual(expectedCleanup);
    expect(await service.cleanupExpiredMobileAppAuthGrants(expiresAt)).toEqual(expectedCleanup);
    expect(await rowCounts()).toEqual({ grants: 3, keys: 3 });
    const preserved = await dbWrite.execute(
      "SELECT is_active, deleted_at, key_ciphertext FROM api_keys",
    );
    expect(preserved.rows).toHaveLength(3);
    for (const row of preserved.rows) {
      expect(row).toMatchObject({ is_active: true, deleted_at: null });
      expect(row.key_ciphertext).toBeNull();
    }
  });

  test("acknowledged expiry keeps shared references unsafe across repeated sweeps", async () => {
    const authorization = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    await service.acknowledgeMobileAppAuthCredential({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      credentialId: exchanged.credentialId,
      secret: exchanged.secret,
      now: new Date(START.getTime() + 2_000),
    });
    await dbWrite.execute(`INSERT INTO mobile_app_auth_grants
      (code_hash, app_id, client_id, user_id, organization_id, environment,
       redirect_uri, state_hash, code_challenge, code_challenge_method, scopes,
       status, credential_id, expires_at, exchanged_at, acknowledged_at)
      SELECT '${"d".repeat(64)}', app_id, client_id, user_id, organization_id,
       environment, redirect_uri, '${"c".repeat(64)}', code_challenge,
       code_challenge_method, scopes, status, credential_id, expires_at, exchanged_at,
       acknowledged_at
      FROM mobile_app_auth_grants WHERE credential_id = '${exchanged.credentialId}'`);

    const expiresAt = new Date(exchanged.expiresAt);
    const expectedCleanup = {
      grantsDeleted: 0,
      grantsScanned: 2,
      inactiveCredentialsTombstoned: 0,
      acknowledgedCredentialsTombstoned: 0,
      integrityViolations: 2,
      batchesProcessed: 1,
      batchSize: 250,
      maxBatches: 8,
      scanCapacity: 2000,
      remainingExpiredGrants: 2,
      remainingWork: true,
    };
    expect(await service.cleanupExpiredMobileAppAuthGrants(expiresAt)).toEqual(expectedCleanup);
    expect(await service.cleanupExpiredMobileAppAuthGrants(expiresAt)).toEqual(expectedCleanup);
    expect(await rowCounts()).toEqual({ grants: 2, keys: 1 });
    const preserved = await dbWrite.execute(
      "SELECT is_active, deleted_at, key_ciphertext FROM api_keys",
    );
    expect(preserved.rows[0]).toMatchObject({ is_active: true, deleted_at: null });
    expect(preserved.rows[0]?.key_ciphertext).toBeNull();
    expect(await apiKeysService.validateApiKey(exchanged.secret)).toMatchObject({
      id: exchanged.credentialId,
    });
  });

  test("acknowledged cleanup never trusts a grant expiry ahead of credential expiry", async () => {
    const authorization = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    await service.acknowledgeMobileAppAuthCredential({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      credentialId: exchanged.credentialId,
      secret: exchanged.secret,
      now: new Date(START.getTime() + 2_000),
    });
    const prematureExpiry = new Date(START.getTime() + 3_000);
    await dbWrite.execute(
      `UPDATE mobile_app_auth_grants SET expires_at = '${prematureExpiry.toISOString()}'
       WHERE credential_id = '${exchanged.credentialId}'`,
    );

    expect(await service.cleanupExpiredMobileAppAuthGrants(prematureExpiry)).toMatchObject({
      grantsDeleted: 0,
      inactiveCredentialsTombstoned: 0,
      acknowledgedCredentialsTombstoned: 0,
      integrityViolations: 1,
      remainingExpiredGrants: 1,
      remainingWork: true,
    });
    const preserved = await dbWrite.execute(
      "SELECT is_active, deleted_at, key_ciphertext FROM api_keys",
    );
    expect(preserved.rows[0]).toMatchObject({ is_active: true, deleted_at: null });
    expect(preserved.rows[0]?.key_ciphertext).toBeNull();
    expect(await apiKeysService.validateApiKey(exchanged.secret)).toMatchObject({
      id: exchanged.credentialId,
    });
  });

  test("acknowledged expiry retains a missing credential receipt for operator correction", async () => {
    const authorization = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    await service.acknowledgeMobileAppAuthCredential({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      credentialId: exchanged.credentialId,
      secret: exchanged.secret,
      now: new Date(START.getTime() + 2_000),
    });
    await dbWrite.execute(`DELETE FROM api_keys WHERE id = '${exchanged.credentialId}'`);

    expect(await service.cleanupExpiredMobileAppAuthGrants(new Date(exchanged.expiresAt))).toEqual({
      grantsDeleted: 0,
      grantsScanned: 1,
      inactiveCredentialsTombstoned: 0,
      acknowledgedCredentialsTombstoned: 0,
      integrityViolations: 1,
      batchesProcessed: 1,
      batchSize: 250,
      maxBatches: 8,
      scanCapacity: 2000,
      remainingExpiredGrants: 1,
      remainingWork: true,
    });
    expect(await rowCounts()).toEqual({ grants: 1, keys: 0 });
  });

  test("cleanup retains exchanged grants sharing a credential across repeated sweeps", async () => {
    const authorization = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    await dbWrite.execute(`INSERT INTO mobile_app_auth_grants
      (code_hash, app_id, client_id, user_id, organization_id, environment,
       redirect_uri, state_hash, code_challenge, code_challenge_method, scopes,
       status, credential_id, expires_at, exchanged_at)
      SELECT '${"f".repeat(64)}', app_id, client_id, user_id, organization_id,
       environment, redirect_uri, '${"e".repeat(64)}', code_challenge,
       code_challenge_method, scopes, status, credential_id, expires_at, exchanged_at
      FROM mobile_app_auth_grants WHERE credential_id = '${exchanged.credentialId}'`);

    const expiredAt = new Date(START.getTime() + service.MOBILE_APP_AUTH_CODE_TTL_SECONDS * 1_000);
    const expectedCleanup = {
      grantsDeleted: 0,
      grantsScanned: 2,
      inactiveCredentialsTombstoned: 0,
      acknowledgedCredentialsTombstoned: 0,
      integrityViolations: 2,
      batchesProcessed: 1,
      batchSize: 250,
      maxBatches: 8,
      scanCapacity: 2000,
      remainingExpiredGrants: 2,
      remainingWork: true,
    };
    expect(await service.cleanupExpiredMobileAppAuthGrants(expiredAt)).toEqual(expectedCleanup);
    expect(await service.cleanupExpiredMobileAppAuthGrants(expiredAt)).toEqual(expectedCleanup);
    expect(await rowCounts()).toEqual({ grants: 2, keys: 1 });
    const preserved = await dbWrite.execute(
      "SELECT id, is_active, deleted_at, key_ciphertext FROM api_keys",
    );
    expect(preserved.rows[0]).toMatchObject({
      id: exchanged.credentialId,
      is_active: false,
      deleted_at: null,
    });
    expect(preserved.rows[0]?.key_ciphertext).not.toBeNull();
    await expect(
      apiKeysService.revokePresentedMobileCredential(exchanged.secret),
    ).resolves.toMatchObject({
      receipt: { credentialId: exchanged.credentialId, status: "revoked" },
      revokedNow: true,
    });
  });

  test("cleanup preserves an inactive credential whose owner no longer matches its grant", async () => {
    const authorization = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    await dbWrite.execute(
      `UPDATE api_keys SET organization_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
       WHERE id = '${exchanged.credentialId}'`,
    );

    const expiredAt = new Date(START.getTime() + service.MOBILE_APP_AUTH_CODE_TTL_SECONDS * 1_000);
    expect(await service.cleanupExpiredMobileAppAuthGrants(expiredAt)).toMatchObject({
      grantsDeleted: 0,
      inactiveCredentialsTombstoned: 0,
      acknowledgedCredentialsTombstoned: 0,
      integrityViolations: 1,
      remainingExpiredGrants: 1,
      remainingWork: true,
    });
    const preserved = await dbWrite.execute(
      "SELECT id, is_active, deleted_at, key_ciphertext FROM api_keys",
    );
    expect(preserved.rows[0]).toMatchObject({
      id: exchanged.credentialId,
      is_active: false,
      deleted_at: null,
    });
    expect(preserved.rows[0]?.key_ciphertext).not.toBeNull();
  });

  test("cleanup retains corruption while completing valid later work", async () => {
    const first = await issue(START);
    const activeCorruption = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: first.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    await dbWrite.execute(
      `UPDATE api_keys SET is_active = true WHERE id = '${activeCorruption.credentialId}'`,
    );

    const secondStart = new Date(START.getTime() + 2_000);
    const second = await issue(secondStart);
    const missingCorruption = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: second.code,
      codeVerifier: VERIFIER,
      now: new Date(secondStart.getTime() + 1_000),
    });
    await dbWrite.execute(`DELETE FROM api_keys WHERE id = '${missingCorruption.credentialId}'`);

    const thirdStart = new Date(START.getTime() + 4_000);
    const third = await issue(thirdStart);
    const valid = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: third.code,
      codeVerifier: VERIFIER,
      now: new Date(thirdStart.getTime() + 1_000),
    });

    const expiredAt = new Date(
      thirdStart.getTime() + service.MOBILE_APP_AUTH_CODE_TTL_SECONDS * 1_000,
    );
    expect(await service.cleanupExpiredMobileAppAuthGrants(expiredAt)).toEqual({
      grantsDeleted: 1,
      grantsScanned: 3,
      inactiveCredentialsTombstoned: 1,
      acknowledgedCredentialsTombstoned: 0,
      integrityViolations: 2,
      batchesProcessed: 1,
      batchSize: 250,
      maxBatches: 8,
      scanCapacity: 2000,
      remainingExpiredGrants: 2,
      remainingWork: true,
    });
    expect(await rowCounts()).toEqual({ grants: 2, keys: 2 });
    const remaining = await dbWrite.execute(
      "SELECT id, is_active, deleted_at, key_ciphertext FROM api_keys",
    );
    expect(remaining.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: activeCorruption.credentialId,
          is_active: true,
          deleted_at: null,
        }),
        expect.objectContaining({
          id: valid.credentialId,
          is_active: false,
          key_ciphertext: null,
        }),
      ]),
    );
  });

  test("stable cleanup pagination advances past more than one batch of retained poison", async () => {
    for (let index = 0; index < 3; index++) {
      const issuedAt = new Date(START.getTime() + index);
      const authorization = await issue(issuedAt);
      const exchanged = await service.exchangeMobileAppAuthCode({
        registration,
        binding: binding(),
        code: authorization.code,
        codeVerifier: VERIFIER,
        now: new Date(issuedAt.getTime() + 1_000),
      });
      await dbWrite.execute(
        `UPDATE api_keys SET name = 'Retained poison ${index}' WHERE id = '${exchanged.credentialId}'`,
      );
    }
    for (let index = 0; index < 2; index++) {
      await issue(new Date(START.getTime() + 100 + index));
    }
    const expiredAt = new Date(
      START.getTime() + 101 + service.MOBILE_APP_AUTH_CODE_TTL_SECONDS * 1_000,
    );

    expect(
      await service.cleanupExpiredMobileAppAuthGrants(expiredAt, {
        batchSize: 2,
        maxBatches: 3,
      }),
    ).toEqual({
      grantsDeleted: 2,
      grantsScanned: 5,
      inactiveCredentialsTombstoned: 0,
      acknowledgedCredentialsTombstoned: 0,
      integrityViolations: 3,
      batchesProcessed: 3,
      batchSize: 2,
      maxBatches: 3,
      scanCapacity: 6,
      remainingExpiredGrants: 3,
      remainingWork: true,
    });
    expect(await rowCounts()).toEqual({ grants: 3, keys: 3 });
    const preserved = await dbWrite.execute(
      "SELECT is_active, deleted_at, key_ciphertext FROM api_keys",
    );
    expect(preserved.rows).toHaveLength(3);
    for (const row of preserved.rows) {
      expect(row).toMatchObject({ is_active: false, deleted_at: null });
      expect(row.key_ciphertext).not.toBeNull();
    }

    expect(
      await service.cleanupExpiredMobileAppAuthGrants(expiredAt, {
        batchSize: 2,
        maxBatches: 3,
      }),
    ).toEqual({
      grantsDeleted: 0,
      grantsScanned: 3,
      inactiveCredentialsTombstoned: 0,
      acknowledgedCredentialsTombstoned: 0,
      integrityViolations: 3,
      batchesProcessed: 2,
      batchSize: 2,
      maxBatches: 3,
      scanCapacity: 6,
      remainingExpiredGrants: 3,
      remainingWork: true,
    });
    expect(await rowCounts()).toEqual({ grants: 3, keys: 3 });
  });

  test("cleanup winning after KMS decrypt prevents a stale plaintext response", async () => {
    const authorization = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    const originalConfirm = mobileAppAuthGrantsRepository.confirmRevealable;
    let cleanupResult: Awaited<
      ReturnType<typeof mobileAppAuthGrantsRepository.cleanupExpired>
    > | null = null;
    mobileAppAuthGrantsRepository.confirmRevealable = async (input) => {
      await dbWrite.execute(
        `UPDATE mobile_app_auth_grants SET expires_at = '${new Date(
          input.now.getTime() - 1,
        ).toISOString()}' WHERE credential_id = '${exchanged.credentialId}'`,
      );
      cleanupResult = await mobileAppAuthGrantsRepository.cleanupExpired(input.now, 50);
      return await originalConfirm.call(mobileAppAuthGrantsRepository, input);
    };

    try {
      await expectProtocolError(
        service.exchangeMobileAppAuthCode({
          registration,
          binding: binding(),
          code: authorization.code,
          codeVerifier: VERIFIER,
          now: new Date(START.getTime() + 2_000),
        }),
        "authorization_code_expired",
      );
    } finally {
      mobileAppAuthGrantsRepository.confirmRevealable = originalConfirm;
    }
    expect(cleanupResult).toMatchObject({
      grantsDeleted: 1,
      inactiveCredentialsTombstoned: 1,
      acknowledgedCredentialsTombstoned: 0,
      integrityViolations: 0,
    });
    expect(await rowCounts()).toEqual({ grants: 0, keys: 1 });
    await expect(
      apiKeysService.revokePresentedMobileCredential(exchanged.secret),
    ).resolves.toMatchObject({
      receipt: { credentialId: exchanged.credentialId, status: "revoked" },
      revokedNow: false,
    });
  });

  test("cleanup drains multiple bounded batches and reports exact remaining work", async () => {
    for (let index = 0; index < 5; index++) {
      await issue(new Date(START.getTime() + index));
    }
    const expiredAt = new Date(
      START.getTime() + service.MOBILE_APP_AUTH_CODE_TTL_SECONDS * 1_000 + 10,
    );

    expect(
      await service.cleanupExpiredMobileAppAuthGrants(expiredAt, {
        batchSize: 2,
        maxBatches: 2,
      }),
    ).toEqual({
      grantsDeleted: 4,
      grantsScanned: 4,
      inactiveCredentialsTombstoned: 0,
      acknowledgedCredentialsTombstoned: 0,
      integrityViolations: 0,
      batchesProcessed: 2,
      batchSize: 2,
      maxBatches: 2,
      scanCapacity: 4,
      remainingExpiredGrants: 1,
      remainingWork: true,
    });
    expect(await rowCounts()).toEqual({ grants: 1, keys: 0 });

    expect(
      await service.cleanupExpiredMobileAppAuthGrants(expiredAt, {
        batchSize: 2,
        maxBatches: 2,
      }),
    ).toMatchObject({
      grantsDeleted: 1,
      grantsScanned: 1,
      batchesProcessed: 1,
      scanCapacity: 4,
      remainingExpiredGrants: 0,
      remainingWork: false,
    });
  });

  test("expired pending codes return the stable error and are removed", async () => {
    const authorization = await issue();
    await expectProtocolError(
      service.exchangeMobileAppAuthCode({
        registration,
        binding: binding(),
        code: authorization.code,
        codeVerifier: VERIFIER,
        now: new Date(START.getTime() + service.MOBILE_APP_AUTH_CODE_TTL_SECONDS * 1_000),
      }),
      "authorization_code_expired",
    );
    expect(await rowCounts()).toEqual({ grants: 0, keys: 0 });
  });

  test("opportunistic expiry cleanup removes safe work and retains credential corruption", async () => {
    const corrupt = await issue(START);
    const corruptCredential = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: corrupt.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    await dbWrite.execute(
      `UPDATE api_keys SET is_active = true WHERE id = '${corruptCredential.credentialId}'`,
    );
    const targetStart = new Date(START.getTime() + 2_000);
    const target = await issue(targetStart);
    const expiredAt = new Date(
      targetStart.getTime() + service.MOBILE_APP_AUTH_CODE_TTL_SECONDS * 1_000,
    );

    await expect(
      service.exchangeMobileAppAuthCode({
        registration,
        binding: binding(),
        code: target.code,
        codeVerifier: VERIFIER,
        now: expiredAt,
      }),
    ).rejects.toMatchObject({
      name: "ElizaError",
      code: "MOBILE_APP_AUTH_CLEANUP_INTEGRITY_VIOLATION",
      context: expect.objectContaining({ integrityViolations: 1 }),
    });
    expect(await rowCounts()).toEqual({ grants: 1, keys: 1 });
  });

  test("exact self-revocation rejects a mismatched hash and survives cache brownout with an idempotent tombstone", async () => {
    const authorization = await issue();
    const exchanged = await service.exchangeMobileAppAuthCode({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      now: new Date(START.getTime() + 1_000),
    });
    await service.acknowledgeMobileAppAuthCredential({
      registration,
      binding: binding(),
      code: authorization.code,
      codeVerifier: VERIFIER,
      credentialId: exchanged.credentialId,
      secret: exchanged.secret,
      now: new Date(START.getTime() + 2_000),
    });
    const rows = await dbWrite.execute("SELECT id, key_hash FROM api_keys");
    const keyHash = String(rows.rows[0]?.key_hash);
    expect(await apiKeysService.validateApiKey(exchanged.secret)).toMatchObject({
      id: exchanged.credentialId,
    });

    await expect(
      apiKeysService.revokeExactMobileCredential({
        id: exchanged.credentialId,
        key_hash: "0".repeat(64),
        source_app_id: APP_ID,
      }),
    ).rejects.toThrow("no longer matches an active key");
    expect(await rowCounts()).toEqual({ grants: 1, keys: 1 });

    const invalidate = spyOn(apiKeysService, "invalidateCache").mockRejectedValue(
      new Error("configured cache backend is unavailable"),
    );
    try {
      await apiKeysService.revokeExactMobileCredential({
        id: exchanged.credentialId,
        key_hash: keyHash,
        source_app_id: APP_ID,
      });
      await expect(
        apiKeysService.revokePresentedMobileCredential(exchanged.secret),
      ).resolves.toMatchObject({
        receipt: {
          credentialId: exchanged.credentialId,
          status: "revoked",
        },
        revokedNow: false,
      });
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      invalidate.mockRestore();
    }
    expect(await rowCounts()).toEqual({ grants: 1, keys: 1 });
    const tombstone = await dbWrite.execute(
      "SELECT id, is_active, deleted_at, key_ciphertext FROM api_keys",
    );
    expect(tombstone.rows[0]).toMatchObject({
      id: exchanged.credentialId,
      is_active: false,
      key_ciphertext: null,
    });
    expect(Number.isFinite(Date.parse(String(tombstone.rows[0]?.deleted_at)))).toBe(true);
    expect(await apiKeysService.validateApiKey(exchanged.secret)).toBeNull();
    await expect(apiKeysService.listByOrganization(ORGANIZATION_ID)).resolves.toEqual([]);
    await expectProtocolError(
      service.exchangeMobileAppAuthCode({
        registration,
        binding: binding(),
        code: authorization.code,
        codeVerifier: VERIFIER,
        now: new Date(START.getTime() + 3_000),
      }),
      "authorization_complete",
    );
    expect(
      await service.cleanupExpiredMobileAppAuthGrants(new Date(exchanged.expiresAt)),
    ).toMatchObject({
      grantsDeleted: 1,
      inactiveCredentialsTombstoned: 0,
      acknowledgedCredentialsTombstoned: 0,
      integrityViolations: 0,
      remainingExpiredGrants: 0,
    });
    expect(await rowCounts()).toEqual({ grants: 0, keys: 1 });
  });
});
