/**
 * processDisconnectedRecovery — the self-heal cycle for `disconnected` always-on
 * (paid) agents. The heartbeat cycle only touches RUNNING agents, so without
 * this a `dedicated-always` agent that briefly dropped past the grace window
 * would stay `disconnected` forever (agent-router routes only `running` → its
 * subdomain 404s). This guards the orchestration seam: listRecoverable →
 * recoverDisconnected → enqueueAgentProvisionOnce only for the still-unreachable.
 */

import { describe, expect, spyOn, test } from "bun:test";

import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { elizaSandboxService } from "./eliza-sandbox";
import { provisioningJobService } from "./provisioning-jobs";

function recoverable(id: string, orgId: string, bridge: string | null) {
  return {
    id,
    organization_id: orgId,
    user_id: `user-${id}`,
    agent_name: `Agent ${id}`,
    bridge_url: bridge,
    updated_at: new Date("2026-06-19T00:00:00Z"),
  };
}

describe("processDisconnectedRecovery", () => {
  test("reachable → recovered (no re-provision); unreachable → re-provision; gone → skipped", async () => {
    const listSpy = spyOn(agentSandboxesRepository, "listRecoverable").mockResolvedValue([
      recoverable("a1", "o1", "http://10.0.0.1:2138"),
      recoverable("a2", "o1", "http://10.0.0.2:2138"),
      recoverable("a3", "o2", "http://10.0.0.3:2138"),
    ]);
    const recoverSpy = spyOn(elizaSandboxService, "recoverDisconnected").mockImplementation(
      async (id: string) => {
        if (id === "a1") return "recovered";
        if (id === "a2") return "unreachable";
        return "gone";
      },
    );
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentProvisionOnce").mockResolvedValue(
      { created: true, job: { id: "job-1" } } as never,
    );

    try {
      const res = await provisioningJobService.processDisconnectedRecovery(5);

      expect(res).toEqual({
        total: 3,
        recovered: 1,
        reprovisioned: 1,
        failed: 0,
      });
      // Only the still-unreachable agent (a2) is re-provisioned; recovered/gone
      // agents are NOT enqueued (would waste a container rebuild on a live one).
      const enqueuedIds = enqueueSpy.mock.calls.map((c) => c[0].agentId);
      expect(enqueuedIds).toEqual(["a2"]);
      expect(enqueueSpy.mock.calls[0]?.[0].userId).toBe("user-a2");
    } finally {
      listSpy.mockRestore();
      recoverSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  test("empty list → no work, no enqueue", async () => {
    const listSpy = spyOn(agentSandboxesRepository, "listRecoverable").mockResolvedValue([]);
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentProvisionOnce").mockResolvedValue(
      { created: true, job: { id: "job-1" } } as never,
    );
    try {
      const res = await provisioningJobService.processDisconnectedRecovery();
      expect(res).toEqual({ total: 0, recovered: 0, reprovisioned: 0, failed: 0 });
      expect(enqueueSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  test("a throw on one agent is counted failed; the rest still process", async () => {
    const listSpy = spyOn(agentSandboxesRepository, "listRecoverable").mockResolvedValue([
      recoverable("a1", "o1", "http://10.0.0.1:2138"),
      recoverable("a2", "o1", "http://10.0.0.2:2138"),
    ]);
    const recoverSpy = spyOn(elizaSandboxService, "recoverDisconnected").mockImplementation(
      async (id: string) => {
        if (id === "a1") throw new Error("probe blew up");
        return "recovered";
      },
    );
    try {
      // concurrency 1 → deterministic order (a1 then a2)
      const res = await provisioningJobService.processDisconnectedRecovery(1);
      expect(res.total).toBe(2);
      expect(res.failed).toBe(1);
      expect(res.recovered).toBe(1);
    } finally {
      listSpy.mockRestore();
      recoverSpy.mockRestore();
    }
  });
});
