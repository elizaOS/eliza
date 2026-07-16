import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { validateProductionGateArtifactSources } from "../src/production-artifact-sources.js";
import { validateProductionEvidenceFreshness } from "../src/production-evidence-freshness.js";
import { createServer } from "../src/server.js";
import { MergeSteward } from "../src/steward.js";
import { InMemoryQueueStore } from "../src/store.js";
import { mkdtempSyncInTestRoot } from "./helpers/tmp-root.js";
import { completeEvidence } from "./production-gate-fixtures.js";

const CLI_PATH = new URL("../src/cli.js", import.meta.url);
const ROOT = new URL("../../..", import.meta.url);
const STAGING_RUNNER_COMPOSE = new URL(
  "deployment/hetzner-staging/compose.actions-runner.yml",
  ROOT,
);
const STAGING_RUNNER_CONFIG = new URL(
  "deployment/hetzner-staging/runner/config.example.yml",
  ROOT,
);

describe("merge steward CLI", () => {
  it("evaluates a queue item from stdin", async () => {
    const result = await runCli("evaluate", {
      authorKind: "human",
      targetProtected: true,
      reviewSatisfied: true,
      headShaMatches: true,
      changedFiles: ["README.md"],
      requiredChecks: ["smoke"],
      checkResults: { smoke: "success" },
    });

    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.decision.allowed, true);
  });

  it("returns non-zero for unknown commands", async () => {
    const result = await runCli("wat", {});

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown command/);
  });

  it("preflights local runtime configuration", async () => {
    const result = await runCli("preflight", {});

    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.preflight.ok, true);
    assert.equal(body.preflight.mode, "local");
  });

  it("returns non-zero for unsafe production preflight", async () => {
    const result = await runCli(
      "preflight",
      {},
      { MERGE_STEWARD_DEPLOYMENT_MODE: "production" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.preflight.ok, false);
    assert.ok(
      body.preflight.errors.some((error) => error.code === "postgres_required"),
    );
  });

  it("runs the worker command without starting when disabled", async () => {
    const result = await runCli("worker", {});

    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.worker.started, false);
    assert.equal(body.worker.stopReason, "worker_disabled");
  });

  it("runs deployment doctor against a local steward server", async () => {
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
    });
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem({
      repo: "elizaos/eliza",
      pullRequestId: 77,
      queueState: "ready",
      targetBranch: "develop",
    });
    const server = createServer({
      config,
      logger: silentLogger,
      steward: new MergeSteward({ config, store, logger: silentLogger }),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      const result = await runCli("doctor", {}, {}, [
        `http://${address.address}:${address.port}`,
      ]);

      assert.equal(result.status, 0);
      const body = JSON.parse(result.stdout);
      assert.equal(body.doctor.ok, true);
      assert.equal(
        body.doctor.checks.find((check) => check.name === "health").ok,
        true,
      );
      assert.equal(
        body.doctor.checks.find((check) => check.name === "ready").ok,
        true,
      );
      assert.equal(
        body.doctor.checks.find((check) => check.name === "discovery_manifest")
          .ok,
        true,
      );
      assert.equal(
        body.doctor.checks.find((check) => check.name === "openapi_contract")
          .ok,
        true,
      );
      assert.equal(
        body.doctor.checks.find((check) => check.name === "metrics").ok,
        true,
      );
      assert.equal(
        body.doctor.checks.find((check) => check.name === "workflow_api").ok,
        true,
      );
      assert.equal(
        body.doctor.checks.find((check) => check.name === "project_board_api")
          .ok,
        true,
      );
      assert.equal(
        body.doctor.checks.find((check) => check.name === "merge_queue_api").ok,
        true,
      );
      assert.equal(
        body.doctor.checks.find((check) => check.name === "agent_insights_api")
          .ok,
        true,
      );
      assert.equal(
        body.doctor.checks.find(
          (check) => check.name === "agent_performance_api",
        ).ok,
        true,
      );
      assert.equal(
        body.doctor.checks.find((check) => check.name === "agent_routing_api")
          .ok,
        true,
      );
      assert.equal(
        body.doctor.checks.find((check) => check.name === "agent_inbox_api").ok,
        true,
      );
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("prints a normalized discovery summary from a local steward server", async () => {
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_AGENT_IDENTITY_REGISTRY: "agent-cli",
    });
    const server = createServer({
      config,
      logger: silentLogger,
      steward: new MergeSteward({
        config,
        store: new InMemoryQueueStore(),
        logger: silentLogger,
      }),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      const result = await runCli("discovery-summary", {}, {}, [
        `http://${address.address}:${address.port}`,
      ]);

      assert.equal(result.status, 0, result.stderr);
      const body = JSON.parse(result.stdout);
      assert.equal(body.discoverySummary.service, "eliza-merge-steward");
      assert.equal(
        body.discoverySummary.routes.discovery,
        "/.well-known/eliza-hub.json",
      );
      assert.equal(
        body.discoverySummary.surfaces.gitAuthority,
        "forgejo_native",
      );
      assert.equal(
        body.discoverySummary.agentPolicy.branchNamespaceRequired,
        true,
      );
      assert.equal(
        body.discoverySummary.agentPolicy.workItemRequiredForAgentPrs,
        true,
      );
      assert.equal(
        body.discoverySummary.agentPolicy.identityRegistryRequired,
        true,
      );
      assert.equal(body.discoverySummary.agentPolicy.knownAgentIdCount, 1);
      assert.equal(
        body.discoverySummary.mergeExecution.liveExecutionConfigured,
        false,
      );
      assert.equal(
        body.discoverySummary.productionReadiness.productionReady,
        false,
      );
      assert.equal(
        body.discoverySummary.githubParity.githubDropInReplacement,
        false,
      );
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("syncs lists and disables agent identities through the CLI", async () => {
    process.env.MERGE_STEWARD_CLI_TEST_TOKEN = "registry-secret";
    const config = loadConfig({
      FORGEJO_WEBHOOK_SECRET_ENV: "MERGE_STEWARD_TEST_SECRET",
      MERGE_STEWARD_API_AUTH_REQUIRED: "true",
      MERGE_STEWARD_API_TOKEN_ENV: "MERGE_STEWARD_CLI_TEST_TOKEN",
    });
    const store = new InMemoryQueueStore();
    const server = createServer({
      config,
      logger: silentLogger,
      steward: new MergeSteward({ config, store, logger: silentLogger }),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      const env = {
        MERGE_STEWARD_URL: `http://${address.address}:${address.port}`,
        MERGE_STEWARD_API_TOKEN: "registry-secret",
      };
      const syncResult = await runCli(
        "agent-identities",
        {
          agents: [
            {
              id: "agent-cli",
              displayName: "CLI Agent",
              source: "eliza-cloud",
            },
          ],
          registeredBy: "admin-cli",
        },
        env,
        ["sync"],
      );
      const listResult = await runCli(
        "agent-identities",
        { status: "active" },
        env,
        ["list"],
      );
      const disableResult = await runCli(
        "agent-identities",
        {
          id: "agent-cli",
          reason: "rotated",
          disabledBy: "admin-cli",
        },
        env,
        ["disable"],
      );

      assert.equal(syncResult.status, 0, syncResult.stderr);
      assert.equal(listResult.status, 0, listResult.stderr);
      assert.equal(disableResult.status, 0, disableResult.stderr);

      const syncBody = JSON.parse(syncResult.stdout);
      const listBody = JSON.parse(listResult.stdout);
      const disableBody = JSON.parse(disableResult.stdout);

      assert.equal(syncBody.agentIdentities.synced, 1);
      assert.equal(syncBody.agentIdentities.agents[0].id, "agent-cli");
      assert.equal(
        syncBody.agentIdentities.agents[0].registeredBy,
        "admin-cli",
      );
      assert.equal(listBody.agentIdentities.agents[0].id, "agent-cli");
      assert.equal(disableBody.agentIdentities.agent.status, "disabled");
      assert.equal(disableBody.agentIdentities.agent.disableReason, "rotated");
    } finally {
      delete process.env.MERGE_STEWARD_CLI_TEST_TOKEN;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("runs the production gate from evidence JSON", async () => {
    const result = await runCli("production-gate", {
      evidence: completeEvidence(),
    });

    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.productionGate.ok, true);
    assert.equal(
      body.productionGate.checks.find(
        (check) => check.name === "steward_runtime",
      ).ok,
      true,
    );
  });

  it("prints static GitHub parity without private evidence", async () => {
    const result = await runCli("github-parity", {});

    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    const mergeQueue = body.parity.surfaces.find(
      (surface) => surface.id === "merge_queue",
    );

    assert.equal(
      body.parity.status,
      "forgejo_plus_eliza_not_full_github_parity",
    );
    assert.equal(body.parity.productionGateSummary, null);
    assert.equal(body.parity.summary.privateEvidenceEvaluated, false);
    assert.equal(body.parity.summary.cutoverReady, false);
    assert.ok(
      body.parity.summary.blockedCutoverSurfaceIds.includes("merge_queue"),
    );
    assert.equal(
      mergeQueue.cutoverReadiness.status,
      "private_evidence_required",
    );
  });

  it("prints cutover-ready GitHub parity with passing private evidence", async () => {
    const result = await runCli("github-parity", {
      evidence: completeEvidence(),
    });

    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    const mergeQueue = body.parity.surfaces.find(
      (surface) => surface.id === "merge_queue",
    );

    assert.equal(body.parity.productionGateSummary.ok, true);
    assert.equal(body.parity.summary.privateEvidenceEvaluated, true);
    assert.equal(body.parity.summary.productionGatePassed, true);
    assert.equal(body.parity.summary.cutoverReady, true);
    assert.deepEqual(body.parity.summary.blockedCutoverSurfaceIds, []);
    assert.equal(mergeQueue.cutoverReadiness.status, "ready");
    assert.ok(
      mergeQueue.cutoverReadiness.passedGateChecks.includes(
        "merge_queue_rollout",
      ),
    );
  });

  it("returns non-zero GitHub parity when private evidence blocks cutover", async () => {
    const evidence = completeEvidence();
    evidence.runner.auditEvidence = null;

    const result = await runCli("github-parity", { evidence });

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const actions = body.parity.surfaces.find(
      (surface) => surface.id === "actions",
    );

    assert.equal(body.parity.productionGateSummary.ok, false);
    assert.equal(body.parity.summary.privateEvidenceEvaluated, true);
    assert.equal(body.parity.summary.cutoverReady, false);
    assert.ok(body.parity.summary.blockedCutoverSurfaceIds.includes("actions"));
    assert.equal(actions.cutoverReadiness.status, "blocked_by_production_gate");
    assert.ok(
      actions.cutoverReadiness.failingGateChecks.includes("runner_isolation"),
    );
  });

  it("renders production readiness scored against private evidence", async () => {
    const result = await runCli("production-readiness", {
      evidence: completeEvidence(),
    });

    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    const domains = Object.fromEntries(
      body.productionReadiness.domains.map((domain) => [domain.id, domain]),
    );

    assert.equal(body.productionReadiness.status, "production_ready");
    assert.equal(body.productionReadiness.currentUse, "production_ready");
    assert.equal(body.productionReadiness.productionReady, true);
    assert.equal(body.productionReadiness.privateEvidenceEvaluated, true);
    assert.deepEqual(body.productionReadiness.summary.blockedDomains, []);
    assert.equal(domains.merge_queue_rollout.status, "passed");
    assert.deepEqual(body.productionReadiness.nextActions, []);
  });

  it("renders production cutover scored against private evidence", async () => {
    const result = await runCli("production-cutover", {
      evidence: completeEvidence(),
    });

    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);

    assert.equal(body.productionCutover.status, "ready_for_cutover");
    assert.equal(body.productionCutover.productionReady, true);
    assert.equal(body.productionCutover.privateEvidenceEvaluated, true);
    assert.equal(
      body.productionCutover.guardrails.liveAgentMergesAllowed,
      true,
    );
    assert.equal(body.productionCutover.nextPhase, null);
    assert.deepEqual(body.productionCutover.executionPlan.orderedSteps, []);
  });

  it("renders a schema-valid non-passing production evidence template", async () => {
    const result = await runCli("production-evidence-template", {});

    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);

    assert.equal(body.productionEvidenceTemplate.readOnly, true);
    assert.equal(body.productionEvidenceTemplate.summary.shapeValid, true);
    assert.equal(
      body.productionEvidenceTemplate.templatePassesProductionGate,
      false,
    );
    assert.ok(
      body.productionEvidenceTemplate.requiredBlocks.includes("domain"),
    );
    assert.equal(
      body.productionEvidenceTemplate.usage.inventoryCommand,
      "node deployment/hetzner-staging/scripts/production-evidence-inventory.mjs --strict",
    );
    assert.equal(
      body.productionEvidenceTemplate.usage.assembleCommand,
      "node deployment/hetzner-staging/scripts/production-evidence-assemble.mjs",
    );
    assert.equal(
      body.productionEvidenceTemplate.template.sso.smokeEvidence,
      null,
    );
    assert.equal(
      body.productionEvidenceTemplate.template.sso.bootstrapEvidence,
      null,
    );
  });

  it("fails production readiness when private evidence leaves a launch domain blocked", async () => {
    const evidence = completeEvidence();
    evidence.runner.trustedSmokeWorkflowPassed = false;

    const result = await runCli("production-readiness", { evidence });

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const runner = body.productionReadiness.domains.find(
      (domain) => domain.id === "runner_isolation",
    );

    assert.equal(
      body.productionReadiness.status,
      "blocked_until_private_evidence_passes",
    );
    assert.equal(body.productionReadiness.productionReady, false);
    assert.deepEqual(body.productionReadiness.summary.blockedDomains, [
      "runner_isolation",
    ]);
    assert.equal(runner.status, "blocked");
    assert.ok(
      runner.gateCheck.errors.some((error) =>
        /trustedSmokeWorkflowPassed/.test(error.message),
      ),
    );
    assert.ok(
      body.productionReadiness.nextActions.some(
        (action) => action.id === "runner_isolation",
      ),
    );
  });

  it("fails production cutover when private evidence leaves a launch domain blocked", async () => {
    const evidence = completeEvidence();
    evidence.runner.trustedSmokeWorkflowPassed = false;

    const result = await runCli("production-cutover", { evidence });

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);

    assert.equal(body.productionCutover.status, "blocked");
    assert.equal(body.productionCutover.productionReady, false);
    assert.equal(body.productionCutover.nextPhase.id, "runner_and_repository");
    assert.ok(
      body.productionCutover.executionPlan.orderedSteps.some(
        (step) => step.domainId === "runner_isolation",
      ),
    );
  });

  it("re-reads rollout artifacts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, true);
    assert.equal(artifactCheck.ok, true);
    assert.equal(body.productionGate.summary.total, 17);
  });

  it("runs strict production gate with artifact and freshness validation", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const result = await runCli(
      "production-gate",
      { evidence },
      {
        PRODUCTION_GATE_NOW: "2026-07-07T00:00:00.000Z",
      },
      ["--strict"],
    );

    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );
    const freshnessCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_freshness",
    );

    assert.equal(body.productionGate.ok, true);
    assert.equal(artifactCheck.ok, true);
    assert.equal(freshnessCheck.ok, true);
    assert.equal(body.productionGate.summary.total, 18);
  });

  it("validates production artifacts and freshness in-process", () => {
    const evidence = completeEvidenceWithRolloutArtifacts();

    const artifactCheck = validateProductionGateArtifactSources(evidence);
    const freshnessCheck = validateProductionEvidenceFreshness(evidence, {
      now: new Date("2026-07-07T00:00:00.000Z"),
    });

    assert.equal(artifactCheck.ok, true);
    assert.deepEqual(artifactCheck.errors, []);
    assert.equal(freshnessCheck.ok, true);
    assert.deepEqual(freshnessCheck.errors, []);
  });

  it("renders strict production readiness with artifact and freshness checks", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const result = await runCli(
      "production-readiness",
      { evidence },
      {
        PRODUCTION_GATE_NOW: "2026-07-07T00:00:00.000Z",
      },
      ["--strict"],
    );

    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);

    assert.equal(body.productionReadiness.productionReady, true);
    assert.equal(body.productionReadiness.privateEvidenceEvaluated, true);
    assert.deepEqual(body.productionReadiness.summary.failedExtraChecks, []);
    assert.deepEqual(
      body.productionReadiness.authoritativeGate.extraChecks.map(
        (check) => check.name,
      ),
      ["production_evidence_artifacts", "production_evidence_freshness"],
    );
  });

  it("blocks forged domain probe artifacts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const domainSource = evidence.domain.probeEvidence.source;
    const domain = JSON.parse(readFileSync(domainSource, "utf8"));
    domain.domainEvidence.domain.tlsVerified = false;
    domain.domainEvidence.checks.find(
      (check) => check.name === "tls_fetch",
    ).ok = false;
    writeJson(domainSource, domain);
    evidence.domain.probeEvidence.sha256 = sha256File(domainSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /tlsVerified|domain probe checks/.test(error.message),
      ),
    );
    assert.ok(
      body.productionGate.checks.find((check) => check.name === "domain_tls")
        .ok,
    );
  });

  it("blocks forged rollout summaries when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    evidence.mergeQueueRollout.liveDrillEvidence.runId = "run:forged";
    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some(
        (error) => error.code === "artifact_summary_mismatch",
      ),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "merge_queue_rollout",
      ).ok,
    );
  });

  it("blocks forged steward summaries when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    evidence.steward.doctorEvidence.checkCount = 99;
    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some(
        (error) => error.code === "artifact_summary_mismatch",
      ),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "steward_runtime",
      ).ok,
    );
  });

  it("blocks forged image provenance artifacts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const imageProvenanceSource =
      evidence.imageProvenance.provenanceEvidence.source;
    const imageProvenance = JSON.parse(
      readFileSync(imageProvenanceSource, "utf8"),
    );
    imageProvenance.imageProvenanceAudit.evidence.sbomGenerated = false;
    writeJson(imageProvenanceSource, imageProvenance);
    evidence.imageProvenance.provenanceEvidence.sha256 = sha256File(
      imageProvenanceSource,
    );

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) => /sbomGenerated/.test(error.message)),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "image_provenance",
      ).ok,
    );
  });

  it("blocks forged backup artifacts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const backupSource = evidence.backups.backupEvidence.source;
    const backup = JSON.parse(readFileSync(backupSource, "utf8"));
    backup.backupAudit.attestations.offHost = false;
    writeJson(backupSource, backup);
    evidence.backups.backupEvidence.sha256 = sha256File(backupSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) => /offHost/.test(error.message)),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "backup_restore",
      ).ok,
    );
  });

  it("blocks forged off-site backup receipts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const uploadSummary = evidence.backups.backupEvidence.offsiteUploadReceipt;
    const uploadReceipt = JSON.parse(
      readFileSync(uploadSummary.source, "utf8"),
    );
    uploadReceipt.uploadVerified = false;
    writeJson(uploadSummary.source, uploadReceipt);
    uploadSummary.sha256 = sha256File(uploadSummary.source);

    const restoreSummary =
      evidence.backups.backupEvidence.offsiteRestoreReceipt;
    const restoreReceipt = JSON.parse(
      readFileSync(restoreSummary.source, "utf8"),
    );
    restoreReceipt.uploadReceiptSha256 = uploadSummary.sha256;
    writeJson(restoreSummary.source, restoreReceipt);
    restoreSummary.sha256 = sha256File(restoreSummary.source);
    restoreSummary.uploadReceiptSha256 = uploadSummary.sha256;

    const backupSource = evidence.backups.backupEvidence.source;
    const backup = JSON.parse(readFileSync(backupSource, "utf8"));
    backup.backupAudit.offsiteUploadReceipt = { ...uploadSummary };
    backup.backupAudit.offsiteRestoreReceipt = { ...restoreSummary };
    writeJson(backupSource, backup);
    evidence.backups.backupEvidence.sha256 = sha256File(backupSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /off-site upload receipt/.test(error.message),
      ),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "backup_restore",
      ).ok,
    );
  });

  it("blocks forged database artifacts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const databaseSource = evidence.database.databaseEvidence.source;
    const database = JSON.parse(readFileSync(databaseSource, "utf8"));
    database.databaseAudit.evidence.emptyHostRestoreDrillPassed = false;
    writeJson(databaseSource, database);
    evidence.database.databaseEvidence.sha256 = sha256File(databaseSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /emptyHostRestoreDrillPassed/.test(error.message),
      ),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "database_migration",
      ).ok,
    );
  });

  it("blocks forged security review artifacts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const securitySource = evidence.securityReview.securityEvidence.source;
    const securityReview = JSON.parse(readFileSync(securitySource, "utf8"));
    securityReview.securityReviewAudit.evidence.tokensReviewed = false;
    writeJson(securitySource, securityReview);
    evidence.securityReview.securityEvidence.sha256 =
      sha256File(securitySource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /tokensReviewed/.test(error.message),
      ),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "security_review",
      ).ok,
    );
  });

  it("blocks forged deployment receipts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const postDeploySource = evidence.deployment.postDeployEvidence.source;
    const postDeploy = JSON.parse(readFileSync(postDeploySource, "utf8"));
    postDeploy.summary.failed = 1;
    postDeploy.checks.find(
      (check) => check.name === "Merge Steward deployment doctor passes",
    ).status = "fail";
    writeJson(postDeploySource, postDeploy);
    evidence.deployment.postDeployEvidence.sha256 =
      sha256File(postDeploySource);
    evidence.deployment.deployEvidence.postDeployEvidenceSha256 =
      sha256File(postDeploySource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /post-deploy evidence/.test(error.message),
      ),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "deployment_verification",
      ).ok,
    );
  });

  it("blocks forged secret management artifacts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const secretSource = evidence.secrets.secretEvidence.source;
    const secretManagement = JSON.parse(readFileSync(secretSource, "utf8"));
    secretManagement.secretManagementAudit.evidence.webhookSecretsIssued = false;
    writeJson(secretSource, secretManagement);
    evidence.secrets.secretEvidence.sha256 = sha256File(secretSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /webhookSecretsIssued/.test(error.message),
      ),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "secret_management",
      ).ok,
    );
  });

  it("blocks forged mail smoke artifacts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const mailSource = evidence.mail.mailEvidence.source;
    const mail = JSON.parse(readFileSync(mailSource, "utf8"));
    mail.mailAudit.evidence.notificationSmokePassed = false;
    writeJson(mailSource, mail);
    evidence.mail.mailEvidence.sha256 = sha256File(mailSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /notificationSmokePassed/.test(error.message),
      ),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "mail_notifications",
      ).ok,
    );
  });

  it("blocks forged storage retention artifacts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const storageSource = evidence.storage.storageEvidence.source;
    const storage = JSON.parse(readFileSync(storageSource, "utf8"));
    storage.storageAudit.evidence.lfsCapacityReviewed = false;
    writeJson(storageSource, storage);
    evidence.storage.storageEvidence.sha256 = sha256File(storageSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /lfsCapacityReviewed/.test(error.message),
      ),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "storage_retention",
      ).ok,
    );
  });

  it("blocks forged observability artifacts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const observabilitySource =
      evidence.observability.observabilityEvidence.source;
    const observability = JSON.parse(readFileSync(observabilitySource, "utf8"));
    observability.observabilityAudit.evidence.noPageAlertsFiring = false;
    writeJson(observabilitySource, observability);
    evidence.observability.observabilityEvidence.sha256 =
      sha256File(observabilitySource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /noPageAlertsFiring/.test(error.message),
      ),
    );
    assert.ok(
      body.productionGate.checks.find((check) => check.name === "observability")
        .ok,
    );
  });

  it("blocks SSO smoke artifacts without agent identity proof when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const ssoSource = evidence.sso.smokeEvidence.source;
    const ssoSmoke = JSON.parse(readFileSync(ssoSource, "utf8"));
    ssoSmoke.ssoSmoke.agentIdentitySmokePassed = false;
    ssoSmoke.ssoSmoke.agentTokenClaimsVerified = false;
    writeJson(ssoSource, ssoSmoke);
    evidence.sso.smokeEvidence.sha256 = sha256File(ssoSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /agent identity/.test(error.message),
      ),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "sso_registration",
      ).ok,
    );
  });

  it("blocks forged identity bootstrap artifacts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const bootstrapSource = evidence.sso.bootstrapEvidence.source;
    const bootstrap = JSON.parse(readFileSync(bootstrapSource, "utf8"));
    bootstrap.options.applyBootstrap = true;
    bootstrap.checks = bootstrap.checks.filter(
      (check) =>
        check.name !== "Eliza Cloud OIDC auth source config matches env",
    );
    bootstrap.summary.total = bootstrap.checks.length;
    bootstrap.summary.passed = bootstrap.checks.length;
    writeJson(bootstrapSource, bootstrap);
    evidence.sso.bootstrapEvidence.sha256 = sha256File(bootstrapSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /read-only APPLY_BOOTSTRAP=false/.test(error.message),
      ),
    );
    assert.ok(
      artifactCheck.errors.some((error) =>
        /OIDC auth source config/.test(error.message),
      ),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "sso_registration",
      ).ok,
    );
  });

  it("blocks runner smoke artifacts without a passing trusted workflow when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const runnerSmokeSource = evidence.runner.smokeEvidence.source;
    const runnerSmoke = JSON.parse(readFileSync(runnerSmokeSource, "utf8"));
    runnerSmoke.runnerSmoke.trustedWorkflowPassed = false;
    runnerSmoke.runnerSmoke.conclusion = "failure";
    writeJson(runnerSmokeSource, runnerSmoke);
    evidence.runner.smokeEvidence.sha256 = sha256File(runnerSmokeSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) => /runner smoke/.test(error.message)),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "runner_isolation",
      ).ok,
    );
  });

  it("blocks forged repository protection artifacts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const repositoryProtectionSource =
      evidence.repository.liveProtectionEvidence.source;
    const repositoryProtection = JSON.parse(
      readFileSync(repositoryProtectionSource, "utf8"),
    );
    repositoryProtection.repositoryProtection.policy.requiredChecks = [];
    writeJson(repositoryProtectionSource, repositoryProtection);
    evidence.repository.liveProtectionEvidence.sha256 = sha256File(
      repositoryProtectionSource,
    );

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /required check policy/.test(error.message),
      ),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "repository_protection",
      ).ok,
    );
  });

  it("blocks forged pilot bootstrap artifacts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const pilotBootstrapSource =
      evidence.githubMigration.pilotBootstrapEvidence.source;
    const pilotBootstrap = JSON.parse(
      readFileSync(pilotBootstrapSource, "utf8"),
    );
    pilotBootstrap.summary.webhookVerified = false;
    writeJson(pilotBootstrapSource, pilotBootstrap);
    evidence.githubMigration.pilotBootstrapEvidence.sha256 =
      sha256File(pilotBootstrapSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /webhookVerified/.test(error.message),
      ),
    );
    assert.ok(
      body.productionGate.checks.find(
        (check) => check.name === "github_migration_rehearsal",
      ).ok,
    );
  });

  it("blocks live rollout artifacts without strict work reservations when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const liveDrillSource = evidence.mergeQueueRollout.liveDrillEvidence.source;
    const liveDrill = JSON.parse(readFileSync(liveDrillSource, "utf8"));
    liveDrill.mergeQueueRolloutLiveDrill.strictWorkReservationsEnforced = false;
    liveDrill.mergeQueueRolloutLiveDrill.readiness.configuration.requireWorkReservationForAgentPrs = false;
    writeJson(liveDrillSource, liveDrill);
    evidence.mergeQueueRollout.liveDrillEvidence.sha256 =
      sha256File(liveDrillSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /strict work reservations/.test(error.message),
      ),
    );
  });

  it("blocks live rollout artifacts without durable Work items when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const liveDrillSource = evidence.mergeQueueRollout.liveDrillEvidence.source;
    const liveDrill = JSON.parse(readFileSync(liveDrillSource, "utf8"));
    liveDrill.mergeQueueRolloutLiveDrill.strictWorkItemsEnforced = false;
    liveDrill.mergeQueueRolloutLiveDrill.readiness.configuration.requireWorkItemForAgentPrs = false;
    writeJson(liveDrillSource, liveDrill);
    evidence.mergeQueueRollout.liveDrillEvidence.sha256 =
      sha256File(liveDrillSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /strict Work items/.test(error.message),
      ),
    );
  });

  it("blocks live rollout artifacts without strict agent branch namespaces when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const liveDrillSource = evidence.mergeQueueRollout.liveDrillEvidence.source;
    const liveDrill = JSON.parse(readFileSync(liveDrillSource, "utf8"));
    liveDrill.mergeQueueRolloutLiveDrill.strictAgentBranchNamespacesEnforced = false;
    liveDrill.mergeQueueRolloutLiveDrill.readiness.configuration.requireAgentBranchNamespaceForAgentPrs = false;
    writeJson(liveDrillSource, liveDrill);
    evidence.mergeQueueRollout.liveDrillEvidence.sha256 =
      sha256File(liveDrillSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /strict agent branch namespaces/.test(error.message),
      ),
    );
  });

  it("blocks live rollout artifacts without verified agent run receipts when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const liveDrillSource = evidence.mergeQueueRollout.liveDrillEvidence.source;
    const liveDrill = JSON.parse(readFileSync(liveDrillSource, "utf8"));
    liveDrill.mergeQueueRolloutLiveDrill.verifiedAgentRunReceiptsEnforced = false;
    liveDrill.mergeQueueRolloutLiveDrill.readiness.configuration.requireVerifiedAgentRunReceiptForAgentPrs = false;
    writeJson(liveDrillSource, liveDrill);
    evidence.mergeQueueRollout.liveDrillEvidence.sha256 =
      sha256File(liveDrillSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /verified agent run receipts/.test(error.message),
      ),
    );
  });

  it("blocks live rollout artifacts without an agent identity registry when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const liveDrillSource = evidence.mergeQueueRollout.liveDrillEvidence.source;
    const liveDrill = JSON.parse(readFileSync(liveDrillSource, "utf8"));
    liveDrill.mergeQueueRolloutLiveDrill.agentIdentityRegistryEnforced = false;
    liveDrill.mergeQueueRolloutLiveDrill.readiness.configuration.requireAgentIdentityRegistryForAgentPrs = false;
    liveDrill.mergeQueueRolloutLiveDrill.readiness.configuration.knownAgentIdCount = 0;
    writeJson(liveDrillSource, liveDrill);
    evidence.mergeQueueRollout.liveDrillEvidence.sha256 =
      sha256File(liveDrillSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /identity registry/.test(error.message),
      ),
    );
  });

  it("blocks live rollout artifacts without stack dependency ordering when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    const liveDrillSource = evidence.mergeQueueRollout.liveDrillEvidence.source;
    const liveDrill = JSON.parse(readFileSync(liveDrillSource, "utf8"));
    liveDrill.mergeQueueRolloutLiveDrill.stackDependencyOrderProof.valid = false;
    liveDrill.mergeQueueRolloutLiveDrill.stackDependencyOrderProof.blockedItemIds =
      [];
    writeJson(liveDrillSource, liveDrill);
    evidence.mergeQueueRollout.liveDrillEvidence.sha256 =
      sha256File(liveDrillSource);

    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some((error) =>
        /stack dependency ordering/.test(error.message),
      ),
    );
  });

  it("blocks artifact hash mismatches when production artifact validation is enabled", async () => {
    const evidence = completeEvidenceWithRolloutArtifacts();
    evidence.mergeQueueRollout.dryRunEvidence.sha256 = "f".repeat(64);
    const result = await runCli(
      "production-gate",
      { evidence },
      { PRODUCTION_GATE_VALIDATE_ARTIFACTS: "true" },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const artifactCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_artifacts",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(artifactCheck.ok, false);
    assert.ok(
      artifactCheck.errors.some(
        (error) => error.code === "artifact_hash_mismatch",
      ),
    );
  });

  it("accepts fresh production evidence when freshness validation is enabled", async () => {
    const result = await runCli(
      "production-gate",
      { evidence: completeEvidence() },
      {
        PRODUCTION_GATE_VALIDATE_FRESHNESS: "true",
        PRODUCTION_GATE_NOW: "2026-07-06T02:00:00.000Z",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    const freshnessCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_freshness",
    );

    assert.equal(body.productionGate.ok, true);
    assert.equal(freshnessCheck.ok, true);
  });

  it("blocks stale production evidence when freshness validation is enabled", async () => {
    const result = await runCli(
      "production-gate",
      { evidence: completeEvidence() },
      {
        PRODUCTION_GATE_VALIDATE_FRESHNESS: "true",
        PRODUCTION_GATE_NOW: "2026-07-30T00:00:00.000Z",
      },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const freshnessCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_freshness",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(freshnessCheck.ok, false);
    assert.ok(
      freshnessCheck.errors.some((error) => error.code === "stale_timestamp"),
    );
  });

  it("blocks future-dated production evidence when freshness validation is enabled", async () => {
    const evidence = completeEvidence();
    evidence.securityReview.approvedAt = "2026-07-07T00:00:00.000Z";
    const result = await runCli(
      "production-gate",
      { evidence },
      {
        PRODUCTION_GATE_VALIDATE_FRESHNESS: "true",
        PRODUCTION_GATE_NOW: "2026-07-06T02:00:00.000Z",
      },
    );

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    const freshnessCheck = body.productionGate.checks.find(
      (check) => check.name === "production_evidence_freshness",
    );

    assert.equal(body.productionGate.ok, false);
    assert.equal(freshnessCheck.ok, false);
    assert.ok(
      freshnessCheck.errors.some((error) => error.code === "future_timestamp"),
    );
  });

  it("returns non-zero domain evidence for non-HTTPS Forgejo roots", async () => {
    const result = await runCli("domain-evidence", {
      forgejoRootUrl: "http://git.example.invalid",
      reverseProxyReviewed: true,
    });

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.domainEvidence.status, "blocked");
    assert.equal(
      body.domainEvidence.domain.forgejoRootUrl,
      "http://git.example.invalid/",
    );
    assert.equal(body.domainEvidence.domain.tlsVerified, false);
    assert.equal(
      body.domainEvidence.checks.find((check) => check.name === "https_url").ok,
      false,
    );
  });

  it("runs runner isolation audit from config and attestations JSON", async () => {
    const result = await runCli("runner-isolation", {
      composeConfig: readFileSync(STAGING_RUNNER_COMPOSE, "utf8"),
      runnerConfig: readFileSync(STAGING_RUNNER_CONFIG, "utf8"),
      registration: { tested: true },
      smoke: { trustedWorkflowPassed: true },
      reviews: { egressReviewed: true, secretExposureReviewed: true },
    });

    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.runnerIsolation.status, "isolated");
    assert.equal(body.runnerIsolation.evidence.runner.isolated, true);
  });

  it("runs runner isolation audit from normalized live smoke workflow evidence", async () => {
    const result = await runCli("runner-isolation", {
      composeConfig: readFileSync(STAGING_RUNNER_COMPOSE, "utf8"),
      runnerConfig: readFileSync(STAGING_RUNNER_CONFIG, "utf8"),
      registration: { tested: true },
      smoke: {
        workflowRun: {
          passed: true,
          workflow: "runner-smoke.yml",
          runId: 42,
          url: "https://git.eliza.test/elizaos/eliza/actions/runs/42",
        },
      },
      reviews: { egressReviewed: true, secretExposureReviewed: true },
    });

    assert.equal(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.runnerIsolation.status, "isolated");
    assert.equal(
      body.runnerIsolation.evidence.runner.trustedSmokeWorkflowPassed,
      true,
    );
  });

  it("returns non-zero when runner isolation evidence is incomplete", async () => {
    const result = await runCli("runner-isolation", {
      composeConfig: readFileSync(STAGING_RUNNER_COMPOSE, "utf8"),
      runnerConfig: readFileSync(STAGING_RUNNER_CONFIG, "utf8"),
    });

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.runnerIsolation.status, "blocked");
    assert.equal(
      body.runnerIsolation.evidence.runner.registrationTested,
      false,
    );
  });

  it("blocks broad validation plans from the CLI", async () => {
    const result = await runCli("validation-plan", {
      repo: "elizaos/eliza",
      ownerAgentId: "agent-ci",
      changedFiles: ["packages/plugin-capacitor-bridge/src/index.ts"],
      commands: ["turbo run typecheck", "bun build"],
    });

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.validationPlan.decision.allowed, false);
    assert.equal(body.validationPlan.decision.state, "blocked");
    assert.ok(
      body.validationPlan.decision.blockers.includes(
        "broad_validation_commands",
      ),
    );
    assert.deepEqual(
      body.validationPlan.recommendedCommands.map((command) => command.command),
      [
        "turbo run typecheck --filter=@elizaos/plugin-capacitor-bridge",
        "turbo run build --filter=@elizaos/plugin-capacitor-bridge",
      ],
    );
  });

  it("accepts scoped validation plans from the CLI", async () => {
    const result = await runCli("validation-plan", {
      repo: "elizaos/eliza",
      changedFiles: ["packages/core/src/runtime.ts"],
      commands: ["turbo run typecheck --filter=@elizaos/core"],
    });

    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.validationPlan.decision.allowed, true);
    assert.equal(body.validationPlan.decision.state, "scoped");
    assert.deepEqual(body.validationPlan.labels, ["validation:scoped"]);
  });

  it("requires validation commands from the CLI", async () => {
    const result = await runCli("validation-plan", {
      changedFiles: ["packages/client/src/chat.ts"],
    });

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.validationPlan.decision.state, "needs_validation_plan");
    assert.deepEqual(body.validationPlan.decision.blockers, [
      "missing_validation_commands",
    ]);
    assert.deepEqual(
      body.validationPlan.recommendedCommands.map((command) => command.command),
      ["turbo run typecheck --filter=@elizaos/client"],
    );
  });

  it("accepts requestedCommands as a CLI alias", async () => {
    const result = await runCli("validation-plan", {
      changedFiles: ["packages/core/src/runtime.ts"],
      requestedCommands: ["tsc -p packages/core/tsconfig.json"],
    });

    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.validationPlan.decision.allowed, true);
    assert.equal(
      body.validationPlan.commands[0].command,
      "tsc -p packages/core/tsconfig.json",
    );
  });

  it("allows broad CLI validation only when explicitly requested", async () => {
    const result = await runCli("validation-plan", {
      changedFiles: ["packages/core/src/runtime.ts"],
      commands: ["turbo run typecheck"],
      allowBroadCommands: true,
    });

    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.validationPlan.decision.allowed, true);
    assert.equal(body.validationPlan.decision.state, "watch");
    assert.equal(body.validationPlan.commands[0].scope, "broad");
  });

  it("normalizes server-style item wrappers for CLI validation plans", async () => {
    const result = await runCli("validation-plan", {
      item: {
        repo: "elizaos/eliza",
        ownerAgentId: "agent-queue",
        changedFiles: ["packages/plugin-capacitor-bridge/src/index.ts"],
        affectedPackages: ["plugin-capacitor-bridge"],
      },
      commands: ["turbo run typecheck"],
    });

    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.validationPlan.repo, "elizaos/eliza");
    assert.equal(body.validationPlan.ownerAgentId, "agent-queue");
    assert.deepEqual(body.validationPlan.affectedPackages, [
      "plugin-capacitor-bridge",
    ]);
    assert.deepEqual(
      body.validationPlan.recommendedCommands.map((command) => command.command),
      ["turbo run typecheck --filter=@elizaos/plugin-capacitor-bridge"],
    );
  });
});

function runCli(command, input, env = {}, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI_PATH.pathname, command, ...args],
      {
        env: { HOME: process.env.HOME, PATH: process.env.PATH, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    child.stdin.end(JSON.stringify(input));
  });
}

const silentLogger = Object.freeze({
  error() {},
  info() {},
  warn() {},
});

function completeEvidenceWithRolloutArtifacts() {
  const evidence = completeEvidence();
  const dir = mkdtempSyncInTestRoot("merge-steward-rollout-artifacts-");
  const domainSource = path.join(dir, "domain-evidence.json");
  const backupAuditSource = path.join(dir, "backup-audit.json");
  const backupUploadReceiptSource = path.join(
    dir,
    "backup-offsite-upload-receipt.json",
  );
  const backupRestoreReceiptSource = path.join(
    dir,
    "backup-offsite-restore-receipt.json",
  );
  const databaseAuditSource = path.join(dir, "database-audit.json");
  const migrationOutputSource = path.join(dir, "merge-steward-migrate.log");
  const restoreDrillOutputSource = path.join(dir, "restore-drill.log");
  const imageProvenanceSource = path.join(dir, "image-provenance-audit.json");
  const preflightSource = path.join(dir, "steward-preflight.json");
  const doctorSource = path.join(dir, "steward-doctor.json");
  const ssoSource = path.join(dir, "sso-smoke.json");
  const ssoBootstrapSource = path.join(
    dir,
    "eliza-hub-identity-bootstrap-evidence.json",
  );
  const runnerSmokeSource = path.join(dir, "runner-smoke.json");
  const runnerAuditSource = path.join(dir, "runner-isolation-audit.json");
  const repositoryProtectionSource = path.join(
    dir,
    "repository-protection.json",
  );
  const pilotBootstrapSource = path.join(
    dir,
    "eliza-hub-pilot-bootstrap-evidence.json",
  );
  const secretManagementAuditSource = path.join(
    dir,
    "secret-management-audit.json",
  );
  const mailAuditSource = path.join(dir, "mail-smoke-audit.json");
  const storageAuditSource = path.join(dir, "storage-retention-audit.json");
  const observabilityAuditSource = path.join(dir, "observability-audit.json");
  const dryRunSource = path.join(dir, "merge-queue-rollout-drill.json");
  const liveDrillSource = path.join(dir, "merge-queue-live-drill.json");
  const securityReviewAuditSource = path.join(
    dir,
    "security-review-audit.json",
  );
  const deployEvidenceSource = path.join(dir, "eliza-hub-deploy-evidence.json");
  const postDeployEvidenceSource = path.join(
    dir,
    "eliza-hub-post-deploy-evidence.json",
  );

  writeJson(domainSource, {
    domainEvidence: {
      status: "ready",
      checkedAt: "2026-07-06T00:00:00.000Z",
      domain: {
        forgejoRootUrl: "https://git.eliza.example/",
        forgejoDomain: "git.eliza.example",
        tlsVerified: true,
        rootUrlCanonical: true,
        reverseProxyReviewed: true,
      },
      probe: {
        statusCode: 200,
        finalUrl: "https://git.eliza.example/",
        error: null,
      },
      checks: [
        { name: "https_url", ok: true },
        { name: "host_matches", ok: true },
        { name: "tls_fetch", ok: true },
        { name: "canonical_root_url", ok: true },
        { name: "reverse_proxy_reviewed", ok: true },
      ],
    },
  });
  evidence.domain.probeEvidence = {
    source: domainSource,
    sha256: sha256File(domainSource),
    checkedAt: "2026-07-06T00:00:00.000Z",
    status: "ready",
    checkCount: 5,
  };

  writeJson(ssoSource, {
    ssoSmoke: {
      issuerUrl: "https://cloud.eliza.example",
      checkedAt: "2026-07-06T00:05:00.000Z",
      oidcLoginSucceeded: true,
      humanIdentitySmokePassed: true,
      agentIdentitySmokePassed: true,
      agentTokenClaimsVerified: true,
      serviceIdentitySmokePassed: true,
      serviceTokenClaimsVerified: true,
      publicRegistrationLocked: true,
      nonIssuerRejected: true,
      recoveryAdminLoginSucceeded: true,
    },
  });
  writeJson(ssoBootstrapSource, {
    schema: "https://eliza.hub/schemas/identity-bootstrap-evidence.v1",
    finishedAt: "2026-07-06T00:04:00.000Z",
    status: "passed",
    options: {
      applyBootstrap: false,
      checkDiscovery: true,
      checkStewardToken: true,
    },
    targets: {
      forgejoLocalUrl: "https://git.eliza.example/",
    },
    oidc: {
      authName: "elizacloud",
      issuerUrl: "https://cloud.eliza.example",
    },
    summary: {
      total: 8,
      passed: 8,
      failed: 0,
      warnings: 0,
    },
    checks: identityBootstrapChecks(),
  });
  const backupName = "eliza-forgejo-production-20260706T000000Z";
  const backupRemoteArchive = `r2:eliza-hub-backups/production/${backupName}/${backupName}.tar.gz.age`;
  const backupRemoteReceipt = `r2:eliza-hub-backups/production/${backupName}/receipt.json`;
  const backupCiphertextSha256 = "35".repeat(32);
  const backupCiphertextBytes = 1048576;
  writeJson(backupUploadReceiptSource, {
    schema: "https://eliza.hub/schemas/offsite-backup-receipt.v1",
    status: "verified",
    checkedAt: "2026-07-06T00:10:00.000Z",
    backupName,
    backupCreatedAt: "2026-07-06T00:00:00.000Z",
    sourceManifestSha256: "37".repeat(32),
    sourceChecksumsSha256: "38".repeat(32),
    encryption: {
      format: "age",
      recipientsFileSha256: "39".repeat(32),
    },
    ciphertext: {
      sha256: backupCiphertextSha256,
      bytes: backupCiphertextBytes,
    },
    remoteArchive: backupRemoteArchive,
    remoteReceipt: backupRemoteReceipt,
    uploadVerified: true,
    verificationMethod: "download_sha256",
  });
  const backupUploadSummary = {
    source: backupUploadReceiptSource,
    sha256: sha256File(backupUploadReceiptSource),
    checkedAt: "2026-07-06T00:10:00.000Z",
    status: "verified",
    backupName,
    backupCreatedAt: "2026-07-06T00:00:00.000Z",
    remoteArchive: backupRemoteArchive,
    remoteReceipt: backupRemoteReceipt,
    ciphertextSha256: backupCiphertextSha256,
    ciphertextBytes: backupCiphertextBytes,
    encryptionFormat: "age",
    recipientsFileSha256: "39".repeat(32),
    verificationMethod: "download_sha256",
    verified: true,
  };
  writeJson(backupRestoreReceiptSource, {
    schema: "https://eliza.hub/schemas/offsite-restore-receipt.v1",
    status: "verified",
    checkedAt: "2026-07-06T00:30:00.000Z",
    backupName,
    remoteReceipt: backupRemoteReceipt,
    remoteArchive: backupRemoteArchive,
    uploadReceiptSha256: backupUploadSummary.sha256,
    ciphertext: {
      sha256: backupCiphertextSha256,
      bytes: backupCiphertextBytes,
    },
    downloadVerified: true,
    decryptionVerified: true,
    archivePathsVerified: true,
    structuralRestoreCheckPassed: true,
  });
  const backupRestoreSummary = {
    source: backupRestoreReceiptSource,
    sha256: sha256File(backupRestoreReceiptSource),
    checkedAt: "2026-07-06T00:30:00.000Z",
    status: "verified",
    remoteArchive: backupRemoteArchive,
    remoteReceipt: backupRemoteReceipt,
    uploadReceiptSha256: backupUploadSummary.sha256,
    ciphertextSha256: backupCiphertextSha256,
    ciphertextBytes: backupCiphertextBytes,
    downloadVerified: true,
    decryptionVerified: true,
    archivePathsVerified: true,
    structuralRestoreCheckPassed: true,
    verified: true,
  };
  writeJson(backupAuditSource, {
    backupAudit: {
      checkedAt: "2026-07-06T00:31:00.000Z",
      status: "verified",
      productionReady: true,
      backupDir: "/var/lib/eliza-hub-artifacts/backup",
      backupCreatedAt: "2026-07-06T00:00:00.000Z",
      restoreCheckedAt: "2026-07-06T00:30:00.000Z",
      includes: [
        "repositories",
        "database",
        "attachments",
        "packages",
        "lfs",
        "configuration",
      ],
      attestations: {
        scheduled: true,
        offHost: true,
        encrypted: true,
        restoreCheckPassed: true,
      },
      offsiteUploadReceipt: backupUploadSummary,
      offsiteRestoreReceipt: backupRestoreSummary,
      checks: [
        { name: "backup_bundle_verified", status: "pass" },
        { name: "checksum_manifest_verified", status: "pass" },
        { name: "postgres_dump_verified", status: "pass" },
        { name: "offsite_upload_receipt_verified", status: "pass" },
        { name: "offsite_restore_receipt_verified", status: "pass" },
        { name: "restore_check_passed", status: "pass" },
        { name: "scheduled", status: "pass" },
        { name: "off_host", status: "pass" },
        { name: "encrypted", status: "pass" },
        { name: "components_complete", status: "pass" },
      ],
    },
  });
  writeText(
    migrationOutputSource,
    '[MergeStewardMigrate] complete {"applied":["001_steward_runtime.sql"],"skipped":[]}\n',
  );
  writeText(
    restoreDrillOutputSource,
    [
      "[restore-drill] restore drill passed",
      "backup=/var/lib/eliza-hub-artifacts/backup",
      "postgres_image=postgres:16-alpine",
      "database=forgejo",
      "verified_tables=steward_schema_migrations,steward_queue_items,steward_runs,steward_events,steward_agent_claims,steward_worker_leases",
      "",
    ].join("\n"),
  );
  writeJson(databaseAuditSource, {
    databaseAudit: {
      checkedAt: "2026-07-06T00:32:00.000Z",
      status: "verified",
      productionReady: true,
      evidence: {
        forgejoPostgres: true,
        stewardPostgres: true,
        migrationsApplied: true,
        emptyHostRestoreDrillPassed: true,
        checksumDriftClean: true,
      },
      migrationOutput: {
        source: migrationOutputSource,
        sha256: sha256File(migrationOutputSource),
      },
      restoreDrillOutput: {
        source: restoreDrillOutputSource,
        sha256: sha256File(restoreDrillOutputSource),
      },
      verifiedTables: [
        "steward_schema_migrations",
        "steward_queue_items",
        "steward_runs",
        "steward_events",
        "steward_agent_claims",
        "steward_worker_leases",
      ],
      checks: [
        { name: "forgejo_postgres_configured", status: "pass" },
        { name: "steward_postgres_configured", status: "pass" },
        { name: "migration_output_verified", status: "pass" },
        { name: "restore_drill_output_verified", status: "pass" },
        { name: "checksum_drift_clean", status: "pass" },
      ],
    },
  });
  writeJson(imageProvenanceSource, {
    imageProvenanceAudit: {
      checkedAt: "2026-07-06T00:01:00.000Z",
      status: "verified",
      productionReady: true,
      images: {
        forgejoImage: evidence.imageProvenance.forgejoImage,
        stewardImage: evidence.imageProvenance.stewardImage,
        runnerImage: evidence.imageProvenance.runnerImage,
        dindImage: evidence.imageProvenance.dindImage,
      },
      evidence: {
        stewardImageBuiltByCi: true,
        stewardImageSignatureVerified: true,
        sbomGenerated: true,
        vulnerabilityScanClean: true,
      },
      checks: [
        { name: "images_digest_pinned", status: "pass" },
        { name: "stewardImageBuiltByCi", status: "pass" },
        { name: "stewardImageSignatureVerified", status: "pass" },
        { name: "sbomGenerated", status: "pass" },
        { name: "vulnerabilityScanClean", status: "pass" },
      ],
    },
  });
  writeJson(runnerSmokeSource, {
    runnerSmoke: {
      ok: true,
      trustedWorkflowPassed: true,
      repository: "elizaos/eliza",
      workflow: "runner-smoke.yml",
      ref: "main",
      dispatched: true,
      requestedAt: "2026-07-06T00:02:00.000Z",
      observedAt: "2026-07-06T00:03:00.000Z",
      runId: 42,
      runNumber: 7,
      status: "completed",
      conclusion: "success",
      workflowRunUrl: "https://git.eliza.example/elizaos/eliza/actions/runs/42",
    },
  });
  writeJson(runnerAuditSource, {
    runnerIsolation: {
      computedAt: "2026-07-06T00:04:00.000Z",
      status: "isolated",
      productionReady: true,
      summary: "Runner isolation passed.",
      checks: [
        { name: "runner_config_present", status: "pass" },
        { name: "host_docker_socket_absent", status: "pass" },
        { name: "host_labels_absent", status: "pass" },
        { name: "dind_isolated_network", status: "pass" },
        { name: "runner_uses_dind", status: "pass" },
        { name: "runner_capacity_limited", status: "pass" },
        { name: "workflow_containers_unprivileged", status: "pass" },
        { name: "runner_registration_tested", status: "pass" },
        { name: "trusted_smoke_workflow_passed", status: "pass" },
        { name: "runner_egress_reviewed", status: "pass" },
        { name: "runner_secret_exposure_reviewed", status: "pass" },
      ],
      evidence: {
        runner: {
          isolated: true,
          noHostDockerSocket: true,
          noHostLabels: true,
          registrationTested: true,
          trustedSmokeWorkflowPassed: true,
          egressReviewed: true,
          secretExposureReviewed: true,
        },
      },
    },
  });
  writeJson(repositoryProtectionSource, {
    repositoryProtection: {
      computedAt: "2026-07-06T00:20:00.000Z",
      repo: "elizaos/eliza",
      targetBranch: "main",
      status: "protected",
      productionReady: true,
      policy: {
        protectedBranches: ["main"],
        requiredChecks: ["merge-steward"],
      },
      live: {
        available: true,
        required: true,
      },
      checks: [
        { name: "repo_policy_present", status: "pass" },
        { name: "queue_policy_enabled", status: "pass" },
        { name: "protected_branches_configured", status: "pass" },
        { name: "required_checks_configured", status: "pass" },
        { name: "trusted_actors_configured", status: "pass" },
        { name: "fork_policy_reviewed", status: "pass" },
        { name: "live_branch_protection_verified", status: "pass" },
        { name: "live_required_checks_verified", status: "pass" },
      ],
    },
  });
  writeJson(pilotBootstrapSource, {
    schema: "https://eliza.hub/schemas/pilot-bootstrap-evidence.v1",
    status: "passed",
    dryRun: false,
    startedAt: "2026-07-06T00:21:00.000Z",
    finishedAt: "2026-07-06T00:22:00.000Z",
    repo: {
      owner: "elizaos",
      name: "eliza",
      fullName: "elizaos/eliza",
      targetBranch: "main",
    },
    upstream: {
      host: "github.com",
      pathname: "/elizaos/eliza.git",
      service: "github",
    },
    migration: {
      sourceService: "github",
      direction: "pull",
      mirror: true,
      private: true,
    },
    requiredChecks: ["merge-steward"],
    trustedAgentIds: ["agent-codex", "agent-docs"],
    summary: {
      productionReady: true,
      stepCount: 9,
      requiredCheckCount: 1,
      trustedAgentCount: 2,
      mirrorVerified: true,
      defaultBranchVerified: true,
      webhookVerified: true,
      branchProtectionVerified: true,
      repoPolicyVerified: true,
      agentIdentitiesSynced: true,
      pilotSurfacesVerified: true,
      pullMirrorOnly: true,
    },
    steps: [
      { index: 1, name: "forgejo-api-schema", status: "verified" },
      {
        index: 2,
        name: "mirror-repository",
        status: "created",
        mirror: true,
        private: true,
      },
      {
        index: 3,
        name: "verify-default-branch",
        status: "verified",
        branch: "main",
      },
      { index: 4, name: "steward-webhook", status: "created" },
      { index: 5, name: "branch-protection", status: "created" },
      { index: 6, name: "repo-policy", status: "upserted" },
      { index: 7, name: "repo-policy-verify", status: "verified" },
      { index: 8, name: "agent-identities", status: "synced" },
      { index: 9, name: "pilot-surfaces", status: "verified" },
    ],
  });
  writeJson(secretManagementAuditSource, {
    secretManagementAudit: {
      checkedAt: "2026-07-06T00:25:00.000Z",
      status: "verified",
      productionReady: true,
      issuedGroups: [
        "appIniSecretsIssued",
        "runnerTokenIssued",
        "oauthSecretsIssued",
        "webhookSecretsIssued",
      ],
      evidence: {
        externalSecretStore: true,
        rotationPolicyDocumented: true,
        appIniSecretsIssued: true,
        runnerTokenIssued: true,
        oauthSecretsIssued: true,
        webhookSecretsIssued: true,
        noPlaintextSecretsCommitted: true,
      },
      checks: [
        { name: "external_secret_store", status: "pass" },
        { name: "rotation_policy_documented", status: "pass" },
        { name: "app_ini_secrets_issued", status: "pass" },
        { name: "runner_token_issued", status: "pass" },
        { name: "oauth_secrets_issued", status: "pass" },
        { name: "webhook_secrets_issued", status: "pass" },
        { name: "private_reference_scan_passed", status: "pass" },
      ],
    },
  });
  writeJson(mailAuditSource, {
    mailAudit: {
      checkedAt: "2026-07-06T00:26:00.000Z",
      status: "verified",
      productionReady: true,
      evidence: {
        smtpConfigured: true,
        inviteSmokePassed: true,
        passwordResetSmokePassed: true,
        notificationSmokePassed: true,
      },
      checks: [
        { name: "smtp_configured", status: "pass" },
        { name: "invite_smoke_passed", status: "pass" },
        { name: "password_reset_smoke_passed", status: "pass" },
        { name: "notification_smoke_passed", status: "pass" },
      ],
    },
  });
  writeJson(storageAuditSource, {
    storageAudit: {
      checkedAt: "2026-07-06T00:27:00.000Z",
      status: "verified",
      productionReady: true,
      retention: {
        actionArtifactRetentionDays: 14,
        actionLogRetentionDays: 14,
      },
      evidence: {
        sizingReviewed: true,
        artifactRetentionConfigured: true,
        packageRetentionConfigured: true,
        lfsCapacityReviewed: true,
        logRetentionConfigured: true,
      },
      checks: [
        { name: "sizing_reviewed", status: "pass" },
        { name: "artifact_retention_configured", status: "pass" },
        { name: "package_retention_configured", status: "pass" },
        { name: "lfs_capacity_reviewed", status: "pass" },
        { name: "log_retention_configured", status: "pass" },
      ],
    },
  });
  writeJson(observabilityAuditSource, {
    observabilityAudit: {
      checkedAt: "2026-07-06T00:28:00.000Z",
      status: "verified",
      productionReady: true,
      evidence: {
        prometheusScrapeOk: true,
        alertRulesLoaded: true,
        alertRoutingConfigured: true,
        logsCollected: true,
        logRetentionDays: 30,
        noPageAlertsFiring: true,
      },
      checks: [
        { name: "prometheus_scrape_ok", status: "pass" },
        { name: "alert_rules_loaded", status: "pass" },
        { name: "alert_routing_configured", status: "pass" },
        { name: "logs_collected", status: "pass" },
        { name: "log_retention_days_sufficient", status: "pass" },
        { name: "no_page_alerts_firing", status: "pass" },
      ],
    },
  });
  writeJson(preflightSource, {
    preflight: {
      ok: true,
      mode: "production",
      errors: [],
      warnings: [],
      checkedAt: "2026-07-06T00:10:00.000Z",
    },
  });
  writeJson(doctorSource, {
    doctor: {
      ok: true,
      target: "https://steward.eliza.example",
      checkedAt: "2026-07-06T00:15:00.000Z",
      checks: [
        { name: "health", ok: true },
        { name: "ready", ok: true },
        { name: "runtime_preflight", ok: true },
      ],
    },
  });
  writeJson(dryRunSource, {
    mergeQueueRolloutDrill: {
      dryRunPassed: true,
      stagedLiveDrillPassed: false,
      workerLeaseVerified: false,
      rollbackDrillPassed: false,
      humanApprovalRecorded: false,
      checkedAt: "2026-07-06T00:30:00.000Z",
      safeMode: true,
      checks: [
        { name: "Merge Steward /ready is ok", ok: true },
        { name: "Merge Steward deployment doctor passes", ok: true },
        { name: "synthetic queue item creates an integration plan", ok: true },
        {
          name: "manual live execution stays blocked without confirmation",
          ok: true,
        },
        {
          name: "worker run-once stays blocked without confirmation",
          ok: true,
        },
      ],
    },
  });
  writeJson(liveDrillSource, {
    mergeQueueRolloutLiveDrill: {
      stagedLiveDrillPassed: true,
      workerLeaseVerified: true,
      strictWorkReservationsEnforced: true,
      strictWorkItemsEnforced: true,
      strictAgentBranchNamespacesEnforced: true,
      verifiedAgentRunReceiptsEnforced: true,
      agentIdentityRegistryEnforced: true,
      stackDependencyOrderEnforced: true,
      stackDependencyOrderProof: {
        source: "/api/release-readiness",
        repo: "elizaos/eliza",
        targetBranch: null,
        checkedAt: "2026-07-06T00:40:00.000Z",
        status: "blocked",
        stackCheckStatus: "fail",
        stackBlocked: 1,
        blockedItemIds: ["elizaos/eliza#9002"],
        nextMergeItemIds: ["elizaos/eliza#9001"],
        requiredActions: ["merge_stack_parents_first"],
        valid: true,
      },
      rollbackDrillPassed: true,
      humanApprovalRecorded: true,
      checkedAt: "2026-07-06T00:45:00.000Z",
      runId: "run:elizaos/eliza#9001:attempt:1",
      runOnce: {
        claimed: true,
        item: { id: "elizaos/eliza#9001", queueState: "merged" },
        run: { id: "run:elizaos/eliza#9001:attempt:1", status: "succeeded" },
        execution: {
          executions: [
            {
              repo: "elizaos/eliza",
              pullRequestId: 9001,
              status: "executed",
              actions: [
                { type: "ensure_integration_branch", status: "executed" },
                { type: "merge_pr_head_into_integration", status: "executed" },
                { type: "wait_for_checks", status: "executed" },
                { type: "merge_original_pull_request", status: "executed" },
              ],
            },
          ],
        },
      },
      events: [
        { type: "IntegrationActionStarted" },
        { type: "IntegrationActionFinished" },
        { type: "QueueItemMerged" },
      ],
      readiness: {
        ok: true,
        configuration: {
          requireWorkReservationForAgentPrs: true,
          requireWorkItemForAgentPrs: true,
          requireAgentBranchNamespaceForAgentPrs: true,
          requireVerifiedAgentRunReceiptForAgentPrs: true,
          requireAgentIdentityRegistryForAgentPrs: true,
          knownAgentIdCount: 1,
        },
      },
    },
  });
  writeJson(securityReviewAuditSource, {
    securityReviewAudit: {
      checkedAt: "2026-07-06T01:00:00.000Z",
      status: "approved",
      productionReady: true,
      approvedBy: "eliza-security",
      approvedAt: "2026-07-06T01:00:00.000Z",
      reviewedSurfaces: [
        "authReviewed",
        "tokensReviewed",
        "runnerExecutionReviewed",
        "repoPermissionsReviewed",
      ],
      evidence: {
        authReviewed: true,
        tokensReviewed: true,
        runnerExecutionReviewed: true,
        repoPermissionsReviewed: true,
      },
      checks: [
        { name: "auth_reviewed", status: "pass" },
        { name: "tokens_reviewed", status: "pass" },
        { name: "runner_execution_reviewed", status: "pass" },
        { name: "repo_permissions_reviewed", status: "pass" },
        { name: "approved_by_recorded", status: "pass" },
        { name: "approved_at_recorded", status: "pass" },
      ],
    },
  });
  writeJson(postDeployEvidenceSource, {
    schema: "https://eliza.hub/schemas/post-deploy-evidence.v1",
    status: "passed",
    startedAt: "2026-07-06T01:10:00.000Z",
    finishedAt: "2026-07-06T01:12:00.000Z",
    targets: {
      forgejoLocalUrl: "https://git.eliza.example/",
      stewardLocalUrl: "https://git.eliza.example/steward",
      httpTimeoutSeconds: 5,
    },
    summary: {
      total: 6,
      passed: 6,
      failed: 0,
      unknown: 0,
      warnings: 0,
    },
    checks: [
      { name: "Forgejo HTTP responds", status: "pass" },
      {
        name: "Forgejo Eliza theme asset and default theme render",
        status: "pass",
      },
      { name: "Merge Steward /ready is ok", status: "pass" },
      {
        name: "Merge Steward workflow, parity, production readiness, production cutover, evidence template, board, work items, work view evaluation, work pages, fleet coordination, work context, merge queue diagnostics, merge train plan, search, queue simulation, agent identities, insights, agents, agent performance, agent routing, agent bootstrap, agent cockpit, agent action plan, submission gate, work preflight, work reservation, CI failure analysis, validation plan, PR brief, review assignment, patch conflict prediction, and agent inbox APIs respond",
        status: "pass",
      },
      { name: "Merge Steward deployment doctor passes", status: "pass" },
      { name: "Merge queue rollout drill stays safely gated", status: "pass" },
    ],
  });
  writeJson(deployEvidenceSource, {
    schema: "https://eliza.hub/schemas/deploy-evidence.v1",
    status: "passed",
    mode: "first-boot",
    dryRun: false,
    startedAt: "2026-07-06T01:00:00.000Z",
    finishedAt: "2026-07-06T01:10:00.000Z",
    options: {
      pullImages: false,
      runner: false,
      postDeployCheck: true,
      validateEnv: true,
      verifyImages: true,
    },
    files: {
      envFile: "/private/eliza-hub.env",
      composeFile: "deployment/hetzner-staging/compose.yml",
      runnerComposeFile:
        "deployment/hetzner-staging/compose.actions-runner.yml",
      migrationLog: path.join(dir, "merge-steward-migrate.log"),
      postDeployEvidence: postDeployEvidenceSource,
    },
    steps: [
      {
        index: 1,
        phase: "preflight",
        name: "verify Forgejo image exists",
        command: "docker image inspect forgejo",
      },
      {
        index: 2,
        phase: "preflight",
        name: "verify Merge Steward image exists",
        command: "docker image inspect merge-steward",
      },
      {
        index: 3,
        phase: "first-boot",
        name: "start persistent dependencies",
        command: "docker compose up -d --wait postgres forgejo",
      },
      {
        index: 4,
        phase: "first-boot",
        name: "show dependency health",
        command: "docker compose ps postgres forgejo",
      },
      {
        index: 5,
        phase: "first-boot",
        name: "run merge steward migrations",
        command: "docker compose up merge-steward-migrate",
      },
      {
        index: 6,
        phase: "first-boot",
        name: "start merge steward",
        command: "docker compose up -d merge-steward",
      },
      {
        index: 7,
        phase: "post-deploy",
        name: "run post deploy checks",
        command: "deployment/hetzner-staging/scripts/post-deploy-check.sh",
      },
    ],
  });

  evidence.sso.smokeEvidence = {
    source: ssoSource,
    sha256: sha256File(ssoSource),
    checkedAt: "2026-07-06T00:05:00.000Z",
  };
  evidence.sso.bootstrapEvidence = {
    source: ssoBootstrapSource,
    sha256: sha256File(ssoBootstrapSource),
    checkedAt: "2026-07-06T00:04:00.000Z",
    status: "passed",
    checkCount: 8,
  };
  evidence.backups.backupEvidence = {
    source: backupAuditSource,
    sha256: sha256File(backupAuditSource),
    checkedAt: "2026-07-06T00:31:00.000Z",
    status: "verified",
    productionReady: true,
    backupCreatedAt: "2026-07-06T00:00:00.000Z",
    restoreCheckedAt: "2026-07-06T00:30:00.000Z",
    componentCount: 6,
    checkCount: 10,
    offsiteUploadReceipt: backupUploadSummary,
    offsiteRestoreReceipt: backupRestoreSummary,
  };
  evidence.database.databaseEvidence = {
    source: databaseAuditSource,
    sha256: sha256File(databaseAuditSource),
    checkedAt: "2026-07-06T00:32:00.000Z",
    status: "verified",
    productionReady: true,
    migrationOutputSource,
    migrationOutputSha256: sha256File(migrationOutputSource),
    restoreDrillOutputSource,
    restoreDrillOutputSha256: sha256File(restoreDrillOutputSource),
    checkCount: 5,
    verifiedTableCount: 6,
  };
  evidence.imageProvenance.provenanceEvidence = {
    source: imageProvenanceSource,
    sha256: sha256File(imageProvenanceSource),
    checkedAt: "2026-07-06T00:01:00.000Z",
    imageCount: 4,
    checkCount: 5,
  };
  evidence.runner.smokeEvidence = {
    source: runnerSmokeSource,
    sha256: sha256File(runnerSmokeSource),
    checkedAt: "2026-07-06T00:03:00.000Z",
    repository: "elizaos/eliza",
    workflow: "runner-smoke.yml",
    runId: 42,
    workflowRunUrl: "https://git.eliza.example/elizaos/eliza/actions/runs/42",
  };
  evidence.runner.auditEvidence = {
    source: runnerAuditSource,
    sha256: sha256File(runnerAuditSource),
    checkedAt: "2026-07-06T00:04:00.000Z",
    status: "isolated",
    checkCount: 11,
  };
  evidence.repository.liveProtectionEvidence = {
    source: repositoryProtectionSource,
    sha256: sha256File(repositoryProtectionSource),
    checkedAt: "2026-07-06T00:20:00.000Z",
    status: "protected",
    productionReady: true,
    liveAvailable: true,
    liveRequired: true,
    checkCount: 8,
  };
  evidence.githubMigration.pilotBootstrapEvidence = {
    source: pilotBootstrapSource,
    sha256: sha256File(pilotBootstrapSource),
    checkedAt: "2026-07-06T00:22:00.000Z",
    status: "passed",
    dryRun: false,
    repo: "elizaos/eliza",
    upstreamHost: "github.com",
    stepCount: 9,
    requiredCheckCount: 1,
    trustedAgentCount: 2,
  };
  evidence.secrets.secretEvidence = {
    source: secretManagementAuditSource,
    sha256: sha256File(secretManagementAuditSource),
    checkedAt: "2026-07-06T00:25:00.000Z",
    status: "verified",
    productionReady: true,
    groupCount: 4,
    checkCount: 7,
  };
  evidence.mail.mailEvidence = {
    source: mailAuditSource,
    sha256: sha256File(mailAuditSource),
    checkedAt: "2026-07-06T00:26:00.000Z",
    status: "verified",
    productionReady: true,
    checkCount: 4,
  };
  evidence.storage.storageEvidence = {
    source: storageAuditSource,
    sha256: sha256File(storageAuditSource),
    checkedAt: "2026-07-06T00:27:00.000Z",
    status: "verified",
    productionReady: true,
    checkCount: 5,
  };
  evidence.observability.observabilityEvidence = {
    source: observabilityAuditSource,
    sha256: sha256File(observabilityAuditSource),
    checkedAt: "2026-07-06T00:28:00.000Z",
    status: "verified",
    productionReady: true,
    checkCount: 6,
  };
  evidence.steward.preflightEvidence = {
    source: preflightSource,
    sha256: sha256File(preflightSource),
    checkedAt: "2026-07-06T00:10:00.000Z",
    mode: "production",
    errorCount: 0,
  };
  evidence.steward.doctorEvidence = {
    source: doctorSource,
    sha256: sha256File(doctorSource),
    target: "https://steward.eliza.example",
    checkedAt: "2026-07-06T00:15:00.000Z",
    checkCount: 3,
  };
  evidence.mergeQueueRollout.dryRunEvidence = {
    source: dryRunSource,
    sha256: sha256File(dryRunSource),
    checkedAt: "2026-07-06T00:30:00.000Z",
    checkCount: 5,
  };
  evidence.mergeQueueRollout.liveDrillEvidence = {
    source: liveDrillSource,
    sha256: sha256File(liveDrillSource),
    checkedAt: "2026-07-06T00:45:00.000Z",
    runId: "run:elizaos/eliza#9001:attempt:1",
  };
  evidence.securityReview.securityEvidence = {
    source: securityReviewAuditSource,
    sha256: sha256File(securityReviewAuditSource),
    checkedAt: "2026-07-06T01:00:00.000Z",
    status: "approved",
    productionReady: true,
    approvedBy: "eliza-security",
    approvedAt: "2026-07-06T01:00:00.000Z",
    checkCount: 6,
    reviewedSurfaceCount: 4,
  };
  evidence.deployment = {
    deployEvidence: {
      source: deployEvidenceSource,
      sha256: sha256File(deployEvidenceSource),
      checkedAt: "2026-07-06T01:10:00.000Z",
      status: "passed",
      mode: "first-boot",
      dryRun: false,
      stepCount: 7,
      postDeployEvidenceSource,
      postDeployEvidenceSha256: sha256File(postDeployEvidenceSource),
    },
    postDeployEvidence: {
      source: postDeployEvidenceSource,
      sha256: sha256File(postDeployEvidenceSource),
      checkedAt: "2026-07-06T01:12:00.000Z",
      status: "passed",
      checkCount: 6,
      failedCount: 0,
      forgejoLocalUrl: "https://git.eliza.example/",
      stewardLocalUrl: "https://git.eliza.example/steward",
    },
    mode: "first-boot",
    applied: true,
    postDeployVerified: true,
  };

  return evidence;
}

function identityBootstrapChecks() {
  return [
    { name: "private env validates identity inputs", status: "pass" },
    { name: "compose config renders", status: "pass" },
    { name: "forgejo container is running and healthy", status: "pass" },
    { name: "forgejo CLI responds", status: "pass" },
    { name: "Eliza Cloud discovery document is valid", status: "pass" },
    { name: "local recovery admin exists", status: "pass" },
    { name: "Eliza Cloud OIDC auth source config matches env", status: "pass" },
    { name: "steward token authenticates as steward user", status: "pass" },
  ];
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(file, value) {
  writeFileSync(file, value, "utf8");
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
