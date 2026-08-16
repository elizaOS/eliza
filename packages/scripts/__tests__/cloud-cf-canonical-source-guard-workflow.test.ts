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

function steps(jobName: string): Array<{ name?: string; run?: string }> {
  return workflow.jobs[jobName].steps;
}

function step(jobName: string, name: string) {
  const found = steps(jobName).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing ${jobName} step: ${name}`);
  return found;
}

describe("Cloud CF canonical source mutation guards", () => {
  it("rechecks inside migrations and Worker secret mutation/deploy", () => {
    const migration = step("migrate-db", "Run migrations");
    const secretMutation = step(
      "deploy-api",
      "Disable staging session exchange before cutover",
    );
    const workerDeploy = step("deploy-api", "Deploy to Cloudflare Workers");
    for (const guarded of [migration, secretMutation, workerDeploy]) {
      expect(guarded.run).toContain("canonical-deploy-source-guard.mjs");
      expect(guarded.run).toContain('--run-sha "$GITHUB_SHA"');
      expect(guarded.run).toContain('--canonical-ref "$CANONICAL_REF"');
      expect(guarded.run).toContain('if [ "$FORCE" = "true" ]');
    }

    expect(migration.run?.indexOf("generate-keywords.mjs")).toBeLessThan(
      migration.run?.indexOf("canonical-deploy-source-guard.mjs") ?? -1,
    );
    expect(
      migration.run?.indexOf("canonical-deploy-source-guard.mjs"),
    ).toBeLessThan(migration.run?.indexOf("bun run db:cloud:migrate") ?? -1);

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
