/**
 * Fail-closed contract for the real Eliza Cloud job in app-live-e2e.yml.
 *
 * The Playwright spec intentionally remains self-skipping in keyless contexts
 * so PR lanes cannot spend Cloud credits. The secret-gated workflow job must
 * therefore reject a missing credential before setup/build/test work; otherwise
 * Playwright reports the only test as skipped and the declared live job is green.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const repoRoot = new URL("../../../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

interface WorkflowStep {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  env?: Record<string, string>;
  environment?: string;
  if?: string;
  steps?: WorkflowStep[];
}

interface Workflow {
  env?: Record<string, string>;
  on?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

const workflow = Bun.YAML.parse(
  read(".github/workflows/app-live-e2e.yml"),
) as Workflow;
const cloudJob = workflow.jobs?.["cloud-live"];
const notificationJob = workflow.jobs?.["notify-on-failure"];

function namedStep(name: string): WorkflowStep {
  const step = cloudJob?.steps?.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Missing cloud-live workflow step: ${name}`);
  }
  return step;
}

describe("App Live E2E real Cloud job (#14357, #16194)", () => {
  test("keeps every live runtime independent of a headless runner keychain", () => {
    expect(workflow.env?.ELIZA_VAULT_DISABLE_KEYCHAIN).toBe("1");
    expect(workflow.env?.ELIZA_VAULT_PASSPHRASE).toBe(
      "app-live-e2e-headless-vault-only",
    );
  });

  test("maps the runtime key to the established repository-secret fallback", () => {
    expect(cloudJob?.env?.ELIZAOS_CLOUD_API_KEY).toBe(
      "$" + "{{ secrets.ELIZAOS_CLOUD_API_KEY || secrets.ELIZACLOUD_API_KEY }}",
    );
  });

  test("fails on a missing key before setup, build, or Playwright can skip", () => {
    const steps = cloudJob?.steps ?? [];
    const preflightIndex = steps.findIndex(
      (step) => step.name === "Require real Cloud credential",
    );
    const firstExpensiveStepIndex = steps.findIndex(
      (step) => step.name === "Free disk space for browser smoke",
    );
    const testIndex = steps.findIndex(
      (step) => step.name === "Run real cloud login + provision + chat",
    );

    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(firstExpensiveStepIndex).toBeGreaterThan(preflightIndex);
    expect(testIndex).toBeGreaterThan(preflightIndex);

    const run = namedStep("Require real Cloud credential").run;
    expect(run).toBeDefined();

    const missing = spawnSync("bash", ["-c", run ?? ""], {
      encoding: "utf8",
      env: { ...process.env, ELIZAOS_CLOUD_API_KEY: "" },
    });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("refusing a green-by-skip Cloud job");

    const whitespaceOnly = spawnSync("bash", ["-c", run ?? ""], {
      encoding: "utf8",
      env: { ...process.env, ELIZAOS_CLOUD_API_KEY: " \t\n" },
    });
    expect(whitespaceOnly.status).toBe(1);

    const configured = spawnSync("bash", ["-c", run ?? ""], {
      encoding: "utf8",
      env: { ...process.env, ELIZAOS_CLOUD_API_KEY: "contract-test-key" },
    });
    expect(configured.status).toBe(0);
  });

  test("keeps the live spec keyless-safe and out of pull-request workflows", () => {
    const spec = read("packages/app/test/ui-smoke/cloud-live.spec.ts");

    expect(workflow.on?.pull_request).toBeUndefined();
    expect(spec).toContain(
      "const HAS_CLOUD_KEY = Boolean(process.env.ELIZAOS_CLOUD_API_KEY?.trim())",
    );
    expect(spec).toContain("test.skip(\n    !HAS_CLOUD_KEY,");
  });

  test("hands the job credential to the browser without retaining secret-bearing traces", () => {
    const spec = read("packages/app/test/ui-smoke/cloud-live.spec.ts");

    expect(spec).toContain("await seedCloudLiveBrowserAuth(page)");
    expect(spec).toContain('test.use({ trace: "off" });');
  });
});

describe("App Live E2E staging Cloud job (#18076)", () => {
  const stagingJob = workflow.jobs?.["cloud-live-staging"];

  function stagingStep(name: string): WorkflowStep {
    const step = stagingJob?.steps?.find(
      (candidate) => candidate.name === name,
    );
    if (!step) {
      throw new Error(`Missing cloud-live-staging workflow step: ${name}`);
    }
    return step;
  }

  test("pins the staging origin, expectation, and Environment-scoped credential", () => {
    expect(stagingJob?.environment).toBe("staging");
    expect(stagingJob?.env?.ELIZAOS_CLOUD_BASE_URL).toBe(
      "https://api-staging.eliza.app",
    );
    expect(stagingJob?.env?.ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV).toBe("staging");
    // The staging credential must come only from the staging Environment —
    // a production repository-secret fallback would silently retarget prod.
    expect(stagingJob?.env?.ELIZAOS_CLOUD_API_KEY).toBe(
      "$" + "{{ secrets.ELIZAOS_CLOUD_API_KEY }}",
    );
    expect(stagingJob?.env?.ELIZAOS_CLOUD_API_KEY).not.toContain("||");
  });

  test("builds the renderer against the staging Cloud origin, and never retargets production", () => {
    // The renderer resolves its Cloud base at BUILD time from
    // VITE_ELIZA_CLOUD_BASE (ui/src/platform/ios-runtime.ts) and otherwise
    // defaults to production. The job-level ELIZAOS_CLOUD_BASE_URL never
    // reaches Vite, so without this wiring the staging bundle drives
    // production while holding a staging bearer (#18076).
    expect(
      stagingStep("Build app renderer bundle").env?.VITE_ELIZA_CLOUD_BASE,
    ).toBe("$" + "{{ env.ELIZAOS_CLOUD_BASE_URL }}");

    // The production lane must stay on its default origin: retargeting it
    // would point a production key at staging.
    const productionBuild = workflow.jobs?.["cloud-live"]?.steps?.find(
      (candidate) => candidate.name === "Build app renderer bundle",
    );
    expect(productionBuild).toBeDefined();
    expect(productionBuild?.env?.VITE_ELIZA_CLOUD_BASE).toBeUndefined();
  });

  test("stays opt-in on schedule until the staging key is provisioned", () => {
    expect(stagingJob?.if).toContain("ELIZA_CLOUD_STAGING_LIVE_READY");
    expect(stagingJob?.if).toContain("inputs.run_cloud_staging");
  });

  test("fails closed before setup on a missing credential or a wrong origin", () => {
    const steps = stagingJob?.steps ?? [];
    const guardIndex = steps.findIndex(
      (step) =>
        step.name === "Require staging-scoped Cloud credential and origin",
    );
    const firstExpensiveStepIndex = steps.findIndex(
      (step) => step.name === "Free disk space for browser smoke",
    );
    const testIndex = steps.findIndex(
      (step) => step.name === "Run real STAGING cloud login + provision + chat",
    );

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(firstExpensiveStepIndex).toBeGreaterThan(guardIndex);
    expect(testIndex).toBeGreaterThan(guardIndex);

    const run = stagingStep(
      "Require staging-scoped Cloud credential and origin",
    ).run;
    expect(run).toBeDefined();

    const stagingEnv = {
      ...process.env,
      ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app",
    };

    const missingKey = spawnSync("bash", ["-c", run ?? ""], {
      encoding: "utf8",
      env: { ...stagingEnv, ELIZAOS_CLOUD_API_KEY: "" },
    });
    expect(missingKey.status).toBe(1);
    expect(missingKey.stdout).toContain(
      "never falling back to the production key",
    );

    const wrongOrigin = spawnSync("bash", ["-c", run ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        ELIZAOS_CLOUD_API_KEY: "staging-contract-key",
        ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app",
      },
    });
    expect(wrongOrigin.status).toBe(1);
    expect(wrongOrigin.stdout).toContain("must pin ELIZAOS_CLOUD_BASE_URL");

    const configured = spawnSync("bash", ["-c", run ?? ""], {
      encoding: "utf8",
      env: { ...stagingEnv, ELIZAOS_CLOUD_API_KEY: "staging-contract-key" },
    });
    expect(configured.status).toBe(0);
  });

  test("asserts the resolved API origin inside the spec before onboarding", () => {
    const spec = read("packages/app/test/ui-smoke/cloud-live.spec.ts");
    expect(spec).toContain("resolveCloudLiveOriginContract(process.env)");
    expect(spec).toContain("cloud-api-origin");
    expect(spec).toContain("renderer-source");
  });

  test("keeps production and staging as separate jobs and artifacts", () => {
    expect(cloudJob?.env?.ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV).toBe("production");
    const prodUpload = cloudJob?.steps?.find((step) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    const stagingUpload = stagingJob?.steps?.find((step) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    expect(prodUpload?.with?.name).toBe("app-live-e2e-cloud");
    expect(stagingUpload?.with?.name).toBe("app-live-e2e-cloud-staging");
  });

  test("uploads a mandatory exact-SHA, secret-free receipt for every executed smoke", () => {
    const smoke = stagingStep(
      "Run real STAGING cloud login + provision + chat",
    );
    const receipt = stagingStep("Write secret-free staging receipt");
    const upload = stagingStep("Upload cloud-live staging artifacts");

    expect(smoke.id).toBe("staging-cloud-smoke");
    expect(smoke.run).toContain('echo "started_ms=$started_ms"');
    expect(smoke.run).toContain('echo "completed_ms=$completed_ms"');
    expect(receipt.if).toContain(
      "steps.staging-cloud-smoke.outcome != 'skipped'",
    );
    expect(receipt.run).toContain("write-staging-cloud-receipt.mjs");
    expect(receipt.run).toContain('--source-sha "$GITHUB_SHA"');
    expect(receipt.run).not.toMatch(
      /ELIZAOS_CLOUD_API_KEY|authorization|bearer/i,
    );
    expect(upload.if).toBe(receipt.if);
    expect(upload.with?.path).toContain(
      "artifacts/app-live-e2e/cloud-staging-receipt.json",
    );
    expect(upload.with?.["if-no-files-found"]).toBe("error");
  });
});

describe("App Live E2E red-nightly notification (#13681)", () => {
  test("uses the GitHub API without depending on a runner-installed gh CLI", () => {
    const step = notificationJob?.steps?.find(
      (candidate) =>
        candidate.name ===
        "Comment red-nightly diagnostic on tracking issue #13681",
    );

    expect(step?.uses).toBe(
      "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
    );
    expect(step?.run).toBeUndefined();
    expect(step?.with?.["github-token"]).toBe("$" + "{{ github.token }}");
    expect(step?.with?.script).toContain("github.rest.issues.createComment");
    expect(step?.with?.script).toContain("issue_number: 13681");
    expect(step?.with?.script).not.toContain("gh issue comment");
  });
});
