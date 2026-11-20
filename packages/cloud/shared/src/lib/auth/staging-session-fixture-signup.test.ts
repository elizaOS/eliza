import { describe, expect, it } from "bun:test";
import type { StagingSessionBindingEnv } from "./staging-session-binding";
import {
  classifyStagingSessionFixtureSignup,
  STAGING_SESSION_FIXTURE_TENANT_ID,
} from "./staging-session-fixture-signup";
import type { StewardTokenClaims } from "./steward-client";

const email = "staging-fixture@example.invalid";
const env: StagingSessionBindingEnv = {
  NODE_ENV: "production",
  ENVIRONMENT: "staging",
  STEWARD_TENANT_ID: STAGING_SESSION_FIXTURE_TENANT_ID,
  STAGING_SESSION_EXCHANGE_FIXTURE_EMAIL: email,
};
const verifiedSession: StewardTokenClaims = {
  userId: "6e7ca490-90ff-4fc0-9554-35ba92730607",
  email,
  tenantId: STAGING_SESSION_FIXTURE_TENANT_ID,
  authMethod: "email",
  expiration: 2_000_000_060,
  issuedAt: 2_000_000_000,
};
const input = {
  email,
  stewardUserId: verifiedSession.userId,
  verifiedSession,
};

describe("staging session fixture signup", () => {
  it("selects the fixture for its exact verified staging email sign-in", () => {
    expect(classifyStagingSessionFixtureSignup(env, input)).toBe("fixture");
  });

  it("preserves ordinary signup outside the designated fixture", () => {
    expect(classifyStagingSessionFixtureSignup({ ...env, ENVIRONMENT: "production" }, input)).toBe(
      "ordinary",
    );
    expect(classifyStagingSessionFixtureSignup({ ...env, NODE_ENV: "test" }, input)).toBe(
      "ordinary",
    );
    expect(
      classifyStagingSessionFixtureSignup(
        { ...env, STAGING_SESSION_EXCHANGE_FIXTURE_EMAIL: " " },
        input,
      ),
    ).toBe("ordinary");
    expect(
      classifyStagingSessionFixtureSignup(env, {
        ...input,
        email: "another@example.invalid",
      }),
    ).toBe("ordinary");
  });

  it("keeps the fixture signup guarded by the exact verified subject and tenant", () => {
    expect(classifyStagingSessionFixtureSignup(env, { ...input, verifiedSession: undefined })).toBe(
      "unverified",
    );
    expect(classifyStagingSessionFixtureSignup({ ...env, STEWARD_TENANT_ID: "other" }, input)).toBe(
      "unverified",
    );
    for (const difference of [
      { authMethod: "google" },
      { tenantId: "other" },
      { userId: "other" },
      { email: "another@example.invalid" },
      { bridged: true },
    ]) {
      expect(
        classifyStagingSessionFixtureSignup(env, {
          ...input,
          verifiedSession: { ...verifiedSession, ...difference },
        }),
      ).toBe("unverified");
    }
  });

  it("refuses a session that was already minted by the QA exchange", () => {
    expect(
      classifyStagingSessionFixtureSignup(env, {
        ...input,
        verifiedSession: {
          ...verifiedSession,
          stagingSessionBinding: {
            version: "v1",
            apiKeyId: "key",
            cloudUserId: "user",
            organizationId: "organization",
            credentialFingerprint: "fingerprint",
            sessionIssuedAt: verifiedSession.issuedAt,
            sessionMaxExpiresAt: verifiedSession.expiration,
          },
        },
      }),
    ).toBe("unverified");
  });

  it("requires an ordinary Steward user", () => {
    const userId = "system:fixture";
    expect(
      classifyStagingSessionFixtureSignup(env, {
        ...input,
        stewardUserId: userId,
        verifiedSession: { ...verifiedSession, userId },
      }),
    ).toBe("unverified");
  });
});
