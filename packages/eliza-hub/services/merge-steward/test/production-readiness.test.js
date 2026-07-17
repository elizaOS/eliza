import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PRODUCTION_GATE_CHECKS,
  runProductionGate,
} from "../src/production-gate.js";
import {
  buildProductionCutoverPlan,
  buildProductionReadiness,
  buildProductionReadinessSummary,
  PRODUCTION_CUTOVER_PATH,
  PRODUCTION_CUTOVER_STATUS,
  PRODUCTION_READINESS_PATH,
  PRODUCTION_READINESS_STATUS,
} from "../src/production-readiness.js";
import { completeEvidence } from "./production-gate-fixtures.js";

describe("production readiness checklist", () => {
  it("maps every production gate check to an evidence helper without claiming production readiness", () => {
    const readiness = buildProductionReadiness({
      generatedAt: "2026-07-06T00:00:00.000Z",
    });
    const domainsById = Object.fromEntries(
      readiness.domains.map((domain) => [domain.id, domain]),
    );

    assert.equal(
      readiness.schema,
      "https://eliza.hub/schemas/production-readiness.v1",
    );
    assert.equal(readiness.checklistVersion, 1);
    assert.equal(readiness.generatedAt, "2026-07-06T00:00:00.000Z");
    assert.equal(readiness.status, PRODUCTION_READINESS_STATUS.BLOCKED);
    assert.equal(readiness.currentUse, PRODUCTION_READINESS_STATUS.DEMO_READY);
    assert.equal(readiness.productionReady, false);
    assert.equal(readiness.privateEvidenceRequired, true);
    assert.equal(readiness.privateEvidenceEvaluated, false);
    assert.deepEqual(
      readiness.authoritativeGate.gateChecks,
      PRODUCTION_GATE_CHECKS,
    );
    assert.deepEqual(readiness.authoritativeGate.missingChecklistEntries, []);
    assert.match(
      readiness.authoritativeGate.command,
      /production-gate --strict/,
    );
    assert.ok(
      readiness.assembly.commands.some((command) =>
        /production-evidence-inventory\.mjs --strict/.test(command),
      ),
    );
    assert.ok(
      readiness.assembly.commands.some((command) =>
        /production-gate --strict/.test(command),
      ),
    );
    assert.equal(readiness.authoritativeGate.gateSummary, null);
    assert.equal(readiness.summary.totalDomains, PRODUCTION_GATE_CHECKS.length);
    assert.deepEqual(readiness.summary.passedDomains, []);
    assert.deepEqual(readiness.summary.blockedDomains, PRODUCTION_GATE_CHECKS);
    assert.equal(domainsById.domain_tls.status, "blocked");
    assert.equal(domainsById.domain_tls.gateCheck, null);
    assert.equal(domainsById.domain_tls.evidenceBlock, "domain");
    assert.match(domainsById.domain_tls.helper, /domain-evidence/);
    assert.deepEqual(
      domainsById.domain_tls.helperSteps.map((step) => step.id),
      ["capture_domain_probe_artifact", "assemble_domain_probe_summary"],
    );
    assert.ok(
      domainsById.domain_tls.requiredEvidence.includes(
        "domain.probeEvidence.source",
      ),
    );
    assert.ok(
      domainsById.domain_tls.requiredEvidence.includes(
        "domain.probeEvidence.sha256",
      ),
    );
    assert.equal(domainsById.sso_registration.evidenceBlock, "sso");
    assert.match(domainsById.sso_registration.helper, /sso-evidence\.mjs/);
    assert.deepEqual(
      domainsById.sso_registration.helperSteps.map((step) => step.id),
      [
        "verify_forgejo_identity_bootstrap",
        "capture_sso_smoke_artifact",
        "generate_sso_production_evidence",
      ],
    );
    assert.match(
      domainsById.sso_registration.helperSteps[0].command,
      /bootstrap-forgejo-identity\.sh/,
    );
    assert.match(
      domainsById.sso_registration.helperSteps[1].command,
      /sso-smoke-evidence\.mjs/,
    );
    assert.match(
      domainsById.sso_registration.helperSteps[2].command,
      /sso-evidence\.mjs/,
    );
    assert.deepEqual(domainsById.sso_registration.helperSteps[2].requires, [
      "$ELIZA_ARTIFACT_ROOT/sso-smoke.json",
      "$ELIZA_ARTIFACT_ROOT/eliza-hub-identity-bootstrap-evidence.json",
    ]);
    assert.ok(domainsById.sso_registration.surfaces.includes("agent_identity"));
    assert.ok(
      domainsById.sso_registration.requiredEvidence.includes(
        "sso.smokeEvidence",
      ),
    );
    assert.ok(
      domainsById.sso_registration.requiredEvidence.includes(
        "sso.bootstrapEvidence",
      ),
    );
    assert.ok(
      domainsById.sso_registration.requiredEvidence.includes(
        "sso.agentIdentitySmokePassed",
      ),
    );
    assert.ok(
      domainsById.backup_restore.requiredEvidence.includes(
        "backups.backupEvidence",
      ),
    );
    assert.ok(
      domainsById.backup_restore.requiredEvidence.includes(
        "backups.backupEvidence.sha256",
      ),
    );
    assert.ok(
      domainsById.database_migration.requiredEvidence.includes(
        "database.databaseEvidence",
      ),
    );
    assert.ok(
      domainsById.database_migration.requiredEvidence.includes(
        "database.databaseEvidence.sha256",
      ),
    );
    assert.ok(
      domainsById.image_provenance.requiredEvidence.includes(
        "imageProvenance.provenanceEvidence",
      ),
    );
    assert.ok(
      domainsById.image_provenance.requiredEvidence.includes(
        "imageProvenance.provenanceEvidence.sha256",
      ),
    );
    assert.equal(domainsById.repository_protection.evidenceBlock, "repository");
    assert.match(domainsById.repository_protection.helper, /--require-live/);
    assert.ok(
      domainsById.repository_protection.requiredEvidence.includes(
        "repository.liveProtectionEvidence.source",
      ),
    );
    assert.ok(
      domainsById.repository_protection.requiredEvidence.includes(
        "repository.liveProtectionEvidence.sha256",
      ),
    );
    assert.equal(
      domainsById.github_migration_rehearsal.evidenceBlock,
      "githubMigration",
    );
    assert.match(
      domainsById.github_migration_rehearsal.helper,
      /pilot-bootstrap\.mjs --apply/,
    );
    assert.deepEqual(
      domainsById.github_migration_rehearsal.helperSteps.map((step) => step.id),
      [
        "plan_github_migration_bootstrap",
        "apply_github_migration_bootstrap",
        "assemble_github_migration_evidence",
      ],
    );
    assert.ok(
      domainsById.github_migration_rehearsal.surfaces.includes(
        "github_pull_mirror",
      ),
    );
    assert.ok(
      domainsById.github_migration_rehearsal.surfaces.includes(
        "trusted_agent_identities",
      ),
    );
    assert.ok(
      domainsById.github_migration_rehearsal.requiredEvidence.includes(
        "githubMigration.pilotBootstrapEvidence.source",
      ),
    );
    assert.ok(
      domainsById.github_migration_rehearsal.requiredEvidence.includes(
        "githubMigration.pilotBootstrapEvidence.dryRun",
      ),
    );
    assert.ok(
      domainsById.github_migration_rehearsal.requiredEvidence.includes(
        "githubMigration.pilotBootstrapPassed",
      ),
    );
    assert.ok(
      domainsById.github_migration_rehearsal.requiredEvidence.includes(
        "githubMigration.pullMirrorOnly",
      ),
    );
    assert.ok(
      domainsById.secret_management.requiredEvidence.includes(
        "secrets.secretEvidence",
      ),
    );
    assert.ok(
      domainsById.secret_management.requiredEvidence.includes(
        "secrets.secretEvidence.sha256",
      ),
    );
    assert.ok(
      domainsById.mail_notifications.requiredEvidence.includes(
        "mail.mailEvidence",
      ),
    );
    assert.ok(
      domainsById.mail_notifications.requiredEvidence.includes(
        "mail.mailEvidence.sha256",
      ),
    );
    assert.ok(
      domainsById.storage_retention.requiredEvidence.includes(
        "storage.storageEvidence",
      ),
    );
    assert.ok(
      domainsById.storage_retention.requiredEvidence.includes(
        "storage.storageEvidence.sha256",
      ),
    );
    assert.ok(
      domainsById.observability.requiredEvidence.includes(
        "observability.observabilityEvidence",
      ),
    );
    assert.ok(
      domainsById.observability.requiredEvidence.includes(
        "observability.observabilityEvidence.sha256",
      ),
    );
    assert.ok(
      domainsById.runner_isolation.requiredEvidence.includes(
        "runner.smokeEvidence",
      ),
    );
    assert.ok(
      domainsById.runner_isolation.requiredEvidence.includes(
        "runner.auditEvidence",
      ),
    );
    assert.ok(
      domainsById.steward_runtime.requiredEvidence.includes(
        "steward.strictWorkReservationsEnforced",
      ),
    );
    assert.ok(
      domainsById.steward_runtime.requiredEvidence.includes(
        "steward.strictWorkItemsEnforced",
      ),
    );
    assert.ok(
      domainsById.steward_runtime.requiredEvidence.includes(
        "steward.strictAgentBranchNamespacesEnforced",
      ),
    );
    assert.ok(
      domainsById.steward_runtime.requiredEvidence.includes(
        "steward.verifiedAgentRunReceiptsEnforced",
      ),
    );
    assert.ok(
      domainsById.steward_runtime.requiredEvidence.includes(
        "steward.agentIdentityRegistryEnforced",
      ),
    );
    assert.ok(
      domainsById.steward_runtime.surfaces.includes("agent_identities"),
    );
    assert.ok(
      domainsById.steward_runtime.surfaces.includes("agent_branch_namespaces"),
    );
    assert.ok(
      domainsById.steward_runtime.surfaces.includes(
        "signed_agent_run_receipts",
      ),
    );
    assert.equal(
      domainsById.merge_queue_rollout.evidenceBlock,
      "mergeQueueRollout",
    );
    assert.match(
      domainsById.merge_queue_rollout.helper,
      /merge-queue-rollout-evidence\.mjs/,
    );
    assert.ok(
      domainsById.merge_queue_rollout.surfaces.includes(
        "strict_work_reservations",
      ),
    );
    assert.ok(
      domainsById.merge_queue_rollout.surfaces.includes("strict_work_items"),
    );
    assert.ok(
      domainsById.merge_queue_rollout.surfaces.includes("agent_identities"),
    );
    assert.ok(
      domainsById.merge_queue_rollout.surfaces.includes(
        "agent_branch_namespaces",
      ),
    );
    assert.ok(
      domainsById.merge_queue_rollout.surfaces.includes(
        "signed_agent_run_receipts",
      ),
    );
    assert.ok(
      domainsById.merge_queue_rollout.surfaces.includes(
        "stack_dependency_order",
      ),
    );
    assert.ok(
      domainsById.merge_queue_rollout.requiredEvidence.includes(
        "mergeQueueRollout.strictWorkReservationsEnforced",
      ),
    );
    assert.ok(
      domainsById.merge_queue_rollout.requiredEvidence.includes(
        "mergeQueueRollout.strictWorkItemsEnforced",
      ),
    );
    assert.ok(
      domainsById.merge_queue_rollout.requiredEvidence.includes(
        "mergeQueueRollout.strictAgentBranchNamespacesEnforced",
      ),
    );
    assert.ok(
      domainsById.merge_queue_rollout.requiredEvidence.includes(
        "mergeQueueRollout.verifiedAgentRunReceiptsEnforced",
      ),
    );
    assert.ok(
      domainsById.merge_queue_rollout.requiredEvidence.includes(
        "mergeQueueRollout.agentIdentityRegistryEnforced",
      ),
    );
    assert.ok(
      domainsById.merge_queue_rollout.requiredEvidence.includes(
        "mergeQueueRollout.stackDependencyOrderEnforced",
      ),
    );
    assert.ok(
      domainsById.security_review.requiredEvidence.includes(
        "securityReview.securityEvidence",
      ),
    );
    assert.ok(
      domainsById.security_review.requiredEvidence.includes(
        "securityReview.securityEvidence.sha256",
      ),
    );
    assert.equal(
      domainsById.deployment_verification.evidenceBlock,
      "deployment",
    );
    assert.match(
      domainsById.deployment_verification.helper,
      /deploy\.sh --apply/,
    );
    assert.deepEqual(
      domainsById.deployment_verification.helperSteps.map((step) => step.id),
      [
        "run_applied_deploy",
        "capture_post_deploy_receipt",
        "assemble_deployment_evidence",
      ],
    );
    assert.ok(
      domainsById.deployment_verification.requiredEvidence.includes(
        "deployment.deployEvidence.source",
      ),
    );
    assert.ok(
      domainsById.deployment_verification.requiredEvidence.includes(
        "deployment.deployEvidence.postDeployEvidenceSha256",
      ),
    );
    assert.ok(
      domainsById.deployment_verification.requiredEvidence.includes(
        "deployment.postDeployEvidence.source",
      ),
    );
    assert.ok(
      domainsById.deployment_verification.requiredEvidence.includes(
        "deployment.applied",
      ),
    );
    assert.ok(
      domainsById.deployment_verification.requiredEvidence.includes(
        "deployment.postDeployVerified",
      ),
    );
    assert.ok(
      readiness.nextActions.every(
        (action) => action.helper && action.nextAction,
      ),
    );
    assert.ok(
      readiness.nextActions.every(
        (action) =>
          Array.isArray(action.helperSteps) && action.helperSteps.length >= 1,
      ),
    );
    assert.match(
      readiness.nextActions.find((action) => action.id === "sso_registration")
        .helperSteps[0].command,
      /bootstrap-forgejo-identity\.sh/,
    );
  });

  it("scores complete private production evidence as production-ready current use", () => {
    const readiness = buildProductionReadiness({
      generatedAt: "2026-07-06T00:00:00.000Z",
      evidence: completeEvidence(),
    });
    const domainsById = Object.fromEntries(
      readiness.domains.map((domain) => [domain.id, domain]),
    );

    assert.equal(
      readiness.status,
      PRODUCTION_READINESS_STATUS.PRODUCTION_READY,
    );
    assert.equal(
      readiness.currentUse,
      PRODUCTION_READINESS_STATUS.PRODUCTION_READY,
    );
    assert.equal(readiness.productionReady, true);
    assert.equal(readiness.privateEvidenceRequired, true);
    assert.equal(readiness.privateEvidenceEvaluated, true);
    assert.equal(readiness.authoritativeGate.gateSummary.failed, 0);
    assert.equal(readiness.summary.gatePassed, true);
    assert.deepEqual(readiness.summary.blockedDomains, []);
    assert.deepEqual(readiness.summary.passedDomains, PRODUCTION_GATE_CHECKS);
    assert.equal(domainsById.sso_registration.status, "passed");
    assert.equal(domainsById.sso_registration.gateCheck.ok, true);
    assert.deepEqual(readiness.nextActions, []);
  });

  it("keeps required evidence paths aligned with the hard production gate", () => {
    const readiness = buildProductionReadiness({
      generatedAt: "2026-07-06T00:00:00.000Z",
    });
    const domainsById = Object.fromEntries(
      readiness.domains.map((domain) => [domain.id, domain]),
    );
    const gate = runProductionGate({
      evidence: completeEvidence(),
      now: new Date("2026-07-06T00:00:00.000Z"),
    });

    for (const check of gate.checks) {
      assert.deepEqual(
        domainsById[check.name]?.requiredEvidence,
        check.evidence,
        `${check.name} readiness evidence must match production gate evidence`,
      );
    }
  });

  it("maps failed production evidence back to the blocking domain and missing paths", () => {
    const evidence = completeEvidence();
    evidence.repository.liveProtectionEvidence = null;

    const readiness = buildProductionReadiness({
      generatedAt: "2026-07-06T00:00:00.000Z",
      evidence,
    });
    const repository = readiness.domains.find(
      (domain) => domain.id === "repository_protection",
    );
    const action = readiness.nextActions.find(
      (item) => item.id === "repository_protection",
    );

    assert.equal(readiness.status, PRODUCTION_READINESS_STATUS.BLOCKED);
    assert.equal(readiness.productionReady, false);
    assert.equal(readiness.privateEvidenceEvaluated, true);
    assert.ok(readiness.summary.passedDomains.includes("domain_tls"));
    assert.deepEqual(readiness.summary.blockedDomains, [
      "repository_protection",
    ]);
    assert.equal(repository.status, "blocked");
    assert.equal(repository.gateCheck.ok, false);
    assert.ok(
      repository.gateCheck.errors.some((error) =>
        error.message.includes("repository.liveProtectionEvidence"),
      ),
    );
    assert.ok(
      action.missingEvidence.some((message) =>
        message.includes("repository.liveProtectionEvidence"),
      ),
    );
  });

  it("returns a compact discovery summary with private evidence requirements", () => {
    const summary = buildProductionReadinessSummary();

    assert.equal(summary.status, PRODUCTION_READINESS_STATUS.BLOCKED);
    assert.equal(summary.currentUse, PRODUCTION_READINESS_STATUS.DEMO_READY);
    assert.equal(summary.link, PRODUCTION_READINESS_PATH);
    assert.equal(summary.productionReady, false);
    assert.equal(summary.privateEvidenceRequired, true);
    assert.equal(summary.summary.privateEvidenceEvaluated, false);
    assert.ok(summary.requiredEvidenceBlocks.includes("sso"));
    assert.ok(summary.requiredEvidenceBlocks.includes("mergeQueueRollout"));
    assert.ok(summary.requiredEvidenceBlocks.includes("githubMigration"));
    assert.deepEqual(summary.gateChecks, PRODUCTION_GATE_CHECKS);
  });

  it("builds a blocked read-only production cutover plan from missing evidence", () => {
    const plan = buildProductionCutoverPlan({
      generatedAt: "2026-07-06T00:00:00.000Z",
    });

    assert.equal(
      plan.schema,
      "https://eliza.hub/schemas/production-cutover-plan.v1",
    );
    assert.equal(plan.planVersion, 1);
    assert.equal(plan.generatedAt, "2026-07-06T00:00:00.000Z");
    assert.equal(plan.readOnly, true);
    assert.equal(plan.status, PRODUCTION_CUTOVER_STATUS.BLOCKED);
    assert.equal(plan.productionReady, false);
    assert.equal(plan.privateEvidenceRequired, true);
    assert.equal(plan.privateEvidenceEvaluated, false);
    assert.equal(plan.guardrails.mutatesState, false);
    assert.equal(plan.guardrails.storesPrivateEvidence, false);
    assert.equal(plan.guardrails.liveAgentMergesAllowed, false);
    assert.equal(plan.guardrails.githubMigrationReady, false);
    assert.ok(
      plan.guardrails.liveAgentMergeRequires.includes(
        "github_parity_cutover_ready",
      ),
    );
    assert.equal(plan.githubMigration.status, "blocked");
    assert.equal(plan.githubMigration.link, "/api/github-parity");
    assert.equal(plan.githubMigration.githubDropInReplacement, false);
    assert.equal(plan.githubMigration.privateEvidenceEvaluated, false);
    assert.equal(plan.githubMigration.cutoverReady, false);
    assert.ok(plan.githubMigration.blockedSurfaces.includes("merge_queue"));
    assert.ok(plan.githubMigration.acceptedGapSurfaces.includes("discussions"));
    assert.equal(plan.summary.githubMigrationCutoverReady, false);
    assert.ok(
      plan.summary.githubMigrationBlockedSurfaces.includes("merge_queue"),
    );
    assert.equal(plan.nextPhase.id, "foundation");
    assert.equal(plan.phases[0].status, "blocked");
    assert.ok(plan.phases[0].blockers.includes("domain_tls"));
    assert.ok(
      plan.executionPlan.orderedSteps.some(
        (step) => step.domainId === "sso_registration",
      ),
    );
    const ssoStep = plan.executionPlan.orderedSteps.find(
      (step) => step.domainId === "sso_registration",
    );
    assert.match(
      ssoStep.helperSteps[0].command,
      /bootstrap-forgejo-identity\.sh/,
    );
    assert.match(ssoStep.helperSteps[1].command, /sso-smoke-evidence\.mjs/);
    assert.match(ssoStep.helperSteps[2].command, /sso-evidence\.mjs/);
    assert.deepEqual(
      plan.phases
        .find((phase) => phase.id === "identity_and_access")
        .nextActions.find((action) => action.id === "sso_registration")
        .helperSteps.map((step) => step.id),
      [
        "verify_forgejo_identity_bootstrap",
        "capture_sso_smoke_artifact",
        "generate_sso_production_evidence",
      ],
    );
    assert.ok(
      plan.executionPlan.assemblyCommands.some((command) =>
        /production-evidence-inventory\.mjs --strict/.test(command),
      ),
    );
    assert.ok(
      plan.executionPlan.assemblyCommands.some((command) =>
        /production-evidence-assemble/.test(command),
      ),
    );
    assert.ok(
      plan.executionPlan.finalVerificationCommands.some((command) =>
        /RELEASE_GATE_MODE=production/.test(command),
      ),
    );
    assert.ok(
      plan.executionPlan.finalVerificationCommands.some((command) =>
        /PRODUCTION_EVIDENCE_FILE=/.test(command),
      ),
    );
    assert.ok(
      plan.executionPlan.finalVerificationCommands.some((command) =>
        /github-parity --strict/.test(command),
      ),
    );
    assert.equal(plan.links.githubParity, "/api/github-parity");
    assert.equal(plan.links.productionReadiness, PRODUCTION_READINESS_PATH);
    assert.equal(plan.links.productionCutover, PRODUCTION_CUTOVER_PATH);
    assert.ok(plan.labels.includes("production-cutover:blocked"));
    assert.ok(plan.labels.includes("github-migration:blocked"));
  });

  it("marks the production cutover plan ready only when private evidence passes", () => {
    const plan = buildProductionCutoverPlan({
      generatedAt: "2026-07-06T00:00:00.000Z",
      evidence: completeEvidence(),
    });

    assert.equal(plan.status, PRODUCTION_CUTOVER_STATUS.READY);
    assert.equal(plan.productionReady, true);
    assert.equal(plan.privateEvidenceEvaluated, true);
    assert.equal(plan.nextPhase, null);
    assert.equal(plan.summary.blockedPhases, 0);
    assert.deepEqual(plan.summary.blockedDomains, []);
    assert.equal(plan.summary.githubMigrationCutoverReady, true);
    assert.deepEqual(plan.summary.githubMigrationBlockedSurfaces, []);
    assert.equal(plan.guardrails.liveAgentMergesAllowed, true);
    assert.equal(plan.guardrails.githubMigrationReady, true);
    assert.equal(plan.githubMigration.status, "ready");
    assert.equal(plan.githubMigration.privateEvidenceEvaluated, true);
    assert.equal(plan.githubMigration.productionGatePassed, true);
    assert.equal(plan.githubMigration.cutoverReady, true);
    assert.deepEqual(plan.githubMigration.blockedSurfaces, []);
    assert.ok(plan.githubMigration.readySurfaces.includes("merge_queue"));
    assert.deepEqual(plan.executionPlan.orderedSteps, []);
    assert.ok(plan.phases.every((phase) => phase.status === "passed"));
    assert.ok(plan.labels.includes("production-cutover:ready"));
    assert.ok(plan.labels.includes("github-migration:ready"));
  });
});
