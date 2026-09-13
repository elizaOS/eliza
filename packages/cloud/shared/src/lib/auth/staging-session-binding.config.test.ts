/**
 * Pins the configuration gate of the staging-only API-key-to-browser-session
 * bridge: the signing-key contract (`readStagingSessionSigningConfig`), its
 * boolean wrapper, and the four-conjunct enablement predicate.
 *
 * These are the checks that keep the exchange off everywhere but staging and
 * keep its signing key cryptographically distinct from every Steward secret,
 * so each clause is asserted on its own rather than through one happy path.
 * Deliberately mock-free: this surface reaches no repository, so the module
 * imports as-is.
 */

import { describe, expect, test } from "bun:test";
import {
  isStagingSessionExchangeEnabled,
  isStagingSessionSigningConfigured,
  readStagingSessionSigningConfig,
  STAGING_SESSION_EXCHANGE_VERSION,
  STAGING_SESSION_MAX_TTL_SECONDS,
  STAGING_SESSION_TOKEN_TYP,
  type StagingSessionBindingEnv,
  StagingSessionConfigurationError,
  StagingSessionEligibilityError,
} from "./staging-session-binding";

const SECRET = "staging-session-signing-secret-abcdefghijklmnop";
const KEY_ID = "staging-qa-v1-primary";

function signingEnv(overrides: Partial<StagingSessionBindingEnv> = {}): StagingSessionBindingEnv {
  return {
    STAGING_SESSION_EXCHANGE_SIGNING_SECRET: SECRET,
    STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: KEY_ID,
    ...overrides,
  };
}

function enabledEnv(overrides: Partial<StagingSessionBindingEnv> = {}): StagingSessionBindingEnv {
  return {
    NODE_ENV: "production",
    ENVIRONMENT: "staging",
    STAGING_SESSION_EXCHANGE_ENABLED: "true",
    STAGING_SESSION_EXCHANGE_VERSION: STAGING_SESSION_EXCHANGE_VERSION,
    ...overrides,
  };
}

describe("readStagingSessionSigningConfig — signing secret", () => {
  test("returns the trimmed secret and key id for a well-formed pair", () => {
    expect(
      readStagingSessionSigningConfig(
        signingEnv({
          STAGING_SESSION_EXCHANGE_SIGNING_SECRET: `  ${SECRET}  `,
          STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: `\t${KEY_ID}\n`,
        }),
      ),
    ).toEqual({ secret: SECRET, keyId: KEY_ID });
  });

  test("rejects a missing secret", () => {
    expect(() =>
      readStagingSessionSigningConfig(
        signingEnv({ STAGING_SESSION_EXCHANGE_SIGNING_SECRET: undefined }),
      ),
    ).toThrow(StagingSessionConfigurationError);
  });

  test("rejects a whitespace-only secret rather than accepting the padding as length", () => {
    expect(() =>
      readStagingSessionSigningConfig(
        signingEnv({ STAGING_SESSION_EXCHANGE_SIGNING_SECRET: " ".repeat(64) }),
      ),
    ).toThrow(/SIGNING_SECRET is missing or too short/);
  });

  test("length is measured after trimming: 32 padded to 40 is still too short", () => {
    expect(() =>
      readStagingSessionSigningConfig(
        signingEnv({ STAGING_SESSION_EXCHANGE_SIGNING_SECRET: `    ${"a".repeat(31)}    ` }),
      ),
    ).toThrow(/too short/);
  });

  test("31 characters is too short and 32 is the accepted boundary", () => {
    expect(() =>
      readStagingSessionSigningConfig(
        signingEnv({ STAGING_SESSION_EXCHANGE_SIGNING_SECRET: "a".repeat(31) }),
      ),
    ).toThrow(/too short/);
    expect(
      readStagingSessionSigningConfig(
        signingEnv({ STAGING_SESSION_EXCHANGE_SIGNING_SECRET: "a".repeat(32) }),
      ).secret,
    ).toBe("a".repeat(32));
  });
});

describe("readStagingSessionSigningConfig — signing key id", () => {
  test("rejects a missing key id", () => {
    expect(() =>
      readStagingSessionSigningConfig(
        signingEnv({ STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: undefined }),
      ),
    ).toThrow(/SIGNING_KEY_ID is invalid/);
  });

  test("requires the staging-qa-v1- prefix at the start of the value", () => {
    for (const keyId of ["staging-qa-v2-primary", "qa-v1-primary", "x-staging-qa-v1-primary"]) {
      expect(() =>
        readStagingSessionSigningConfig(
          signingEnv({ STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: keyId }),
        ),
      ).toThrow(/SIGNING_KEY_ID is invalid/);
    }
  });

  test("requires a non-empty suffix and caps it at 48 characters", () => {
    expect(() =>
      readStagingSessionSigningConfig(
        signingEnv({ STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: "staging-qa-v1-" }),
      ),
    ).toThrow(/SIGNING_KEY_ID is invalid/);
    expect(
      readStagingSessionSigningConfig(
        signingEnv({ STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: `staging-qa-v1-${"a".repeat(48)}` }),
      ).keyId,
    ).toBe(`staging-qa-v1-${"a".repeat(48)}`);
    expect(() =>
      readStagingSessionSigningConfig(
        signingEnv({ STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: `staging-qa-v1-${"a".repeat(49)}` }),
      ),
    ).toThrow(/SIGNING_KEY_ID is invalid/);
  });

  test("accepts only the dot/underscore/hyphen punctuation set in the suffix", () => {
    expect(
      readStagingSessionSigningConfig(
        signingEnv({ STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: "staging-qa-v1-a.b_c-D9" }),
      ).keyId,
    ).toBe("staging-qa-v1-a.b_c-D9");
    for (const suffix of ["a/b", "a b", "a:b", "a+b", "a%2f"]) {
      expect(() =>
        readStagingSessionSigningConfig(
          signingEnv({ STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: `staging-qa-v1-${suffix}` }),
        ),
      ).toThrow(/SIGNING_KEY_ID is invalid/);
    }
  });

  test("the pattern is end-anchored: trailing junk after a valid suffix is rejected", () => {
    expect(() =>
      readStagingSessionSigningConfig(
        signingEnv({
          STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: "staging-qa-v1-primary\nstaging-qa-v1-evil",
        }),
      ),
    ).toThrow(/SIGNING_KEY_ID is invalid/);
  });
});

describe("readStagingSessionSigningConfig — the key must be dedicated", () => {
  // Each Steward secret is a separate collision to rule out; one shared
  // assertion would let two of the three comparisons be deleted silently.
  const collisions: Array<[string, keyof StagingSessionBindingEnv]> = [
    ["STEWARD_JWT_SECRET", "STEWARD_JWT_SECRET"],
    ["STEWARD_SESSION_SECRET", "STEWARD_SESSION_SECRET"],
    ["ELIZA_SERVICE_JWT_SECRET", "ELIZA_SERVICE_JWT_SECRET"],
  ];

  for (const [label, key] of collisions) {
    test(`rejects a signing secret equal to ${label}`, () => {
      expect(() => readStagingSessionSigningConfig(signingEnv({ [key]: SECRET }))).toThrow(
        /must be dedicated/,
      );
    });

    test(`the ${label} comparison is made on trimmed values`, () => {
      expect(() => readStagingSessionSigningConfig(signingEnv({ [key]: `  ${SECRET}  ` }))).toThrow(
        /must be dedicated/,
      );
    });
  }

  test("an unset Steward secret does not collide with an unset-looking signing secret", () => {
    expect(readStagingSessionSigningConfig(signingEnv()).secret).toBe(SECRET);
  });

  test("a Steward secret that merely shares a prefix is not a collision", () => {
    expect(
      readStagingSessionSigningConfig(signingEnv({ STEWARD_JWT_SECRET: `${SECRET}x` })).secret,
    ).toBe(SECRET);
  });
});

describe("isStagingSessionSigningConfigured", () => {
  test("is true for a valid pair and false for each configuration failure", () => {
    expect(isStagingSessionSigningConfigured(signingEnv())).toBe(true);
    expect(
      isStagingSessionSigningConfigured(
        signingEnv({ STAGING_SESSION_EXCHANGE_SIGNING_SECRET: "short" }),
      ),
    ).toBe(false);
    expect(
      isStagingSessionSigningConfigured(
        signingEnv({ STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: "nope" }),
      ),
    ).toBe(false);
    expect(isStagingSessionSigningConfigured(signingEnv({ STEWARD_JWT_SECRET: SECRET }))).toBe(
      false,
    );
  });

  test("propagates a non-configuration failure instead of reporting 'not configured'", () => {
    const hostile = {
      get STAGING_SESSION_EXCHANGE_SIGNING_SECRET(): string {
        throw new TypeError("environment read failed");
      },
    } as unknown as StagingSessionBindingEnv;
    expect(() => isStagingSessionSigningConfigured(hostile)).toThrow(TypeError);
  });
});

describe("isStagingSessionExchangeEnabled", () => {
  test("is true only when all four conditions hold together", () => {
    expect(isStagingSessionExchangeEnabled(enabledEnv())).toBe(true);
  });

  // One conjunct at a time: a predicate that dropped any single clause would
  // still pass a test that only ever flips everything at once.
  const clauses: Array<[string, Partial<StagingSessionBindingEnv>]> = [
    ["NODE_ENV is not production", { NODE_ENV: "development" }],
    ["NODE_ENV is unset", { NODE_ENV: undefined }],
    ["ENVIRONMENT is not staging", { ENVIRONMENT: "production" }],
    ["ENVIRONMENT is unset", { ENVIRONMENT: undefined }],
    ["the enable flag is unset", { STAGING_SESSION_EXCHANGE_ENABLED: undefined }],
    ["the enable flag is a different version string", { STAGING_SESSION_EXCHANGE_VERSION: "v2" }],
    ["the version is unset", { STAGING_SESSION_EXCHANGE_VERSION: undefined }],
  ];

  for (const [label, override] of clauses) {
    test(`is false when ${label}`, () => {
      expect(isStagingSessionExchangeEnabled(enabledEnv(override))).toBe(false);
    });
  }

  test("the enable flag is the exact string 'true', not a truthy value", () => {
    for (const value of ["TRUE", "True", "1", "yes", "on", " true"]) {
      expect(
        isStagingSessionExchangeEnabled(enabledEnv({ STAGING_SESSION_EXCHANGE_ENABLED: value })),
      ).toBe(false);
    }
  });

  test("an empty environment is not enabled", () => {
    expect(isStagingSessionExchangeEnabled({})).toBe(false);
  });
});

describe("exchange constants and error types", () => {
  test("the wire constants are pinned", () => {
    expect(STAGING_SESSION_EXCHANGE_VERSION).toBe("v1");
    expect(STAGING_SESSION_TOKEN_TYP).toBe("eliza-staging-session+jwt");
    expect(STAGING_SESSION_MAX_TTL_SECONDS).toBe(3600);
  });

  test("StagingSessionConfigurationError carries its own name", () => {
    const error = new StagingSessionConfigurationError("boom");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StagingSessionConfigurationError");
    expect(error.message).toBe("boom");
  });

  test("StagingSessionEligibilityError keeps the reason off the message", () => {
    const error = new StagingSessionEligibilityError("tenant");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StagingSessionEligibilityError");
    expect(error.reason).toBe("tenant");
    // The reason is a structured field for logs; the message stays generic so
    // it can be surfaced without disclosing which check rejected the subject.
    expect(error.message).toBe("Staging session subject is not eligible");
    expect(error.message).not.toContain("tenant");
  });
});
