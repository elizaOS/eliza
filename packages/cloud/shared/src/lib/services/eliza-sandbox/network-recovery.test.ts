/** Exercises sandbox network recovery contracts with explicit database and replacement-authority simulations. Real durable authority is covered separately by the PGlite suites. */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import type { DockerNode } from "../../../db/repositories/docker-nodes";
import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import { logger } from "../../utils/logger";
import { DockerSSHClient } from "../docker-ssh";
import {
  installSandboxBillingSimulation,
  installSandboxDatabaseSimulation,
} from "./test-support/database.js";
import { customSandbox, fetchUrl } from "./test-support/fixtures.js";
import { installReplacementLifecycleSimulation } from "./test-support/replacement.js";

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
function restoreWebSocketPair() {
  if (originalWebSocketPair)
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
  else Reflect.deleteProperty(globalThis, "WebSocketPair");
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreWebSocketPair();
});

let restoreDatabase: (() => void) | undefined;
let restoreReplacement: (() => void) | undefined;
let billing: ReturnType<typeof installSandboxBillingSimulation>;
beforeAll(async () => {
  restoreDatabase = installSandboxDatabaseSimulation();
  restoreReplacement = await installReplacementLifecycleSimulation();
  billing = installSandboxBillingSimulation();
});
afterAll(() => {
  billing.restore();
  restoreReplacement?.();
  restoreDatabase?.();
});
// Stale-tailnet-IP reconciliation (heartbeat + recoverDisconnected). Agent
// containers do not persist tailscale node state, so a container restart mints
// a fresh node key → headscale assigns the NEXT IP → the stored headscale_ip /
// bridge_url go stale while the container stays docker-healthy. These suites
// pin the repair path (columns fixed in place, no reprovision of a healthy
// container) AND every still-dies guard: dead containers, same-IP genuine
// unreachability, failed re-probes, and the 3-cycle unresolvable escalation
// must all still reach disconnected → the reprovision self-heal.
describe("ElizaSandboxService tailnet-IP reconciliation", () => {
  const OLD_IP = "100.64.0.10";
  const NEW_IP = "100.64.0.11";
  const STALE_BRIDGE = `http://${OLD_IP}:3000`;
  const REPAIRED_BRIDGE = `http://${NEW_IP}:3000`;
  const STALE_HEALTH = `http://${OLD_IP}:3000/api`;
  const REPAIRED_HEALTH = `http://${NEW_IP}:3000/api`;

  function staleIpSandbox(overrides: Partial<AgentSandbox> = {}): AgentSandbox {
    return {
      ...customSandbox(),
      bridge_url: STALE_BRIDGE,
      health_url: STALE_HEALTH,
      headscale_ip: OLD_IP,
      // 200s ago > 120s grace — the reconcile path only runs past grace.
      last_heartbeat_at: new Date(Date.now() - 200_000),
      ...overrides,
    };
  }

  function nodeRecord(): DockerNode {
    return {
      node_id: "node-1",
      hostname: "node-1.internal",
      ssh_port: 22,
      ssh_user: "root",
      host_key_fingerprint: null,
      allocated_count: 1,
    } as unknown as DockerNode;
  }

  // One SSH client mock serving both node-side commands the reconcile issues:
  // docker health inspect and the in-container `tailscale ip -4`.
  function mockNodeSsh(opts: { health: string | Error; tailscaleIp: string | Error }) {
    const exec = mock(async (cmd: string) => {
      if (cmd.includes("docker inspect")) {
        if (opts.health instanceof Error) throw opts.health;
        return [
          `state=running health=${opts.health} exit=0 oom=false restarts=0`,
          "module_resolution=false",
          "heap_oom=false",
          "startup_failed=false",
          "terminal_database=false",
          "memory_watchdog=false",
          "port_conflict=false",
          "mesh_auth=false",
        ].join("\n");
      }
      if (cmd.includes("tailscale --socket")) {
        if (opts.tailscaleIp instanceof Error) throw opts.tailscaleIp;
        return opts.tailscaleIp;
      }
      throw new Error(`unexpected ssh command: ${cmd}`);
    });
    const getClientSpy = spyOn(DockerSSHClient, "getClient").mockReturnValue({
      exec,
    } as unknown as DockerSSHClient);
    return { exec, getClientSpy };
  }

  // Bridge probes fail on the stale IP and answer 200 on the repaired one —
  // exactly what a restarted container that re-registered under a new IP does.
  function fetchAliveOnlyOnNewIp() {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = fetchUrl(input);
      if (url.includes(NEW_IP)) return new Response("ok", { status: 200 });
      throw new Error(`unreachable: ${url}`);
    });
  }

  function fetchAllDead() {
    globalThis.fetch = mock(async () => {
      throw new Error("unreachable");
    });
  }

  test("(a) heartbeat: docker-healthy + new IP + repaired probe 200 → stays running with repaired columns", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox = staleIpSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, updates) => ({ ...sandbox, ...updates }) as AgentSandbox,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(nodeRecord());
    // tailscale CLI prints the v4 line first; the parser must take the 100.x line.
    const { getClientSpy } = mockNodeSsh({
      health: "healthy",
      tailscaleIp: `${NEW_IP}\nfd7a:115c:a1e0::1\n`,
    });
    fetchAliveOnlyOnNewIp();

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(true);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [id, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(id).toBe(sandbox.id);
      expect(patch.headscale_ip).toBe(NEW_IP);
      expect(patch.bridge_url).toBe(REPAIRED_BRIDGE);
      expect(patch.health_url).toBe(REPAIRED_HEALTH);
      expect(patch.last_heartbeat_at).toBeInstanceOf(Date);
      expect(patch.error_count).toBe(0);
      // The row must NOT be disconnected — the whole point is no reprovision.
      expect(patch.status).toBeUndefined();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      nodeSpy.mockRestore();
      getClientSpy.mockRestore();
    }
  }, 20_000);

  test("(b) heartbeat: docker NOT healthy → disconnected (dead containers still self-heal via reprovision)", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox = staleIpSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(
      undefined as never,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(nodeRecord());
    const { exec, getClientSpy } = mockNodeSsh({ health: "unhealthy", tailscaleIp: NEW_IP });
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    fetchAllDead();

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.status).toBe("disconnected");
      expect(patch.headscale_ip).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        "[agent-sandbox] Heartbeat failed past grace window, marking disconnected",
        expect.objectContaining({
          reconcileOutcome: "container-dead",
          containerRuntimeFailureKind: "unhealthy",
        }),
      );
      // A dead container short-circuits — no IP resolve is attempted on it.
      const tailscaleCalls = exec.mock.calls.filter(([cmd]) =>
        String(cmd).includes("tailscale --socket"),
      );
      expect(tailscaleCalls).toHaveLength(0);
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      nodeSpy.mockRestore();
      getClientSpy.mockRestore();
      warnSpy.mockRestore();
    }
  }, 20_000);

  test("(c) heartbeat: docker-healthy but the resolved IP equals the stored one → genuinely unreachable → disconnected", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox = staleIpSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(
      undefined as never,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(nodeRecord());
    const { getClientSpy } = mockNodeSsh({ health: "healthy", tailscaleIp: OLD_IP });
    fetchAllDead();

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.status).toBe("disconnected");
      expect(patch.headscale_ip).toBeUndefined();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      nodeSpy.mockRestore();
      getClientSpy.mockRestore();
    }
  }, 20_000);

  test("(c2) heartbeat: only repairs a coherent prior tailnet generation", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const invalidGenerations: Partial<AgentSandbox>[] = [
      { headscale_ip: null },
      { health_url: "http://100.64.0.12:3000/api" },
      { health_url: `http://${OLD_IP}:3001/api` },
    ];

    for (const invalidGeneration of invalidGenerations) {
      const sandbox = staleIpSandbox(invalidGeneration);
      const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
        sandbox,
      );
      const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(
        undefined as never,
      );
      const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(nodeRecord());
      const { getClientSpy } = mockNodeSsh({ health: "healthy", tailscaleIp: NEW_IP });
      fetchAliveOnlyOnNewIp();

      try {
        const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
        expect(ok).toBe(false);
        expect(updateSpy).toHaveBeenCalledTimes(1);
        const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
        expect(patch.status).toBe("disconnected");
        expect(patch.headscale_ip).toBeUndefined();
        expect(patch.bridge_url).toBeUndefined();
        expect(patch.health_url).toBeUndefined();
      } finally {
        findSpy.mockRestore();
        updateSpy.mockRestore();
        nodeSpy.mockRestore();
        getClientSpy.mockRestore();
      }
    }
  }, 30_000);

  test("(d) heartbeat: docker-healthy + IP unresolvable guards error_count and escalates to disconnected on the 3rd cycle", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    // error_count evolves across cycles the way the guard writes it.
    let errorCount = 0;
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => staleIpSandbox({ error_count: errorCount }),
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(
      undefined as never,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(nodeRecord());
    const { getClientSpy } = mockNodeSsh({
      health: "healthy",
      tailscaleIp: new Error("docker exec failed: container has no tailscale binary reachable"),
    });
    fetchAllDead();

    try {
      const svc = new ElizaSandboxService();
      // Cycles 1 and 2: still running, error_count guards, NO disconnect.
      for (const expected of [1, 2]) {
        updateSpy.mockClear();
        const ok = await svc.heartbeat(
          "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
          "22222222-2222-4222-8222-222222222222",
        );
        expect(ok).toBe(false);
        expect(updateSpy).toHaveBeenCalledTimes(1);
        const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
        expect(patch.error_count).toBe(expected);
        expect(patch.status).toBeUndefined();
        errorCount = expected;
      }
      // Cycle 3 hits the cap: never keep an unreachable agent running forever.
      updateSpy.mockClear();
      const ok = await svc.heartbeat(
        "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
        "22222222-2222-4222-8222-222222222222",
      );
      expect(ok).toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.status).toBe("disconnected");
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      nodeSpy.mockRestore();
      getClientSpy.mockRestore();
    }
  }, 60_000);

  test("(e) recoverDisconnected: repaired IP + live re-probe → recovered with columns updated, no reprovision", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox = staleIpSandbox({ status: "disconnected" });
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      sandbox,
    );
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockResolvedValue({ ...sandbox, status: "running" });
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(
      undefined as never,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(nodeRecord());
    const { getClientSpy } = mockNodeSsh({ health: "healthy", tailscaleIp: NEW_IP });
    fetchAliveOnlyOnNewIp();

    try {
      const result = await new ElizaSandboxService().recoverDisconnected(
        sandbox.id,
        sandbox.organization_id,
      );
      expect(result).toBe("recovered");
      expect(casSpy).toHaveBeenCalledTimes(1);
      expect(casSpy.mock.calls[0]).toEqual([
        sandbox,
        {
          headscaleIp: NEW_IP,
          bridgeUrl: REPAIRED_BRIDGE,
          healthUrl: REPAIRED_HEALTH,
          errorCount: 0,
        },
      ]);
      // Repaired ingress is part of the same generation CAS. A second generic
      // update could otherwise write A's URL/IP onto a stopped or replaced B.
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      casSpy.mockRestore();
      updateSpy.mockRestore();
      nodeSpy.mockRestore();
      getClientSpy.mockRestore();
    }
  }, 20_000);

  test("(f) recoverDisconnected: repaired IP still dead → unreachable (reprovision path), nothing written", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox = staleIpSandbox({ status: "disconnected" });
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      sandbox,
    );
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockResolvedValue(undefined);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(
      undefined as never,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(nodeRecord());
    const { getClientSpy } = mockNodeSsh({ health: "healthy", tailscaleIp: NEW_IP });
    fetchAllDead();

    try {
      const result = await new ElizaSandboxService().recoverDisconnected(
        sandbox.id,
        sandbox.organization_id,
      );
      // "unreachable" is the caller's contract to reprovision — same as before.
      expect(result).toBe("unreachable");
      expect(casSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      casSpy.mockRestore();
      updateSpy.mockRestore();
      nodeSpy.mockRestore();
      getClientSpy.mockRestore();
    }
  }, 30_000);
});
