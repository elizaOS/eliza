/**
 * Executable contract for Cloudflare Pages branch isolation in deploy workflow.
 *
 * The harness parses both App and Console jobs, executes their embedded Bash
 * resolvers, and fault-injects a canonical PR result to keep the downstream
 * rejection reachable even though the valid derivation always uses `pr-<id>`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGnuBash } from "../lib/gnu-shell.mjs";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const workflowSource = readFileSync(
  new URL(".github/workflows/cloud-cf-deploy.yml", repoRoot),
  "utf8",
);

interface WorkflowStep {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  run?: string;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const deployJobs = ["deploy-console", "deploy-app"] as const;
const GNU_BASH = resolveGnuBash();
const executedDescribe = GNU_BASH ? describe : describe.skip;

function pagesBranchStep(jobId: (typeof deployJobs)[number]): WorkflowStep {
  const step = workflow.jobs?.[jobId]?.steps?.find(
    (candidate) => candidate.name === "Resolve Pages branch",
  );
  if (!step?.run) {
    throw new Error(`Missing Pages branch resolver for ${jobId}`);
  }
  return step;
}

interface ResolverInput {
  eventName: string;
  githubRef?: string;
  prNumber?: string;
  targetEnvironment?: string;
}

function injectCanonicalPrResult(script: string, branch: "develop" | "main") {
  const derivation = 'pages_branch="pr-$' + '{PR_NUMBER}"';
  const matches = script.split(derivation).length - 1;
  if (matches !== 1) {
    throw new Error(
      `Expected exactly one immutable PR branch derivation, found ${matches}`,
    );
  }
  return script.replace(derivation, `pages_branch="${branch}"`);
}

function runResolver(
  step: WorkflowStep,
  input: ResolverInput,
  faultBranch?: "develop" | "main",
) {
  if (!GNU_BASH || !step.run) {
    throw new Error("Pages branch resolver execution requires bash >= 4");
  }

  const directory = mkdtempSync(join(tmpdir(), "cloud-cf-pages-branch-"));
  const outputPath = join(directory, "github-output");
  const script = faultBranch
    ? injectCanonicalPrResult(step.run, faultBranch)
    : step.run;

  try {
    const result = spawnSync(GNU_BASH, ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        EVENT_NAME: input.eventName,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REF: input.githubRef ?? "refs/heads/develop",
        PR_NUMBER: input.prNumber ?? "",
        TARGET_ENVIRONMENT: input.targetEnvironment ?? "",
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

describe("Cloud CF Pages branch workflow contract", () => {
  test("keeps App and Console on the same immutable PR identity inputs", () => {
    const consoleStep = pagesBranchStep("deploy-console");
    const appStep = pagesBranchStep("deploy-app");

    expect(consoleStep.id).toBe("pages");
    expect(consoleStep.env).toEqual({
      EVENT_NAME: "$" + "{{ github.event_name }}",
      PR_NUMBER: "$" + "{{ github.event.pull_request.number }}",
      TARGET_ENVIRONMENT: "$" + "{{ inputs.environment }}",
    });
    expect(appStep.env).toEqual(consoleStep.env);
    expect(appStep.run).toBe(consoleStep.run);
    expect(workflowSource).not.toContain("PR_HEAD_REF");
  });
});

executedDescribe("Cloud CF Pages branch resolver", () => {
  test("isolates ordinary and develop-to-main pull requests for both surfaces", () => {
    const cases = [
      { prNumber: "18088", expected: "branch=pr-18088\n" },
      { prNumber: "18028", expected: "branch=pr-18028\n" },
    ];

    for (const jobId of deployJobs) {
      const step = pagesBranchStep(jobId);
      for (const input of cases) {
        const result = runResolver(step, {
          eventName: "pull_request",
          githubRef: `refs/pull/${input.prNumber}/merge`,
          prNumber: input.prNumber,
        });
        expect(result.status).toBe(0);
        expect(result.output).toBe(input.expected);
        expect(result.output).not.toMatch(/branch=(?:main|develop)\n/);
      }
    }
  });

  test("rejects missing and malformed pull-request identities", () => {
    const invalidNumbers = ["", "0", "01", "-1", "1.5", "main", "1/main"];

    for (const jobId of deployJobs) {
      const step = pagesBranchStep(jobId);
      for (const prNumber of invalidNumbers) {
        const result = runResolver(step, {
          eventName: "pull_request",
          prNumber,
        });
        expect(result.status).toBe(1);
        expect(result.output).toBe("");
        expect(result.stdout).toContain(
          "Pull-request Pages branch requires a valid immutable PR number",
        );
      }
    }
  });

  test("fails closed if PR branch derivation ever yields a canonical branch", () => {
    for (const jobId of deployJobs) {
      const step = pagesBranchStep(jobId);
      for (const canonicalBranch of ["main", "develop"] as const) {
        const result = runResolver(
          step,
          { eventName: "pull_request", prNumber: "18088" },
          canonicalBranch,
        );
        expect(result.status).toBe(1);
        expect(result.output).toBe("");
        expect(result.stdout).toContain(
          `Pull-request Pages branch may not target canonical branch ${canonicalBranch}`,
        );
      }
    }
  });

  test("preserves canonical push and manual-dispatch branch behavior", () => {
    const cases: Array<{ input: ResolverInput; expected: string }> = [
      {
        input: { eventName: "push", githubRef: "refs/heads/develop" },
        expected: "branch=develop\n",
      },
      {
        input: { eventName: "push", githubRef: "refs/heads/main" },
        expected: "branch=main\n",
      },
      {
        input: {
          eventName: "workflow_dispatch",
          targetEnvironment: "staging",
        },
        expected: "branch=develop\n",
      },
      {
        input: {
          eventName: "workflow_dispatch",
          targetEnvironment: "production",
        },
        expected: "branch=main\n",
      },
    ];

    for (const jobId of deployJobs) {
      const step = pagesBranchStep(jobId);
      for (const { input, expected } of cases) {
        const result = runResolver(step, input);
        expect(result.status).toBe(0);
        expect(result.output).toBe(expected);
      }
    }
  });
});
