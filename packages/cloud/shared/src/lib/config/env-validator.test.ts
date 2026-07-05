/**
 * Environment validation coverage for shared cloud configuration gates.
 * These tests exercise the startup validator with a minimal valid environment so
 * optional-key format checks cannot drift from runtime provider initialization.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { validateEnvironment } from "./env-validator";

const ORIGINAL_ENV = { ...process.env };

function withBaseEnv(stripeSecretKey: string) {
  process.env = {
    ...ORIGINAL_ENV,
    DATABASE_URL: "postgresql://user:pass@localhost:5432/eliza",
    STEWARD_SESSION_SECRET: "x".repeat(32),
    CRON_SECRET: "y".repeat(32),
    STRIPE_SECRET_KEY: stripeSecretKey,
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("validateEnvironment", () => {
  it("accepts Stripe secret and restricted keys that runtime initialization supports", () => {
    for (const key of ["sk_test_123", "sk_live_123", "rk_test_123", "rk_live_123"]) {
      withBaseEnv(key);

      const result = validateEnvironment();

      expect(result.errors.filter((error) => error.variable === "STRIPE_SECRET_KEY")).toEqual([]);
      expect(result.warnings.filter((warning) => warning.variable === "STRIPE_SECRET_KEY")).toEqual(
        [],
      );
    }
  });

  it("warns on unsupported Stripe key prefixes", () => {
    withBaseEnv("pk_test_123");

    const result = validateEnvironment();

    expect(result.warnings).toContainEqual({
      variable: "STRIPE_SECRET_KEY",
      message:
        "STRIPE_SECRET_KEY: Must start with 'sk_test_', 'sk_live_', 'rk_test_', or 'rk_live_'. Feature may not work correctly.",
      required: false,
    });
  });
});
