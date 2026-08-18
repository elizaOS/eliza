/** Guards the inert-by-default, fail-closed Railway PostgreSQL release gate. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../../.github/workflows/cloud-cf-release.yml", import.meta.url),
  "utf8",
);
const parsed = Bun.YAML.parse(workflow) as {
  jobs?: { "migrate-db"?: { env?: Record<string, string> } };
};

describe("Cloud PostgreSQL resilience release gate", () => {
  test("is off by default and performs no Railway query in off mode", () => {
    expect(workflow).toContain(
      "DATABASE_RESILIENCE_GATE_MODE: $" +
        "{{ vars.DATABASE_RESILIENCE_GATE_MODE || 'off' }}",
    );
    expect(workflow).toContain('case "$DATABASE_RESILIENCE_GATE_MODE" in');
    expect(workflow).toContain("off)");
    expect(workflow).toContain('echo "enabled=false"');
    expect(workflow).toContain(
      "if: $" + "{{ steps.database_resilience.outputs.enabled == 'true' }}",
    );
  });

  test("uses only protected setting names and exact Railway target arguments", () => {
    for (const name of [
      "RAILWAY_PROJECT_ID",
      "RAILWAY_ENVIRONMENT_ID",
      "RAILWAY_POSTGRES_SERVICE_ID",
    ]) {
      expect(workflow).toContain(`\n            ${name}\n`);
    }
    expect(workflow).toContain(
      "HAS_RAILWAY_TOKEN: $" + "{{ secrets.RAILWAY_TOKEN != '' }}",
    );
    expect(workflow).toContain('missing+=("RAILWAY_TOKEN")');
    expect(workflow).toContain('--project "$RAILWAY_PROJECT_ID"');
    expect(workflow).toContain('--environment "$RAILWAY_ENVIRONMENT_ID"');
    expect(workflow).toContain('--service "$RAILWAY_POSTGRES_SERVICE_ID"');
    expect(workflow).not.toContain('echo "$RAILWAY_TOKEN"');
    expect(workflow).not.toContain("railway variable list");
    expect(parsed.jobs?.["migrate-db"]?.env?.RAILWAY_TOKEN).toBeUndefined();
  });

  test("pins and verifies the Railway CLI artifact", () => {
    expect(workflow).toContain("v5.38.0");
    expect(workflow).toContain(
      "72835c48a710c48c4542141bf12264823cf3a029b514f9e27994096c036c539e",
    );
    expect(workflow).toContain("sha256sum --check --status");
  });

  test("captures only read-only status, service, PITR, schedule, and backup lists", () => {
    for (const command of [
      "railway status",
      "railway service list",
      "railway api",
      "railway postgres pitr status",
      "railway postgres pitr schedule list",
      "railway postgres pitr backup list",
    ]) {
      expect(workflow).toContain(command);
    }
    for (const mutation of [
      "railway postgres pitr enable",
      "railway postgres pitr restore",
      "railway postgres pitr schedule set",
      "railway postgres pitr backup create",
      "railway add",
      "railway delete",
      "mutation VolumeEvidence",
    ]) {
      expect(workflow).not.toContain(mutation);
    }
  });

  test("runs before migrations and preserves enforce failure", () => {
    const preflight = workflow.indexOf(
      "Verify backup, PITR, and physical-isolation evidence",
    );
    const migrations = workflow.indexOf("name: Run migrations");
    expect(preflight).toBeGreaterThan(-1);
    expect(migrations).toBeGreaterThan(preflight);
    expect(workflow).toContain(
      "bun packages/cloud/scripts/admin/preflight-railway-postgres-resilience.ts",
    );
    expect(workflow).toContain('gate_status="$?"');
    expect(workflow).toContain('if [ "$gate_status" -ne 0 ]');
    expect(workflow).toContain('"- \\(.key)Receipt: \\(.value)"');
    expect(workflow).not.toContain(
      "continue-on-error: true\n        env:\n          TARGET_ENVIRONMENT",
    );
  });

  test("requires production service and volume receipts for staging", () => {
    expect(workflow).toContain("RAILWAY_PRODUCTION_POSTGRES_SERVICE_RECEIPT");
    expect(workflow).toContain("RAILWAY_PRODUCTION_POSTGRES_VOLUME_RECEIPT");
    expect(workflow).toContain(
      '--production-service-receipt "$RAILWAY_PRODUCTION_POSTGRES_SERVICE_RECEIPT"',
    );
    expect(workflow).toContain(
      '--production-volume-receipt "$RAILWAY_PRODUCTION_POSTGRES_VOLUME_RECEIPT"',
    );
    expect(workflow).toContain('--volumes-json "$evidence_dir/volumes.json"');
  });
});
