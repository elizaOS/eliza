/** Verifies Cloud migrations keep database identity checks explicitly gated and pre-mutation. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../../.github/workflows/cloud-cf-release.yml", import.meta.url),
  "utf8",
);

describe("Cloud database identity workflow", () => {
  test("delegates identity enforcement to the migration session", () => {
    const migration = source.indexOf("bun run db:cloud:migrate");
    expect(migration).toBeGreaterThan(0);
    const block = source.slice(migration - 2_500, migration + 100);
    expect(block).toContain(
      "DATABASE_IDENTITY_GATE_MODE: $" +
        "{{ vars.DATABASE_IDENTITY_GATE_MODE || 'off' }}",
    );
    expect(block).toContain(
      "DATABASE_IDENTITY_ENVIRONMENT: $" + "{{ inputs.target_environment }}",
    );
    expect(block).toContain("DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256");
    expect(block).toContain("DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256");
    expect(block).toContain("exact PostgreSQL session");
    expect(block).not.toContain(
      "bun --conditions=eliza-source packages/cloud/scripts/admin/preflight-database-identity.ts",
    );
    expect(block).not.toContain("railway variables --set");
    expect(block).not.toContain("wrangler hyperdrive update");
  });
});
