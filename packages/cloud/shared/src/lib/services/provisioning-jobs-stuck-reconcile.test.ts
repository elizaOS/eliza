/**
 * reconcileStuckProvisioning — the daemon-side self-heal for rows WEDGED in
 * `provisioning` whose container is actually healthy (#15310 failure mode #6).
 *
 * The live incident: a readiness-probe false-negative left a HEALTHY container's
 * row stuck in `provisioning` forever (the Worker cron can only mark it `error`,
 * not re-check — it has no SSH). This guards the two seams:
 *   - service: reconcileStuckProvisioning re-probes the container and CAS-flips
 *     the row to `running` on healthy; leaves it alone on unresolved; treats a
 *     throwing probe as no-signal; never touches a row that moved on.
 *   - orchestrator: the pass fans over listStuckProvisioningWithContainer with
 *     bounded concurrency and tallies recovered/unresolved/failed.
 */
import { describe, expect, spyOn, test } from "bun:test";
import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { elizaSandboxService } from "./eliza-sandbox";
import { provisioningJobService } from "./provisioning-jobs";
import type { SandboxProvider } from "./sandbox-provider-types";

const ORG = "org-1";

function stuckRec(id: string, over: Partial<AgentSandbox> = {}): AgentSandbox {
  return {
    id,
    organization_id: ORG,
    user_id: `user-${id}`,
    agent_name: `Agent ${id}`,
    status: "provisioning",
    sandbox_id: `sandbox-${id}`,
    bridge_url: "http://10.0.0.9:2138",
    health_url: "http://10.0.0.9:2138/api",
    headscale_ip: "100.64.0.9",
    ...over,
  } as unknown as AgentSandbox;
}

function providerWithHealth(outcome: { ready: boolean; verdict: string }): SandboxProvider {
  return {
    create: async () => {
      throw new Error("unused");
    },
    stop: async () => {},
    checkHealth: async () => outcome.ready,
    checkHealthDetailed: async () => outcome,
  } as unknown as SandboxProvider;
}

describe("elizaSandboxService.reconcileStuckProvisioning (service seam)", () => {
  test("container re-probes healthy → CAS-flips the row to running → 'recovered'", async () => {
    const svc = elizaSandboxService;
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(
      stuckRec("a1"),
    );
    const getProvider = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue(providerWithHealth({ ready: true, verdict: "ready" }));
    const flipSpy = spyOn(
      agentSandboxesRepository,
      "markRunningFromProvisioning",
    ).mockResolvedValue(stuckRec("a1", { status: "running" }));

    try {
      const outcome = await svc.reconcileStuckProvisioning("a1", ORG);
      expect(outcome).toBe("recovered");
      expect(flipSpy).toHaveBeenCalledTimes(1);
      expect(flipSpy.mock.calls[0]?.[0]).toBe("a1");
    } finally {
      findSpy.mockRestore();
      getProvider.mockRestore();
      flipSpy.mockRestore();
    }
  });

  test("container re-probes NOT healthy → 'unresolved', row is NOT flipped (never condemned here)", async () => {
    const svc = elizaSandboxService;
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(
      stuckRec("a2"),
    );
    const getProvider = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue(providerWithHealth({ ready: false, verdict: "transport_unresolved" }));
    const flipSpy = spyOn(
      agentSandboxesRepository,
      "markRunningFromProvisioning",
    ).mockResolvedValue(undefined);

    try {
      const outcome = await svc.reconcileStuckProvisioning("a2", ORG);
      expect(outcome).toBe("unresolved");
      expect(flipSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      getProvider.mockRestore();
      flipSpy.mockRestore();
    }
  });

  test("row moved on (no longer provisioning) → 'gone', no probe, no flip", async () => {
    const svc = elizaSandboxService;
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(
      stuckRec("a3", { status: "running" }),
    );
    const getProvider = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue(providerWithHealth({ ready: true, verdict: "ready" }));
    const flipSpy = spyOn(agentSandboxesRepository, "markRunningFromProvisioning");

    try {
      const outcome = await svc.reconcileStuckProvisioning("a3", ORG);
      expect(outcome).toBe("gone");
      expect(getProvider).not.toHaveBeenCalled();
      expect(flipSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      getProvider.mockRestore();
      flipSpy.mockRestore();
    }
  });

  test("row lost its container (no sandbox_id) → 'gone'", async () => {
    const svc = elizaSandboxService;
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(
      stuckRec("a4", { sandbox_id: null }),
    );
    try {
      const outcome = await svc.reconcileStuckProvisioning("a4", ORG);
      expect(outcome).toBe("gone");
    } finally {
      findSpy.mockRestore();
    }
  });

  test("probe THROWS → 'unresolved' (no signal; never condemn or resurrect on an errored probe)", async () => {
    const svc = elizaSandboxService;
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(
      stuckRec("a5"),
    );
    const getProvider = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create: async () => {
        throw new Error("unused");
      },
      stop: async () => {},
      checkHealth: async () => {
        throw new Error("ssh down");
      },
      checkHealthDetailed: async () => {
        throw new Error("ssh down");
      },
    } as unknown as SandboxProvider);
    const flipSpy = spyOn(agentSandboxesRepository, "markRunningFromProvisioning");

    try {
      const outcome = await svc.reconcileStuckProvisioning("a5", ORG);
      expect(outcome).toBe("unresolved");
      expect(flipSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      getProvider.mockRestore();
      flipSpy.mockRestore();
    }
  });
});

describe("provisioningJobService.reconcileStuckProvisioning (orchestrator seam)", () => {
  test("fans over candidates: healthy → recovered, else → unresolved, throw → failed", async () => {
    const listSpy = spyOn(
      agentSandboxesRepository,
      "listStuckProvisioningWithContainer",
    ).mockResolvedValue([
      { id: "a1", organization_id: ORG, user_id: "u1", agent_name: "A1", updated_at: new Date() },
      { id: "a2", organization_id: ORG, user_id: "u2", agent_name: "A2", updated_at: new Date() },
      { id: "a3", organization_id: ORG, user_id: "u3", agent_name: "A3", updated_at: new Date() },
    ]);
    const svcSpy = spyOn(elizaSandboxService, "reconcileStuckProvisioning").mockImplementation(
      async (id: string) => {
        if (id === "a1") return "recovered";
        if (id === "a2") return "unresolved";
        throw new Error("boom");
      },
    );

    try {
      const res = await provisioningJobService.reconcileStuckProvisioning({ concurrency: 2 });
      expect(res).toEqual({ total: 3, recovered: 1, unresolved: 1, failed: 1 });
    } finally {
      listSpy.mockRestore();
      svcSpy.mockRestore();
    }
  });

  test("no candidates → no work", async () => {
    const listSpy = spyOn(
      agentSandboxesRepository,
      "listStuckProvisioningWithContainer",
    ).mockResolvedValue([]);
    const svcSpy = spyOn(elizaSandboxService, "reconcileStuckProvisioning");
    try {
      const res = await provisioningJobService.reconcileStuckProvisioning();
      expect(res).toEqual({ total: 0, recovered: 0, unresolved: 0, failed: 0 });
      expect(svcSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
      svcSpy.mockRestore();
    }
  });
});
