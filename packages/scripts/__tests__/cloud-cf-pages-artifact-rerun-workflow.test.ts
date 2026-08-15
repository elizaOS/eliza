/**
 * Contract for Pages artifacts across GitHub Actions rerun attempts.
 *
 * A failed-only rerun keeps outputs from the successful build-pages job. The
 * deploy jobs must resolve that producer attempt instead of assuming their own
 * newer github.run_attempt produced another artifact. A full rerun executes
 * build-pages again, so the same output contract selects the new attempt.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGnuBash } from "../lib/gnu-shell.mjs";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

// The canonical producer/consumer pair (build-pages -> deploy-app) lives in the
// reusable release workflow invoked by `cloud-cf-deploy.yml`; the entry
// workflow keeps only the credential-free pull-request producer, whose artifact
// is consumed by `cloud-cf-pr-preview-deploy.yml`. Both producers are asserted
// so neither can drift away from the immutable-identity contract.
const repoRoot = new URL("../../../", import.meta.url);
const workflowSource = readFileSync(
  new URL(".github/workflows/cloud-cf-release.yml", repoRoot),
  "utf8",
);
const entrySource = readFileSync(
  new URL(".github/workflows/cloud-cf-deploy.yml", repoRoot),
  "utf8",
);

interface WorkflowStep {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  needs?: string[] | string;
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const entryWorkflow = Bun.YAML.parse(entrySource) as Workflow;
const buildJob = workflow.jobs?.["build-pages"];
const entryBuildJob = entryWorkflow.jobs?.["build-pages"];
const deployJobs = [
  {
    artifactPrefix: "pages-app",
    download: "Download immutable app artifact",
    jobId: "deploy-app",
    resolver: "Resolve immutable app artifact",
    upload: "Upload consolidated frontend artifact",
  },
] as const;

function namedStep(job: WorkflowJob | undefined, name: string): WorkflowStep {
  const step = job?.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

interface ResolverInput {
  consumerAttempt: string;
  consumerRunId?: string;
  consumerSha?: string;
  producerAttempt: string;
  producerRunId?: string;
  producerSha?: string;
}

function runResolver(step: WorkflowStep, input: ResolverInput) {
  if (!GNU_BASH || !step.run) {
    throw new Error("Resolver execution requires bash >= 4 and a run script");
  }

  const directory = mkdtempSync(join(tmpdir(), "cloud-cf-pages-artifact-"));
  const outputPath = join(directory, "github-output");
  const runId = "31336372345";
  const sha = "4166a72707556591e58eb68114a137385ce2c3ff";

  try {
    const result = spawnSync(GNU_BASH, ["-c", step.run], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        GITHUB_RUN_ATTEMPT: input.consumerAttempt,
        GITHUB_RUN_ID: input.consumerRunId ?? runId,
        GITHUB_SHA: input.consumerSha ?? sha,
        PRODUCER_RUN_ATTEMPT: input.producerAttempt,
        PRODUCER_RUN_ID: input.producerRunId ?? runId,
        PRODUCER_SOURCE_SHA: input.producerSha ?? sha,
      },
    });
    return {
      ...result,
      output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

const GNU_BASH = resolveGnuBash();
const executedDescribe = GNU_BASH ? describe : describe.skip;

describe("Cloud CF Pages artifact metadata", () => {
  test("exports immutable producer identity and uses it for the unified upload", () => {
    expect(buildJob?.outputs).toEqual({
      artifact_run_id: "$" + "{{ steps.pages-artifact.outputs.run_id }}",
      artifact_run_attempt:
        "$" + "{{ steps.pages-artifact.outputs.run_attempt }}",
      artifact_source_sha:
        "$" + "{{ steps.pages-artifact.outputs.source_sha }}",
      telegram_bot_id:
        "$" +
        "{{ needs.resolve-pages-environment-config.outputs.telegram_bot_id }}",
      telegram_bot_username:
        "$" +
        "{{ needs.resolve-pages-environment-config.outputs.telegram_bot_username }}",
      whatsapp_phone_number:
        "$" +
        "{{ needs.resolve-pages-environment-config.outputs.whatsapp_phone_number }}",
    });
    expect(entryBuildJob?.outputs).toEqual({
      artifact_run_id: "$" + "{{ steps.pages-artifact.outputs.run_id }}",
      artifact_run_attempt:
        "$" + "{{ steps.pages-artifact.outputs.run_attempt }}",
      artifact_source_sha:
        "$" + "{{ steps.pages-artifact.outputs.source_sha }}",
      telegram_bot_id:
        "$" +
        "{{ needs.resolve-pages-preview-config.outputs.telegram_bot_id }}",
      telegram_bot_username:
        "$" +
        "{{ needs.resolve-pages-preview-config.outputs.telegram_bot_username }}",
    });

    for (const producer of [buildJob, entryBuildJob]) {
      const metadata = namedStep(
        producer,
        "Bind Pages artifacts to this producer attempt",
      );
      expect(metadata.id).toBe("pages-artifact");
      expect(metadata.env).toEqual({
        PRODUCER_RUN_ID: "$" + "{{ github.run_id }}",
        PRODUCER_RUN_ATTEMPT: "$" + "{{ github.run_attempt }}",
        PRODUCER_SOURCE_SHA: "$" + "{{ github.sha }}",
      });

      for (const { artifactPrefix, upload: uploadName } of deployJobs) {
        const upload = namedStep(producer, uploadName);
        expect(upload.with?.name).toBe(
          `${artifactPrefix}-` +
            "$" +
            "{{ steps.pages-artifact.outputs.run_id }}-" +
            "$" +
            "{{ steps.pages-artifact.outputs.run_attempt }}",
        );
      }
    }
  });

  test("uses a fail-closed resolver contract for the unified frontend", () => {
    for (const { download, jobId, resolver } of deployJobs) {
      const job = workflow.jobs?.[jobId];
      const resolveStep = namedStep(job, resolver);
      const downloadStep = namedStep(job, download);

      expect(resolveStep.id).toBe("pages-artifact");
      expect(resolveStep.env).toEqual({
        PRODUCER_RUN_ID:
          "$" + "{{ needs.build-pages.outputs.artifact_run_id }}",
        PRODUCER_RUN_ATTEMPT:
          "$" + "{{ needs.build-pages.outputs.artifact_run_attempt }}",
        PRODUCER_SOURCE_SHA:
          "$" + "{{ needs.build-pages.outputs.artifact_source_sha }}",
      });
      expect(resolveStep.run).toContain(
        'if [ "$PRODUCER_RUN_ID" != "$GITHUB_RUN_ID" ]',
      );
      expect(resolveStep.run).toContain(
        'if [ "$PRODUCER_SOURCE_SHA" != "$GITHUB_SHA" ]',
      );
      expect(resolveStep.run).not.toContain("GITHUB_RUN_ATTEMPT");
      expect(downloadStep.with?.name).toBe(
        "$" + "{{ steps.pages-artifact.outputs.name }}",
      );
    }
  });

  test("keeps the deploy and served-frontend freshness gates strict", () => {
    for (const { jobId } of deployJobs) {
      const job = workflow.jobs?.[jobId];
      expect(job?.needs).toEqual(["deploy-api", "build-pages"]);

      const guard = namedStep(job, "Deploy freshness guard");
      const verification = namedStep(job, "Verify Pages frontend freshness");
      expect(guard.run).toContain("deploy-freshness-guard-cli.mjs");
      expect(verification.if).toContain(
        "steps.freshness.outputs.should_deploy == 'true'",
      );
      expect(verification.run).toContain(
        "packages/cloud/scripts/verify-pages-frontend-cli.mjs",
      );
    }
  });
});

executedDescribe("Cloud CF Pages artifact resolver", () => {
  test("failed-only attempt 2 consumes attempt 1", () => {
    for (const { artifactPrefix, jobId, resolver } of deployJobs) {
      const result = runResolver(namedStep(workflow.jobs?.[jobId], resolver), {
        consumerAttempt: "2",
        producerAttempt: "1",
      });
      expect(result.status).toBe(0);
      expect(result.output).toBe(`name=${artifactPrefix}-31336372345-1\n`);
    }
  });

  test("full rerun attempt 3 consumes attempt 3", () => {
    for (const { artifactPrefix, jobId, resolver } of deployJobs) {
      const result = runResolver(namedStep(workflow.jobs?.[jobId], resolver), {
        consumerAttempt: "3",
        producerAttempt: "3",
      });
      expect(result.status).toBe(0);
      expect(result.output).toBe(`name=${artifactPrefix}-31336372345-3\n`);
    }
  });

  test("rejects missing, cross-run, and cross-SHA producer metadata", () => {
    for (const { jobId, resolver } of deployJobs) {
      const step = namedStep(workflow.jobs?.[jobId], resolver);
      const invalidAttempt = runResolver(step, {
        consumerAttempt: "2",
        producerAttempt: "",
      });
      expect(invalidAttempt.status).toBe(1);
      expect(invalidAttempt.stdout).toContain(
        "Pages producer run attempt is missing or invalid",
      );

      const crossRun = runResolver(step, {
        consumerAttempt: "2",
        producerAttempt: "1",
        producerRunId: "31336372344",
      });
      expect(crossRun.status).toBe(1);
      expect(crossRun.stdout).toContain("Pages artifact run mismatch");

      const crossSha = runResolver(step, {
        consumerAttempt: "2",
        producerAttempt: "1",
        producerSha: "0000000000000000000000000000000000000000",
      });
      expect(crossSha.status).toBe(1);
      expect(crossSha.stdout).toContain("Pages artifact SHA mismatch");
    }
  });
});
