/** Verifies Cloud migrations keep database identity checks explicitly gated and pre-mutation. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const canonicalSource = readFileSync(
  new URL("../../../.github/workflows/cloud-cf-release.yml", import.meta.url),
  "utf8",
);
const legacySource = readFileSync(
  new URL(
    "../../../.github/workflows/cloud-deploy-backend.yml",
    import.meta.url,
  ),
  "utf8",
);

function expectGatedMigration(
  source: string,
  expectedEnvironmentExpression: string,
): void {
  const preflight = source.indexOf("preflight-database-identity.ts");
  const migration = source.indexOf("bun run db:cloud:migrate", preflight);
  expect(preflight).toBeGreaterThan(0);
  expect(migration).toBeGreaterThan(preflight);
  const block = source.slice(preflight - 2_500, migration);
  expect(block).toContain(
    "DATABASE_IDENTITY_GATE_MODE: $" +
      "{{ vars.DATABASE_IDENTITY_GATE_MODE || 'off' }}",
  );
  expect(block).toContain(expectedEnvironmentExpression);
  expect(block).toContain("DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256");
  expect(block).toContain("DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256");
  expect(block).not.toContain("railway variables --set");
  expect(block).not.toContain("wrangler hyperdrive update");
}

describe("Cloud database identity workflow", () => {
  test("gates canonical migrations immediately before mutation", () => {
    expectGatedMigration(
      canonicalSource,
      "DATABASE_IDENTITY_ENVIRONMENT: $" + "{{ inputs.target_environment }}",
    );
  });

  test("gates explicit legacy migrations with the selected environment", () => {
    expectGatedMigration(
      legacySource,
      "DATABASE_IDENTITY_ENVIRONMENT: $" +
        "{{ needs.determine-env.outputs.environment }}",
    );
  });
});
