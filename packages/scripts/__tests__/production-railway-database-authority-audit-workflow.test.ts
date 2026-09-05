/** Guards the protected, read-only production Railway database authority audit. */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const workflowSource = readFileSync(
  new URL(
    "../../../.github/workflows/production-railway-database-authority-audit.yml",
    import.meta.url,
  ),
  "utf8",
);
const auditSource = readFileSync(
  new URL(
    "../../cloud/scripts/admin/audit-production-railway-database-authority.ts",
    import.meta.url,
  ),
  "utf8",
);

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
  run?: string;
}

interface Workflow {
  jobs?: Record<string, { environment?: string; steps?: WorkflowStep[] }>;
}

const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const job = workflow.jobs?.audit;
const steps = job?.steps ?? [];

function step(name: string): WorkflowStep {
  const found = steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing workflow step: ${name}`);
  return found;
}

describe("production Railway database authority audit workflow", () => {
  test("uses only the protected production environment and canonical main source", () => {
    expect(job?.environment).toBe("production");
    const config = step("Validate protected audit configuration");
    expect(config.env?.HAS_DATABASE_URL).toContain("secrets.DATABASE_URL");
    expect(config.env?.HAS_RAILWAY_TOKEN).toContain("secrets.RAILWAY_TOKEN");
    expect(config.env?.RAILWAY_PROJECT_ID).toContain("vars.RAILWAY_PROJECT_ID");
    expect(config.env?.RAILWAY_ENVIRONMENT_ID).toContain(
      "vars.RAILWAY_ENVIRONMENT_ID",
    );
    expect(config.run).toContain(
      ['if [ -n "$', '{RAILWAY_POSTGRES_SERVICE_ID:-}" ]'].join(""),
    );
    expect(config.run).not.toContain(
      "RAILWAY_ENVIRONMENT_ID \\\n            RAILWAY_POSTGRES_SERVICE_ID; do",
    );
  });

  test.each([
    ["refs/heads/main", 0],
    ["refs/heads/develop", 1],
    ["refs/heads/fix/deployment", 1],
    ["refs/tags/main", 1],
    ["", 1],
  ])("admits production audit source %s with exit %i", (sourceRef, status) => {
    const guard = step("Require canonical main source").run;
    if (!guard) throw new Error("Missing production source guard");
    const result = spawnSync("bash", ["-c", guard], {
      env: { PATH: process.env.PATH, SOURCE_REF: sourceRef },
      encoding: "utf8",
    });
    expect(result.status).toBe(status);
    if (status !== 0) {
      expect(result.stdout).toContain("must run from refs/heads/main");
    }
  });

  test("discovers one private Postgres target and never publishes its identity", () => {
    const capture = step(
      "Capture private read-only Railway authority evidence",
    );
    for (const command of [
      "railway status",
      "railway service list",
      "railway variable list",
      "resolve-production-railway-postgres-service.ts",
    ]) {
      expect(capture.run).toContain(command);
    }
    expect(capture.run).toContain('echo "::add-mask::$resolved_service_id"');
    expect(capture.run).toContain('--service "$resolved_service_id"');
    expect(capture.run).toContain("umask 077");
    expect(capture.run).not.toContain('cat "$evidence_dir');
    expect(workflowSource).not.toContain("actions/upload-artifact");
    expect(workflowSource).not.toContain("GITHUB_ENV");
  });

  test("wires the protected URL only to the database-enforced read-only audit", () => {
    const audit = step(
      "Audit protected database authority, schema, and migration ledger",
    );
    expect(audit.env?.DATABASE_URL).toContain("secrets.DATABASE_URL");
    expect(audit.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(audit.run).toContain(
      "audit-production-railway-database-authority.ts",
    );
    expect(audit.run).toContain("--resolved-service-id-file");
    expect(audit.run).toContain("canonical-deploy-source-guard.mjs");
    expect(audit.run).toContain(
      ["GITHUB_TOKEN='$", "{{ github.token }}'"].join(""),
    );
    expect(audit.run).toContain("--canonical-ref refs/heads/main");
    expect(audit.run).toContain("env -u GITHUB_STEP_SUMMARY");
    expect(audit.run?.indexOf("audit-production-railway")).toBeLessThan(
      audit.run?.indexOf("canonical-deploy-source-guard.mjs") ?? -1,
    );
    expect(
      audit.run?.indexOf("canonical-deploy-source-guard.mjs"),
    ).toBeLessThan(audit.run?.indexOf('tee -a "$GITHUB_STEP_SUMMARY"') ?? -1);
    expect(auditSource).toContain(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(auditSource).toContain(
      'options: "-c default_transaction_read_only=on"',
    );
    expect(auditSource).toContain(
      'if (report.verdict !== "pass") process.exitCode = 1',
    );
  });

  test("contains no database, Railway, or evidence-publishing mutation path", () => {
    for (const mutation of [
      "railway variable set",
      "railway add",
      "railway delete",
      "railway postgres pitr enable",
      "railway postgres pitr restore",
      "bun run db:cloud:migrate",
      "actions/upload-artifact",
    ]) {
      expect(workflowSource).not.toContain(mutation);
    }
    expect(auditSource).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/,
    );
    const cleanup = step("Destroy private audit evidence");
    expect(cleanup.run).toContain("shred -u");
    expect(cleanup.run).toContain("find");
  });
});
