/**
 * Executable contract for credential-safe Cloudflare Pages PR previews.
 *
 * Pull requests build unprivileged artifacts. A default-branch workflow_run
 * consumer validates the source, stages static output without PR-authored
 * Functions/configuration, and deploys the unified frontend to `pr-<number>`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGnuBash } from "../lib/gnu-shell.mjs";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const producerSource = readFileSync(
  new URL(".github/workflows/cloud-cf-deploy.yml", repoRoot),
  "utf8",
);
const consumerSource = readFileSync(
  new URL(".github/workflows/cloud-cf-pr-preview-deploy.yml", repoRoot),
  "utf8",
);
// The unprivileged pull-request producer stays in the entry workflow. Canonical
// Pages deployment moved into the reusable release workflow the entry calls
// after admission, so its API gate is asserted there.
const releaseSource = readFileSync(
  new URL(".github/workflows/cloud-cf-release.yml", repoRoot),
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
  [key: string]: unknown;
}

interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  steps?: WorkflowStep[];
  uses?: string;
  strategy?: {
    matrix?: {
      include?: Array<Record<string, string>>;
    };
  };
}

interface WorkflowTrigger {
  branches?: string[];
  paths?: string[];
  types?: string[];
  workflows?: string[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
  on?: {
    pull_request?: WorkflowTrigger;
    pull_request_target?: WorkflowTrigger;
    push?: WorkflowTrigger;
    workflow_run?: WorkflowTrigger;
  };
  permissions?: Record<string, string>;
}

const producer = Bun.YAML.parse(producerSource) as Workflow;
const consumer = Bun.YAML.parse(consumerSource) as Workflow;
const release = Bun.YAML.parse(releaseSource) as Workflow;
const deployJobs = ["deploy-app"] as const;
const GNU_BASH = resolveGnuBash();
const executedDescribe = GNU_BASH ? describe : describe.skip;

function namedStep(
  workflow: Workflow,
  jobId: string,
  name: string,
): WorkflowStep {
  const step = workflow.jobs?.[jobId]?.steps?.find(
    (candidate) => candidate.name === name,
  );
  if (!step) {
    throw new Error(`Missing ${name} step for ${jobId}`);
  }
  return step;
}

interface ResolverInput {
  actor?: string;
  conclusion?: string;
  headRepository?: string;
  prNumber?: string;
  sourceEvent?: string;
  sourceRunAttempt?: string;
  sourceRunId?: string;
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

function runTrustedResolver(
  input: ResolverInput,
  faultBranch?: "develop" | "main",
) {
  const step = namedStep(
    consumer,
    "deploy-preview",
    "Validate trusted source and resolve Pages branch",
  );
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
        ACTOR: input.actor ?? "trusted-contributor",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "elizaOS/eliza",
        HEAD_REPOSITORY: input.headRepository ?? "elizaOS/eliza",
        PR_NUMBER: input.prNumber ?? "18088",
        SOURCE_CONCLUSION: input.conclusion ?? "success",
        SOURCE_EVENT: input.sourceEvent ?? "pull_request",
        SOURCE_RUN_ATTEMPT: input.sourceRunAttempt ?? "2",
        SOURCE_RUN_ID: input.sourceRunId ?? "123456",
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

describe("Cloud CF PR preview workflow contract", () => {
  test("subscribes the unprivileged producer to path-scoped pull requests", () => {
    expect(producer.on?.pull_request).toEqual({
      branches: ["main", "develop"],
      paths: producer.on?.push?.paths,
    });
    expect(producer.on?.pull_request_target).toBeUndefined();
    expect(producer.permissions).toEqual({ contents: "read" });
  });

  test("keeps PR builds reachable and gates canonical Pages on the API", () => {
    const buildJob = producer.jobs?.["build-pages"];
    expect(buildJob?.needs).toBe("resolve-pages-preview-config");
    expect(buildJob?.if).toBe(
      "$" +
        "{{ github.event_name == 'pull_request' && needs.resolve-pages-preview-config.result == 'success' }}",
    );
    expect(
      namedStep(producer, "build-pages", "Validate PR preview identity").if,
    ).toBe("github.event_name == 'pull_request'");
    expect(JSON.stringify(buildJob)).not.toContain("secrets.");

    // The entry workflow owns no Cloudflare mutation of its own: every deploy
    // job lives behind the approved release call, which pull requests can
    // never reach.
    for (const jobId of [...deployJobs, "deploy-api", "migrate-db"] as const) {
      expect(producer.jobs?.[jobId]).toBeUndefined();
    }
    const releaseCall = producer.jobs?.release;
    expect(releaseCall?.uses).toBe("./.github/workflows/cloud-cf-release.yml");
    expect(releaseCall?.if).toContain("github.event_name != 'pull_request'");

    for (const jobId of deployJobs) {
      const job = release.jobs?.[jobId];
      expect(job?.needs).toEqual(["deploy-api", "build-pages"]);
      expect(job?.if).toBe(
        "$" +
          "{{ !cancelled() && github.event_name != 'pull_request' && needs.deploy-api.result == 'success' && needs.build-pages.result == 'success' }}",
      );
    }
  });

  test("uses a read-only trusted workflow_run consumer with strict source guards", () => {
    expect(consumer.on).toEqual({
      workflow_run: {
        workflows: ["Cloud CF Deploy"],
        types: ["completed"],
      },
    });
    expect(consumer.permissions).toEqual({ actions: "read" });

    const condition = consumer.jobs?.["deploy-preview"]?.if ?? "";
    expect(condition).toContain("workflow_run.event == 'pull_request'");
    expect(condition).toContain("workflow_run.conclusion == 'success'");
    expect(condition).toContain("workflow_run.pull_requests[0].number > 0");
    expect(condition).toContain(
      "workflow_run.head_repository.full_name == github.repository",
    );
    expect(condition).toContain(
      "workflow_run.actor.login != 'dependabot[bot]'",
    );
    expect(consumerSource).not.toContain("pull_request_target");
  });

  test("never checks out PR code or deploys its Functions/configuration", () => {
    expect(consumerSource).not.toContain("actions/checkout");
    const stage = namedStep(
      consumer,
      "deploy-preview",
      "Stage static artifact without PR Functions or configuration",
    );
    expect(stage.run).toContain('cp -R "$ARTIFACT_DIR/dist"');
    expect(stage.run).not.toMatch(/cp[^\n]*(?:functions|wrangler\.toml)/);
    expect(stage.run).toContain('find "$ARTIFACT_DIR/dist" -type l');
    expect(stage.run).toContain('find "$ARTIFACT_DIR/dist" -name _worker.js');
  });

  test("binds the final Wrangler deploy to the unified project and resolved branch", () => {
    expect(consumer.jobs?.["deploy-preview"]?.strategy).toBeUndefined();
    const deploy = namedStep(
      consumer,
      "deploy-preview",
      "Deploy to isolated Cloudflare Pages branch",
    );
    expect(deploy.env).toMatchObject({
      PAGES_BRANCH: "$" + "{{ steps.source.outputs.branch }}",
      PAGES_PROJECT: "eliza-app",
    });
    expect(deploy.run).toContain(
      'wrangler@4.100.0 pages deploy ./dist --project-name="$PAGES_PROJECT" --branch="$PAGES_BRANCH"',
    );
  });
});

executedDescribe("trusted Cloud CF PR preview resolver", () => {
  test("isolates ordinary and develop-to-main PRs", () => {
    for (const prNumber of ["18088", "18028"]) {
      const result = runTrustedResolver({ prNumber });
      expect(result.status).toBe(0);
      expect(result.output).toBe(
        `branch=pr-${prNumber}\nartifact=pages-app-123456-2\n`,
      );
      expect(result.output).not.toMatch(/branch=(?:main|develop)\n/);
    }
  });

  test("rejects missing or malformed immutable run and PR identities", () => {
    const invalidValues = ["", "0", "01", "-1", "1.5", "main", "1/main"];
    for (const invalid of invalidValues) {
      for (const field of [
        "prNumber",
        "sourceRunAttempt",
        "sourceRunId",
      ] as const) {
        const result = runTrustedResolver({ [field]: invalid });
        expect(result.status).toBe(1);
        expect(result.output).toBe("");
        expect(result.stdout).toContain(
          "requires valid immutable run and PR identities",
        );
      }
    }
  });

  test("rejects untrusted producer event, outcome, repository, and actor", () => {
    const cases: ResolverInput[] = [
      { sourceEvent: "push" },
      { conclusion: "failure" },
      { headRepository: "fork/example" },
      { actor: "dependabot[bot]" },
    ];
    for (const input of cases) {
      const result = runTrustedResolver(input);
      expect(result.status).toBe(1);
      expect(result.output).toBe("");
    }
  });

  test("fails closed if PR branch derivation ever yields a canonical branch", () => {
    for (const canonicalBranch of ["main", "develop"] as const) {
      const result = runTrustedResolver({}, canonicalBranch);
      expect(result.status).toBe(1);
      expect(result.output).toBe("");
      expect(result.stdout).toContain(
        `Pull-request Pages branch may not target canonical branch ${canonicalBranch}`,
      );
    }
  });
});
