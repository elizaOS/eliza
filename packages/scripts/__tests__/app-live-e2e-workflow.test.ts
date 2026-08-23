/**
 * Fail-closed contract for the real Eliza Cloud job in app-live-e2e.yml.
 *
 * The Playwright spec intentionally remains self-skipping in keyless contexts
 * so PR lanes cannot spend Cloud credits. The secret-gated workflow job must
 * therefore reject a missing credential before setup/build/test work; otherwise
 * Playwright reports the only test as skipped and the declared live job is green.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);

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

interface WorkflowDispatch {
  inputs?: Record<
    string,
    { default?: boolean; description?: string; type?: string }
  >;
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

  test("keeps production Cloud mutations off manual staging-only dispatches", () => {
    const dispatch = workflow.on?.workflow_dispatch as
      | WorkflowDispatch
      | undefined;

    expect(dispatch?.inputs?.run_cloud_production).toEqual({
      description:
        "Also run the production Cloud login+personal-identity+chat lane. Keep false for staging-only evidence.",
      type: "boolean",
      default: false,
    });
    expect(cloudJob?.if).toContain("github.event_name == 'schedule'");
    expect(cloudJob?.if).toContain("inputs.run_cloud_production");
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
      (step) => step.name === "Run real cloud login + personal identity + chat",
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
    expect(spec).toContain(
      "test.skip(\n    !HAS_CLOUD_KEY && !REQUIRE_NAMED_WARMING,",
    );
  });

  test("hands the job credential to the browser without retaining secret-bearing traces", () => {
    const spec = read("packages/app/test/ui-smoke/cloud-live.spec.ts");

    expect(cloudJob?.env?.PLAYWRIGHT_NO_COPY_PROMPT).toBe("1");
    expect(spec).toContain("await seedCloudLiveBrowserAuth({");
    expect(spec).toContain('trace: "off"');
    expect(spec).toContain('screenshot: "off"');
    expect(spec).toContain('video: "off"');
    expect(spec).toContain('serviceWorkers: "block"');
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
    expect(stagingJob?.env?.VITE_ELIZA_CLOUD_BASE).toBe(
      "https://api-staging.eliza.app",
    );
    // The staging credential must come only from the staging Environment —
    // a production repository-secret fallback would silently retarget prod.
    expect(stagingJob?.env?.ELIZAOS_CLOUD_API_KEY).toBe(
      "$" + "{{ secrets.ELIZAOS_CLOUD_API_KEY }}",
    );
    expect(stagingJob?.env?.ELIZAOS_CLOUD_API_KEY).not.toContain("||");
    expect(stagingJob?.env?.PLAYWRIGHT_NO_COPY_PROMPT).toBe("1");
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

  test("stays opt-in on schedule until the staging key is configured", () => {
    expect(stagingJob?.if).toContain("ELIZA_CLOUD_STAGING_LIVE_READY");
    expect(stagingJob?.if).toContain("inputs.run_cloud_staging");
  });

  test("can isolate explicitly requested live lanes without changing defaults", () => {
    const dispatch = workflow.on?.workflow_dispatch as
      | WorkflowDispatch
      | undefined;
    expect(dispatch?.inputs?.run_only_requested).toEqual({
      description:
        "Skip the default local/walkthrough/desktop lanes and run only explicitly selected opt-in lanes.",
      type: "boolean",
      default: false,
    });

    for (const jobName of [
      "app-live-chat",
      "walkthrough-live",
      "desktop-packaged",
    ]) {
      expect(workflow.jobs?.[jobName]?.if).toBe(
        "$" +
          "{{ github.event_name != 'workflow_dispatch' || !inputs.run_only_requested }}",
      );
    }
    expect(stagingJob?.if).not.toContain("run_only_requested");
    expect(cloudJob?.if).not.toContain("run_only_requested");
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
      (step) =>
        step.name === "Run real STAGING cloud login + personal identity + chat",
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

  test("uploads only allowlisted closed staging artifacts", () => {
    expect(cloudJob?.env?.ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV).toBe("production");
    const prodUploads = cloudJob?.steps?.filter((step) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    const stagingUpload = stagingJob?.steps?.find((step) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    expect(prodUploads).toEqual([]);
    expect(stagingUpload?.with?.name).toBe("app-live-e2e-cloud-staging");
    const uploadedPaths = stagingUpload?.with?.path
      ?.split("\n")
      .map((path) => path.trim())
      .filter(Boolean);
    expect(uploadedPaths).toEqual([
      "artifacts/app-live-e2e/cloud-staging-receipt.json",
      "packages/app/test-results/**/privacy-safe-post-reload-history-network-diagnostics.json",
      "packages/app/test-results/**/privacy-safe-fresh-context-history-network-diagnostics.json",
    ]);
    expect(stagingUpload?.with?.path).not.toMatch(
      /playwright-report|trace|screenshot|video/i,
    );
  });

  test("uploads a mandatory exact-SHA, secret-free receipt for every executed smoke", () => {
    const smoke = stagingStep(
      "Run real STAGING cloud login + personal identity + chat",
    );
    const receipt = stagingStep("Write secret-free staging receipt");
    const latency = stagingStep(
      "Validate privacy-safe staging chat latency evidence",
    );
    const continuity = stagingStep(
      "Validate privacy-safe staging history continuity evidence",
    );
    const aggregate = stagingStep(
      "Resolve fail-closed staging receipt evidence",
    );
    const summary = stagingStep("Record what this lane drove");
    const upload = stagingStep("Upload cloud-live staging artifacts");

    expect(smoke.id).toBe("staging-cloud-smoke");
    expect(
      stagingJob?.env?.ELIZA_UI_SMOKE_STAGING_CHAT_LATENCY_EVIDENCE_PATH,
    ).toBe(
      "$" +
        "{{ github.workspace }}/artifacts/app-live-e2e/cloud-staging-chat-latency.json",
    );
    expect(
      stagingJob?.env?.ELIZA_UI_SMOKE_STAGING_CONTINUITY_EVIDENCE_PATH,
    ).toBe(
      "$" +
        "{{ github.workspace }}/artifacts/app-live-e2e/cloud-staging-continuity.json",
    );
    expect(smoke.run).toContain(
      'rm -f -- "$ELIZA_UI_SMOKE_STAGING_CHAT_LATENCY_EVIDENCE_PATH"',
    );
    expect(smoke.run).toContain(
      'rm -f -- "$ELIZA_UI_SMOKE_STAGING_CONTINUITY_EVIDENCE_PATH"',
    );
    expect(smoke.run).toContain('echo "started_ms=$started_ms"');
    expect(smoke.run).toContain('echo "completed_ms=$completed_ms"');
    expect(latency.id).toBe("staging-cloud-chat-latency");
    expect(latency.if).toContain(
      "steps.staging-cloud-smoke.outcome == 'success'",
    );
    expect(latency.run).toContain("staging-cloud-chat-latency-evidence.ts");
    expect(latency.run).toContain('echo "first_turn_latency_ms=$latency_ms"');
    expect(continuity.id).toBe("staging-cloud-continuity");
    expect(continuity.if).toContain(
      "steps.staging-cloud-smoke.outcome == 'success'",
    );
    expect(continuity.run).toContain("cloud-live-continuity-contract.ts");
    expect(continuity.run).toContain(
      'echo "continuity_evidence=$continuity_evidence"',
    );
    expect(aggregate.id).toBe("staging-cloud-receipt-evidence");
    expect(aggregate.if).toContain(
      "steps.staging-cloud-smoke.outcome != 'skipped'",
    );
    expect(aggregate.env?.SMOKE_OUTCOME).toContain(
      "steps.staging-cloud-smoke.outcome",
    );
    expect(aggregate.env?.LATENCY_VALIDATION_OUTCOME).toContain(
      "steps.staging-cloud-chat-latency.outcome",
    );
    expect(aggregate.env?.CONTINUITY_VALIDATION_OUTCOME).toContain(
      "steps.staging-cloud-continuity.outcome",
    );
    expect(aggregate.run).toContain("receipt_outcome=failure");
    expect(aggregate.run).toContain("first_turn_latency_ms=unavailable");
    expect(aggregate.run).toContain("continuity_evidence=unavailable");
    expect(summary.env?.TEST_OUTCOME).toBe(
      "$" +
        "{{ steps.staging-cloud-receipt-evidence.outputs.receipt_outcome || 'failure' }}",
    );
    expect(summary.env?.CONTINUITY_EVIDENCE).toContain(
      "steps.staging-cloud-receipt-evidence.outputs.continuity_evidence",
    );
    expect(summary.run).toContain(
      '[[ "$TEST_OUTCOME" == "success" && "$CONTINUITY_EVIDENCE" == "verified" ]]',
    );
    expect(summary.run).toContain(
      "no deletion or preservation claim is made for this run",
    );
    expect(summary.run).toContain("no deletion attempted or claimed");
    expect(receipt.if).toContain(
      "steps.staging-cloud-smoke.outcome != 'skipped'",
    );
    expect(receipt.env?.TEST_OUTCOME).toContain(
      "steps.staging-cloud-receipt-evidence.outputs.receipt_outcome",
    );
    expect(receipt.env?.FIRST_TURN_LATENCY_MS).toContain(
      "steps.staging-cloud-receipt-evidence.outputs.first_turn_latency_ms",
    );
    expect(receipt.env?.CONTINUITY_EVIDENCE).toContain(
      "steps.staging-cloud-receipt-evidence.outputs.continuity_evidence",
    );
    expect(receipt.run).toContain("write-staging-cloud-receipt.mjs");
    expect(receipt.run).toContain('--source-sha "$GITHUB_SHA"');
    expect(receipt.run).toContain(
      '--first-turn-latency-ms "$FIRST_TURN_LATENCY_MS"',
    );
    expect(receipt.run).toContain(
      '--continuity-evidence "$CONTINUITY_EVIDENCE"',
    );
    expect(receipt.run).not.toMatch(
      /ELIZAOS_CLOUD_API_KEY|authorization|bearer/i,
    );
    expect(upload.if).toBe(receipt.if);
    expect(upload.with?.path).toContain(
      "artifacts/app-live-e2e/cloud-staging-receipt.json",
    );
    expect(upload.with?.path).not.toMatch(
      /playwright-report|test-results\/\*\*\/\*|trace|screenshot|video/i,
    );
    expect(upload.with?.["if-no-files-found"]).toBe("error");
  });

  test("turns either validator failure into an exact-SHA failure receipt instead of losing the artifact", () => {
    const aggregate = stagingStep(
      "Resolve fail-closed staging receipt evidence",
    );
    const receipt = stagingStep("Write secret-free staging receipt");
    const directory = mkdtempSync(join(tmpdir(), "staging-receipt-workflow-"));
    try {
      const exactSha = "87da9c8ba169440f0fb21dc613f7bc425c8014b6";
      for (const [failedValidator, latencyOutcome, continuityOutcome] of [
        ["latency", "failure", "success"],
        ["continuity", "success", "failure"],
      ] as const) {
        const githubOutput = join(
          directory,
          `${failedValidator}-github-output`,
        );
        const aggregateResult = spawnSync("bash", ["-c", aggregate.run ?? ""], {
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_OUTPUT: githubOutput,
            SMOKE_OUTCOME: "success",
            LATENCY_VALIDATION_OUTCOME: latencyOutcome,
            CONTINUITY_VALIDATION_OUTCOME: continuityOutcome,
            VALIDATED_FIRST_TURN_LATENCY_MS: "12345",
            VALIDATED_CONTINUITY_EVIDENCE: "verified",
          },
        });
        expect(aggregateResult.status).toBe(0);
        const outputs = Object.fromEntries(
          readFileSync(githubOutput, "utf8")
            .trim()
            .split("\n")
            .map((line) => line.split("=", 2)),
        );
        expect(outputs).toEqual({
          receipt_outcome: "failure",
          first_turn_latency_ms: "unavailable",
          continuity_evidence: "unavailable",
        });

        const outputPath = join(
          directory,
          `${failedValidator}-cloud-staging-receipt.json`,
        );
        const receiptRun = (receipt.run ?? "").replace(
          "artifacts/app-live-e2e/cloud-staging-receipt.json",
          outputPath,
        );
        const receiptResult = spawnSync("bash", ["-c", receiptRun], {
          cwd: repoRootPath,
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_SHA: exactSha,
            GITHUB_RUN_ID: "32237956456",
            GITHUB_RUN_ATTEMPT: "1",
            TEST_OUTCOME: outputs.receipt_outcome,
            TEST_STARTED_MS: "1787151674000",
            TEST_COMPLETED_MS: "1787151717600",
            FIRST_TURN_LATENCY_MS: outputs.first_turn_latency_ms,
            CONTINUITY_EVIDENCE: outputs.continuity_evidence,
          },
        });
        expect(receiptResult.status).toBe(0);
        const parsed = JSON.parse(readFileSync(outputPath, "utf8"));
        expect(parsed.sourceSha).toBe(exactSha);
        expect(parsed.result).toEqual({
          outcome: "failure",
          startedAtMs: 1787151674000,
          completedAtMs: 1787151717600,
          durationMs: 43600,
        });
        expect(parsed.measurements.firstTurnLatencyMs).toBeNull();
        expect(parsed.continuity.verified).toBe(false);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // The credentialed spec cannot execute in a keyless lane, so the invariants
  // that keep a real Cloud bearer and real model content out of CI output are
  // asserted against its source. This deliberately covers only handling of the
  // credential and of test-seeded browser state; the behaviour of the evidence
  // modules it calls is exercised for real by their own unit suites
  // (packages/app/test/cloud-live-continuity-contract.test.ts and
  // packages/app/test/staging-cloud-chat-latency-evidence.test.ts).
  test("keeps the credentialed spec free of extra sends and borrowed browser state", () => {
    const spec = read("packages/app/test/ui-smoke/cloud-live.spec.ts");

    // Exactly one challenge turn is sent, and the lane asserts that count at
    // runtime rather than trusting the source shape alone.
    expect(spec.match(/assertOnboardingLivenessWithTiming\(/g)).toHaveLength(1);
    expect(spec).toContain("challengeLogicalChatSendCount).toBe(1)");
    expect(spec).toContain("unidentifiedChatSendAttemptCount).toBe(0)");
    // Both the initial leg and the two history legs bind the accepted reply to
    // the exact run-unique user row without requiring the model to echo it.
    expect(spec).toContain("turnAnchorToken,");
    expect(spec).toContain("findAnchoredLiveTurn(");
    expect(spec).toContain("isLiveReply(anchored.reply)");
    // The fresh-context leg must inherit nothing: no shared smoke seed, no
    // storageState hand-off, and no production service worker.
    expect(spec).not.toContain("seedAppStorage");
    expect(spec).not.toContain("storageState:");
    expect(spec).toContain("const freshContext = await browser.newContext({");
    expect(spec).toContain('serviceWorkers: "block"');
    expect(spec).toContain(
      'localStorage.setItem("eliza:first-run-complete", "")',
    );
    expect(spec).toContain('localStorage.setItem("elizaos:active-server", "")');
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
