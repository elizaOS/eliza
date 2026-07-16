import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPatchConflictPrediction } from "../src/patch-conflict-prediction.js";

describe("patch conflict prediction", () => {
  it("blocks patches that collide with open PR files and foreign claims", () => {
    const prediction = buildPatchConflictPrediction({
      now: "2026-07-07T00:00:00.000Z",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      ownerAgentId: "agent-runtime",
      changedFiles: [
        "packages/core/src/runtime.ts",
        "packages/core/src/db/migrations/002.sql",
      ],
      affectedPackages: ["core"],
      queueItems: [
        {
          repo: "elizaos/eliza",
          pullRequestId: 77,
          queueState: "ready",
          ownerAgentId: "agent-ci",
          targetBranch: "develop",
          changedFiles: ["packages/core/src/runtime.ts"],
          affectedPackages: ["core"],
        },
      ],
      claims: [
        {
          id: "claim-db",
          repo: "elizaos/eliza",
          status: "active",
          ownerAgentId: "agent-db",
          resourceKind: "path",
          resourceId: "packages/core/src/db/migrations/002.sql",
          expiresAt: "2026-07-07T01:00:00.000Z",
        },
      ],
    });

    assert.equal(prediction.prediction.state, "blocked");
    assert.equal(prediction.prediction.level, "high");
    assert.equal(prediction.prediction.safeToStart, false);
    assert.ok(prediction.prediction.blockers.includes("active_claim_conflict"));
    assert.ok(prediction.prediction.blockers.includes("same_file_open_pr"));
    assert.ok(
      prediction.prediction.blockers.includes("migration_conflict_risk"),
    );
    assert.deepEqual(prediction.overlaps.files, [
      "packages/core/src/db/migrations/002.sql",
      "packages/core/src/runtime.ts",
    ]);
    assert.equal(prediction.overlaps.queueItems[0].pullRequestId, 77);
    assert.equal(prediction.overlaps.claims[0].ownerAgentId, "agent-db");
    assert.ok(prediction.recommendedPlan.coordinateWith.includes("agent-ci"));
    assert.ok(prediction.recommendedPlan.coordinateWith.includes("agent-db"));
    assert.equal(prediction.recommendedPlan.splitRecommended, true);
    assert.ok(prediction.labels.includes("agent:claimed-conflict"));
    assert.ok(prediction.labels.includes("agent:duplicate-risk"));
    assert.ok(prediction.labels.includes("conflict:migration"));
  });

  it("warns when a patch only shares a package lane", () => {
    const prediction = buildPatchConflictPrediction({
      now: "2026-07-07T00:00:00.000Z",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      ownerAgentId: "agent-runtime",
      changedFiles: ["packages/core/src/agent.ts"],
      affectedPackages: ["core"],
      queueItems: [
        {
          repo: "elizaos/eliza",
          pullRequestId: 80,
          queueState: "ready",
          ownerAgentId: "agent-memory",
          targetBranch: "develop",
          changedFiles: ["packages/core/src/memory.ts"],
          affectedPackages: ["core"],
        },
      ],
    });

    assert.equal(prediction.prediction.state, "watch");
    assert.equal(prediction.prediction.safeToStart, true);
    assert.deepEqual(prediction.prediction.blockers, []);
    assert.ok(prediction.prediction.warnings.includes("same_package_open_pr"));
    assert.equal(prediction.overlaps.queueItems[0].severity, "medium");
    assert.deepEqual(prediction.overlaps.packages, ["core"]);
    assert.equal(
      prediction.recommendedPlan.strategy,
      "open_after_coordination_ack",
    );
    assert.ok(prediction.labels.includes("conflict:package-watch"));
  });
});
