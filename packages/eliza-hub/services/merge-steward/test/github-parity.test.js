import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  buildGithubParityMatrix,
  buildGithubParitySummary,
  GITHUB_PARITY_PATH,
  GITHUB_PARITY_STATUS,
} from "../src/github-parity.js";
import { completeEvidence } from "./production-gate-fixtures.js";

const OPENAPI_PATH = new URL("../openapi.json", import.meta.url);

describe("GitHub parity matrix", () => {
  it("makes GitHub parity explicit without claiming unsupported native surfaces", () => {
    const matrix = buildGithubParityMatrix({
      generatedAt: "2026-07-06T00:00:00.000Z",
    });
    const byId = Object.fromEntries(
      matrix.surfaces.map((surface) => [surface.id, surface]),
    );

    assert.equal(matrix.schema, "https://eliza.hub/schemas/github-parity.v1");
    assert.equal(matrix.matrixVersion, 1);
    assert.equal(matrix.status, "forgejo_plus_eliza_not_full_github_parity");
    assert.equal(matrix.summary.githubParityClaim, "explicit_partial_parity");
    assert.equal(matrix.summary.githubDropInReplacement, false);
    assert.equal(matrix.summary.productionReadyWithoutPrivateEvidence, false);
    assert.equal(matrix.summary.productionUseRequiresPrivateEvidence, true);
    assert.equal(matrix.summary.privateEvidenceEvaluated, false);
    assert.equal(matrix.summary.productionGatePassed, false);
    assert.equal(matrix.summary.cutoverReady, false);
    assert.equal(
      matrix.summary.githubMigrationMode,
      "surface_by_surface_with_agent_native_replacements",
    );
    assert.equal(matrix.summary.totalSurfaces, matrix.surfaces.length);
    assert.equal(
      matrix.summary.cutoverBlockerCount,
      matrix.summary.cutoverBlockerSurfaceIds.length,
    );
    assert.equal(matrix.summary.acceptedGapCount, 2);
    assert.equal(
      matrix.summary.evidenceRequiredSurfaceCount,
      matrix.summary.evidenceRequiredSurfaceIds.length,
    );
    assert.equal(
      matrix.summary.blockedCutoverSurfaceCount,
      matrix.summary.blockedCutoverSurfaceIds.length,
    );
    assert.equal(matrix.productionGateSummary, null);
    assert.ok(matrix.productionGateChecks.includes("merge_queue_rollout"));
    assert.ok(matrix.summary.cutoverBlockerSurfaceIds.includes("merge_queue"));
    assert.ok(matrix.summary.blockedCutoverSurfaceIds.includes("merge_queue"));
    assert.ok(
      matrix.summary.cutoverBlockerSurfaceIds.includes(
        "organization_governance",
      ),
    );
    assert.deepEqual(matrix.summary.acceptedGapSurfaceIds, [
      "discussions",
      "codespaces",
    ]);
    assert.ok(
      matrix.migrationGuardrails.some(
        (guardrail) => guardrail.id === "not_drop_in_github",
      ),
    );
    assert.ok(
      matrix.migrationGuardrails.some(
        (guardrail) => guardrail.id === "live_merges_evidence_gated",
      ),
    );
    assert.equal(byId.git_repositories.status, GITHUB_PARITY_STATUS.NATIVE);
    assert.equal(byId.git_repositories.githubDropInReplacement, false);
    assert.equal(byId.git_repositories.maturity, "ready_for_private_use");
    assert.equal(byId.git_repositories.cutoverBlocker, true);
    assert.equal(
      byId.git_repositories.productionDisposition,
      "production_gate_required",
    );
    assert.ok(
      byId.git_repositories.requiredEvidence.includes(
        "repository.liveProtectionEvidence",
      ),
    );
    assert.ok(
      byId.git_repositories.requiredGateChecks.includes(
        "repository_protection",
      ),
    );
    assert.equal(
      byId.git_repositories.cutoverReadiness.status,
      "private_evidence_required",
    );
    assert.equal(byId.git_repositories.cutoverReadiness.blocksCutover, true);
    assert.equal(byId.pull_requests.authority, "forgejo");
    assert.ok(
      byId.pull_requests.requiredEvidence.includes("runner.auditEvidence"),
    );
    assert.equal(byId.projects_v2.status, GITHUB_PARITY_STATUS.COMPUTED);
    assert.equal(byId.projects_v2.authority, "eliza_hub");
    assert.equal(byId.projects_v2.agentFit, "strong_agent_kanban");
    assert.equal(byId.projects_v2.cutoverBlocker, false);
    assert.equal(byId.projects_v2.migrationTarget, "eliza_work");
    assert.ok(byId.projects_v2.targetApis.includes("/api/work-dashboard"));
    assert.equal(byId.merge_queue.status, GITHUB_PARITY_STATUS.STEWARD);
    assert.equal(byId.merge_queue.authority, "merge_steward");
    assert.equal(byId.merge_queue.maturity, "production_evidence_gated");
    assert.equal(byId.merge_queue.cutoverBlocker, true);
    assert.ok(
      byId.merge_queue.requiredEvidence.includes(
        "mergeQueueRollout.liveDrillEvidence",
      ),
    );
    assert.ok(
      byId.merge_queue.requiredGateChecks.includes("merge_queue_rollout"),
    );
    assert.equal(
      byId.merge_queue.cutoverReadiness.status,
      "private_evidence_required",
    );
    assert.equal(byId.merge_queue.cutoverReadiness.ready, false);
    assert.ok(
      byId.merge_queue.cutoverReadiness.failingGateChecks.includes(
        "merge_queue_rollout",
      ),
    );
    assert.ok(byId.merge_queue.targetApis.includes("/api/merge-train"));
    assert.equal(byId.discussions.status, GITHUB_PARITY_STATUS.NOT_SUPPORTED);
    assert.equal(byId.discussions.maturity, "not_available");
    assert.equal(byId.discussions.productionDisposition, "accepted_gap");
    assert.equal(byId.discussions.cutoverBlocker, false);
    assert.deepEqual(byId.discussions.requiredEvidence, []);
    assert.deepEqual(byId.discussions.requiredGateChecks, []);
    assert.equal(byId.discussions.cutoverReadiness.status, "accepted_gap");
    assert.equal(byId.discussions.cutoverReadiness.ready, true);
    assert.equal(byId.discussions.cutoverReadiness.blocksCutover, false);
    assert.deepEqual(byId.discussions.replacementSurfaces, [
      "pull_request_comments",
      "human_requests",
      "approvals",
      "signals",
    ]);
    assert.equal(byId.advanced_security.status, GITHUB_PARITY_STATUS.DELEGATED);
    assert.equal(
      byId.advanced_security.productionDisposition,
      "external_dependency_required",
    );
    assert.equal(byId.advanced_security.cutoverBlocker, true);
    assert.equal(byId.codespaces.status, GITHUB_PARITY_STATUS.NOT_SUPPORTED);
    assert.equal(byId.codespaces.productionDisposition, "accepted_gap");
    assert.equal(byId.organization_governance.cutoverBlocker, true);
    assert.ok(
      byId.organization_governance.requiredEvidence.includes(
        "sso.bootstrapEvidence",
      ),
    );
    assert.ok(
      matrix.agentNativeAdditions.some(
        (surface) => surface.id === "agent_claims",
      ),
    );
    assert.ok(
      matrix.agentNativeAdditions.some(
        (surface) => surface.id === "agent_branch_namespaces",
      ),
    );
    assert.ok(
      matrix.agentNativeAdditions.some(
        (surface) => surface.id === "agent_cockpit",
      ),
    );
    assert.ok(
      matrix.agentNativeAdditions.some(
        (surface) => surface.id === "queue_item_action_plans",
      ),
    );
    assert.ok(
      matrix.agentNativeAdditions.some(
        (surface) => surface.id === "verified_agent_run_receipts",
      ),
    );
    assert.ok(
      matrix.agentNativeAdditions.some(
        (surface) => surface.id === "agent_identity_registry",
      ),
    );
    assert.ok(
      matrix.agentNativeAdditions.some(
        (surface) => surface.id === "agent_review_assignment",
      ),
    );
    assert.ok(
      matrix.agentNativeAdditions.some(
        (surface) => surface.id === "agent_repo_search",
      ),
    );
    assert.ok(
      matrix.agentNativeAdditions.some(
        (surface) => surface.id === "agent_work_items",
      ),
    );
    assert.ok(
      matrix.agentNativeAdditions.some(
        (surface) => surface.id === "agent_work_planning",
      ),
    );
    assert.ok(
      matrix.agentNativeAdditions.some(
        (surface) => surface.id === "agent_action_plan",
      ),
    );
    assert.ok(
      matrix.agentNativeAdditions.some(
        (surface) => surface.id === "agent_patch_conflict_prediction",
      ),
    );
    assert.ok(
      matrix.agentNativeAdditions.some(
        (surface) => surface.id === "agent_release_notes",
      ),
    );
  });

  it("returns a compact discovery summary with the parity endpoint link", () => {
    const summary = buildGithubParitySummary();

    assert.equal(summary.status, "forgejo_plus_eliza_not_full_github_parity");
    assert.equal(summary.link, GITHUB_PARITY_PATH);
    assert.equal(summary.githubDropInReplacement, false);
    assert.equal(summary.productionReadyWithoutPrivateEvidence, false);
    assert.ok(summary.migrationGuardrailIds.includes("not_drop_in_github"));
    assert.ok(
      summary.migrationGuardrailIds.includes("live_merges_evidence_gated"),
    );
    assert.ok(summary.agentNativeAdditionIds.includes("agent_cockpit"));
    assert.ok(
      summary.agentNativeAdditionIds.includes("queue_item_action_plans"),
    );
    assert.ok(summary.cutoverBlockerSurfaces.includes("merge_queue"));
    assert.ok(summary.blockedCutoverSurfaces.includes("merge_queue"));
    assert.equal(summary.readySurfaceCount, 2);
    assert.equal(summary.cutoverReady, false);
    assert.deepEqual(summary.acceptedGapSurfaces, [
      "discussions",
      "codespaces",
    ]);
    assert.ok(summary.evidenceRequiredSurfaces.includes("actions"));
    assert.ok(summary.unsupportedNativeSurfaces.includes("discussions"));
    assert.ok(summary.unsupportedNativeSurfaces.includes("codespaces"));
    assert.ok(summary.partialOrDelegatedSurfaces.includes("actions"));
    assert.ok(summary.partialOrDelegatedSurfaces.includes("advanced_security"));
  });

  it("keeps agent-native addition links backed by documented API paths", async () => {
    const openapi = JSON.parse(await readFile(OPENAPI_PATH, "utf8"));
    const documentedPaths = new Set(Object.keys(openapi.paths));
    const matrix = buildGithubParityMatrix();

    for (const addition of matrix.agentNativeAdditions) {
      assert.ok(
        addition.links.length > 0,
        `${addition.id} should expose at least one API link`,
      );

      for (const link of addition.links) {
        if (!link.startsWith("/")) continue;
        assert.ok(
          documentedPaths.has(link),
          `${addition.id} links unknown path ${link}`,
        );
      }
    }

    for (const surface of matrix.surfaces) {
      for (const link of surface.targetApis) {
        if (!link.startsWith("/")) continue;
        assert.ok(
          documentedPaths.has(link),
          `${surface.id} routes to unknown target API ${link}`,
        );
      }
    }
  });

  it("classifies every GitHub surface for production cutover decisions", () => {
    const matrix = buildGithubParityMatrix();

    for (const surface of matrix.surfaces) {
      assert.equal(
        typeof surface.productionDisposition,
        "string",
        `${surface.id} needs a production disposition`,
      );
      assert.equal(
        typeof surface.cutoverBlocker,
        "boolean",
        `${surface.id} needs a cutover blocker flag`,
      );
      assert.ok(
        Array.isArray(surface.requiredEvidence),
        `${surface.id} needs required evidence paths`,
      );
      assert.ok(
        Array.isArray(surface.requiredGateChecks),
        `${surface.id} needs required gate check names`,
      );
      assert.equal(
        typeof surface.cutoverReadiness,
        "object",
        `${surface.id} needs cutover readiness`,
      );
      assert.equal(
        typeof surface.migrationTarget,
        "string",
        `${surface.id} needs a migration target`,
      );
      assert.ok(
        Array.isArray(surface.targetApis),
        `${surface.id} needs target API routing`,
      );
      assert.equal(
        typeof surface.nextAction,
        "string",
        `${surface.id} needs a next action`,
      );

      if (surface.cutoverBlocker) {
        assert.ok(
          surface.requiredEvidence.length > 0,
          `${surface.id} cannot block cutover without evidence paths`,
        );
        assert.equal(
          surface.cutoverReadiness.blocksCutover,
          true,
          `${surface.id} should block static cutover`,
        );
      }
    }
  });

  it("scores cutover readiness when private evidence passes the production gate", () => {
    const matrix = buildGithubParityMatrix({
      generatedAt: "2026-07-06T00:00:00.000Z",
      evidence: completeEvidence(),
    });
    const byId = Object.fromEntries(
      matrix.surfaces.map((surface) => [surface.id, surface]),
    );

    assert.equal(matrix.productionGateSummary.ok, true);
    assert.equal(matrix.productionGateSummary.failed, 0);
    assert.equal(matrix.summary.privateEvidenceEvaluated, true);
    assert.equal(matrix.summary.productionGatePassed, true);
    assert.equal(matrix.summary.cutoverReady, true);
    assert.deepEqual(matrix.summary.blockedCutoverSurfaceIds, []);
    assert.equal(matrix.summary.blockedCutoverSurfaceCount, 0);
    assert.equal(matrix.summary.readySurfaceCount, matrix.surfaces.length);
    assert.ok(matrix.summary.readySurfaceIds.includes("merge_queue"));
    assert.ok(
      matrix.surfaces.every(
        (surface) => surface.cutoverReadiness.blocksCutover === false,
      ),
    );
    assert.equal(byId.merge_queue.cutoverReadiness.status, "ready");
    assert.equal(byId.merge_queue.cutoverReadiness.ready, true);
    assert.ok(
      byId.merge_queue.cutoverReadiness.passedGateChecks.includes(
        "merge_queue_rollout",
      ),
    );
    assert.deepEqual(byId.merge_queue.cutoverReadiness.failingGateChecks, []);
    assert.deepEqual(byId.merge_queue.cutoverReadiness.missingGateChecks, []);
  });

  it("blocks affected GitHub surfaces when private evidence fails a required gate", () => {
    const evidence = completeEvidence();
    evidence.runner.auditEvidence = null;
    const matrix = buildGithubParityMatrix({ evidence });
    const byId = Object.fromEntries(
      matrix.surfaces.map((surface) => [surface.id, surface]),
    );

    assert.equal(matrix.productionGateSummary.ok, false);
    assert.equal(matrix.summary.privateEvidenceEvaluated, true);
    assert.equal(matrix.summary.productionGatePassed, false);
    assert.equal(matrix.summary.cutoverReady, false);
    assert.ok(
      matrix.summary.blockedCutoverSurfaceIds.includes("pull_requests"),
    );
    assert.ok(matrix.summary.blockedCutoverSurfaceIds.includes("actions"));
    assert.equal(
      byId.pull_requests.cutoverReadiness.status,
      "blocked_by_production_gate",
    );
    assert.equal(
      byId.actions.cutoverReadiness.status,
      "blocked_by_production_gate",
    );
    assert.ok(
      byId.pull_requests.cutoverReadiness.failingGateChecks.includes(
        "runner_isolation",
      ),
    );
    assert.ok(
      byId.actions.cutoverReadiness.failingGateChecks.includes(
        "runner_isolation",
      ),
    );
    assert.equal(byId.projects_v2.cutoverReadiness.blocksCutover, false);
  });

  it("keeps parity required gate checks aligned with production gate check ids", () => {
    const matrix = buildGithubParityMatrix();
    const knownGateChecks = new Set(matrix.productionGateChecks);

    for (const surface of matrix.surfaces) {
      for (const gateCheck of surface.requiredGateChecks) {
        assert.ok(
          knownGateChecks.has(gateCheck),
          `${surface.id} references unknown gate check ${gateCheck}`,
        );
      }
    }
  });
});
