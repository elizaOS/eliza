/**
 * Locks the credential, target, evidence, and cleanup boundaries that make the
 * managed dedicated canary safe to invoke from the consolidated live workflow.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface WorkflowStep {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string | number | boolean>;
}

interface WorkflowJob {
  concurrency?: {
    "cancel-in-progress": boolean;
    group: string;
  };
  env?: Record<string, string>;
  environment?: string;
  if?: string;
  "runs-on"?: string;
  steps: WorkflowStep[];
  "timeout-minutes"?: number;
}

interface LiveSmokeWorkflow {
  jobs: {
    dedicated: WorkflowJob;
    "dedicated-diagnostic": WorkflowJob;
    "shared-staging-onboarding": WorkflowJob;
    smoke: WorkflowJob;
  };
  on: {
    workflow_dispatch: {
      inputs: {
        stale_canary_suffix: {
          default: string;
          required: boolean;
          type: string;
        };
        diagnose_canary_suffix: {
          default: string;
          required: boolean;
          type: string;
        };
        cleanup_only: {
          default: boolean;
          required: boolean;
          type: string;
        };
        suite: {
          options: string[];
        };
      };
    };
  };
}

const repoRoot = resolve(import.meta.dirname, "../../../..");
const workflowPath = resolve(repoRoot, ".github/workflows/live-smoke.yml");
const retiredWorkflowPath = resolve(
  repoRoot,
  ".github/workflows/managed-dedicated-canary.yml",
);
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = parse(workflowSource) as LiveSmokeWorkflow;
const dedicated = workflow.jobs.dedicated;

function githubExpression(body: string): string {
  return ["$", "{{ ", body, " }}"].join("");
}

function bracedExpansion(body: string): string {
  return ["$", "{", body, "}"].join("");
}

function namedStep(name: string): WorkflowStep {
  const step = dedicated.steps.find((candidate) => candidate.name === name);
  if (!step)
    throw new Error(`Missing managed dedicated workflow step: ${name}`);
  return step;
}

describe("managed dedicated live-smoke workflow contract", () => {
  test("has one manual owner and a dedicated dispatch route", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs.suite.options).toEqual([
      "all",
      "app",
      "scenarios",
      "group-chat",
      "live-information",
      "cloud",
      "voice",
      "dedicated",
    ]);
    expect(
      workflow.on.workflow_dispatch.inputs.stale_canary_suffix,
    ).toMatchObject({ default: "", required: false, type: "string" });
    expect(
      workflow.on.workflow_dispatch.inputs.diagnose_canary_suffix,
    ).toMatchObject({ default: "", required: false, type: "string" });
    expect(workflow.on.workflow_dispatch.inputs.cleanup_only).toMatchObject({
      default: false,
      required: false,
      type: "boolean",
    });
    expect(workflow.jobs.smoke.if).toBe(
      githubExpression(
        "inputs.diagnose_canary_suffix == '' && !inputs.cleanup_only && inputs.suite != 'dedicated'",
      ),
    );
    expect(dedicated.if).toBe(
      "inputs.diagnose_canary_suffix == '' && (inputs.cleanup_only || inputs.suite == 'all' || inputs.suite == 'dedicated')",
    );
    expect(workflow.jobs["dedicated-diagnostic"].if).toBe(
      "inputs.diagnose_canary_suffix != ''",
    );
    expect(workflow.jobs["shared-staging-onboarding"].if).toBe(
      githubExpression(
        "always() && inputs.diagnose_canary_suffix == '' && !inputs.cleanup_only && (inputs.suite == 'all' || inputs.suite == 'cloud')",
      ),
    );
    expect(existsSync(retiredWorkflowPath)).toBe(false);
  });

  test("serializes the bounded staging lifecycle", () => {
    expect(dedicated["runs-on"]).toBe("ubuntu-24.04");
    expect(dedicated.environment).toBe("staging");
    expect(dedicated["timeout-minutes"]).toBe(45);
    expect(dedicated.concurrency).toEqual({
      group: "managed-dedicated-staging-canary",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs["dedicated-diagnostic"].concurrency).toEqual({
      group: "managed-dedicated-staging-canary",
      "cancel-in-progress": false,
    });
  });

  test("restores an exact, read-only, privacy-safe provisioning diagnostic", () => {
    const diagnostic = workflow.jobs["dedicated-diagnostic"];
    expect(diagnostic.environment).toBe("staging");
    expect(diagnostic["timeout-minutes"]).toBe(10);
    expect(diagnostic.env?.CANARY_DIAGNOSTIC_SUFFIX).toBe(
      githubExpression("inputs.diagnose_canary_suffix"),
    );

    const query = diagnostic.steps.find(
      (step) => step.name === "Query exact failed canary read-only",
    );
    expect(query?.env?.PGOPTIONS).toContain("default_transaction_read_only=on");
    expect(query?.run).toContain("BEGIN READ ONLY");
    expect(query?.run).toContain("jobs.type = 'agent_provision'");
    expect(query?.run).toContain(
      "agent_name = 'managed-dedicated-canary-' || :'suffix'",
    );
    expect(query?.run).toContain("mutually exclusive");

    const classify = diagnostic.steps.find(
      (step) => step.name === "Classify privacy-safe provision diagnostic",
    );
    expect(classify?.run).toContain(
      "managed-dedicated-provision-diagnostic.ts",
    );
    expect(classify?.run).toContain("rm -f --");

    const upload = diagnostic.steps.find(
      (step) => step.name === "Upload privacy-safe provision diagnostic",
    );
    expect(upload?.with?.path).toBe(
      "reports/managed-dedicated-provision-diagnostic.json",
    );
    expect(upload?.with?.["retention-days"]).toBe(14);
  });

  test("fails closed on credentials, target drift, and invalid recovery intent", () => {
    expect(dedicated.env?.CLOUD_DEDICATED_CANARY_BASE_URL).toBe(
      "https://api-staging.eliza.app",
    );
    expect(dedicated.env?.CLOUD_DEDICATED_CANARY_EVIDENCE_PATH).toBe(
      "reports/managed-dedicated-canary.json",
    );
    expect(dedicated.env?.CLOUD_DEDICATED_CANARY_STALE_CANARY_SUFFIX).toBe(
      githubExpression("inputs.stale_canary_suffix || ''"),
    );
    expect(dedicated.env?.CLOUD_DEDICATED_CANARY_CLEANUP_ONLY).toBe(
      githubExpression("inputs.cleanup_only && 'true' || 'false'"),
    );
    expect(dedicated.env?.CLOUD_DEDICATED_CANARY_MINIMUM_CLEANUP_API_SHA).toBe(
      "aada8198bc10045c8c841ea4d6dab974ac2a3319",
    );
    expect(dedicated.env?.ELIZAOS_CLOUD_API_KEY).toBe(
      githubExpression(
        "secrets.ELIZAOS_CLOUD_API_KEY || secrets.ELIZACLOUD_API_KEY",
      ),
    );

    const credential = namedStep("Require real Cloud credential").run ?? "";
    expect(credential).toContain("cloud_key_without_whitespace");
    expect(credential).toContain("refusing green-by-skip");
    expect(credential).toContain("exit 1");

    const target = namedStep("Require exact staging target").run ?? "";
    expect(target).toContain(
      'const expected = "https://api-staging.eliza.app"',
    );
    expect(target).toContain("url.username");
    expect(target).toContain("url.password");
    expect(target).toContain("url.pathname");
    expect(target).toContain("url.search");
    expect(target).toContain("url.hash");

    const recovery = namedStep("Bind stale-recovery intent");
    expect(recovery.id).toBe("recovery_intent");
    expect(recovery.run).toContain("/^r[1-9]\\d{7,19}a[1-9]\\d{0,3}$/");
    expect(recovery.run).toContain("requested=$" + "{requested");
    expect(recovery.run).toContain("cleanupOnly && !requested");
  });

  test("checks out full history and validates deterministic contracts", () => {
    const checkout = namedStep("Checkout exact run commit");
    expect(checkout.uses).toBe(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    );
    expect(checkout.with?.["fetch-depth"]).toBe(0);
    expect(checkout.with?.submodules).toBe(false);

    const setup = namedStep("Setup Bun");
    expect(setup.uses).toBe(
      "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    );
    expect(setup.with?.["bun-version"]).toBe("1.3.14");

    const install = namedStep("Install contract dependencies");
    expect(install.run).toBe("bun install --frozen-lockfile --ignore-scripts");
    expect(install.uses).toBeUndefined();

    const validation = namedStep("Validate canary and workflow contracts").run;
    expect(validation).toContain("bridge-reply-verdict.test.ts");
    expect(validation).toContain("managed-dedicated-canary.test.ts");
    expect(validation).toContain("managed-dedicated-canary-workflow.test.ts");

    const setupIndex = dedicated.steps.indexOf(setup);
    const installIndex = dedicated.steps.indexOf(install);
    const validationIndex = dedicated.steps.findIndex(
      (step) => step.name === "Validate canary and workflow contracts",
    );
    expect(installIndex).toBe(setupIndex + 1);
    expect(validationIndex).toBe(installIndex + 1);
    expect(
      dedicated.steps.some(
        (step) => step.uses === "./.github/actions/setup-bun-workspace",
      ),
    ).toBe(false);
  });

  test("uploads only canonical privacy-validated evidence", () => {
    const preflight = namedStep("Preflight cleanup API ancestry");
    const live = namedStep("Run bounded managed dedicated canary");
    expect(preflight.id).toBe("cleanup_api_preflight");
    expect(preflight.if).toBe("inputs.cleanup_only");
    expect(preflight.run).toContain("/api/health");
    expect(preflight.run).toContain(
      'git merge-base --is-ancestor "$minimum_cleanup_api_sha" "$deployed_commit"',
    );
    expect(preflight.run).not.toContain("managed-dedicated-canary.ts");
    expect(live.id).toBe("live");
    expect(live.if).toBe(
      githubExpression(
        "success() && (!inputs.cleanup_only || steps.cleanup_api_preflight.outcome == 'success')",
      ),
    );
    expect(live.env?.CLOUD_DEDICATED_CANARY_EXPECTED_DEPLOY_COMMIT).toBe(
      githubExpression(
        "steps.cleanup_api_preflight.outputs.deployed_commit || ''",
      ),
    );
    expect(live.run).toContain("managed-dedicated-canary.ts");
    expect(live.run).toContain("status=$?");
    expect(live.run).toContain('echo "status=$status" >> "$GITHUB_OUTPUT"');
    expect(dedicated.steps.indexOf(preflight)).toBeLessThan(
      dedicated.steps.indexOf(live),
    );
    const deleteCapableSteps = dedicated.steps.filter((step) =>
      step.run?.includes(
        "bun run packages/cloud/scripts/admin/managed-dedicated-canary.ts",
      ),
    );
    expect(deleteCapableSteps).toEqual([live]);

    const privacy = namedStep("Validate privacy-safe evidence artifact");
    expect(privacy.id).toBe("privacy");
    expect(privacy.if).toBe(githubExpression("always()"));
    expect(privacy.run).toContain("canonicalizeManagedDedicatedCanaryArtifact");
    expect(privacy.run).toContain("errors.length > 0");
    expect(privacy.run).toContain("mode: 0o600");
    expect(privacy.run).toContain('echo "validated=true"');

    const upload = namedStep("Upload privacy-safe timing and path evidence");
    expect(upload.if).toBe(
      githubExpression("always() && steps.privacy.outputs.validated == 'true'"),
    );
    expect(upload.uses).toBe(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(upload.with?.path).toBe("reports/managed-dedicated-canary.json");
    expect(upload.with?.["retention-days"]).toBe(14);
  });

  test("requires live success, the deployed ancestry, and exact cleanup", () => {
    const enforce = namedStep("Enforce live proof, deployed SHA, and cleanup");
    expect(enforce.if).toBe(githubExpression("always()"));
    expect(enforce.env).toMatchObject({
      EXPECTED_RECOVERY_REQUESTED: githubExpression(
        "steps.recovery_intent.outputs.requested",
      ),
      EXPECTED_SOURCE_SHA: githubExpression("github.sha"),
      LIVE_PROCESS_STATUS: githubExpression("steps.live.outputs.status"),
      PRIVACY_VALIDATED: githubExpression("steps.privacy.outputs.validated"),
    });
    expect(enforce.run).toContain("validateManagedDedicatedCanaryEvidence");
    expect(enforce.run).toContain(
      "validateManagedDedicatedCanaryCleanupEvidence",
    );
    expect(enforce.run).toContain("workflow_recovery_intent_mismatch");
    expect(enforce.run).toContain(
      `"${bracedExpansion("LIVE_PROCESS_STATUS:-missing")}" != "0"`,
    );
    expect(enforce.run).toContain(
      `git cat-file -e "${bracedExpansion("deployed_commit")}^{commit}"`,
    );
    expect(enforce.run).toContain(
      'git merge-base --is-ancestor "$expected_source_sha" "$deployed_commit"',
    );
    expect(enforce.run).toContain(
      'git merge-base --is-ancestor "$minimum_cleanup_api_sha" "$deployed_commit"',
    );
    expect(enforce.run).toContain(
      "Staging deploy predates the conditional cleanup API contract.",
    );
    expect(enforce.run).toContain("evidence.cleanup.status");
    expect(enforce.run).toContain("evidence.operation");
    expect(enforce.run).toContain(
      "Managed dedicated canary passed with exact cleanup.",
    );
  });
});
