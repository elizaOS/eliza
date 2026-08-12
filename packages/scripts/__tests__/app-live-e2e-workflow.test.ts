/**
 * Fail-closed contracts for the real Cloud and packaged-desktop jobs in
 * app-live-e2e.yml.
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
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  env?: Record<string, string>;
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
const desktopJob = workflow.jobs?.["desktop-packaged"];
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

describe("App Live E2E packaged desktop display ownership", () => {
  test("reuses the workflow xvfb display for every native harness launch", () => {
    const runStep = desktopJob?.steps?.find(
      (candidate) => candidate.name === "Run packaged desktop e2e (xvfb)",
    );

    expect(desktopJob?.env?.ELIZA_ELECTROBUN_PACKAGED_USE_CURRENT_DISPLAY).toBe(
      "1",
    );
    expect(runStep?.run).toContain(
      'xvfb-run -a --server-args="-screen 0 1920x1080x24"',
    );
    expect(runStep?.run).toContain(
      "bun run --cwd packages/app test:desktop:packaged",
    );
  });
});
