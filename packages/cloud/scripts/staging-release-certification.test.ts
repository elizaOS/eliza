/**
 * Exercises tree-bound staging release certification and the production gate.
 *
 * The pure fixtures cover malformed and adversarial metadata; the CLI test
 * executes real JSON files, and the workflow assertions pin the protected job
 * graph plus the exact artifact actions.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse } from "yaml";
import {
  createEvidence,
  currentValidationManifest,
  verifyCompleteManifest,
} from "../../scripts/develop-impact-evidence.ts";
import {
  assertProductionCertificationFresh,
  readValidationArchive,
  requireMainValidation,
  requireProductionCertification,
  verifyMainValidation,
} from "./production-effect-certification.ts";

import {
  artifactNameForTree,
  CERTIFICATION_ARTIFACT_PREFIX,
  CERTIFICATION_FILENAME,
  CERTIFICATION_SCHEMA,
  CERTIFICATION_WORKFLOW,
  createStagingReleaseCertification,
  verifyStagingReleaseCertification,
} from "./staging-release-certification.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowPath = resolve(repoRoot, CERTIFICATION_WORKFLOW);
const workflow = readFileSync(workflowPath, "utf8").replaceAll("\r\n", "\n");
const releaseWorkflow = readFileSync(
  resolve(repoRoot, ".github/workflows/cloud-cf-release.yml"),
  "utf8",
).replaceAll("\r\n", "\n");
const sourceSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const workflowSha256 = "c".repeat(64);
const artifactName = artifactNameForTree(treeSha);
const issuedAt = "2026-08-16T12:00:00.000Z";
const now = "2026-08-17T12:00:00.000Z";

function createSourceAdmissionFixture() {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), "source-admission-"));
  try {
    // Real workflow/action closure, graph, policies and Git inventory; no Docker or provider effects.
    cpSync(
      resolve(repoRoot, ".github/workflows"),
      resolve(fixtureRoot, ".github/workflows"),
      { recursive: true },
    );
    cpSync(
      resolve(repoRoot, ".github/actions"),
      resolve(fixtureRoot, ".github/actions"),
      { recursive: true },
    );
    cpSync(
      resolve(repoRoot, ".github/develop-surface-graph.json"),
      resolve(fixtureRoot, ".github/develop-surface-graph.json"),
    );
    mkdirSync(resolve(fixtureRoot, "packages/fixture"), { recursive: true });
    mkdirSync(resolve(fixtureRoot, "packages/app/deploy"), {
      recursive: true,
    });
    writeFileSync(
      resolve(fixtureRoot, "package.json"),
      JSON.stringify({
        name: "admission-fixture",
        workspaces: ["packages/*"],
      }),
    );
    writeFileSync(
      resolve(fixtureRoot, "packages/fixture/package.json"),
      JSON.stringify({ name: "@fixture/source" }),
    );
    writeFileSync(
      resolve(fixtureRoot, "packages/fixture/source.ts"),
      "export const value = 1;\n",
    );
    cpSync(
      resolve(repoRoot, ".dockerignore"),
      resolve(fixtureRoot, ".dockerignore"),
    );
    cpSync(
      resolve(repoRoot, "packages/app/deploy/.dockerignore.ci"),
      resolve(fixtureRoot, "packages/app/deploy/.dockerignore.ci"),
    );
    const git = (...args) => {
      const child = spawnSync("git", args, {
        cwd: fixtureRoot,
        encoding: "utf8",
      });
      expect(child.status).toBe(0);
      return child.stdout.trim();
    };
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Admission fixture",
      "-c",
      "user.email=ci@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "controlled source",
    );
    const head = git("rev-parse", "HEAD");
    return { root: fixtureRoot, head };
  } catch (error) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

function fixture() {
  const certification = createStagingReleaseCertification({
    repository: "elizaOS/eliza",
    runId: "12345",
    runAttempt: "2",
    sourceSha,
    treeSha,
    workflowSha256,
    artifactName,
    issuedAt,
  });
  return {
    certification,
    run: {
      id: 12345,
      run_attempt: 2,
      status: "completed",
      conclusion: "success",
      event: "push",
      head_branch: "staging",
      head_sha: sourceSha,
      path: CERTIFICATION_WORKFLOW,
      repository: { full_name: "elizaOS/eliza" },
    },
    artifact: {
      id: 67890,
      name: artifactName,
      expired: false,
      digest: `sha256:${"d".repeat(64)}`,
      workflow_run: {
        id: 12345,
        head_sha: sourceSha,
      },
    },
    expectedRepository: "elizaOS/eliza",
    expectedTreeSha: treeSha,
    expectedWorkflowSha256: workflowSha256,
    now,
  };
}

function jobBlock(source, jobId) {
  const start = source.search(new RegExp(`^  ${jobId}:\\n`, "m"));
  if (start < 0) throw new Error(`missing job ${jobId}`);
  const fromJob = source.slice(start);
  const header = `  ${jobId}:\n`;
  const next = fromJob.slice(header.length).search(/^ {2}[A-Za-z0-9_-]+:/m);
  return next < 0 ? fromJob : fromJob.slice(0, header.length + next);
}

describe("staging release certification payload", () => {
  test("accepts a different production commit when the root tree is identical", () => {
    const input = fixture();
    expect(verifyStagingReleaseCertification(input)).toEqual({
      treeSha,
      stagingSourceSha: sourceSha,
      runId: "12345",
      runAttempt: "2",
      artifactId: "67890",
      artifactDigest: `sha256:${"d".repeat(64)}`,
      expiresAt: "2026-08-30T12:00:00.000Z",
    });
  });

  test("creates the canonical schema and deterministic artifact identity", () => {
    const { certification } = fixture();
    expect(certification).toMatchObject({
      schema: CERTIFICATION_SCHEMA,
      repository: "elizaOS/eliza",
      workflow: CERTIFICATION_WORKFLOW,
      environment: "staging",
      event: "push",
      ref: "refs/heads/staging",
      source_sha: sourceSha,
      tree_sha: treeSha,
      artifact: {
        name: `${CERTIFICATION_ARTIFACT_PREFIX}${treeSha}`,
        filename: CERTIFICATION_FILENAME,
      },
    });
  });

  test("accepts an explicit canonical staging dispatch", () => {
    const input = fixture();
    input.certification = createStagingReleaseCertification({
      repository: "elizaOS/eliza",
      runId: "12345",
      runAttempt: "2",
      sourceSha,
      treeSha,
      workflowSha256,
      event: "workflow_dispatch",
      artifactName,
      issuedAt,
    });
    input.run.event = "workflow_dispatch";
    expect(verifyStagingReleaseCertification(input).treeSha).toBe(treeSha);
  });

  test.each([
    ["wrong tree", (input) => (input.expectedTreeSha = "e".repeat(40))],
    [
      "wrong repository",
      (input) => (input.expectedRepository = "attacker/fork"),
    ],
    [
      "wrong workflow bytes",
      (input) => (input.expectedWorkflowSha256 = "e".repeat(64)),
    ],
    [
      "wrong environment",
      (input) => (input.certification.environment = "production"),
    ],
    ["wrong event", (input) => (input.certification.event = "pull_request")],
    ["wrong ref", (input) => (input.certification.ref = "refs/heads/main")],
    ["expired", (input) => (input.now = "2026-08-30T12:00:00.000Z")],
    [
      "future dated",
      (input) => (input.certification.issued_at = "2026-08-18T12:00:00.000Z"),
    ],
  ])("rejects %s certificate metadata", (_label, mutate) => {
    const input = fixture();
    mutate(input);
    expect(() => verifyStagingReleaseCertification(input)).toThrow(
      /Staging release certification rejected/,
    );
  });

  test.each([
    ["failed", (run) => (run.conclusion = "failure")],
    ["incomplete", (run) => (run.status = "in_progress")],
    ["pull request", (run) => (run.event = "pull_request")],
    ["event mismatch", (run) => (run.event = "workflow_dispatch")],
    ["main", (run) => (run.head_branch = "main")],
    ["wrong workflow", (run) => (run.path = ".github/workflows/ci.yml")],
    ["wrong repository", (run) => (run.repository.full_name = "attacker/fork")],
    ["wrong source", (run) => (run.head_sha = "f".repeat(40))],
    ["wrong attempt", (run) => (run.run_attempt = 3)],
  ])("rejects an originating run that is %s", (_label, mutate) => {
    const input = fixture();
    mutate(input.run);
    expect(() => verifyStagingReleaseCertification(input)).toThrow(
      /Staging release certification rejected/,
    );
  });

  test.each([
    ["expired", (artifact) => (artifact.expired = true)],
    ["renamed", (artifact) => (artifact.name = "other")],
    ["digestless", (artifact) => (artifact.digest = "")],
    ["wrong owner", (artifact) => (artifact.workflow_run.id = 99999)],
    [
      "wrong source",
      (artifact) => (artifact.workflow_run.head_sha = "f".repeat(40)),
    ],
  ])("rejects an artifact that is %s", (_label, mutate) => {
    const input = fixture();
    mutate(input.artifact);
    expect(() => verifyStagingReleaseCertification(input)).toThrow(
      /Staging release certification rejected/,
    );
  });

  test("rejects malformed and overlong certificate lifetimes", () => {
    const input = fixture();
    input.certification.expires_at = "2026-09-30T12:00:00.000Z";
    expect(() => verifyStagingReleaseCertification(input)).toThrow(
      /lifetime exceeds policy/,
    );
    expect(() =>
      createStagingReleaseCertification({
        repository: "elizaOS/eliza",
        runId: "1",
        runAttempt: "1",
        sourceSha,
        treeSha,
        workflowSha256,
        issuedAt: "not-a-date",
      }),
    ).toThrow(/ISO timestamp/);
  });
});

describe("staging release certification CLI", () => {
  test("creates and verifies real JSON files", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "eliza-staging-cert-"));
    try {
      const localWorkflow = resolve(directory, "cloud-cf-deploy.yml");
      const certFile = resolve(directory, CERTIFICATION_FILENAME);
      const runFile = resolve(directory, "run.json");
      const artifactFile = resolve(directory, "artifact.json");
      writeFileSync(localWorkflow, "name: test-workflow\n");
      const createResult = spawnSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "staging-release-certification.ts"),
          "create",
          "--out",
          certFile,
          "--repository",
          "elizaOS/eliza",
          "--run-id",
          "12345",
          "--run-attempt",
          "2",
          "--source-sha",
          sourceSha,
          "--tree-sha",
          treeSha,
          "--artifact-name",
          artifactName,
          "--workflow-file",
          localWorkflow,
          "--issued-at",
          issuedAt,
        ],
        { encoding: "utf8" },
      );
      expect(createResult.status).toBe(0);

      const input = fixture();
      writeFileSync(runFile, JSON.stringify(input.run));
      writeFileSync(artifactFile, JSON.stringify(input.artifact));
      const verifyResult = spawnSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "staging-release-certification.ts"),
          "verify",
          "--cert",
          certFile,
          "--run-json",
          runFile,
          "--artifact-json",
          artifactFile,
          "--expected-repository",
          "elizaOS/eliza",
          "--expected-tree-sha",
          treeSha,
          "--workflow-file",
          localWorkflow,
          "--now",
          now,
        ],
        { encoding: "utf8" },
      );
      expect(verifyResult.status).toBe(0);
      expect(JSON.parse(verifyResult.stdout)).toMatchObject({
        treeSha,
        runId: "12345",
        artifactId: "67890",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Cloud CF workflow staging certification gate", () => {
  test("emits a certificate only after a successful canonical staging release", () => {
    const block = jobBlock(workflow, "certify-staging-release");
    expect(block).toContain("needs: release");
    expect(block).toContain("github.event_name == 'push'");
    expect(block).toContain("github.event_name == 'workflow_dispatch'");
    expect(block).toContain("github.ref == 'refs/heads/staging'");
    expect(block).toContain("needs.release.result == 'success'");
    // A freshness-guard skip ends green without deploying; only a run that
    // released both surfaces may certify its tree (#27229/#28746).
    expect(block).toContain("needs.release.outputs.api_deployed == 'true'");
    expect(block).toContain("needs.release.outputs.pages_deployed == 'true'");
    expect(releaseWorkflow).toContain(
      "value: $" + "{{ jobs.deploy-api.outputs.api_deployed }}",
    );
    expect(releaseWorkflow).toContain(
      "value: $" + "{{ jobs.deploy-app.outputs.pages_deployed }}",
    );
    expect(releaseWorkflow).toContain(
      'args=(--run-sha "$GITHUB_SHA" --served-url "$SERVED_URL" --served-path /api/health --canonical-ref "$CANONICAL_REF")',
    );
    expect(releaseWorkflow).toContain(
      'args=(--run-sha "$GITHUB_SHA" --served-url "$SERVED_URL" --canonical-ref "$CANONICAL_REF")',
    );
    expect(block).toContain("git rev-parse 'HEAD^{tree}'");
    expect(block).toContain("staging-release-certification.ts create");
    expect(block).toContain('--event "$GITHUB_EVENT_NAME"');
    expect(block).toContain(
      "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    );
    expect(block).toContain("retention-days: 14");
    expect(block).toContain("steps.upload.outputs.artifact-id");
    expect(block).toContain("steps.upload.outputs.artifact-digest");
  });

  test("validates the exact production tree before environment approval", () => {
    const validate = jobBlock(workflow, "validate-staging-certification");
    const authorize = jobBlock(workflow, "authorize-production");
    const release = jobBlock(workflow, "release");
    expect(validate).not.toContain("environment: production");
    expect(validate).toContain("ref: $" + "{{ github.sha }}");
    expect(validate).toContain("persist-credentials: false");
    expect(validate).toContain(`git rev-parse "\${certified_base_sha}^{tree}"`);
    expect(validate).toContain(
      '(.event == "push" or .event == "workflow_dispatch")',
    );
    expect(validate).toContain('head_branch == "staging"');
    expect(validate).toContain(
      'path == ".github/workflows/cloud-cf-deploy.yml"',
    );
    expect(validate).toContain(
      "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
    );
    expect(validate).toContain("artifact-ids:");
    expect(validate).toContain("github-token: $" + "{{ github.token }}");
    expect(validate).toContain(
      "run-id: $" + "{{ steps.resolve.outputs.staging_run_id }}",
    );
    expect(validate).toContain("digest-mismatch: error");
    expect(validate).toContain("staging-release-certification.ts verify");
    expect(validate).toContain("inputs.force == true");
    expect(authorize).toContain("validate-staging-certification");
    expect(authorize).toContain(
      "needs.validate-staging-certification.result == 'success'",
    );
    expect(release).toContain("validate-staging-certification");
    expect(release).toContain(
      "needs.validate-staging-certification.result == 'success'",
    );
  });

  test("admits only a certified currently served binding-only recovery", () => {
    const source = jobBlock(workflow, "validate-deploy-source");
    const validate = jobBlock(workflow, "validate-staging-certification");
    expect(workflow).toContain("production_binding_only_recovery:");
    expect(workflow).toContain("certified_production_base_sha:");
    expect(workflow).toContain("certified_recovery_policy_sha:");
    expect(source).toContain(
      "Production binding-only recovery may target only production",
    );
    expect(source).toContain("Production binding-only recovery forbids force");
    expect(validate).toContain("fetch-depth: 0");
    expect(validate).toContain("https://api.eliza.app/api/health");
    expect(validate).toContain(".commit == $base");
    expect(validate).toContain('.environment == "production"');
    expect(validate).toContain("git merge-base --is-ancestor");
    expect(validate).toContain("production-hyperdrive-binding-admission.ts");
    expect(validate).toContain('certification_mode="binding_only"');
    expect(validate).toContain(
      `git show "\${CERTIFIED_BASE_SHA}:.github/workflows/cloud-cf-deploy.yml"`,
    );
    expect(validate).toContain('--workflow-file "$workflow_file"');
    expect(validate).toContain(
      "Resolve immutable successful recovery-policy artifact",
    );
    expect(validate).toContain("recovery-policy-certification");
    expect(validate).toContain(
      `git show "\${POLICY_SHA}:packages/cloud/scripts/production-hyperdrive-binding-admission.ts"`,
    );
    expect(validate).toContain('--policy-sha "$POLICY_SHA"');
    expect(validate).toContain("Certified staging policy bytes admitted");
  });

  test("imports native registrations after certified schema migration and before runtime activation", () => {
    const release = parse(releaseWorkflow);
    const migrate = release.jobs["migrate-db"];
    const schema = migrate.steps.findIndex(
      (step) => step.name === "Run migrations",
    );
    const prepare = migrate.steps.findIndex(
      (step) =>
        step.name ===
        "Complete one-time native registration import before activation",
    );
    expect(prepare).toBeGreaterThan(schema);
    expect(migrate.environment).toBe(`\${{ inputs.target_environment }}`);
    expect(migrate.steps[schema].run).toContain(
      "production-effect-certification.ts main-validation",
    );
    expect(migrate.steps[prepare].if).toBe(migrate.steps[schema].if);
    expect(migrate.steps[prepare].run).toContain(
      "migrate-native-app-auth.ts --release",
    );
    expect(
      migrate.steps[prepare].env.ELIZA_NATIVE_AUTH_CALLBACKS_JSON,
    ).toBeUndefined();
    expect(release.jobs["deploy-api"].needs).toContain("migrate-db");
    expect(release.jobs["deploy-api"].if).toContain(
      "needs.migrate-db.result == 'success'",
    );
    expect(release.jobs["deploy-app"].needs).toContain("deploy-api");
    expect(release.jobs["deploy-app"].if).toContain(
      "needs.deploy-api.result == 'success'",
    );
  });

  test("rechecks the trusted policy and all authorities inside the mutation job", () => {
    const caller = jobBlock(workflow, "release");
    const migrate = jobBlock(releaseWorkflow, "migrate-db");
    expect(caller).toContain("production_binding_only_recovery:");
    expect(caller).toContain("certified_production_base_sha:");
    expect(caller).toContain("certified_recovery_policy_sha:");
    expect(migrate).toContain(
      "Re-admit bounded Hyperdrive recovery immediately before mutation",
    );
    expect(migrate).toContain('--policy-sha "$POLICY_SHA"');
    expect(migrate).toContain(`hyperdrive/configs/\${candidate_id}`);
    expect(migrate).toContain("preflight-database-identity.ts");
    expect(migrate).toContain("loadCanonicalMigrations");
    expect(migrate).toContain("validateAppliedMigrationLedger");
    expect(migrate).toContain(
      "Production migration ledger matches exact current main",
    );
    expect(migrate).not.toContain("railway variable list");
    expect(migrate).toContain("wrangler deploy --env production --dry-run");
    expect(migrate).toContain("Served production base drifted before mutation");
    expect(migrate).toContain("--canonical-ref refs/heads/main");
    expect(migrate.indexOf("bun run build:core")).toBeLessThan(
      migrate.indexOf("preflight-database-identity.ts"),
    );
    expect(
      migrate.indexOf("Re-admit bounded Hyperdrive recovery"),
    ).toBeLessThan(migrate.indexOf("- name: Run migrations"));
  });

  test("fails closed before mutation when trusted policy or authority evidence drifts", () => {
    const migrate = jobBlock(releaseWorkflow, "migrate-db");
    expect(migrate).toContain(
      "Certified recovery policy is no longer contained in staging",
    );
    expect(migrate).toContain(
      "Protected audit and migration database authorities differ",
    );
    expect(migrate).toContain(
      "Protected recovery authority settings are incomplete",
    );
    expect(migrate).toContain("trap cleanup EXIT");
    expect(migrate).toContain("shred -f -u --");
    expect(migrate).toContain("production_migration_ledger_not_current");
    expect(migrate).toContain('DATABASE_IDENTITY_GATE_MODE" = "enforce');
  });

  test("re-audits database authority and exact production Worker before approval", () => {
    const authorize = jobBlock(workflow, "authorize-production");
    const release = jobBlock(workflow, "release");
    expect(authorize).toContain("environment: production");
    expect(authorize).toContain("secrets.DATABASE_URL");
    expect(authorize).toContain("secrets.RAILWAY_TOKEN");
    expect(authorize).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(authorize).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
    expect(authorize).toContain(`hyperdrive/configs/\${candidate_id}`);
    expect(authorize).toContain('--hyperdrive-json "$response"');
    expect(authorize).toContain("staging:refs/remotes/origin/staging");
    expect(authorize).toContain(
      'git merge-base --is-ancestor "$POLICY_SHA" refs/remotes/origin/staging',
    );
    expect(authorize).toContain(
      "audit-production-railway-database-authority.ts",
    );
    expect(
      authorize.match(/install -d -m 0700 "\$evidence_dir"/g),
    ).toHaveLength(2);
    expect(authorize).toContain("--canonical-ref refs/heads/main");
    expect(authorize).toContain("bun run build:core");
    expect(authorize).toContain("wrangler deploy --env production --dry-run");
    expect(authorize.match(/--canonical-ref refs\/heads\/main/g)).toHaveLength(
      2,
    );
    expect(authorize).toContain("Destroy private bounded-recovery evidence");
    expect(release).toContain("environment == 'production'");
    expect(release).toContain("group: cloud-cf-release-v6-");
    expect(release).toContain("cancel-in-progress: false");
  });

  test("fails closed on absent, expired, digestless, or noncanonical artifacts", () => {
    const block = jobBlock(workflow, "validate-staging-certification");
    expect(block).toContain(
      "No unexpired successful staging Cloud certification",
    );
    expect(block).toContain("select(.expired == false)");
    expect(block).toContain('test("^sha256:[0-9a-f]{64}$")');
    expect(block).toContain('.conclusion == "success"');
    expect(block).toContain(".repository.full_name == $repo");
    expect(block).toContain("--artifact-json");
  });
});

describe("deployed renderer compute consent", () => {
  test("keeps renderer selection separate from explicit staging compute approval", () => {
    for (const source of [workflow, releaseWorkflow]) {
      expect(source).toContain(
        "      approve_staging_billable_dedicated_confirmation:\n" +
          "        description: Explicitly approve the staging fixture Dedicated compute quote during the browser proof\n" +
          "        required: false\n        default: false\n        type: boolean",
      );
    }
    expect(workflow).toContain(
      "approve_staging_billable_dedicated_confirmation: ${{ github.event_name == 'workflow_dispatch' && inputs.environment == 'staging' && inputs.approve_staging_billable_dedicated_confirmation == true }}",
    );
    const browserJob = jobBlock(releaseWorkflow, "deployed-renderer-staging");
    expect(browserJob).toContain(
      "ELIZA_UI_SMOKE_APPROVE_BILLABLE_DEDICATED_CONFIRMATION: ${{ inputs.approve_staging_billable_dedicated_confirmation == true && '1' || '0' }}",
    );
    expect(browserJob).not.toContain(
      'ELIZA_UI_SMOKE_APPROVE_BILLABLE_DEDICATED_CONFIRMATION: "1"',
    );
  });
});

describe("exact-source main Full admission", () => {
  const sourceFixture = createSourceAdmissionFixture();
  afterAll(
    () => rmSync(sourceFixture.root, { recursive: true, force: true }),
    30_000,
  );

  function mainFixture(
    validationRepoRoot = repoRoot,
    fixtureSourceSha = sourceSha,
  ) {
    const expected = currentValidationManifest(
      validationRepoRoot,
      fixtureSourceSha,
    );
    const rows = expected.surfaces.map((surface) =>
      createEvidence(expected, surface.id, now, 168),
    );
    return {
      repository: "elizaOS/eliza",
      sourceSha: fixtureSourceSha,
      expected,
      now,
      run: {
        id: 701,
        run_attempt: 2,
        run_started_at: "2026-08-17T11:00:00Z",
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        event: "push",
        head_sha: fixtureSourceSha,
        path: ".github/workflows/develop-full.yml",
        repository: { full_name: "elizaOS/eliza" },
      },
      artifact: {
        id: 801,
        name: `develop-full-manifest-${fixtureSourceSha}`,
        expired: false,
        digest: `sha256:${"d".repeat(64)}`,
        workflow_run: {
          id: 701,
          head_sha: fixtureSourceSha,
          head_branch: "main",
        },
      },
      archive: {
        expected,
        observed: verifyCompleteManifest(expected, rows, now),
        results: {
          headSha: fixtureSourceSha,
          runId: "701",
          runAttempt: "2",
          results: Object.fromEntries(
            expected.surfaces.map((surface) => [surface.id, "success"]),
          ),
        },
      },
    };
  }

  // Compute the actual Git/workspace dependency closure once; mutations below are isolated copies.
  const original = mainFixture();
  const main = () => structuredClone(original);
  // Keep the real monorepo happy admission below. Adversarial API orderings
  // use the same real Git consumer with a small committed source fixture.
  const controlledOriginal = mainFixture(
    sourceFixture.root,
    sourceFixture.head,
  );
  const controlledMain = () => structuredClone(controlledOriginal);
  test("admits the complete current source manifest and an exact main manual run", () => {
    const input = main();
    expect(verifyMainValidation(input).runAttempt).toBe(2);
    input.run.event = "workflow_dispatch";
    expect(verifyMainValidation(input).sourceSha).toBe(sourceSha);
  });
  test.each([
    ["fork", (x) => (x.run.repository.full_name = "other/repo")],
    ["workflow", (x) => (x.run.path = ".github/workflows/ci.yml")],
    ["branch", (x) => (x.run.head_branch = "staging")],
    ["source", (x) => (x.run.head_sha = "e".repeat(40))],
    ["PR event", (x) => (x.run.event = "pull_request")],
    ["cancelled", (x) => (x.run.conclusion = "cancelled")],
    ["unfinished", (x) => (x.run.status = "in_progress")],
    ["attempt", (x) => x.run.run_attempt++],
    ["artifact run", (x) => x.artifact.workflow_run.id++],
    [
      "artifact source",
      (x) => (x.artifact.workflow_run.head_sha = "e".repeat(40)),
    ],
    [
      "artifact branch",
      (x) => (x.artifact.workflow_run.head_branch = "staging"),
    ],
    ["expired artifact", (x) => (x.artifact.expired = true)],
    ["result source", (x) => (x.archive.results.headSha = "e".repeat(40))],
    ["result run", (x) => (x.archive.results.runId = "702")],
    ["missing surface result", (x) => delete x.archive.results.results.cloud],
    [
      "skipped surface",
      (x) => (x.archive.results.results.canonical = "skipped"),
    ],
    [
      "extra surface result",
      (x) => (x.archive.results.results.extra = "success"),
    ],
    ["missing row", (x) => x.archive.observed.surfaces.pop()],
    [
      "extra row",
      (x) => x.archive.observed.surfaces.push(x.archive.observed.surfaces[0]),
    ],
    [
      "row from prior source",
      (x) => (x.archive.observed.surfaces[0].sourceSha = "e".repeat(40)),
    ],
    [
      "row digest",
      (x) => (x.archive.observed.surfaces[0].inputDigest = "e".repeat(64)),
    ],
    [
      "expected input",
      (x) => (x.archive.expected.surfaces[0].inputDigest = "e".repeat(64)),
    ],
    ["expired proof", (x) => (x.now = "2026-08-30T12:00:00Z")],
  ])("refuses %s without an effect", (_name, mutate) => {
    const input = main();
    mutate(input);
    expect(() => verifyMainValidation(input)).toThrow();
  });

  function archiveBytes(input, extra = false) {
    const directory = mkdtempSync(resolve(tmpdir(), "main-admission-test-"));
    try {
      for (const name of ["expected", "observed", "results"])
        writeFileSync(
          resolve(directory, `${name}.json`),
          JSON.stringify(input.archive[name]),
        );
      if (extra) writeFileSync(resolve(directory, "extra.json"), "{}");
      const zip = resolve(directory, "proof.zip");
      const child = spawnSync(
        "zip",
        [
          "-q",
          zip,
          "expected.json",
          "observed.json",
          "results.json",
          ...(extra ? ["extra.json"] : []),
        ],
        { cwd: directory },
      );
      expect(child.status).toBe(0);
      return readFileSync(zip);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  test("reads the actual archive and refuses corrupt bytes or extra members", () => {
    const input = main();
    const bytes = archiveBytes(input);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    expect(readValidationArchive(bytes, digest)).toEqual(input.archive);
    expect(() =>
      readValidationArchive(
        Buffer.concat([bytes, Buffer.from("changed")]),
        digest,
      ),
    ).toThrow(/digest/);
    const extra = archiveBytes(input, true);
    expect(() =>
      readValidationArchive(
        extra,
        `sha256:${createHash("sha256").update(extra).digest("hex")}`,
      ),
    ).toThrow(/members/);
  });
  test("rechecks the actual run after download and rejects rerun, newer run, or missing manifest", async () => {
    for (const variant of [
      "valid",
      "rerun",
      "newer",
      "missing",
      "failed",
      "old attempt",
      "older ID active",
      "older ID queued",
      "older ID failure",
      "older ID cancelled",
      "older ID success",
      "fresh recovery",
      "cross-ID rerun during download",
      "tied failure",
      "missing start",
    ]) {
      const input = variant === "valid" ? main() : controlledMain();
      const validationRepoRoot =
        variant === "valid" ? repoRoot : sourceFixture.root;
      input.run.run_attempt = 1;
      input.archive.results.runAttempt = variant === "old attempt" ? "0" : "1";
      let other = {
        ...input.run,
        id: 700,
        run_attempt: 2,
        run_started_at: "2026-08-17T11:30:00Z",
      };
      const fresh = {
        ...input.run,
        id: 702,
        run_started_at: "2026-08-17T11:45:00Z",
      };
      if (variant === "older ID active")
        other = { ...other, status: "in_progress", conclusion: null };
      if (variant === "older ID queued")
        other = {
          ...other,
          status: "queued",
          conclusion: null,
          run_started_at: undefined,
        };
      if (
        ["older ID failure", "fresh recovery", "tied failure"].includes(variant)
      )
        other.conclusion = "failure";
      if (variant === "older ID cancelled") other.conclusion = "cancelled";
      if (variant === "tied failure")
        other.run_started_at = "2026-08-17T11:00:00.000Z";
      if (variant === "missing start") delete input.run.run_started_at;
      if (variant === "cross-ID rerun during download")
        other = {
          ...other,
          run_attempt: 1,
          run_started_at: "2026-08-17T10:00:00Z",
        };
      const selected =
        variant === "older ID success"
          ? other
          : variant === "fresh recovery"
            ? fresh
            : input.run;
      input.archive.results.runId = String(selected.id);
      input.archive.results.runAttempt =
        variant === "old attempt" ? "0" : String(selected.run_attempt);
      input.artifact.workflow_run.id = selected.id;
      const bytes = archiveBytes(input);
      input.artifact.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      let downloaded = false;
      const calls = [];
      const inventory = () => {
        if (
          variant.startsWith("older ID") ||
          [
            "fresh recovery",
            "tied failure",
            "cross-ID rerun during download",
          ].includes(variant)
        )
          return [
            input.run,
            other,
            ...(variant === "fresh recovery" ? [fresh] : []),
          ];
        return variant === "newer" && downloaded
          ? [input.run, fresh]
          : [input.run];
      };
      const api = {
        async request(method, endpoint, _body, mode) {
          calls.push({ method, endpoint, mode });
          expect(method).toBe("GET");
          if (endpoint.includes("/workflows/")) {
            const runs = structuredClone(inventory());
            if (variant === "failed") runs[0].conclusion = "failure";
            return { total_count: runs.length, workflow_runs: runs };
          }
          if (endpoint.endsWith("/zip")) {
            downloaded = true;
            if (variant === "cross-ID rerun during download")
              other = {
                ...other,
                run_attempt: 2,
                status: "in_progress",
                conclusion: null,
                run_started_at: "2026-08-17T11:30:00Z",
              };
            return bytes;
          }
          if (endpoint.includes("/artifacts?"))
            return {
              total_count: variant === "missing" ? 0 : 1,
              artifacts: variant === "missing" ? [] : [input.artifact],
            };
          const attempt = endpoint.match(
            /^\/actions\/runs\/(\d+)\/attempts\/(\d+)$/,
          );
          if (attempt) {
            const run = inventory().find(
              (run) => run.id === Number(attempt[1]),
            );
            expect(run.run_attempt).toBe(Number(attempt[2]));
            return structuredClone(run);
          }
          const detail = endpoint.match(/^\/actions\/runs\/(\d+)$/);
          if (detail) {
            const run = structuredClone(
              inventory().find((run) => run.id === Number(detail[1])),
            );
            if (variant === "rerun")
              return {
                ...run,
                run_attempt: 2,
                status: "in_progress",
                conclusion: null,
              };
            return run;
          }
          throw new Error(`Unexpected read ${endpoint}`);
        },
      };
      const admission = requireMainValidation({
        api,
        repository: input.repository,
        sourceSha: input.sourceSha,
        repoRoot: validationRepoRoot,
        now,
      });
      if (["valid", "older ID success", "fresh recovery"].includes(variant)) {
        const proof = await admission;
        expect(proof.runId).toBe(selected.id);
        expect(proof.runAttempt).toBe(selected.run_attempt);
      } else await expect(admission).rejects.toThrow();
      expect(calls.every((call) => call.method === "GET")).toBe(true);
      console.log(
        `[main-proof-fixture] ${variant}: ${["valid", "older ID success", "fresh recovery"].includes(variant) ? "admitted current proof" : "refused"}; read-only calls=${calls.length}`,
      );
    }

    // Exercise the combined exported entrypoint with real staging+main ZIPs.
    // A main rerun starting during the staging read must be seen before return.
    const stageDirectory = mkdtempSync(
      resolve(tmpdir(), "combined-main-stage-"),
    );
    try {
      const stageSource = "c".repeat(40);
      const certification = createStagingReleaseCertification({
        repository: "elizaOS/eliza",
        runId: "901",
        runAttempt: "1",
        sourceSha: stageSource,
        treeSha,
        workflowSha256: createHash("sha256")
          .update(readFileSync(workflowPath))
          .digest("hex"),
        issuedAt: now,
        expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
      });
      writeFileSync(
        resolve(stageDirectory, CERTIFICATION_FILENAME),
        JSON.stringify(certification),
      );
      const zip = resolve(stageDirectory, "stage.zip");
      expect(
        spawnSync("zip", ["-q", zip, CERTIFICATION_FILENAME], {
          cwd: stageDirectory,
        }).status,
      ).toBe(0);
      const stageBytes = readFileSync(zip);
      const stageArtifact = {
        id: 902,
        name: artifactNameForTree(treeSha),
        expired: false,
        digest: `sha256:${createHash("sha256").update(stageBytes).digest("hex")}`,
        workflow_run: {
          id: 901,
          head_sha: stageSource,
          head_branch: "staging",
        },
      };
      const stageRun = {
        id: 901,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        event: "push",
        head_branch: "staging",
        head_sha: stageSource,
        path: CERTIFICATION_WORKFLOW,
        repository: { full_name: "elizaOS/eliza" },
      };
      for (const variant of [
        "both valid",
        "main starts during staging read",
        "stage only",
        "main only",
      ]) {
        const input = controlledMain();
        input.run.run_attempt = 1;
        input.archive.results.runAttempt = "1";
        const bytes = archiveBytes(input);
        input.artifact.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        let run = structuredClone(input.run);
        const calls = [];
        const api = {
          async request(method, endpoint) {
            expect(method).toBe("GET");
            calls.push(endpoint);
            if (endpoint.startsWith("/actions/artifacts?"))
              return {
                artifacts: variant === "main only" ? [] : [stageArtifact],
              };
            if (endpoint === "/actions/runs/901") return stageRun;
            if (endpoint === "/actions/artifacts/902/zip") {
              if (variant === "main starts during staging read")
                run = {
                  ...run,
                  run_attempt: 2,
                  status: "in_progress",
                  conclusion: null,
                };
              return stageBytes;
            }
            if (endpoint.includes("/workflows/"))
              return {
                total_count: variant === "stage only" ? 0 : 1,
                workflow_runs: variant === "stage only" ? [] : [run],
              };
            if (endpoint.includes("/artifacts?"))
              return { total_count: 1, artifacts: [input.artifact] };
            if (endpoint === "/actions/artifacts/801/zip") return bytes;
            if (endpoint === "/actions/runs/701") return run;
            throw new Error(`Unexpected combined read ${endpoint}`);
          },
        };
        const admission = requireProductionCertification({
          api,
          repository: input.repository,
          sourceSha: input.sourceSha,
          treeSha,
          repoRoot: sourceFixture.root,
          now,
        });
        if (variant === "both valid") {
          const proof = await admission;
          expect(proof.mainValidation.runAttempt).toBe(1);
          expect(proof.expiresAt).toBe(
            new Date(
              Math.min(
                Date.parse(certification.expires_at),
                Date.parse(proof.mainValidation.expiresAt),
              ),
            ).toISOString(),
          );
          // Returned earliest expiry is checked again at every actual mutation boundary.
          expect(() =>
            assertProductionCertificationFresh(
              proof.expiresAt,
              Date.parse(proof.expiresAt),
            ),
          ).toThrow(/expired/);
          expect(calls.indexOf("/actions/artifacts/902/zip")).toBeLessThan(
            calls.findIndex((endpoint) => endpoint.includes("/workflows/")),
          );
        } else await expect(admission).rejects.toThrow();
        console.log(
          `[combined-proof-fixture] ${variant}: ${variant === "both valid" ? "admitted both current proofs" : "refused"}; mutations=0`,
        );
      }
    } finally {
      rmSync(stageDirectory, { recursive: true, force: true });
    }
  }, 300_000);
  test("all three production effect consumers require main proof before their first mutation", () => {
    const image = readFileSync(
      resolve(repoRoot, ".github/workflows/build-agent-image.yml"),
      "utf8",
    );
    const worker = readFileSync(
      resolve(
        repoRoot,
        ".github/workflows/deploy-eliza-provisioning-worker.yml",
      ),
      "utf8",
    );
    expect(image.indexOf("production-effect-certification.ts")).toBeLessThan(
      image.indexOf('\n            docker push "$tag"'),
    );
    expect(worker.indexOf("production-effect-certification.ts")).toBeLessThan(
      worker.indexOf("bun run db:cloud:migrate"),
    );
    const imageSteps = Object.values(parse(image).jobs).flatMap(
      (job) => job.steps ?? [],
    );
    const prepare = imageSteps.find(
      (step) => step.name === "Prepare CI dockerignore",
    );
    const restore = imageSteps.find(
      (step) =>
        step.name ===
        "Restore source Docker ignore after local image verification",
    );
    const push = imageSteps.find(
      (step) => step.name === "Push exact verified image",
    );
    expect(imageSteps.indexOf(restore)).toBe(imageSteps.indexOf(push) - 1);
    expect(restore.run).toBe("git restore --source=HEAD -- .dockerignore");
    const { root: fixtureRoot, head } = createSourceAdmissionFixture();
    try {
      const clean = currentValidationManifest(fixtureRoot, head);
      const rows = clean.surfaces.map((surface) =>
        createEvidence(clean, surface.id, now, 168),
      );
      const run = (step) => {
        const child = spawnSync("bash", ["-e", "-c", step.run], {
          cwd: fixtureRoot,
          encoding: "utf8",
        });
        expect(child.status).toBe(0);
      };
      run(prepare);
      const prepared = currentValidationManifest(fixtureRoot, head);
      expect(
        prepared.surfaces.every(
          (surface, i) => surface.inputDigest !== clean.surfaces[i].inputDigest,
        ),
      ).toBe(true);
      expect(() => verifyCompleteManifest(prepared, rows, now)).toThrow(
        /input digest/,
      );
      run(restore);
      const restored = currentValidationManifest(fixtureRoot, head);
      expect(verifyCompleteManifest(restored, rows, now)).toEqual(
        verifyCompleteManifest(clean, rows, now),
      );
      writeFileSync(
        resolve(fixtureRoot, "packages/fixture/source.ts"),
        "export const value = 2;\n",
      );
      expect(() =>
        verifyCompleteManifest(
          currentValidationManifest(fixtureRoot, head),
          rows,
          now,
        ),
      ).toThrow(/input digest/);
      console.log(
        "[image-preparation-fixture] actual CI copy refused; exact owned-file restore admitted; unrelated dirty source refused; effects=0",
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
    const release = parse(releaseWorkflow);
    for (const [job, labels] of Object.entries({
      "migrate-db": ["Run migrations"],
      "deploy-api": ["Deploy to Cloudflare Workers"],
      "deploy-app": [
        "Ensure eliza-app Pages project exists",
        "Deploy to Cloudflare Pages",
      ],
    }))
      for (const label of labels) {
        const step = release.jobs[job].steps.find(
          (step) => step.name === label,
        );
        expect(step.env.GITHUB_TOKEN).toBe(`\${{ github.token }}`);
        expect(step.run).toContain(
          'production-effect-certification.ts main-validation "$GITHUB_SHA"',
        );
        expect(step.run).not.toContain("EFFECT_DIGEST");
        expect(step.run).toContain('cd "$(git rev-parse --show-toplevel)"');
        const prefix = step.run.slice(
          0,
          step.run.indexOf("\nfi") + "\nfi".length,
        );
        // Execute the actual YAML admission prefix from its real nested job directory.
        // The expected branch refusal occurs before any GitHub read or effect.
        const nested =
          job === "deploy-api"
            ? "packages/cloud/api"
            : job === "deploy-app"
              ? "packages/app"
              : ".";
        for (const context of [
          { name: "feature", ref: "refs/heads/feature" },
          { name: "main", ref: "refs/tags/main" },
        ]) {
          const probe = spawnSync("bash", ["-c", prefix], {
            timeout: 15_000,
            cwd: resolve(repoRoot, nested),
            encoding: "utf8",
            env: {
              ...process.env,
              MAIN_VALIDATION_ENVIRONMENT: "production",
              TARGET_ENVIRONMENT: "production",
              GITHUB_SHA: sourceSha,
              GITHUB_REF_NAME: context.name,
              GITHUB_REF: context.ref,
              GITHUB_TOKEN: "",
            },
          });
          expect(probe.status).toBe(1);
          expect(probe.stderr).toContain(
            "Production certification requires a full main source SHA",
          );
          expect(probe.stderr).not.toContain("MODULE_NOT_FOUND");
        }

        expect(
          step.run.split("production-effect-certification.ts")[0],
        ).not.toContain('if [ "$FORCE"'); // existing force may be used later by freshness, proof itself is unconditional on it
      }
  }, 90_000);
});
