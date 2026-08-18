/** Verifies Cloud migrations keep database identity checks explicitly gated and pre-mutation. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../../.github/workflows/cloud-cf-release.yml", import.meta.url),
  "utf8",
);

describe("Cloud database identity workflow", () => {
  test("runs the read-only identity preflight immediately before migrations", () => {
    const preflight = source.indexOf("preflight-database-identity.ts");
    const migration = source.indexOf("bun run db:cloud:migrate", preflight);
    expect(preflight).toBeGreaterThan(0);
    expect(migration).toBeGreaterThan(preflight);
    const block = source.slice(preflight - 2_500, migration);
    expect(block).toContain(
      "DATABASE_IDENTITY_GATE_MODE: $" +
        "{{ vars.DATABASE_IDENTITY_GATE_MODE || 'off' }}",
    );
    expect(block).toContain(
      "DATABASE_IDENTITY_ENVIRONMENT: $" + "{{ inputs.target_environment }}",
    );
    expect(block).toContain("DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256");
    expect(block).toContain("DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256");
    expect(block).not.toContain("railway variables --set");
    expect(block).not.toContain("wrangler hyperdrive update");
  });
});
