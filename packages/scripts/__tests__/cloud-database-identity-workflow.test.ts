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
const provisioningSource = readFileSync(
  new URL(
    "../../../.github/workflows/deploy-eliza-provisioning-worker.yml",
    import.meta.url,
  ),
  "utf8",
);

function expectSameSessionGate(
  source: string,
  environmentExpression: string,
): void {
  const migration = source.indexOf("bun run db:cloud:migrate");
  expect(migration).toBeGreaterThan(0);
  const block = source.slice(migration - 3_000, migration + 100);
  expect(block).toContain(
    "DATABASE_IDENTITY_GATE_MODE: $" +
      "{{ vars.DATABASE_IDENTITY_GATE_MODE || 'off' }}",
  );
  expect(block).toContain(environmentExpression);
  expect(block).toContain("DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256");
  expect(block).toContain("DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256");
  expect(block).not.toContain(
    "bun --conditions=eliza-source packages/cloud/scripts/admin/preflight-database-identity.ts",
  );
  expect(block).not.toContain("railway variables --set");
  expect(block).not.toContain("wrangler hyperdrive update");
}

describe("Cloud database identity workflow", () => {
  test("delegates canonical release enforcement to its migration session", () => {
    expectSameSessionGate(
      canonicalSource,
      "DATABASE_IDENTITY_ENVIRONMENT: $" + "{{ inputs.target_environment }}",
    );
    expect(canonicalSource).toContain("exact PostgreSQL session");
  });

  test("gates the explicit legacy migration on its selected environment", () => {
    expectSameSessionGate(
      legacySource,
      "DATABASE_IDENTITY_ENVIRONMENT: $" +
        "{{ needs.determine-env.outputs.environment }}",
    );
  });

  test("gates exact-SHA provisioning migrations on their selected environment", () => {
    expectSameSessionGate(
      provisioningSource,
      "DATABASE_IDENTITY_ENVIRONMENT: $" +
        "{{ needs.determine-env.outputs.environment }}",
    );
  });
});
