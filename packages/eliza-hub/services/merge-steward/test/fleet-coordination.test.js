import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFleetCoordination,
  FLEET_COORDINATION_VERSION,
} from "../src/fleet-coordination.js";

describe("fleet coordination contract", () => {
  it("publishes agent-readable board, claim, evidence, and shared-lever rules", () => {
    const contract = buildFleetCoordination({
      repo: "elizaos/eliza",
      ownerAgentId: "agent-one",
      now: "2026-07-07T00:30:00.000Z",
      claims: [
        {
          id: "claim:elizaos/eliza:runner:ci-capacity",
          repo: "elizaos/eliza",
          resourceKind: "runner",
          resourceId: "ci-capacity",
          ownerAgentId: "agent-two",
          status: "active",
          expiresAt: "2026-07-07T00:45:00.000Z",
        },
        {
          id: "claim:elizaos/eliza:environment:staging",
          repo: "elizaos/eliza",
          resourceKind: "environment",
          resourceId: "staging",
          ownerAgentId: "agent-one",
          status: "active",
          expiresAt: "2026-07-07T00:00:00.000Z",
        },
      ],
    });

    assert.equal(contract.version, FLEET_COORDINATION_VERSION);
    assert.equal(contract.filters.repo, "elizaos/eliza");
    assert.equal(contract.identity.laneTagRequired, true);
    assert.equal(contract.identity.laneTagExample, "[agent-one]");
    assert.deepEqual(
      contract.surfaces.workBoard.columns.map((column) => column.id),
      [
        "todo",
        "claimed",
        "in_progress",
        "needs_agent_verify",
        "needs_human_verify",
        "done",
      ],
    );
    assert.equal(
      contract.surfaces.workBoard.columns.find((column) => column.id === "done")
        .ownerOnly,
      true,
    );
    assert.equal(contract.claimProtocol.blockedAfterMinutes, 30);
    assert.equal(contract.claimProtocol.steps[0].id, "read_latest_context");
    assert.ok(
      contract.claimProtocol.evidenceRows.includes("real_llm_trajectories"),
    );

    const runner = contract.sharedLevers.find(
      (lever) => lever.id === "runner_capacity",
    );
    assert.equal(runner.state, "claimed_by_other");
    assert.equal(runner.activeClaim.ownerAgentId, "agent-two");
    assert.equal(runner.requiredAction, "wait_or_coordinate_with_claim_owner");

    const staging = contract.sharedLevers.find(
      (lever) => lever.id === "staging_environment",
    );
    assert.equal(staging.state, "own_claim_stale");
    assert.equal(staging.requiredAction, "renew_or_release_claim");

    assert.equal(contract.nextActions[0].id, "coordinate_shared_lever_claims");
    assert.equal(contract.nextActions[0].blocking, true);
    assert.equal(
      contract.nextActions[1].id,
      "renew_or_release_shared_lever_claims",
    );
  });
});
