/**
 * Guards the single homepage deployment authority against production bypasses.
 * The contract reads workflow source directly so trigger, environment,
 * credential, and artifact-boundary drift fails before a deploy can run.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const workflowsDirectory = path.join(repositoryRoot, ".github/workflows");
const deployWorkflowPath = path.join(workflowsDirectory, "deploy-homepage.yml");
const expressionOpen = "$" + "{{";

describe("homepage deployment workflow", () => {
  const workflow = readFileSync(deployWorkflowPath, "utf8");

  it("is the only workflow authorized to select the production Pages project", () => {
    const productionAuthorities = readdirSync(workflowsDirectory)
      .filter((filename) => filename.endsWith(".yml"))
      .filter((filename) =>
        readFileSync(path.join(workflowsDirectory, filename), "utf8").includes(
          "eliza-app-home",
        ),
      );

    expect(productionAuthorities).toEqual(["deploy-homepage.yml"]);
  });

  it("maps every push to staging and rejects push-selected production", () => {
    expect(workflow).toContain(
      "github.event_name == 'push' && 'staging' || inputs.target || 'production'",
    );
    expect(workflow).toContain(
      `if [ "${expressionOpen} github.event_name }}" = "push" ]; then`,
    );
    expect(workflow).toContain(
      'echo "::error::Push events can never select production."',
    );
    const dispatchBlock = workflow.slice(
      workflow.indexOf("  workflow_dispatch:"),
      workflow.indexOf("\npermissions:"),
    );
    expect(dispatchBlock).not.toMatch(/^\s+ref:/m);
  });

  it("keeps repository code and Cloudflare credentials in separate jobs", () => {
    const deployJob = workflow.slice(workflow.indexOf("\n  deploy:"));
    const buildJob = workflow.slice(
      workflow.indexOf("\n  build:"),
      workflow.indexOf("\n  deploy:"),
    );

    expect(workflow).toContain("build:\n    runs-on: ubuntu-24.04");
    expect(deployJob).toContain("runs-on: ubuntu-24.04");
    expect(deployJob).not.toContain("actions/checkout@");
    expect(deployJob).toContain(
      `environment: ${expressionOpen} needs.build.outputs.target }}`,
    );
    expect(deployJob).toContain("CLOUDFLARE_PAGES_API_TOKEN");
    expect(buildJob).not.toContain("CLOUDFLARE_PAGES_API_TOKEN");
  });

  it("preserves the full homepage gates and verifies exact deployed assets", () => {
    for (const command of [
      "bun run test",
      "bun run typecheck",
      "bun run lint:check",
      "bun run check:snapshot-inventory",
      "bun run build",
      "bun run test:e2e",
    ]) {
      expect(workflow).toContain(command);
    }
    expect(workflow).toContain('grep -Fx "commit=$GITHUB_SHA"');
    expect(workflow).toContain("EXPECTED_ASSETS");
    expect(workflow).toContain(
      'echo "::error::$TARGET_URL did not serve the $GITHUB_SHA artifact"',
    );
  });
});
