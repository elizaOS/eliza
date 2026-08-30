/**
 * Pins fail-closed canonical-head checks to every Cloud provider mutation.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const workflowPath = join(
  import.meta.dir,
  "../../../.github/workflows/cloud-cf-release.yml",
);
const workflow = parse(readFileSync(workflowPath, "utf8"));

function steps(jobName: string): Array<{
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
}> {
  return workflow.jobs[jobName].steps;
}

function step(jobName: string, name: string) {
  const found = steps(jobName).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing ${jobName} step: ${name}`);
  return found;
}

describe("Cloud CF canonical source mutation guards", () => {
  it("rechecks inside migrations and Worker secret mutation/deploy", () => {
    const migrationGuard = step("migrate-db", "Verify canonical deploy source");
    const migration = step("migrate-db", "Run migrations");
    const secretMutation = step(
      "deploy-api",
      "Disable staging session exchange before cutover",
    );
    const workerDeploy = step("deploy-api", "Deploy to Cloudflare Workers");
    for (const guarded of [migrationGuard, secretMutation, workerDeploy]) {
      expect(guarded.run).toContain("canonical-deploy-source-guard.mjs");
      expect(guarded.run).toContain('--run-sha "$GITHUB_SHA"');
      expect(guarded.run).toContain('--canonical-ref "$CANONICAL_REF"');
      expect(guarded.run).toContain('if [ "$FORCE" = "true" ]');
    }

    // The first mutation of the release skips neutrally when the canonical
    // branch fast-forwarded past this run's SHA: the guard step emits
    // superseded=true and the migration step is gated on it.
    expect(migrationGuard.run).toContain("--neutral-when-superseded");
    expect(migrationGuard.run).toContain(
      'if [ "$NEUTRAL_WHEN_SUPERSEDED" = "true" ]',
    );
    expect(migrationGuard.env?.NEUTRAL_WHEN_SUPERSEDED).toContain(
      "inputs.target_environment == 'staging'",
    );
    expect(migrationGuard.env?.NEUTRAL_WHEN_SUPERSEDED).toContain(
      "github.event_name == 'push'",
    );
    expect(migrationGuard.env?.GITHUB_TOKEN).toContain("github.token");
    expect(migrationGuard.id).toBe("source_guard");
    expect(migration.if).toContain(
      "steps.source_guard.outputs.superseded != 'true'",
    );
    expect(migration.run).toContain("bun run db:cloud:migrate");
    expect(migration.run).toContain("canonical-deploy-source-guard.mjs");
    expect(migration.run).not.toContain("--neutral-when-superseded");
    const keywordGeneration =
      migration.run?.indexOf("generate-keywords.mjs") ?? -1;
    const finalSourceGuard =
      migration.run?.indexOf("canonical-deploy-source-guard.mjs") ?? -1;
    const databaseMutation =
      migration.run?.indexOf("bun run db:cloud:migrate") ?? -1;
    expect(keywordGeneration).toBeGreaterThan(-1);
    expect(finalSourceGuard).toBeGreaterThan(keywordGeneration);
    expect(databaseMutation).toBeGreaterThan(finalSourceGuard);

    // A superseded migrate-db skips every downstream mutation job and is
    // surfaced to the calling workflow for its certification gate.
    expect(workflow.jobs["migrate-db"].outputs?.superseded).toContain(
      "steps.source_guard.outputs.superseded",
    );
    expect(workflow.on.workflow_call.outputs?.superseded?.value).toContain(
      "jobs.migrate-db.outputs.superseded",
    );
    // The read-only public-identity preflight now precedes migrate-db. Only
    // downstream mutation/build jobs can consume migrate-db's supersession
    // result; the preflight-to-migration edge is covered by the homepage
    // workflow contract test.
    for (const dependent of ["deploy-api", "build-pages"]) {
      expect(workflow.jobs[dependent].if).toContain(
        "needs.migrate-db.outputs.superseded != 'true'",
      );
    }

    expect(
      secretMutation.run?.indexOf("canonical-deploy-source-guard.mjs"),
    ).toBeLessThan(
      secretMutation.run?.indexOf("ensure-worker-secret-absent.mjs") ?? -1,
    );
    const deleteFunction = workerDeploy.run?.slice(
      workerDeploy.run.indexOf("delete_legacy_onboarding_secret()"),
      workerDeploy.run.indexOf(
        String.raw`if [ -z "\${WORKER_SECRETS_FILE:-}" ]`,
      ),
    );
    expect(deleteFunction?.indexOf("recheck_canonical_source")).toBeGreaterThan(
      -1,
    );
    expect(deleteFunction?.indexOf("recheck_canonical_source")).toBeLessThan(
      deleteFunction?.indexOf("ensure-worker-secret-absent.mjs") ?? -1,
    );
    expect(
      workerDeploy.run?.lastIndexOf("recheck_canonical_source"),
    ).toBeGreaterThan(-1);
    expect(
      workerDeploy.run?.lastIndexOf("recheck_canonical_source"),
    ).toBeLessThan(workerDeploy.run?.indexOf("bunx wrangler deploy") ?? -1);
  });

  it("rechecks inside Pages project and deployment mutations", () => {
    const project = step("deploy-app", "Ensure eliza-app Pages project exists");
    const deploy = step("deploy-app", "Deploy to Cloudflare Pages");
    for (const guarded of [project, deploy]) {
      expect(guarded.run).toContain("canonical-deploy-source-guard.mjs");
      expect(guarded.run).toContain('--run-sha "$GITHUB_SHA"');
      expect(guarded.run).toContain('--canonical-ref "$CANONICAL_REF"');
    }

    expect(
      project.run?.indexOf("canonical-deploy-source-guard.mjs"),
    ).toBeLessThan(project.run?.indexOf("pages project create") ?? -1);
    expect(
      deploy.run?.indexOf("canonical-deploy-source-guard.mjs"),
    ).toBeLessThan(deploy.run?.indexOf("pages deploy") ?? -1);
    const deployLoop = deploy.run?.slice(
      deploy.run.indexOf("for attempt in 1 2 3; do"),
    );
    expect(deployLoop?.indexOf("recheck_canonical_source")).toBeGreaterThan(-1);
    expect(deployLoop?.indexOf("recheck_canonical_source")).toBeLessThan(
      deployLoop?.indexOf("pages deploy") ?? -1,
    );
  });
});
