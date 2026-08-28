/**
 * Contract pins for the staging QA session-exchange boundary. The config
 * surface (dedicated signing key, secret/key id shape, enablement conjunction)
 * and the binding-window structural checks are pure env/shape gates whose
 * silent regression would weaken staging auth with no other test noticing.
 * Repository collaborators are module-mocked (workers-hono-auth harness
 * pattern); `timingSafeEqualSecret` and the WebCrypto fingerprint stay real so
 * the mint/revalidate paths are exercised against actual crypto.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash, createHmac } from "crypto";

const API_KEY_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const STEWARD_USER_ID = "usr_real_steward_1";
const TENANT_ID = "tenant-staging-1";
const PRESENTED_API_KEY = "eliza-qa-presented-key";
const API_KEY_HASH = createHash("sha256").update(PRESENTED_API_KEY).digest("hex");
// Mirrors CREDENTIAL_FINGERPRINT_DOMAIN in staging-session-binding.ts; kept
// literal here so the pin catches the domain string drifting silently.
const FINGERPRINT_DOMAIN = "eliza:staging-session-exchange:v1:api-key-generation";
const SIGNING_SECRET = "dedicated-staging-qa-secret-0123456789abcdef";
const SIGNING_KEY_ID = "staging-qa-v1-localtests";

const VALID_ENV = {
  NODE_ENV: "production",
  ENVIRONMENT: "staging",
  STEWARD_TENANT_ID: TENANT_ID,
  STAGING_SESSION_EXCHANGE_ENABLED: "true",
  STAGING_SESSION_EXCHANGE_VERSION: "v1",
  STAGING_SESSION_EXCHANGE_SIGNING_SECRET: SIGNING_SECRET,
  STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: SIGNING_KEY_ID,
  STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS: API_KEY_ID,
  STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS: USER_ID,
  STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS: ORG_ID,
} as const;

const NOW = new Date("2026-08-26T12:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

let apiKeyBehavior: () => Promise<unknown> = async () => makeApiKey();
let appCredentialBehavior: () => Promise<unknown> = async () => null;
let userBehavior: () => Promise<unknown> = async () => makeUser();
let identityBehavior: () => Promise<unknown> = async () => ({
  user_id: USER_ID,
  steward_user_id: STEWARD_USER_ID,
});
let logoutMarkerBehavior: () => Promise<unknown> = async () => null;
let findActiveCalls = 0;

// Argument-sensitive fakes: each returns its configured row only for the
// exact key the production code must query, so a regression that looks up the
// wrong id/user/steward subject yields null and fails the tests below.
const findActiveByIdConsistent = mock(async (id: string, _now?: Date) => {
  findActiveCalls += 1;
  if (id !== API_KEY_ID) return null;
  return await apiKeyBehavior();
});
const findByApiKeyIdForWrite = mock(async (id: string) => {
  if (id !== API_KEY_ID) return null;
  return await appCredentialBehavior();
});
const findWithOrganizationForWrite = mock(async (userId: string) => {
  if (userId !== USER_ID) return null;
  return await userBehavior();
});
const findIdentityByStewardIdForWrite = mock(async (stewardId: string) => {
  if (stewardId !== STEWARD_USER_ID) return null;
  return await identityBehavior();
});
const getLogoutMarkerForWrite = mock(async (stewardId: string) => {
  if (stewardId !== STEWARD_USER_ID) return null;
  return await logoutMarkerBehavior();
});

mock.module("../../db/repositories", () => ({
  apiKeysRepository: { findActiveByIdConsistent },
  appsRepository: { findByApiKeyIdForWrite },
  usersRepository: { findWithOrganizationForWrite, findIdentityByStewardIdForWrite },
  ssoBridgeRepository: { getLogoutMarkerForWrite },
}));

// the module imports the sso-bridge repository directly by subpath; mock the
// exact specifier too or the real PGlite store is reached on logout checks
mock.module("../../db/repositories/sso-bridge", () => ({
  ssoBridgeRepository: { getLogoutMarkerForWrite },
}));

mock.module("../utils/logger", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
}));

import {
  isStagingSessionExchangeEnabled,
  isStagingSessionSigningConfigured,
  loadExistingStagingSessionSubjectForMint,
  loadVerifiedStagingSessionUser,
  readStagingSessionSigningConfig,
  type StagingSessionBinding,
  StagingSessionConfigurationError,
  validateStagingSessionBinding,
} from "./staging-session-binding";

function makeApiKey(overrides: Record<string, unknown> = {}) {
  return {
    id: API_KEY_ID,
    user_id: USER_ID,
    organization_id: ORG_ID,
    key_hash: API_KEY_HASH,
    name: "qa-session-exchange-key",
    expires_at: null,
    ...overrides,
  };
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    is_active: true,
    is_anonymous: false,
    deleted_at: null,
    expires_at: null,
    organization_id: ORG_ID,
    steward_user_id: STEWARD_USER_ID,
    email: null,
    wallet_address: null,
    wallet_chain_type: null,
    organization: { id: ORG_ID, is_active: true, steward_tenant_id: TENANT_ID },
    ...overrides,
  };
}

function expectedFingerprint(): string {
  return createHmac("sha256", SIGNING_SECRET)
    .update(`${FINGERPRINT_DOMAIN}\0${API_KEY_ID}\0${API_KEY_HASH}`)
    .digest("hex");
}

async function mintSubjectBinding() {
  const subject = await loadExistingStagingSessionSubjectForMint({
    env: VALID_ENV,
    apiKeyId: API_KEY_ID,
    presentedApiKey: PRESENTED_API_KEY,
    now: NOW,
  });
  return { subject, binding: subject.binding };
}

function validValidationInput(binding: TestBinding) {
  return {
    env: VALID_ENV,
    binding: makeBinding(binding),
    stewardUserId: STEWARD_USER_ID,
    tenantId: TENANT_ID,
    // token iat must stay inside the issuer clock-skew allowance
    issuedAt: NOW_SECONDS + 2,
    expiration: NOW_SECONDS + 1800,
    now: NOW,
  };
}

interface TestBinding {
  version: string;
  apiKeyId: string;
  cloudUserId: string;
  organizationId: string;
  credentialFingerprint: string;
  sessionIssuedAt: number;
  sessionMaxExpiresAt: number;
}

function makeBinding(overrides: Partial<TestBinding> = {}): StagingSessionBinding {
  // rows below deliberately construct structurally-invalid bindings, so a
  // single cast here keeps the rest of the suite type-checked
  const binding = {
    version: "v1",
    apiKeyId: API_KEY_ID,
    cloudUserId: USER_ID,
    organizationId: ORG_ID,
    credentialFingerprint: expectedFingerprint(),
    sessionIssuedAt: NOW_SECONDS,
    sessionMaxExpiresAt: NOW_SECONDS + 3600,
    ...overrides,
  };
  return binding as StagingSessionBinding;
}

beforeEach(() => {
  apiKeyBehavior = async () => makeApiKey();
  appCredentialBehavior = async () => null;
  userBehavior = async () => makeUser();
  identityBehavior = async () => ({ user_id: USER_ID, steward_user_id: STEWARD_USER_ID });
  logoutMarkerBehavior = async () => null;
  findActiveCalls = 0;
});

describe("readStagingSessionSigningConfig", () => {
  test("returns the trimmed secret and key id for a valid dedicated key", () => {
    const config = readStagingSessionSigningConfig({
      ...VALID_ENV,
      STAGING_SESSION_EXCHANGE_SIGNING_SECRET: `  ${SIGNING_SECRET}  `,
      STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: `  ${SIGNING_KEY_ID} `,
    });
    expect(config).toEqual({ secret: SIGNING_SECRET, keyId: SIGNING_KEY_ID });
  });

  test("rejects a missing secret and a secret shorter than 32 characters", () => {
    expect(() =>
      readStagingSessionSigningConfig({
        ...VALID_ENV,
        STAGING_SESSION_EXCHANGE_SIGNING_SECRET: undefined,
      }),
    ).toThrow(StagingSessionConfigurationError);
    expect(() =>
      readStagingSessionSigningConfig({
        ...VALID_ENV,
        STAGING_SESSION_EXCHANGE_SIGNING_SECRET: "a".repeat(31),
      }),
    ).toThrow(/too short/);
    // exactly 32 characters is the accepted boundary
    expect(() =>
      readStagingSessionSigningConfig({
        ...VALID_ENV,
        STAGING_SESSION_EXCHANGE_SIGNING_SECRET: "a".repeat(32),
      }),
    ).not.toThrow();
  });

  test("rejects a whitespace-only secret (trim, not truthiness, is the gate)", () => {
    expect(() =>
      readStagingSessionSigningConfig({
        ...VALID_ENV,
        STAGING_SESSION_EXCHANGE_SIGNING_SECRET: " ".repeat(40),
      }),
    ).toThrow(StagingSessionConfigurationError);
  });

  test("rejects a missing or malformed signing key id", () => {
    expect(() =>
      readStagingSessionSigningConfig({
        ...VALID_ENV,
        STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: undefined,
      }),
    ).toThrow(/KEY_ID is invalid/);
    expect(() =>
      readStagingSessionSigningConfig({
        ...VALID_ENV,
        STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: "staging-qa-v2-other",
      }),
    ).toThrow(/KEY_ID is invalid/);
    // 48 suffix characters is the accepted boundary; 49 is not
    expect(() =>
      readStagingSessionSigningConfig({
        ...VALID_ENV,
        STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: `staging-qa-v1-${"a".repeat(48)}`,
      }),
    ).not.toThrow();
    expect(() =>
      readStagingSessionSigningConfig({
        ...VALID_ENV,
        STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: `staging-qa-v1-${"a".repeat(49)}`,
      }),
    ).toThrow(/KEY_ID is invalid/);
  });

  test.each(["STEWARD_JWT_SECRET", "STEWARD_SESSION_SECRET", "ELIZA_SERVICE_JWT_SECRET"] as const)(
    "rejects a signing secret reused from %s (dedicated-key rollback boundary)",
    (otherSecretEnv) => {
      expect(() =>
        readStagingSessionSigningConfig({
          ...VALID_ENV,
          [otherSecretEnv]: SIGNING_SECRET,
        }),
      ).toThrow(/dedicated/);
      // the comparison must use the trimmed ambient secret too
      expect(() =>
        readStagingSessionSigningConfig({
          ...VALID_ENV,
          [otherSecretEnv]: `  ${SIGNING_SECRET} `,
        }),
      ).toThrow(/dedicated/);
    },
  );

  test("the configuration error carries the typed name for callers to branch on", () => {
    try {
      readStagingSessionSigningConfig({
        ...VALID_ENV,
        STAGING_SESSION_EXCHANGE_SIGNING_SECRET: "x",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StagingSessionConfigurationError);
      expect((error as Error).name).toBe("StagingSessionConfigurationError");
    }
  });
});

describe("isStagingSessionSigningConfigured", () => {
  test("true only when the full config parses", () => {
    expect(isStagingSessionSigningConfigured(VALID_ENV)).toBe(true);
    expect(
      isStagingSessionSigningConfigured({
        ...VALID_ENV,
        STAGING_SESSION_EXCHANGE_SIGNING_SECRET: "short",
      }),
    ).toBe(false);
    expect(
      isStagingSessionSigningConfigured({
        ...VALID_ENV,
        STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: "wrong",
      }),
    ).toBe(false);
  });
});

describe("isStagingSessionExchangeEnabled", () => {
  test("enabled only for production-node staging with the exact flag and version", () => {
    expect(isStagingSessionExchangeEnabled(VALID_ENV)).toBe(true);
  });

  test.each([
    ["NODE_ENV development", { NODE_ENV: "development" }],
    ["ENVIRONMENT production", { ENVIRONMENT: "production" }],
    ["flag missing", { STAGING_SESSION_EXCHANGE_ENABLED: undefined }],
    ["flag '1'", { STAGING_SESSION_EXCHANGE_ENABLED: "1" }],
    ["flag 'TRUE'", { STAGING_SESSION_EXCHANGE_ENABLED: "TRUE" }],
    ["version mismatch", { STAGING_SESSION_EXCHANGE_VERSION: "v2" }],
    ["version missing", { STAGING_SESSION_EXCHANGE_VERSION: undefined }],
  ] as const)("disabled when %s", (_label, patch) => {
    expect(isStagingSessionExchangeEnabled({ ...VALID_ENV, ...patch })).toBe(false);
  });
});

describe("loadExistingStagingSessionSubjectForMint", () => {
  test("mints a subject bound to the presented key's current hash and the 1h window", async () => {
    const { subject, binding } = await mintSubjectBinding();
    expect(binding.version).toBe("v1");
    expect(binding.apiKeyId).toBe(API_KEY_ID);
    expect(binding.cloudUserId).toBe(USER_ID);
    expect(binding.organizationId).toBe(ORG_ID);
    expect(binding.sessionIssuedAt).toBe(NOW_SECONDS);
    expect(binding.sessionMaxExpiresAt).toBe(NOW_SECONDS + 3600);
    // parity between WebCrypto in the module and node crypto here proves the
    // fingerprint is a deterministic HMAC over (domain, key id, key hash)
    expect(binding.credentialFingerprint).toBe(expectedFingerprint());
    expect(subject.stewardUserId).toBe(STEWARD_USER_ID);
    expect(subject.tenantId).toBe(TENANT_ID);
    expect(subject.expiration).toBe(NOW_SECONDS + 3600);
  });

  test("caps the session window at the source API key's own expiry", async () => {
    apiKeyBehavior = async () => makeApiKey({ expires_at: new Date((NOW_SECONDS + 600) * 1000) });
    const { subject } = await mintSubjectBinding();
    expect(subject.binding.sessionMaxExpiresAt).toBe(NOW_SECONDS + 600);
    expect(subject.expiration).toBe(NOW_SECONDS + 600);
  });

  test("rejects a presented key whose hash does not match the current row (rotation)", async () => {
    await expect(
      loadExistingStagingSessionSubjectForMint({
        env: VALID_ENV,
        apiKeyId: API_KEY_ID,
        presentedApiKey: "eliza-qa-rotated-different-key",
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: "source_key" });
  });

  test("rejects a stored key hash that is not 64-hex at mint", async () => {
    apiKeyBehavior = async () => makeApiKey({ key_hash: "not-hex" });
    await expect(
      loadExistingStagingSessionSubjectForMint({
        env: VALID_ENV,
        apiKeyId: API_KEY_ID,
        presentedApiKey: PRESENTED_API_KEY,
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: "source_key" });
  });

  test("revalidation also fails closed when the current stored hash turns malformed", async () => {
    // mint while the row is healthy, then corrupt the stored hash: the
    // binding_revalidation path must reject, not fall back to the old proof
    const { binding } = await mintSubjectBinding();
    apiKeyBehavior = async () => makeApiKey({ key_hash: "not-hex" });
    expect(await validateStagingSessionBinding(validValidationInput(binding))).toBe(false);
  });

  test.each([
    [
      "app credential shares the api_keys table",
      "app credential",
      async () => {
        appCredentialBehavior = async () => ({ id: "app-1" });
      },
      "source_key",
    ],
    [
      "agent-sandbox provisioner key",
      "sandbox key",
      async () => {
        apiKeyBehavior = async () => makeApiKey({ name: "agent-sandbox:box-1" });
      },
      "source_key",
    ],
    [
      "key not in the allowlist",
      "allowlist miss",
      async () => {
        apiKeyBehavior = async () => makeApiKey({ id: "99999999-9999-4999-8999-999999999999" });
      },
      "allowlist",
    ],
    [
      "user is deactivated",
      "user gate",
      async () => {
        userBehavior = async () => makeUser({ is_active: false });
      },
      "user",
    ],
    [
      "organization is deactivated",
      "org gate",
      async () => {
        userBehavior = async () =>
          makeUser({
            organization: { id: ORG_ID, is_active: false, steward_tenant_id: TENANT_ID },
          });
      },
      "organization",
    ],
    [
      "steward identity uses a reserved prefix",
      "identity gate",
      async () => {
        userBehavior = async () => makeUser({ steward_user_id: "email:qa@example.com" });
      },
      "steward_identity",
    ],
    [
      "organization tenant does not match STEWARD_TENANT_ID",
      "tenant gate",
      async () => {
        userBehavior = async () =>
          makeUser({
            organization: { id: ORG_ID, is_active: true, steward_tenant_id: "tenant-other" },
          });
      },
      "tenant",
    ],
  ] as const)(
    "%s is rejected with reason %s before any session is minted",
    async (_label, _name, setup, reason) => {
      await setup();
      await expect(
        loadExistingStagingSessionSubjectForMint({
          env: VALID_ENV,
          apiKeyId: API_KEY_ID,
          presentedApiKey: PRESENTED_API_KEY,
          now: NOW,
        }),
      ).rejects.toMatchObject({ reason });
    },
  );

  test("rejects with a configuration error when the exchange is disabled", async () => {
    await expect(
      loadExistingStagingSessionSubjectForMint({
        env: { ...VALID_ENV, STAGING_SESSION_EXCHANGE_ENABLED: "false" },
        apiKeyId: API_KEY_ID,
        presentedApiKey: PRESENTED_API_KEY,
        now: NOW,
      }),
    ).rejects.toThrow(StagingSessionConfigurationError);
  });

  test.each([
    ["a wildcard", "*"],
    ["a non-UUID entry", "not-a-uuid"],
    ["an empty comma-separated entry list", " , ,"],
  ] as const)(
    "fails closed at config parse when the api-key allowlist contains %s",
    async (_label: string, raw: string) => {
      // a permissive parse would turn these into silent eligibility misses;
      // the boundary must reject the configuration itself
      let caught: unknown;
      try {
        await loadExistingStagingSessionSubjectForMint({
          env: { ...VALID_ENV, STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS: raw },
          apiKeyId: API_KEY_ID,
          presentedApiKey: PRESENTED_API_KEY,
          now: NOW,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StagingSessionConfigurationError);
    },
  );

  test("fails closed at config parse when an allowlist exceeds 100 entries", async () => {
    const raw = Array.from(
      { length: 101 },
      (_, i) => `99999999-9999-4999-8999-${String(i).padStart(12, "0")}`,
    ).join(",");
    await expect(
      loadExistingStagingSessionSubjectForMint({
        env: { ...VALID_ENV, STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS: raw },
        apiKeyId: API_KEY_ID,
        presentedApiKey: PRESENTED_API_KEY,
        now: NOW,
      }),
    ).rejects.toThrow(StagingSessionConfigurationError);
  });

  test("an expired source key yields no session (window would be empty)", async () => {
    apiKeyBehavior = async () => makeApiKey({ expires_at: new Date((NOW_SECONDS - 60) * 1000) });
    await expect(
      loadExistingStagingSessionSubjectForMint({
        env: VALID_ENV,
        apiKeyId: API_KEY_ID,
        presentedApiKey: PRESENTED_API_KEY,
        now: NOW,
      }),
    ).rejects.toMatchObject({ reason: "source_key" });
  });
});

describe("validateStagingSessionBinding", () => {
  test("accepts a freshly minted binding end to end", async () => {
    const { binding } = await mintSubjectBinding();
    expect(await validateStagingSessionBinding(validValidationInput(binding))).toBe(true);
  });

  test("pins the exact five-second issuer skew boundary on both sides", async () => {
    // Literals, not the production export: this test fails if the allowance
    // is widened past five seconds (the +6 cases above) or narrowed below it
    // (the exact-boundary acceptances here), so a silent policy change in
    // either direction is caught.
    expect(
      await validateStagingSessionBinding({
        ...validValidationInput(
          makeBinding({
            sessionIssuedAt: NOW_SECONDS + 5,
            sessionMaxExpiresAt: NOW_SECONDS + 3600,
          }),
        ),
        issuedAt: NOW_SECONDS + 5,
      }),
    ).toBe(true);
    expect(
      await validateStagingSessionBinding({
        ...validValidationInput(
          makeBinding({ sessionIssuedAt: NOW_SECONDS, sessionMaxExpiresAt: NOW_SECONDS + 3600 }),
        ),
        issuedAt: NOW_SECONDS + 5,
      }),
    ).toBe(true);
    // A binding minted beyond the skew allowance cannot be isolated from the
    // token-iat bound: iat >= sessionIssuedAt always drags the token past the
    // same allowance, so the "+6" reject case below (iat NOW+6 against a NOW
    // binding) is the one that flips if the policy is widened past five
    // seconds, and the accept pins above flip if it is narrowed.
  });

  test("pins the exact one-hour absolute-window cap on both sides", async () => {
    expect(
      await validateStagingSessionBinding(
        validValidationInput(
          makeBinding({
            sessionIssuedAt: NOW_SECONDS,
            sessionMaxExpiresAt: NOW_SECONDS + 3600,
          }),
        ),
      ),
    ).toBe(true);
  });

  test("rejects a binding when the bearer logged out at or after mint", async () => {
    const { binding } = await mintSubjectBinding();
    logoutMarkerBehavior = async () => ({
      logged_out_at: new Date(binding.sessionIssuedAt * 1000),
    });
    expect(await validateStagingSessionBinding(validValidationInput(binding))).toBe(false);
    // a logout BEFORE mint does not invalidate the newer session
    logoutMarkerBehavior = async () => ({
      logged_out_at: new Date((binding.sessionIssuedAt - 1) * 1000),
    });
    expect(await validateStagingSessionBinding(validValidationInput(binding))).toBe(true);
  });

  test("rejects when the verified subject no longer matches the binding", async () => {
    const { binding } = await mintSubjectBinding();
    expect(
      await validateStagingSessionBinding({
        ...validValidationInput(binding),
        stewardUserId: "usr_someone_else",
      }),
    ).toBe(false);
    expect(
      await validateStagingSessionBinding({
        ...validValidationInput(binding),
        tenantId: "tenant-other",
      }),
    ).toBe(false);
    expect(
      await validateStagingSessionBinding({
        ...validValidationInput(binding),
        binding: makeBinding({ credentialFingerprint: "0".repeat(64) }),
      }),
    ).toBe(false);
  });

  test.each([
    ["wrong binding version", makeBinding({ version: "v0" })],
    ["non-UUID api key id", makeBinding({ apiKeyId: "not-a-uuid" })],
    ["non-UUID cloud user id", makeBinding({ cloudUserId: "not-a-uuid" })],
    ["non-UUID organization id", makeBinding({ organizationId: "not-a-uuid" })],
    ["fingerprint that is 63 hex chars", makeBinding({ credentialFingerprint: "a".repeat(63) })],
    ["fractional sessionIssuedAt", makeBinding({ sessionIssuedAt: NOW_SECONDS + 0.5 })],
    [
      "fractional sessionMaxExpiresAt within the TTL",
      makeBinding({ sessionMaxExpiresAt: NOW_SECONDS + 3599.5 }),
    ],
    ["empty absolute window", makeBinding({ sessionMaxExpiresAt: NOW_SECONDS })],
    [
      // one second past the documented one-hour cap; literal for the same
      // reason as the skew case above
      "absolute window beyond the max TTL",
      makeBinding({ sessionMaxExpiresAt: NOW_SECONDS + 3601 }),
    ],
    ["already-expired session bound", makeBinding({ sessionMaxExpiresAt: NOW_SECONDS - 1 })],
  ] as const)(
    "structurally rejects %s before touching primary storage",
    async (_label: string, binding: ReturnType<typeof makeBinding>) => {
      findActiveCalls = 0;
      expect(await validateStagingSessionBinding(validValidationInput(binding))).toBe(false);
      expect(findActiveCalls).toBe(0);
    },
  );

  test.each([
    ["token iat before the session window", { issuedAt: NOW_SECONDS - 1 }],
    [
      // one second past the documented five-second token-iat skew; literal so
      // widening the production constant fails this case rather than moving it
      "token iat more than the issuer skew allowance in the future",
      { issuedAt: NOW_SECONDS + 6 },
    ],
    ["fractional token iat inside the skew allowance", { issuedAt: NOW_SECONDS + 2.5 }],
    ["token exp not after iat", { issuedAt: NOW_SECONDS + 2, expiration: NOW_SECONDS + 2 }],
    [
      // one second past the documented one-hour bound cap; literal for the
      // same reason as the skew case above
      "token exp beyond the session bound",
      { expiration: NOW_SECONDS + 3601 },
    ],
    ["fractional token exp", { expiration: NOW_SECONDS + 1800.5 }],
  ] as const)("structurally rejects %s", async (_label, patch) => {
    const { binding } = await mintSubjectBinding();
    findActiveCalls = 0;
    expect(
      await validateStagingSessionBinding({ ...validValidationInput(binding), ...patch }),
    ).toBe(false);
    expect(findActiveCalls).toBe(0);
  });

  test("rejects a binding whose bound expiry exceeds the current subject window", async () => {
    apiKeyBehavior = async () => makeApiKey({ expires_at: new Date((NOW_SECONDS + 600) * 1000) });
    // mint against the long-lived key, then revalidate after the key was
    // rotated to a shorter expiry: the absolute bound must not survive
    const longBinding = makeBinding({
      sessionIssuedAt: NOW_SECONDS,
      sessionMaxExpiresAt: NOW_SECONDS + 3600,
    });
    expect(await validateStagingSessionBinding(validValidationInput(longBinding))).toBe(false);
  });

  test("rejects a binding minted beyond the 5s issuer clock-skew allowance", async () => {
    // 60s ahead is far beyond the allowed skew but inside every other window,
    // so only the skew bound itself rejects it
    const futureBinding = makeBinding({
      sessionIssuedAt: NOW_SECONDS + 60,
      sessionMaxExpiresAt: NOW_SECONDS + 3600,
    });
    expect(
      await validateStagingSessionBinding({
        ...validValidationInput(futureBinding),
        issuedAt: NOW_SECONDS + 60,
        expiration: NOW_SECONDS + 1800,
      }),
    ).toBe(false);
  });

  test("returns false (not a throw) when the exchange becomes disabled", async () => {
    const { binding } = await mintSubjectBinding();
    expect(
      await validateStagingSessionBinding({
        ...validValidationInput(binding),
        env: { ...VALID_ENV, STAGING_SESSION_EXCHANGE_ENABLED: "false" },
      }),
    ).toBe(false);
  });
});

describe("loadVerifiedStagingSessionUser", () => {
  test("returns the bound user only while identity and org still match", async () => {
    const { binding } = await mintSubjectBinding();
    const user = await loadVerifiedStagingSessionUser({
      binding,
      stewardUserId: STEWARD_USER_ID,
      now: NOW,
    });
    expect(user?.id).toBe(USER_ID);

    expect(
      await loadVerifiedStagingSessionUser({
        binding,
        stewardUserId: "usr_relinked_identity",
        now: NOW,
      }),
    ).toBeNull();
    userBehavior = async () =>
      makeUser({ organization_id: "44444444-4444-4444-8444-444444444444" });
    expect(
      await loadVerifiedStagingSessionUser({
        binding,
        stewardUserId: STEWARD_USER_ID,
        now: NOW,
      }),
    ).toBeNull();
  });
});
