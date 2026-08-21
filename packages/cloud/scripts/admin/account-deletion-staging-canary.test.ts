/**
 * Verifies the staging canary's deterministic target, authority, cleanup, and
 * privacy gates without contacting Cloud, Steward, or PostgreSQL.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type AccountDeletionStagingCanaryEvidence,
  isExactAccountDeletionStagingDatabaseUrl,
  readAccountDeletionStagingCanaryConfig,
  validateAccountDeletionStagingCanaryEvidence,
} from "./account-deletion-staging-canary";

const validEnvironment = {
  ELIZA_ACCOUNT_DELETION_STAGING_CANARY: "1",
  ELIZA_ACCOUNT_DELETION_STAGING_CLOUD_BASE_URL:
    "https://api-staging.eliza.app",
  ELIZA_ACCOUNT_DELETION_STAGING_CLOUD_ORIGIN:
    "https://cloud-staging.eliza.app",
  ELIZA_ACCOUNT_DELETION_STAGING_STEWARD_BASE_URL:
    "https://steward-api-staging.up.railway.app",
  ELIZA_ACCOUNT_DELETION_STAGING_ALLOW_RAILWAY_SELF_SIGNED_TLS: "1",
  ELIZA_ACCOUNT_DELETION_STAGING_EXPECTED_CLOUD_COMMIT: "a".repeat(40),
  ELIZA_ACCOUNT_DELETION_STAGING_EXPECTED_CLUSTER_SHA256: "b".repeat(64),
  ELIZA_ACCOUNT_DELETION_STAGING_EXPECTED_AUTHORITY_SHA256: "c".repeat(64),
  ELIZA_ACCOUNT_DELETION_STAGING_RUN_SUFFIX: "r12345678a1",
  DATABASE_URL:
    "postgresql://staging_user:secret@switchback.proxy.rlwy.net:49295/eliza_staging?sslmode=require",
  STEWARD_PLATFORM_KEY: "secret-platform-key",
} as const;

function evidence(): AccountDeletionStagingCanaryEvidence {
  return {
    schemaVersion: 1,
    verdict: "pass",
    cloudCommit: "a".repeat(40),
    database: { identityVerified: true, postgresMajor: 18 },
    path: {
      providerPersonalLifecycle: true,
      targetSessionExchange: true,
      controlSessionExchange: true,
      scheduled: true,
      immediateDeactivation: true,
      scheduledWorkerCompleted: true,
      cloudErasure: true,
      providerErasure: true,
      controlPreserved: true,
    },
    cleanup: { status: "passed", possibleResidue: false },
    timingsMs: { total: 1 },
    failure: null,
  };
}

describe("account deletion staging canary", () => {
  test("accepts only the exact staging PostgreSQL authority", () => {
    expect(
      isExactAccountDeletionStagingDatabaseUrl(validEnvironment.DATABASE_URL),
    ).toBe(true);
    for (const value of [
      "postgresql://user:secret@switchback.proxy.rlwy.net:49295/production",
      "postgresql://user:secret@other.example:49295/eliza_staging",
      "postgresql://user:secret@switchback.proxy.rlwy.net:5432/eliza_staging",
      "postgresql://switchback.proxy.rlwy.net:49295/eliza_staging",
      "postgresql://user:secret@switchback.proxy.rlwy.net:49295/eliza_staging?sslmode=require&options=unsafe",
      "not-a-url",
    ]) {
      expect(isExactAccountDeletionStagingDatabaseUrl(value)).toBe(false);
    }
  });

  test("requires explicit opt-in and exact Cloud and Steward staging origins", () => {
    expect(() =>
      readAccountDeletionStagingCanaryConfig({
        ...validEnvironment,
        ELIZA_ACCOUNT_DELETION_STAGING_CANARY: "0",
      }),
    ).toThrow("explicit_opt_in_required");
    expect(() =>
      readAccountDeletionStagingCanaryConfig({
        ...validEnvironment,
        ELIZA_ACCOUNT_DELETION_STAGING_CLOUD_BASE_URL: "https://api.eliza.app",
      }),
    ).toThrow("non_staging_cloud_target");
    expect(() =>
      readAccountDeletionStagingCanaryConfig({
        ...validEnvironment,
        ELIZA_ACCOUNT_DELETION_STAGING_STEWARD_BASE_URL:
          "https://steward.example",
      }),
    ).toThrow("non_staging_steward_target");
  });

  test("requires reviewed commit and database identity receipts", () => {
    expect(() =>
      readAccountDeletionStagingCanaryConfig({
        ...validEnvironment,
        ELIZA_ACCOUNT_DELETION_STAGING_EXPECTED_CLOUD_COMMIT: "develop",
      }),
    ).toThrow("invalid_expected_cloud_commit");
    expect(() =>
      readAccountDeletionStagingCanaryConfig({
        ...validEnvironment,
        ELIZA_ACCOUNT_DELETION_STAGING_EXPECTED_CLUSTER_SHA256:
          "raw-cluster-id",
      }),
    ).toThrow("invalid_expected_cluster_receipt");
    expect(() =>
      readAccountDeletionStagingCanaryConfig({
        ...validEnvironment,
        ELIZA_ACCOUNT_DELETION_STAGING_ALLOW_RAILWAY_SELF_SIGNED_TLS: "0",
      }),
    ).toThrow("railway_tls_opt_in_required");
    expect(() =>
      readAccountDeletionStagingCanaryConfig({
        ...validEnvironment,
        ELIZA_ACCOUNT_DELETION_STAGING_EVIDENCE_PATH: "/tmp/canary.json",
      }),
    ).toThrow("invalid_evidence_path");
    expect(() =>
      readAccountDeletionStagingCanaryConfig({
        ...validEnvironment,
        ELIZA_ACCOUNT_DELETION_STAGING_COMPLETION_TIMEOUT_MS: "1000",
      }),
    ).toThrow("invalid_completion_timeout_ms");
  });

  test("parses a valid authority without retaining credentials in evidence", () => {
    const config = readAccountDeletionStagingCanaryConfig(validEnvironment);
    expect(config.expectedCloudCommit).toBe("a".repeat(40));
    expect(config.runSuffix).toBe("r12345678a1");
    expect(
      readAccountDeletionStagingCanaryConfig({
        ...validEnvironment,
        STEWARD_PLATFORM_KEY: undefined,
        STEWARD_PLATFORM_KEYS: "first-key,second-key",
      }).platformKey,
    ).toBe("first-key");
    expect(validateAccountDeletionStagingCanaryEvidence(evidence())).toBe(true);

    const contaminated = evidence() as AccountDeletionStagingCanaryEvidence & {
      leaked?: string;
    };
    contaminated.leaked = "test-123456@steward.test";
    expect(validateAccountDeletionStagingCanaryEvidence(contaminated)).toBe(
      false,
    );
  });

  test("locks exact-row acceleration and scoped cleanup in source", () => {
    const source = readFileSync(
      new URL("./account-deletion-staging-canary.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      `account_deletion_canary_${["$", "{", "requestId", "}"].join("")}`,
    );
    expect(source).toContain(
      "AND user_id = $2 AND organization_id = $3 AND steward_user_id = $4",
    );
    expect(source).toContain("members.rows.length !== 1");
    expect(source).toContain("cloud_cleanup_scope_mismatch");
    expect(
      source.match(/DELETE FROM organizations WHERE id = \$1 RETURNING id/g),
    ).toHaveLength(2);
    expect(source).toContain("await steward.assertTenantAbsent(tenantId)");
    expect(source).toContain("await database.assertStewardIdentityAbsent");
    expect(source).toContain("await database.assertCloudEmailAbsent");
    expect(source).not.toContain("DELETE FROM users");
  });
});
