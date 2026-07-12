import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  PRODUCTION_GATE_CHECKS,
  runProductionGate,
} from "../src/production-gate.js";
import { completeEvidence } from "./production-gate-fixtures.js";

const EVIDENCE_TEMPLATE_URL = new URL(
  "../../../deployment/hetzner-staging/release/production-evidence.example.json",
  import.meta.url,
);

describe("production gate", () => {
  it("passes only when every production launch requirement has evidence", () => {
    const gate = runProductionGate({
      evidence: completeEvidence(),
      now: new Date("2026-07-06T00:00:00.000Z"),
    });

    assert.equal(gate.ok, true);
    assert.equal(gate.checkedAt, "2026-07-06T00:00:00.000Z");
    assert.equal(gate.summary.total, PRODUCTION_GATE_CHECKS.length);
    assert.equal(gate.summary.failed, 0);
    assert.equal(gate.summary.shapeErrors, 0);
    assert.equal(gate.evidenceShape.ok, true);
    assert.deepEqual(gate.evidenceShape.errors, []);
    assert.deepEqual(
      gate.checks.map((check) => check.name),
      PRODUCTION_GATE_CHECKS,
    );
    assert.ok(gate.checks.every((check) => check.ok));
  });

  it("reports each production evidence path once per check", () => {
    const gate = runProductionGate({ evidence: completeEvidence() });

    for (const check of gate.checks) {
      assert.deepEqual(
        duplicates(check.evidence),
        [],
        `${check.name} has duplicate evidence paths`,
      );
    }
  });

  it("fails closed with missing evidence and reports actionable paths", () => {
    const gate = runProductionGate({
      evidence: {
        domain: {
          forgejoRootUrl: "http://git.example.invalid",
          forgejoDomain: "git.example.invalid",
        },
        steward: {
          preflight: { ok: true, mode: "local", errors: [] },
          doctor: { ok: false },
        },
      },
    });

    assert.equal(gate.ok, false);
    assert.equal(gate.summary.failed, PRODUCTION_GATE_CHECKS.length);
    assert.equal(gate.evidenceShape.ok, false);
    assert.ok(
      gate.evidenceShape.errors.some(
        (error) => error.code === "missing_property",
      ),
    );

    const domain = gate.checks.find((check) => check.name === "domain_tls");
    assert.equal(domain.ok, false);
    assert.ok(domain.errors.some((error) => error.code === "https_required"));
    assert.ok(
      domain.errors.some((error) =>
        error.message.includes("domain.tlsVerified"),
      ),
    );

    const steward = gate.checks.find(
      (check) => check.name === "steward_runtime",
    );
    assert.equal(steward.ok, false);
    assert.ok(
      steward.errors.some((error) =>
        error.message.includes("steward.preflight.mode"),
      ),
    );
    assert.ok(
      steward.errors.some((error) =>
        error.message.includes("steward.doctor.ok"),
      ),
    );

    const backups = gate.checks.find(
      (check) => check.name === "backup_restore",
    );
    assert.ok(
      backups.errors.some((error) =>
        error.message.includes("backups.includes"),
      ),
    );
  });

  it("keeps the checked-in evidence template non-passing", async () => {
    const evidence = JSON.parse(await readFile(EVIDENCE_TEMPLATE_URL, "utf8"));
    const gate = runProductionGate({ evidence });

    assert.equal(gate.ok, false);
    assert.equal(gate.summary.failed, PRODUCTION_GATE_CHECKS.length);
    assert.equal(gate.evidenceShape.ok, true);
    assert.ok(gate.checks.every((check) => check.ok === false));
  });

  it("fails production evidence with schema shape errors even when semantic checks pass", () => {
    const evidence = completeEvidence();
    evidence.domain.unreviewedHostname = "shadow.example.invalid";

    const gate = runProductionGate({ evidence });

    assert.equal(gate.ok, false);
    assert.equal(gate.summary.failed, 0);
    assert.equal(gate.summary.shapeErrors, 1);
    assert.equal(gate.evidenceShape.ok, false);
    assert.deepEqual(gate.evidenceShape.errors, [
      {
        code: "unexpected_property",
        path: "domain.unreviewedHostname",
        message: "domain.unreviewedHostname is not allowed",
      },
    ]);
    assert.ok(gate.checks.every((check) => check.ok));
  });

  it("requires immutable image provenance for production cutover", () => {
    const evidence = completeEvidence();
    evidence.imageProvenance.stewardImage =
      "registry.eliza.example/eliza/merge-steward:latest";
    evidence.imageProvenance.stewardImageSignatureVerified = false;

    const gate = runProductionGate({ evidence });
    const imageCheck = gate.checks.find(
      (check) => check.name === "image_provenance",
    );

    assert.equal(gate.ok, false);
    assert.equal(imageCheck.ok, false);
    assert.ok(
      imageCheck.errors.some((error) => error.code === "image_digest_required"),
    );
    assert.ok(
      imageCheck.errors.some((error) =>
        error.message.includes("stewardImageSignatureVerified"),
      ),
    );
  });

  it("requires domain probe artifact provenance for production cutover", () => {
    const evidence = completeEvidence();
    evidence.domain.probeEvidence = null;

    const gate = runProductionGate({ evidence });
    const domainCheck = gate.checks.find(
      (check) => check.name === "domain_tls",
    );

    assert.equal(gate.ok, false);
    assert.equal(domainCheck.ok, false);
    assert.ok(
      domainCheck.errors.some((error) =>
        error.message.includes("domain.probeEvidence"),
      ),
    );
    assert.ok(
      domainCheck.errors.some((error) =>
        error.message.includes("domain.probeEvidence.source"),
      ),
    );
  });

  it("requires backup audit artifact evidence for production cutover", () => {
    const evidence = completeEvidence();
    evidence.backups.backupEvidence = null;

    const gate = runProductionGate({ evidence });
    const backupCheck = gate.checks.find(
      (check) => check.name === "backup_restore",
    );

    assert.equal(gate.ok, false);
    assert.equal(backupCheck.ok, false);
    assert.ok(
      backupCheck.errors.some((error) =>
        error.message.includes("backupEvidence"),
      ),
    );
  });

  it("requires cryptographic off-site upload and recovery receipts for production cutover", () => {
    const evidence = completeEvidence();
    evidence.backups.backupEvidence.offsiteUploadReceipt = null;
    evidence.backups.backupEvidence.offsiteRestoreReceipt = null;

    const gate = runProductionGate({ evidence });
    const backupCheck = gate.checks.find(
      (check) => check.name === "backup_restore",
    );

    assert.equal(gate.ok, false);
    assert.equal(backupCheck.ok, false);
    assert.ok(
      backupCheck.errors.some((error) =>
        error.message.includes("offsiteUploadReceipt"),
      ),
    );
    assert.ok(
      backupCheck.errors.some((error) =>
        error.message.includes("offsiteRestoreReceipt"),
      ),
    );
  });

  it("rejects backup recovery evidence that predates its upload", () => {
    const evidence = completeEvidence();
    const restoreCheckedAt = "2026-07-06T00:05:00.000Z";
    evidence.backups.backupEvidence.offsiteRestoreReceipt.checkedAt =
      restoreCheckedAt;
    evidence.backups.backupEvidence.restoreCheckedAt = restoreCheckedAt;
    evidence.backups.lastRestoreCheckAt = restoreCheckedAt;

    const gate = runProductionGate({ evidence });
    const backupCheck = gate.checks.find(
      (check) => check.name === "backup_restore",
    );

    assert.equal(gate.ok, false);
    assert.equal(backupCheck.ok, false);
    assert.ok(
      backupCheck.errors.some(
        (error) => error.code === "invalid_timestamp_order",
      ),
    );
  });

  it("requires database audit artifact evidence for production cutover", () => {
    const evidence = completeEvidence();
    evidence.database.databaseEvidence = null;

    const gate = runProductionGate({ evidence });
    const databaseCheck = gate.checks.find(
      (check) => check.name === "database_migration",
    );

    assert.equal(gate.ok, false);
    assert.equal(databaseCheck.ok, false);
    assert.ok(
      databaseCheck.errors.some((error) =>
        error.message.includes("databaseEvidence"),
      ),
    );
  });

  it("requires image provenance artifact evidence for production cutover", () => {
    const evidence = completeEvidence();
    evidence.imageProvenance.provenanceEvidence = null;

    const gate = runProductionGate({ evidence });
    const imageCheck = gate.checks.find(
      (check) => check.name === "image_provenance",
    );

    assert.equal(gate.ok, false);
    assert.equal(imageCheck.ok, false);
    assert.ok(
      imageCheck.errors.some((error) =>
        error.message.includes("provenanceEvidence"),
      ),
    );
  });

  it("requires secret management audit artifact evidence for production cutover", () => {
    const evidence = completeEvidence();
    evidence.secrets.secretEvidence = null;

    const gate = runProductionGate({ evidence });
    const secretsCheck = gate.checks.find(
      (check) => check.name === "secret_management",
    );

    assert.equal(gate.ok, false);
    assert.equal(secretsCheck.ok, false);
    assert.ok(
      secretsCheck.errors.some((error) =>
        error.message.includes("secretEvidence"),
      ),
    );
  });

  it("requires mail smoke audit artifact evidence for production cutover", () => {
    const evidence = completeEvidence();
    evidence.mail.mailEvidence = null;

    const gate = runProductionGate({ evidence });
    const mailCheck = gate.checks.find(
      (check) => check.name === "mail_notifications",
    );

    assert.equal(gate.ok, false);
    assert.equal(mailCheck.ok, false);
    assert.ok(
      mailCheck.errors.some((error) => error.message.includes("mailEvidence")),
    );
  });

  it("requires storage retention audit artifact evidence for production cutover", () => {
    const evidence = completeEvidence();
    evidence.storage.storageEvidence = null;

    const gate = runProductionGate({ evidence });
    const storageCheck = gate.checks.find(
      (check) => check.name === "storage_retention",
    );

    assert.equal(gate.ok, false);
    assert.equal(storageCheck.ok, false);
    assert.ok(
      storageCheck.errors.some((error) =>
        error.message.includes("storageEvidence"),
      ),
    );
  });

  it("requires observability audit artifact evidence for production cutover", () => {
    const evidence = completeEvidence();
    evidence.observability.observabilityEvidence = null;

    const gate = runProductionGate({ evidence });
    const observabilityCheck = gate.checks.find(
      (check) => check.name === "observability",
    );

    assert.equal(gate.ok, false);
    assert.equal(observabilityCheck.ok, false);
    assert.ok(
      observabilityCheck.errors.some((error) =>
        error.message.includes("observabilityEvidence"),
      ),
    );
  });

  it("requires security review audit artifact evidence for production cutover", () => {
    const evidence = completeEvidence();
    evidence.securityReview.securityEvidence = null;

    const gate = runProductionGate({ evidence });
    const securityCheck = gate.checks.find(
      (check) => check.name === "security_review",
    );

    assert.equal(gate.ok, false);
    assert.equal(securityCheck.ok, false);
    assert.ok(
      securityCheck.errors.some((error) =>
        error.message.includes("securityEvidence"),
      ),
    );
  });

  it("requires applied deploy and post-deploy receipt evidence for production cutover", () => {
    const evidence = completeEvidence();
    evidence.deployment.deployEvidence = null;
    evidence.deployment.postDeployVerified = false;

    const gate = runProductionGate({ evidence });
    const deploymentCheck = gate.checks.find(
      (check) => check.name === "deployment_verification",
    );

    assert.equal(gate.ok, false);
    assert.equal(deploymentCheck.ok, false);
    assert.ok(
      deploymentCheck.errors.some((error) =>
        error.message.includes("deployment.deployEvidence"),
      ),
    );
    assert.ok(
      deploymentCheck.errors.some((error) =>
        error.message.includes("deployment.postDeployVerified"),
      ),
    );
  });

  it("requires merge queue rollout provenance, not only boolean attestations", () => {
    const evidence = completeEvidence();
    evidence.mergeQueueRollout.dryRunEvidence = null;
    evidence.mergeQueueRollout.liveDrillEvidence = null;

    const gate = runProductionGate({ evidence });
    const rolloutCheck = gate.checks.find(
      (check) => check.name === "merge_queue_rollout",
    );

    assert.equal(gate.ok, false);
    assert.equal(rolloutCheck.ok, false);
    assert.ok(
      rolloutCheck.errors.some((error) =>
        error.message.includes("dryRunEvidence"),
      ),
    );
    assert.ok(
      rolloutCheck.errors.some((error) =>
        error.message.includes("liveDrillEvidence"),
      ),
    );
  });

  it("requires steward runtime provenance, not only status summaries", () => {
    const evidence = completeEvidence();
    evidence.steward.preflightEvidence = null;
    evidence.steward.doctorEvidence = null;

    const gate = runProductionGate({ evidence });
    const stewardCheck = gate.checks.find(
      (check) => check.name === "steward_runtime",
    );

    assert.equal(gate.ok, false);
    assert.equal(stewardCheck.ok, false);
    assert.ok(
      stewardCheck.errors.some((error) =>
        error.message.includes("preflightEvidence"),
      ),
    );
    assert.ok(
      stewardCheck.errors.some((error) =>
        error.message.includes("doctorEvidence"),
      ),
    );
  });

  it("requires SSO smoke provenance, not only status summaries", () => {
    const evidence = completeEvidence();
    evidence.sso.smokeEvidence = null;

    const gate = runProductionGate({ evidence });
    const ssoCheck = gate.checks.find(
      (check) => check.name === "sso_registration",
    );

    assert.equal(gate.ok, false);
    assert.equal(ssoCheck.ok, false);
    assert.ok(
      ssoCheck.errors.some((error) => error.message.includes("smokeEvidence")),
    );
  });

  it("requires Forgejo identity bootstrap provenance for SSO cutover", () => {
    const evidence = completeEvidence();
    evidence.sso.bootstrapEvidence = null;

    const gate = runProductionGate({ evidence });
    const ssoCheck = gate.checks.find(
      (check) => check.name === "sso_registration",
    );

    assert.equal(gate.ok, false);
    assert.equal(ssoCheck.ok, false);
    assert.ok(
      ssoCheck.errors.some((error) =>
        error.message.includes("bootstrapEvidence"),
      ),
    );
  });

  it("requires runner artifact provenance, not only isolation summaries", () => {
    const evidence = completeEvidence();
    evidence.runner.smokeEvidence = null;
    evidence.runner.auditEvidence = null;

    const gate = runProductionGate({ evidence });
    const runnerCheck = gate.checks.find(
      (check) => check.name === "runner_isolation",
    );

    assert.equal(gate.ok, false);
    assert.equal(runnerCheck.ok, false);
    assert.ok(
      runnerCheck.errors.some((error) =>
        error.message.includes("smokeEvidence"),
      ),
    );
    assert.ok(
      runnerCheck.errors.some((error) =>
        error.message.includes("auditEvidence"),
      ),
    );
  });

  it("requires human agent and service identity smoke evidence for SSO", () => {
    const evidence = completeEvidence();
    evidence.sso.humanIdentitySmokePassed = false;
    evidence.sso.agentIdentitySmokePassed = false;
    evidence.sso.serviceIdentitySmokePassed = false;

    const gate = runProductionGate({ evidence });
    const ssoCheck = gate.checks.find(
      (check) => check.name === "sso_registration",
    );

    assert.equal(gate.ok, false);
    assert.equal(ssoCheck.ok, false);
    assert.ok(
      ssoCheck.errors.some((error) =>
        error.message.includes("humanIdentitySmokePassed"),
      ),
    );
    assert.ok(
      ssoCheck.errors.some((error) =>
        error.message.includes("agentIdentitySmokePassed"),
      ),
    );
    assert.ok(
      ssoCheck.errors.some((error) =>
        error.message.includes("serviceIdentitySmokePassed"),
      ),
    );
  });

  it("requires strict work reservations in steward production evidence", () => {
    const evidence = completeEvidence();
    evidence.steward.strictWorkReservationsEnforced = false;

    const gate = runProductionGate({ evidence });
    const stewardCheck = gate.checks.find(
      (check) => check.name === "steward_runtime",
    );

    assert.equal(gate.ok, false);
    assert.equal(stewardCheck.ok, false);
    assert.ok(
      stewardCheck.errors.some((error) =>
        error.message.includes("strictWorkReservationsEnforced"),
      ),
    );
  });

  it("requires durable Work item links in steward production evidence", () => {
    const evidence = completeEvidence();
    evidence.steward.strictWorkItemsEnforced = false;

    const gate = runProductionGate({ evidence });
    const stewardCheck = gate.checks.find(
      (check) => check.name === "steward_runtime",
    );

    assert.equal(gate.ok, false);
    assert.equal(stewardCheck.ok, false);
    assert.ok(
      stewardCheck.errors.some((error) =>
        error.message.includes("strictWorkItemsEnforced"),
      ),
    );
  });

  it("requires strict agent branch namespaces in steward production evidence", () => {
    const evidence = completeEvidence();
    evidence.steward.strictAgentBranchNamespacesEnforced = false;

    const gate = runProductionGate({ evidence });
    const stewardCheck = gate.checks.find(
      (check) => check.name === "steward_runtime",
    );

    assert.equal(gate.ok, false);
    assert.equal(stewardCheck.ok, false);
    assert.ok(
      stewardCheck.errors.some((error) =>
        error.message.includes("strictAgentBranchNamespacesEnforced"),
      ),
    );
  });

  it("requires verified agent run receipts in steward production evidence", () => {
    const evidence = completeEvidence();
    evidence.steward.verifiedAgentRunReceiptsEnforced = false;

    const gate = runProductionGate({ evidence });
    const stewardCheck = gate.checks.find(
      (check) => check.name === "steward_runtime",
    );

    assert.equal(gate.ok, false);
    assert.equal(stewardCheck.ok, false);
    assert.ok(
      stewardCheck.errors.some((error) =>
        error.message.includes("verifiedAgentRunReceiptsEnforced"),
      ),
    );
  });

  it("requires agent identity registry enforcement in steward production evidence", () => {
    const evidence = completeEvidence();
    evidence.steward.agentIdentityRegistryEnforced = false;

    const gate = runProductionGate({ evidence });
    const stewardCheck = gate.checks.find(
      (check) => check.name === "steward_runtime",
    );

    assert.equal(gate.ok, false);
    assert.equal(stewardCheck.ok, false);
    assert.ok(
      stewardCheck.errors.some((error) =>
        error.message.includes("agentIdentityRegistryEnforced"),
      ),
    );
  });

  it("requires strict work reservations in merge queue rollout evidence", () => {
    const evidence = completeEvidence();
    evidence.mergeQueueRollout.strictWorkReservationsEnforced = false;

    const gate = runProductionGate({ evidence });
    const rolloutCheck = gate.checks.find(
      (check) => check.name === "merge_queue_rollout",
    );

    assert.equal(gate.ok, false);
    assert.equal(rolloutCheck.ok, false);
    assert.ok(
      rolloutCheck.errors.some((error) =>
        error.message.includes("strictWorkReservationsEnforced"),
      ),
    );
  });

  it("requires durable Work item links in merge queue rollout evidence", () => {
    const evidence = completeEvidence();
    evidence.mergeQueueRollout.strictWorkItemsEnforced = false;

    const gate = runProductionGate({ evidence });
    const rolloutCheck = gate.checks.find(
      (check) => check.name === "merge_queue_rollout",
    );

    assert.equal(gate.ok, false);
    assert.equal(rolloutCheck.ok, false);
    assert.ok(
      rolloutCheck.errors.some((error) =>
        error.message.includes("strictWorkItemsEnforced"),
      ),
    );
  });

  it("requires strict agent branch namespaces in merge queue rollout evidence", () => {
    const evidence = completeEvidence();
    evidence.mergeQueueRollout.strictAgentBranchNamespacesEnforced = false;

    const gate = runProductionGate({ evidence });
    const rolloutCheck = gate.checks.find(
      (check) => check.name === "merge_queue_rollout",
    );

    assert.equal(gate.ok, false);
    assert.equal(rolloutCheck.ok, false);
    assert.ok(
      rolloutCheck.errors.some((error) =>
        error.message.includes("strictAgentBranchNamespacesEnforced"),
      ),
    );
  });

  it("requires verified agent run receipts in merge queue rollout evidence", () => {
    const evidence = completeEvidence();
    evidence.mergeQueueRollout.verifiedAgentRunReceiptsEnforced = false;

    const gate = runProductionGate({ evidence });
    const rolloutCheck = gate.checks.find(
      (check) => check.name === "merge_queue_rollout",
    );

    assert.equal(gate.ok, false);
    assert.equal(rolloutCheck.ok, false);
    assert.ok(
      rolloutCheck.errors.some((error) =>
        error.message.includes("verifiedAgentRunReceiptsEnforced"),
      ),
    );
  });

  it("requires agent identity registry enforcement in merge queue rollout evidence", () => {
    const evidence = completeEvidence();
    evidence.mergeQueueRollout.agentIdentityRegistryEnforced = false;

    const gate = runProductionGate({ evidence });
    const rolloutCheck = gate.checks.find(
      (check) => check.name === "merge_queue_rollout",
    );

    assert.equal(gate.ok, false);
    assert.equal(rolloutCheck.ok, false);
    assert.ok(
      rolloutCheck.errors.some((error) =>
        error.message.includes("agentIdentityRegistryEnforced"),
      ),
    );
  });

  it("requires stack dependency order enforcement in merge queue rollout evidence", () => {
    const evidence = completeEvidence();
    evidence.mergeQueueRollout.stackDependencyOrderEnforced = false;

    const gate = runProductionGate({ evidence });
    const rolloutCheck = gate.checks.find(
      (check) => check.name === "merge_queue_rollout",
    );

    assert.equal(gate.ok, false);
    assert.equal(rolloutCheck.ok, false);
    assert.ok(
      rolloutCheck.errors.some((error) =>
        error.message.includes("stackDependencyOrderEnforced"),
      ),
    );
  });

  it("requires live repository protection evidence for production cutover", () => {
    const evidence = completeEvidence();
    evidence.repository.liveProtectionEvidence = null;

    const gate = runProductionGate({ evidence });
    const repositoryCheck = gate.checks.find(
      (check) => check.name === "repository_protection",
    );

    assert.equal(gate.ok, false);
    assert.equal(repositoryCheck.ok, false);
    assert.ok(
      repositoryCheck.errors.some((error) =>
        error.message.includes("liveProtectionEvidence"),
      ),
    );
  });

  it("requires applied GitHub migration bootstrap evidence for production cutover", () => {
    const evidence = completeEvidence();
    evidence.githubMigration.pilotBootstrapEvidence = null;
    evidence.githubMigration.pilotBootstrapPassed = false;

    const gate = runProductionGate({ evidence });
    const migrationCheck = gate.checks.find(
      (check) => check.name === "github_migration_rehearsal",
    );

    assert.equal(gate.ok, false);
    assert.equal(migrationCheck.ok, false);
    assert.ok(
      migrationCheck.errors.some((error) =>
        error.message.includes("pilotBootstrapEvidence"),
      ),
    );
    assert.ok(
      migrationCheck.errors.some((error) =>
        error.message.includes("pilotBootstrapPassed"),
      ),
    );
  });

  it("rejects dry-run GitHub migration bootstrap evidence for production cutover", () => {
    const evidence = completeEvidence();
    evidence.githubMigration.pilotBootstrapEvidence.dryRun = true;

    const gate = runProductionGate({ evidence });
    const migrationCheck = gate.checks.find(
      (check) => check.name === "github_migration_rehearsal",
    );

    assert.equal(gate.ok, false);
    assert.equal(migrationCheck.ok, false);
    assert.ok(
      migrationCheck.errors.some((error) => error.message.includes("dryRun")),
    );
  });

  it("requires a live repository protection artifact digest for production cutover", () => {
    const evidence = completeEvidence();
    evidence.repository.liveProtectionEvidence.sha256 = null;

    const gate = runProductionGate({ evidence });
    const repositoryCheck = gate.checks.find(
      (check) => check.name === "repository_protection",
    );

    assert.equal(gate.ok, false);
    assert.equal(repositoryCheck.ok, false);
    assert.ok(
      repositoryCheck.errors.some((error) => error.message.includes("sha256")),
    );
  });
});

function duplicates(items = []) {
  const seen = new Set();
  const duplicateItems = new Set();

  for (const item of items) {
    if (seen.has(item)) {
      duplicateItems.add(item);
      continue;
    }
    seen.add(item);
  }

  return [...duplicateItems];
}
