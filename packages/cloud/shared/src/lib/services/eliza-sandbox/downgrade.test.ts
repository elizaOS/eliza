/** Exercises sandbox downgrade contracts with explicit database and replacement-authority simulations. Real durable authority is covered separately by the PGlite suites. */
import { describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSandbox, AgentSandboxBackup } from "../../../db/repositories/agent-sandboxes";
import type { DockerNode } from "../../../db/repositories/docker-nodes";
import { type SandboxProvider } from "../sandbox-provider-types";
import { customSandbox, fetchUrl, sqlBoundParams } from "./test-support/fixtures.js";
import { replacementAwareProvider } from "./test-support/provider.js";

/**
 * Covers sandbox lifecycle, state transfer, recovery, and upgrade invariants
 * using deterministic repository and provider fixtures.
 */

import { afterAll, afterEach, beforeAll } from "bun:test";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import {
  installSandboxBillingSimulation,
  installSandboxDatabaseSimulation,
  sandboxTransactions,
  UpgradeTx,
} from "./test-support/database.js";
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
// #9964 — executeDowngrade() symmetric blue/green rollback onto the persisted
// previous_image_digest. Mirrors the executeUpgrade harness: a real
// DockerSandboxProvider with spied I/O so `instanceof` holds, a genuine
// DockerSandboxMetadata for blue, and the swap driven through
// sandboxTransactions.implementation + spies on the private lifecycle seams. The pre-upgrade
// restore point and its reconstruction are stubbed on the repository.
describe("ElizaSandboxService.executeDowngrade rollback onto previous_image_digest (#9964)", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const ORG = "22222222-2222-4222-8222-222222222222";
  const OWNER = "33333333-3333-4333-8333-333333333333";
  const DOCKER_IMAGE = "ghcr.io/elizaos/eliza-agent:latest";
  // The agent currently runs on the post-upgrade digest; rollback targets PREV.
  const CURRENT_DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111bbb";
  const PREV_DIGEST = "sha256:0000000000000000000000000000000000000000000000000000000000000aaa";

  // A live fleet agent that HAS a persisted rollback target.
  function upgradedAgentRow(): AgentSandbox {
    return {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      status: "running",
      sandbox_id: "sandbox-cur-1",
      node_id: "node-cur",
      container_name: "agent-cur-1",
      bridge_url: "https://cur-bridge.example",
      health_url: "https://cur-bridge.example/health",
      docker_image: null,
      image_digest: CURRENT_DIGEST,
      previous_image_digest: PREV_DIGEST,
      previous_docker_image: DOCKER_IMAGE,
    };
  }

  function curNode(): DockerNode {
    return {
      node_id: "node-cur",
      hostname: "node-cur.internal",
      ssh_port: 22,
      ssh_user: "root",
      host_key_fingerprint: null,
      allocated_count: 1,
    } as unknown as DockerNode;
  }

  function blueMetadata(imageDigest: string | null, previousVpnNodeId?: string) {
    return {
      provider: "docker" as const,
      nodeId: "node-rb",
      hostname: "node-rb.internal",
      containerName: "agent-rb-1",
      bridgePort: 21090,
      webUiPort: 23960,
      agentId: AGENT,
      volumePath: "/var/lib/eliza/agent-rb-1",
      dockerImage: DOCKER_IMAGE,
      imageDigest,
      ...(previousVpnNodeId ? { previousVpnNodeId } : {}),
    };
  }

  function blueHandle(imageDigest: string | null, previousVpnNodeId?: string) {
    return {
      sandboxId: "sandbox-rb-1",
      bridgeUrl: "https://rb-bridge.example",
      healthUrl: "https://rb-bridge.example/health",
      metadata: blueMetadata(imageDigest, previousVpnNodeId),
    };
  }

  function runtimeStatusResponse(
    body: Record<string, unknown> = {
      state: "running",
      canRespond: true,
      startup: { phase: "running", attempt: 0 },
    },
    status = 200,
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function runtimeHealthResponse(
    body: Record<string, unknown> = {
      ready: true,
      canRespond: true,
      runtime: "ok",
      database: "ok",
      plugins: { loaded: 18, failed: 0 },
      startup: { phase: "running", attempt: 0 },
    },
    status = 200,
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  async function makeDockerProvider(overrides: {
    create: () => Promise<unknown>;
    checkHealth: () => Promise<boolean>;
    runtimeStatus?: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;
    runtimeHealth?: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;
  }) {
    const { DockerSandboxProvider } = await import("../docker-sandbox-provider");
    const provider = new DockerSandboxProvider();
    const create = mock(overrides.create);
    const checkHealth = mock(overrides.checkHealth);
    const stop = mock(async () => {});
    const stopOnSpecificNode = mock(async () => {});
    Object.assign(provider, {
      create,
      checkHealth,
      stop,
      stopOnSpecificNodeForReplacement: stopOnSpecificNode,
    });
    replacementAwareProvider(provider as unknown as SandboxProvider);
    const runtimeFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) =>
      fetchUrl(input).endsWith("/api/status")
        ? await (overrides.runtimeStatus?.(input, init) ?? runtimeStatusResponse())
        : await (overrides.runtimeHealth?.(input, init) ?? runtimeHealthResponse()),
    );
    globalThis.fetch = runtimeFetch as unknown as typeof fetch;
    return {
      provider: provider as unknown as SandboxProvider,
      create,
      checkHealth,
      stop,
      stopOnSpecificNode,
      runtimeFetch,
    };
  }

  afterEach(() => {
    sandboxTransactions.implementation = null;
  });

  async function runAdminCanaryRollback(options: {
    onCutoverInTx: () => Promise<void>;
    failPostCutoverCleanup?: boolean;
    runtimeStatus?: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;
    runtimeHealth?: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;
    environmentVars?: Record<string, string>;
    targetImage?: string;
    targetDigest?: string;
  }) {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const SOURCE_IMAGE = `ghcr.io/elizaos/eliza-demo@${CURRENT_DIGEST}`;
    const TARGET_IMAGE = options.targetImage ?? "ghcr.io/elizaos/eliza:sha-production";
    const TARGET_DIGEST = options.targetDigest ?? PREV_DIGEST;
    const agent: AgentSandbox = {
      ...upgradedAgentRow(),
      docker_image: SOURCE_IMAGE,
      previous_docker_image: TARGET_IMAGE,
      ...(options.environmentVars ? { environment_vars: options.environmentVars } : {}),
    };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(curNode());
    const backup = {
      id: "backup-admin-canary-adversarial",
      sandbox_record_id: AGENT,
      snapshot_type: "pre-upgrade",
    } as unknown as AgentSandboxBackup;
    const byTypeSpy = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue(
      backup,
    );
    const reconstructSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: {}, workspaceFiles: {} });
    const lifecycleEvents: string[] = [];
    const { provider, stop, stopOnSpecificNode, runtimeFetch } = await makeDockerProvider({
      create: async () =>
        blueHandle(TARGET_DIGEST, options.failPostCutoverCleanup ? "vpn-old-rollback" : undefined),
      checkHealth: async () => true,
      runtimeStatus: async (input, init) => {
        lifecycleEvents.push("status");
        return options.runtimeStatus
          ? await options.runtimeStatus(input, init)
          : runtimeStatusResponse();
      },
      runtimeHealth: async (input, init) => {
        lifecycleEvents.push("health");
        return options.runtimeHealth
          ? await options.runtimeHealth(input, init)
          : runtimeHealthResponse();
      },
    });
    if (options.failPostCutoverCleanup) {
      stopOnSpecificNode.mockImplementation(async () => {
        throw new Error("rollback old-container teardown unavailable");
      });
    }
    const svc = new ElizaSandboxService(provider);
    const pushSpy = spyOn(
      svc as unknown as { pushState: (...a: unknown[]) => Promise<void> },
      "pushState",
    ).mockImplementation(async () => {
      lifecycleEvents.push("restore");
    });
    const lockSpy = spyOn(
      svc as unknown as { lockLifecycle: (...a: unknown[]) => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const readSpy = spyOn(
      svc as unknown as {
        getAgentForLifecycleMutation: (...a: unknown[]) => Promise<AgentSandbox | undefined>;
      },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(agent);
    let transactionCalled = false;
    sandboxTransactions.implementation = async (fn) => {
      transactionCalled = true;
      lifecycleEvents.push("swap");
      const tx: UpgradeTx = {
        execute: async () => ({ rows: [{ id: AGENT }] }),
      };
      return fn(tx);
    };
    try {
      const result = await svc.executeAdminCanaryRollback({
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: OWNER,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: CURRENT_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TARGET_DIGEST,
        onCutoverInTx: options.onCutoverInTx,
        onConvergedInTx: async () => {},
      });
      return {
        result,
        stop,
        stopOnSpecificNode,
        runtimeFetch,
        lifecycleEvents,
        transactionCalled,
        pushCalls: pushSpy.mock.calls.length,
      };
    } finally {
      primarySpy.mockRestore();
      nodeSpy.mockRestore();
      byTypeSpy.mockRestore();
      reconstructSpy.mockRestore();
      pushSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
    }
  }

  test("no previous_image_digest → refuses, never touches the live agent", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const agent: AgentSandbox = { ...upgradedAgentRow(), previous_image_digest: null };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const { provider, create } = await makeDockerProvider({
      create: async () => blueHandle(PREV_DIGEST),
      checkHealth: async () => true,
    });
    try {
      const res = await new ElizaSandboxService(provider).executeDowngrade(
        AGENT,
        ORG,
        DOCKER_IMAGE,
        CURRENT_DIGEST,
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain("nothing to roll back to");
      // No blue is ever provisioned — there is no rollback target.
      expect(create).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  const rollbackRuntimeHealthFailures: Array<{
    name: string;
    response: () => Response;
    expectedError: string;
  }> = [
    {
      name: "rejects a 503",
      response: () => runtimeHealthResponse({ error: "Unavailable" }, 503),
      expectedError: "/api/health returned HTTP 503",
    },
    {
      name: "rejects malformed JSON",
      response: () =>
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      expectedError: "/api/health returned malformed JSON",
    },
    {
      name: "rejects a runtime that cannot respond",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          canRespond: false,
          runtime: "ok",
          database: "ok",
          plugins: { loaded: 18, failed: 0 },
          startup: { phase: "running", attempt: 0 },
        }),
      expectedError: "canRespond=false",
    },
    {
      name: "rejects a missing plugins structure",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          runtime: "ok",
          database: "ok",
          startup: { phase: "running", attempt: 0 },
        }),
      expectedError: "plugins=missing",
    },
    {
      name: "rejects a missing startup structure",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          runtime: "ok",
          database: "ok",
          plugins: { loaded: 18, failed: 0 },
        }),
      expectedError: "startup=missing",
    },
    {
      name: "rejects malformed plugin counters",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          runtime: "ok",
          database: "ok",
          plugins: { loaded: "18", failed: "0" },
          startup: { phase: "running", attempt: 0 },
        }),
      expectedError: "plugins.loaded=18",
    },
    {
      name: "rejects a runtime with no loaded plugins",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          runtime: "ok",
          database: "ok",
          plugins: { loaded: 0, failed: 0 },
          startup: { phase: "running", attempt: 0 },
        }),
      expectedError: "plugins.loaded=0",
    },
    {
      name: "rejects plugin load failures",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          runtime: "ok",
          database: "ok",
          plugins: { loaded: 17, failed: 1 },
          startup: { phase: "running", attempt: 0 },
        }),
      expectedError: "plugins.failed=1",
    },
    {
      name: "rejects database failures",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          runtime: "ok",
          database: "terminal_error",
          plugins: { loaded: 18, failed: 0 },
          startup: { phase: "running", attempt: 0 },
        }),
      expectedError: "database=terminal_error",
    },
    {
      name: "rejects startup failures",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          runtime: "ok",
          database: "ok",
          plugins: { loaded: 18, failed: 0 },
          startup: { phase: "error", attempt: 1, lastError: "migration failed" },
        }),
      expectedError: "startup.phase=error",
    },
  ];

  const rollbackRuntimeStatusFailures: Array<{
    name: string;
    response: () => Response;
    expectedError: string;
  }> = [
    {
      name: "rejects malformed JSON",
      response: () =>
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      expectedError: "/api/status returned malformed JSON",
    },
    {
      name: "rejects a non-running runtime",
      response: () =>
        runtimeStatusResponse({
          state: "starting",
          canRespond: true,
          startup: { phase: "starting", attempt: 1 },
        }),
      expectedError: "state=starting",
    },
    {
      name: "rejects a runtime that cannot respond",
      response: () =>
        runtimeStatusResponse({
          state: "running",
          canRespond: false,
          startup: { phase: "running", attempt: 0 },
        }),
      expectedError: "canRespond=false",
    },
    {
      name: "rejects missing startup state",
      response: () => runtimeStatusResponse({ state: "running" }),
      expectedError: "startup=missing",
    },
  ];

  for (const scenario of rollbackRuntimeStatusFailures) {
    test(`pre-restore protected status gate ${scenario.name} before public health`, async () => {
      const audit = mock(() => Promise.resolve());
      const {
        result,
        stop,
        stopOnSpecificNode,
        runtimeFetch,
        lifecycleEvents,
        transactionCalled,
        pushCalls,
      } = await runAdminCanaryRollback({
        onCutoverInTx: audit,
        runtimeStatus: async () => scenario.response(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Blue runtime readiness gate failed before state restore");
      expect(result.error).toContain(scenario.expectedError);
      expect(pushCalls).toBe(0);
      expect(runtimeFetch.mock.calls.map((call) => fetchUrl(call[0]))).toEqual([
        "https://rb-bridge.example/api/status",
      ]);
      expect(lifecycleEvents).toEqual(["status"]);
      expect(transactionCalled).toBe(false);
      expect(audit).not.toHaveBeenCalled();
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
    });
  }

  test("pre-restore protected status gate rejects 401 before public health or state mutation", async () => {
    const audit = mock(() => Promise.resolve());
    const {
      result,
      stop,
      stopOnSpecificNode,
      runtimeFetch,
      lifecycleEvents,
      transactionCalled,
      pushCalls,
    } = await runAdminCanaryRollback({
      onCutoverInTx: audit,
      runtimeStatus: async () => runtimeStatusResponse({ error: "Unauthorized" }, 401),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Blue runtime readiness gate failed before state restore");
    expect(result.error).toContain("/api/status returned HTTP 401");
    expect(result.oldNodeId).toBe("node-cur");
    expect(result.oldContainerName).toBe("agent-cur-1");
    expect(pushCalls).toBe(0);
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    expect(fetchUrl(runtimeFetch.mock.calls[0]![0])).toBe("https://rb-bridge.example/api/status");
    expect(new Headers(runtimeFetch.mock.calls[0]![1]?.headers).get("authorization")).toBe(
      "Bearer agent-token",
    );
    expect(lifecycleEvents).toEqual(["status"]);
    expect(transactionCalled).toBe(false);
    expect(audit).not.toHaveBeenCalled();
    expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
    expect(stopOnSpecificNode).toHaveBeenCalledWith(
      "node-rb",
      "agent-rb-1",
      null,
      expect.objectContaining({
        replacementAttemptId: expect.any(String),
        containerId: "container-sandbox-rb-1",
      }),
    );
    expect(stop).not.toHaveBeenCalled();
  });

  test("pre-restore runtime gate refuses an unauthenticated request when the API token is absent", async () => {
    const audit = mock(() => Promise.resolve());
    const {
      result,
      stop,
      stopOnSpecificNode,
      runtimeFetch,
      lifecycleEvents,
      transactionCalled,
      pushCalls,
    } = await runAdminCanaryRollback({
      onCutoverInTx: audit,
      environmentVars: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("agent API token is unavailable");
    expect(pushCalls).toBe(0);
    expect(runtimeFetch).not.toHaveBeenCalled();
    expect(lifecycleEvents).toEqual([]);
    expect(transactionCalled).toBe(false);
    expect(audit).not.toHaveBeenCalled();
    expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
    expect(stopOnSpecificNode).toHaveBeenCalledWith(
      "node-rb",
      "agent-rb-1",
      null,
      expect.objectContaining({
        replacementAttemptId: expect.any(String),
        containerId: "container-sandbox-rb-1",
      }),
    );
    expect(stop).not.toHaveBeenCalled();
  });

  test("post-restore protected status gate rejects a lost authorization before public health or swap", async () => {
    const audit = mock(() => Promise.resolve());
    let statusAttempt = 0;
    const {
      result,
      stop,
      stopOnSpecificNode,
      runtimeFetch,
      lifecycleEvents,
      transactionCalled,
      pushCalls,
    } = await runAdminCanaryRollback({
      onCutoverInTx: audit,
      runtimeStatus: async () => {
        statusAttempt += 1;
        return statusAttempt === 1
          ? runtimeStatusResponse()
          : runtimeStatusResponse({ error: "Unauthorized" }, 401);
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Blue runtime readiness gate failed after state restore");
    expect(result.error).toContain("/api/status returned HTTP 401");
    expect(result.oldNodeId).toBe("node-cur");
    expect(result.oldContainerName).toBe("agent-cur-1");
    expect(pushCalls).toBe(1);
    expect(runtimeFetch.mock.calls.map((call) => fetchUrl(call[0]))).toEqual([
      "https://rb-bridge.example/api/status",
      "https://rb-bridge.example/api/health",
      "https://rb-bridge.example/api/status",
    ]);
    for (const call of runtimeFetch.mock.calls) {
      expect(new Headers(call[1]?.headers).get("authorization")).toBe("Bearer agent-token");
    }
    expect(lifecycleEvents).toEqual(["status", "health", "restore", "status"]);
    expect(transactionCalled).toBe(false);
    expect(audit).not.toHaveBeenCalled();
    expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
    expect(stopOnSpecificNode).toHaveBeenCalledWith(
      "node-rb",
      "agent-rb-1",
      null,
      expect.objectContaining({
        replacementAttemptId: expect.any(String),
        containerId: "container-sandbox-rb-1",
      }),
    );
    expect(stop).not.toHaveBeenCalled();
  });

  for (const scenario of rollbackRuntimeHealthFailures) {
    test(`post-restore runtime gate ${scenario.name}, preserves current primary, and retires blue`, async () => {
      const audit = mock(() => Promise.resolve());
      let healthAttempt = 0;
      const {
        result,
        stop,
        stopOnSpecificNode,
        runtimeFetch,
        lifecycleEvents,
        transactionCalled,
        pushCalls,
      } = await runAdminCanaryRollback({
        onCutoverInTx: audit,
        runtimeHealth: async () => {
          healthAttempt += 1;
          return healthAttempt === 1 ? runtimeHealthResponse() : scenario.response();
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Blue runtime readiness gate failed after state restore");
      expect(result.error).toContain(scenario.expectedError);
      expect(result.oldNodeId).toBe("node-cur");
      expect(result.oldContainerName).toBe("agent-cur-1");
      expect(pushCalls).toBe(1);
      expect(runtimeFetch.mock.calls.map((call) => fetchUrl(call[0]))).toEqual([
        "https://rb-bridge.example/api/status",
        "https://rb-bridge.example/api/health",
        "https://rb-bridge.example/api/status",
        "https://rb-bridge.example/api/health",
      ]);
      for (const call of runtimeFetch.mock.calls) {
        const healthHeaders = new Headers((call[1] as RequestInit | undefined)?.headers);
        expect(healthHeaders.get("authorization")).toBe("Bearer agent-token");
        expect(healthHeaders.get("x-api-key")).toBe("agent-token");
        expect(healthHeaders.get("x-eliza-token")).toBe("agent-token");
      }
      expect(lifecycleEvents).toEqual(["status", "health", "restore", "status", "health"]);
      expect(transactionCalled).toBe(false);
      expect(audit).not.toHaveBeenCalled();
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-rb",
        "agent-rb-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-rb-1",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
    });
  }

  test("rollback forces a stored direct-relay opt-in off while restoring the pre-upgrade snapshot", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const upgradedAgent: AgentSandbox = {
      ...upgradedAgentRow(),
      execution_tier: "dedicated-always",
    };
    const agent: AgentSandbox = {
      ...upgradedAgent,
      previous_docker_image: "",
      environment_vars: {
        ...(upgradedAgent.environment_vars as Record<string, string>),
        ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
      },
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(curNode());
    // The pre-upgrade restore point + its reconstruction.
    const preUpgradeBackup = {
      id: "backup-preupgrade-1",
      sandbox_record_id: AGENT,
      snapshot_type: "pre-upgrade",
    } as unknown as AgentSandboxBackup;
    const byTypeSpy = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue(
      preUpgradeBackup,
    );
    const reconstructSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: { restored: true }, workspaceFiles: {} });
    const { provider, create, checkHealth, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(PREV_DIGEST),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
    // The pre-cutover state push lands on blue's /api/restore — stub the private
    // pushState so the test stays offline; assert it received blue's bridge URL.
    const pushSpy = spyOn(
      svc as unknown as { pushState: (...a: unknown[]) => Promise<void> },
      "pushState",
    ).mockResolvedValue(undefined);
    const lockSpy = spyOn(
      svc as unknown as { lockLifecycle: (...a: unknown[]) => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const readSpy = spyOn(
      svc as unknown as {
        getAgentForLifecycleMutation: (...a: unknown[]) => Promise<AgentSandbox | undefined>;
      },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(agent);
    let executedSql: unknown;
    sandboxTransactions.implementation = async (fn) => {
      const tx: UpgradeTx = {
        execute: async (query: unknown) => {
          executedSql = query;
          return { rows: [{ id: AGENT }] };
        },
      };
      return fn(tx);
    };
    try {
      const res = await svc.executeDowngrade(AGENT, ORG, DOCKER_IMAGE, CURRENT_DIGEST);
      expect(res.success).toBe(true);
      expect(res.newNodeId).toBe("node-rb");
      expect(res.newContainerName).toBe("agent-rb-1");
      // Rolls the agent back ONTO the prior digest.
      expect(res.newDigest).toBe(PREV_DIGEST);
      // The pre-upgrade snapshot was looked up and reconstructed before cutover.
      expect(byTypeSpy).toHaveBeenCalledWith(AGENT, "pre-upgrade");
      expect(reconstructSpy).toHaveBeenCalledWith("backup-preupgrade-1");
      // ...and pushed onto BLUE (the rollback container) before the swap.
      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(pushSpy.mock.calls[0]?.[0]).toBe("https://rb-bridge.example");
      // The swap binds blue's identity + PREV_DIGEST and NULLs the prior columns.
      const params = sqlBoundParams(executedSql);
      expect(params).toContain("sandbox-rb-1");
      expect(params).toContain("node-rb");
      expect(params).toContain(PREV_DIGEST); // image_digest := previous
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        dockerImage: `ghcr.io/elizaos/eliza-agent@${PREV_DIGEST}`,
        executionTier: "dedicated-always",
        environmentVars: {
          ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
        },
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledTimes(1);
      // The old (post-upgrade) container is torn down; blue stays.
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      byTypeSpy.mockRestore();
      reconstructSpy.mockRestore();
      pushSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  test("admin canary rollback restores and atomically returns to the exact canonical pair", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const SOURCE_IMAGE = `ghcr.io/elizaos/eliza-demo@${CURRENT_DIGEST}`;
    const TARGET_IMAGE = "ghcr.io/elizaos/eliza:sha-production";
    const agent: AgentSandbox = {
      ...upgradedAgentRow(),
      docker_image: SOURCE_IMAGE,
      previous_docker_image: TARGET_IMAGE,
      execution_tier: "dedicated-lazy",
    };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const replicaSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(agent);
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(curNode());
    const backup = {
      id: "backup-admin-canary",
      sandbox_record_id: AGENT,
      snapshot_type: "pre-upgrade",
    } as unknown as AgentSandboxBackup;
    const byTypeSpy = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue(
      backup,
    );
    const reconstructSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: {}, workspaceFiles: {} });
    const { provider, create } = await makeDockerProvider({
      create: async () => blueHandle(PREV_DIGEST),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
    const pushSpy = spyOn(
      svc as unknown as { pushState: (...a: unknown[]) => Promise<void> },
      "pushState",
    ).mockResolvedValue(undefined);
    const lockSpy = spyOn(
      svc as unknown as { lockLifecycle: (...a: unknown[]) => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const readSpy = spyOn(
      svc as unknown as {
        getAgentForLifecycleMutation: (...a: unknown[]) => Promise<AgentSandbox | undefined>;
      },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(agent);
    let executedSql: unknown;
    sandboxTransactions.implementation = async (fn) => {
      const tx: UpgradeTx = {
        execute: async (query: unknown) => {
          executedSql = query;
          return { rows: [{ id: AGENT }] };
        },
      };
      return fn(tx);
    };
    try {
      const result = await svc.executeAdminCanaryRollback({
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: OWNER,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: CURRENT_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: PREV_DIGEST,
        onCutoverInTx: async () => {},
        onConvergedInTx: async () => {},
      });
      expect(result.success).toBe(true);
      expect(primarySpy).toHaveBeenCalledTimes(1);
      expect(replicaSpy).not.toHaveBeenCalled();
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        dockerImage: `ghcr.io/elizaos/eliza@${PREV_DIGEST}`,
        executionTier: "dedicated-lazy",
      });
      const params = sqlBoundParams(executedSql);
      expect(params).toContain(TARGET_IMAGE);
      expect(params).toContain(PREV_DIGEST);
      expect(params).toContain(SOURCE_IMAGE);
      expect(params).toContain(CURRENT_DIGEST);
    } finally {
      primarySpy.mockRestore();
      replicaSpy.mockRestore();
      nodeSpy.mockRestore();
      byTypeSpy.mockRestore();
      reconstructSpy.mockRestore();
      pushSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  test("admin canary rollback audit failure preserves demo and tears down blue", async () => {
    const audit = mock(async () => {
      throw new Error("durable rollback audit write failed");
    });
    const { result, stop, stopOnSpecificNode } = await runAdminCanaryRollback({
      onCutoverInTx: audit,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("durable rollback audit write failed");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(stopOnSpecificNode).toHaveBeenCalledWith(
      "node-rb",
      "agent-rb-1",
      null,
      expect.objectContaining({
        replacementAttemptId: expect.any(String),
        containerId: "container-sandbox-rb-1",
      }),
    );
    expect(stop).not.toHaveBeenCalled();
  });

  test("admin canary rollback remains successful when post-cutover cleanup fails", async () => {
    const audit = mock(() => Promise.resolve());
    const {
      result,
      stop,
      stopOnSpecificNode,
      runtimeFetch,
      lifecycleEvents,
      transactionCalled,
      pushCalls,
    } = await runAdminCanaryRollback({
      onCutoverInTx: audit,
      failPostCutoverCleanup: true,
    });
    expect(result.success).toBe(true);
    expect(result.cleanupPending).toBe(true);
    expect(pushCalls).toBe(1);
    expect(runtimeFetch.mock.calls.map((call) => fetchUrl(call[0]))).toEqual([
      "https://rb-bridge.example/api/status",
      "https://rb-bridge.example/api/health",
      "https://rb-bridge.example/api/status",
      "https://rb-bridge.example/api/health",
    ]);
    expect(lifecycleEvents).toEqual(["status", "health", "restore", "status", "health", "swap"]);
    expect(transactionCalled).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
    expect(stopOnSpecificNode).toHaveBeenCalledWith(
      "node-cur",
      "agent-cur-1",
      "vpn-old-rollback",
      expect.objectContaining({
        replacementAttemptId: null,
        previousVpnNodeId: null,
      }),
    );
    expect(stop).not.toHaveBeenCalled();
  });

  test("admin canary rollback restores an immutable demo target from a prior canary", async () => {
    const targetImage = `ghcr.io/elizaos/eliza-demo@${PREV_DIGEST}`;
    const { result, transactionCalled } = await runAdminCanaryRollback({
      onCutoverInTx: async () => {},
      targetImage,
      targetDigest: PREV_DIGEST,
    });

    expect(result.success).toBe(true);
    expect(transactionCalled).toBe(true);
  });
});
