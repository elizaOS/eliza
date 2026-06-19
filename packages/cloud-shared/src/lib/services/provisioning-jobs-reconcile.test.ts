/**
 * Accounting + fault-isolation of the disconnected-agent reconcile wrapper
 * (ProvisioningJobService.processDisconnectedReconcile), the on-prem daemon's
 * per-cycle entry point. The wrapper mirrors processRunningHeartbeats: it must
 * call reconcileDisconnected exactly once per candidate, tally
 * {recovered, stillDown} correctly, and never let one throwing candidate abort
 * the rest of the cycle.
 */

import { describe, expect, spyOn, test } from "bun:test";

import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { elizaSandboxService } from "./eliza-sandbox";
import { provisioningJobService } from "./provisioning-jobs";

describe("processDisconnectedReconcile", () => {
  test("tallies recovered/stillDown and isolates a throwing candidate", async () => {
    const candidates = [
      { id: "11111111-1111-4111-8111-111111111111", organization_id: "o1" },
      { id: "22222222-2222-4222-8222-222222222222", organization_id: "o2" },
      { id: "33333333-3333-4333-8333-333333333333", organization_id: "o3" },
    ];
    const listSpy = spyOn(
      agentSandboxesRepository,
      "listReconcilableDisconnected",
    ).mockResolvedValue(candidates);
    const reconcileSpy = spyOn(elizaSandboxService, "reconcileDisconnected").mockImplementation(
      async (id: string) => {
        if (id === candidates[0].id) return true; // recovered
        if (id === candidates[1].id) return false; // still down
        throw new Error("probe blew up"); // must be caught -> stillDown
      },
    );

    try {
      const result = await provisioningJobService.processDisconnectedReconcile(5);

      expect(result).toEqual({ total: 3, recovered: 1, stillDown: 2 });
      // exactly once per candidate, no double-drain of the queue
      expect(reconcileSpy).toHaveBeenCalledTimes(3);
      const calledIds = reconcileSpy.mock.calls.map((c) => c[0]).sort();
      expect(calledIds).toEqual(candidates.map((c) => c.id).sort());
    } finally {
      listSpy.mockRestore();
      reconcileSpy.mockRestore();
    }
  });

  test("no candidates -> no probes, zeroed result", async () => {
    const listSpy = spyOn(
      agentSandboxesRepository,
      "listReconcilableDisconnected",
    ).mockResolvedValue([]);
    const reconcileSpy = spyOn(elizaSandboxService, "reconcileDisconnected").mockResolvedValue(
      true,
    );

    try {
      const result = await provisioningJobService.processDisconnectedReconcile(5);
      expect(result).toEqual({ total: 0, recovered: 0, stillDown: 0 });
      expect(reconcileSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
      reconcileSpy.mockRestore();
    }
  });
});
