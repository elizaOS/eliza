/**
 * Locks the homepage production workflow to fail-closed validation, immutable
 * source identity, and a digest-verified artifact before deployment.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface WorkflowInput {
  required?: boolean;
  type?: string;
}

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, boolean | number | string>;
  "continue-on-error"?: boolean | string;
}

interface WorkflowJob {
  environment?: string;
  if?: string;
  needs?: string | string[];
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
  on?: {
    push?: { branches?: string[] };
    workflow_call?: { inputs?: Record<string, WorkflowInput> };
    workflow_dispatch?: unknown;
  };
  permissions?: Record<string, string>;
}

const workflowUrl = new URL(
  "../../../.github/workflows/deploy-homepage.yml",
  import.meta.url,
);
const workflowSource = readFileSync(workflowUrl, "utf8");

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parse(source: string): Workflow {
  return Bun.YAML.parse(source) as Workflow;
}

function expression(value: string): string {
  const dollar = String.fromCodePoint(36);
  return `${dollar}{{ ${value} }}`;
}

function namedStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  invariant(step, `Missing workflow step: ${name}`);
  return step;
}

function needNames(job: WorkflowJob): string[] {
  if (Array.isArray(job.needs)) return job.needs;
  return job.needs ? [job.needs] : [];
}

function stepIndex(job: WorkflowJob, name: string): number {
  return job.steps?.findIndex((step) => step.name === name) ?? -1;
}

function assertHomepageDeployContract(source: string): void {
  const workflow = parse(source);
  const triggers = workflow.on ?? {};
  const jobs = workflow.jobs ?? {};
  const resolve = jobs["resolve-source"];
  const build = jobs.build;
  const deploy = jobs.deploy;

  invariant(
    Object.keys(triggers).sort().join(",") === "push,workflow_call",
    "Only develop pushes and trusted reusable release calls may deploy.",
  );
  invariant(
    triggers.push?.branches?.join(",") === "develop",
    "Push authority must be restricted to develop.",
  );
  invariant(
    triggers.workflow_call?.inputs?.ref?.required === true,
    "Release calls must provide an explicit tag.",
  );
  invariant(
    triggers.workflow_call?.inputs?.ref?.type === "string",
    "The release source tag must be a string.",
  );
  invariant(
    workflow.permissions?.contents === "read" &&
      Object.keys(workflow.permissions).length === 1,
    "The workflow must retain read-only repository authority.",
  );
  invariant(
    resolve && build && deploy,
    "The three release stages are required.",
  );
  invariant(
    source.match(/\|\|\s*true/g) === null,
    "Production validation may not swallow command failures.",
  );
  invariant(
    !source.includes("continue-on-error"),
    "Production validation may not continue after step failures.",
  );
  invariant(
    !source.includes("--update-snapshots"),
    "Release jobs may not rewrite missing or mismatched snapshot baselines.",
  );
  invariant(
    !source.includes("::warning::"),
    "Release gates must fail instead of warning and skipping.",
  );

  const resolveScript = namedStep(
    resolve,
    "Resolve and authorize immutable source",
  ).run;
  invariant(resolveScript, "Source resolution must be executable.");
  invariant(
    resolveScript.includes('[ "$GITHUB_REPOSITORY" = "elizaOS/eliza" ]'),
    "Production authority must be repository-scoped.",
  );
  invariant(
    resolveScript.includes('[ "$EVENT_REF" = "refs/heads/develop" ]'),
    "The caller must run from develop.",
  );
  invariant(
    resolveScript.includes(
      "^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$",
    ),
    "Release calls must accept stable SemVer tags only.",
  );
  invariant(
    resolveScript.includes('source_ref="refs/tags/$REQUESTED_REF"'),
    "Release refs must resolve only through the tag namespace.",
  );
  invariant(
    resolveScript.includes('[ "$authority_ref_oid" = "$EVENT_SHA" ]'),
    "Source resolution must reject a moved authority ref.",
  );
  invariant(
    resolveScript.includes("git merge-base --is-ancestor"),
    "Release commits must belong to authorized develop history.",
  );
  invariant(
    resolveScript.includes("release.draft !== false") &&
      resolveScript.includes("release.prerelease !== false"),
    "Release tags must map to a published stable GitHub release.",
  );

  invariant(
    needNames(build).join(",") === "resolve-source",
    "Build must consume only resolved source identity.",
  );
  const checkout = namedStep(build, "Checkout exact source commit");
  invariant(
    checkout.with?.ref ===
      expression("needs.resolve-source.outputs.source_sha"),
    "Build checkout must use the resolved commit SHA.",
  );
  invariant(
    checkout.with?.["persist-credentials"] === false,
    "The build checkout must not retain repository credentials.",
  );
  const e2e = namedStep(build, "Run homepage E2E and snapshot validation");
  invariant(
    e2e.run?.trim() === "bun run test:e2e",
    "E2E and snapshot validation must be an unwrapped hard gate.",
  );
  const createArtifact = namedStep(
    build,
    "Create SHA-bound deployment artifact",
  );
  invariant(
    createArtifact.run?.includes(
      '"packages/homepage/dist/.deployment-source.json"',
    ) &&
      createArtifact.run.includes("homepage-artifact.sha256") &&
      createArtifact.run.includes("cd packages/homepage/dist") &&
      createArtifact.run.includes("source_sha: process.env.SOURCE_SHA"),
    "The build artifact must carry SHA provenance and a content digest.",
  );
  const upload = namedStep(build, "Upload exact homepage artifact");
  invariant(
    upload.with?.name === expression("steps.artifact.outputs.name"),
    "Only the dynamically SHA-bound artifact may be uploaded.",
  );
  invariant(
    upload.with?.["if-no-files-found"] === "error",
    "A missing artifact must fail the build.",
  );
  invariant(
    stepIndex(build, "Run homepage E2E and snapshot validation") <
      stepIndex(build, "Create SHA-bound deployment artifact") &&
      stepIndex(build, "Create SHA-bound deployment artifact") <
        stepIndex(build, "Upload exact homepage artifact"),
    "Validation must finish before artifact creation and upload.",
  );

  invariant(
    needNames(deploy).sort().join(",") === "build,resolve-source",
    "Deployment must require both source resolution and a successful build.",
  );
  invariant(
    deploy.if === undefined,
    "Deployment must not bypass normal successful-needs semantics.",
  );
  invariant(
    deploy.environment === "homepage-production",
    "Production secrets must remain behind the homepage environment.",
  );
  const download = namedStep(deploy, "Download exact homepage artifact");
  invariant(
    download.with?.name ===
      `homepage-${expression("needs.resolve-source.outputs.source_sha")}`,
    "Deployment must download the artifact named for the resolved SHA.",
  );
  const verify = namedStep(
    deploy,
    "Verify artifact identity and reject ref movement",
  );
  invariant(
    verify.run?.includes('[ "$actual_digest" = "$expected_digest" ]') &&
      verify.run.includes("cd release-bundle/dist") &&
      verify.run.includes(
        '[ "$(resolve_remote_oid "$remote" "$AUTHORITY_REF")" = "$AUTHORITY_REF_OID" ]',
      ) &&
      verify.run.includes(
        '[ "$(resolve_remote_oid "$remote" "$SOURCE_REF")" = "$SOURCE_REF_OID" ]',
      ),
    "Deployment must reject artifact mismatch and post-build ref movement.",
  );
  const publish = namedStep(deploy, "Deploy verified production homepage");
  invariant(
    publish.run?.includes('--commit-hash "$SOURCE_SHA"') &&
      publish.run.includes("--commit-dirty=false"),
    "Cloudflare metadata must bind production to the resolved source SHA.",
  );
  invariant(
    stepIndex(deploy, "Verify artifact identity and reject ref movement") <
      stepIndex(deploy, "Verify Cloudflare credentials") &&
      stepIndex(deploy, "Verify Cloudflare credentials") <
        stepIndex(deploy, "Deploy verified production homepage"),
    "Production deployment must follow identity and credential gates.",
  );
}

function replaceRequired(
  source: string,
  target: string,
  replacement: string,
): string {
  invariant(source.includes(target), `Mutation target not found: ${target}`);
  return source.replace(target, replacement);
}

describe("homepage deploy workflow contract", () => {
  test("the checked-in workflow satisfies the release-integrity contract", () => {
    expect(() => assertHomepageDeployContract(workflowSource)).not.toThrow();
  });

  test("rejects swallowed E2E failures", () => {
    const mutated = replaceRequired(
      workflowSource,
      "run: bun run test:e2e",
      "run: bun run test:e2e || true",
    );
    expect(() => assertHomepageDeployContract(mutated)).toThrow();
  });

  test("rejects snapshot baseline generation in the production path", () => {
    const mutated = replaceRequired(
      workflowSource,
      "run: bun run test:e2e",
      "run: bun run test:e2e -- --update-snapshots",
    );
    expect(() => assertHomepageDeployContract(mutated)).toThrow();
  });

  test("rejects a spoofable arbitrary release ref", () => {
    const mutated = replaceRequired(
      workflowSource,
      'source_ref="refs/tags/$REQUESTED_REF"',
      'source_ref="$REQUESTED_REF"',
    );
    expect(() => assertHomepageDeployContract(mutated)).toThrow();
  });

  test("rejects removal of the post-build source movement check", () => {
    const mutated = replaceRequired(
      workflowSource,
      '[ "$(resolve_remote_oid "$remote" "$SOURCE_REF")" = "$SOURCE_REF_OID" ]',
      '[ "$SOURCE_REF_OID" = "$SOURCE_REF_OID" ]',
    );
    expect(() => assertHomepageDeployContract(mutated)).toThrow();
  });

  test("rejects an artifact name that is not bound to the source SHA", () => {
    const mutated = replaceRequired(
      workflowSource,
      `homepage-${expression("needs.resolve-source.outputs.source_sha")}`,
      "homepage-latest",
    );
    expect(() => assertHomepageDeployContract(mutated)).toThrow();
  });

  test("rejects removal of the downloaded artifact digest comparison", () => {
    const mutated = replaceRequired(
      workflowSource,
      '[ "$actual_digest" = "$expected_digest" ]',
      '[ -n "$actual_digest" ]',
    );
    expect(() => assertHomepageDeployContract(mutated)).toThrow();
  });

  test("rejects deployment paths that bypass failed prerequisites", () => {
    const mutated = replaceRequired(
      workflowSource,
      "    environment: homepage-production",
      "    if: always()\n    environment: homepage-production",
    );
    expect(() => assertHomepageDeployContract(mutated)).toThrow();
  });
});
