/** Exercises sandbox provision retry contracts with explicit database and replacement-authority simulations. Real durable authority is covered separately by the PGlite suites. */

import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { KeyNotFoundError, orgKey } from "@elizaos/core/security/kms";
import type { AgentSandbox, AgentSandboxBackup } from "../../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { WARM_POOL_ORG_ID, WARM_POOL_USER_ID } from "../../../db/schemas/agent-sandboxes";
import { runWithCloudBindings } from "../../runtime/cloud-bindings";
import { logger } from "../../utils/logger";
import { apiKeysService } from "../api-keys";
import {
  type SandboxProvider,
  SandboxReplacementCleanupUnresolvedError,
} from "../sandbox-provider-types";
import { SandboxProvision } from "./lifecycle/provision.js";
import {
  installSandboxBillingSimulation,
  installSandboxDatabaseSimulation,
} from "./test-support/database.js";
import { customSandbox, fetchUrl } from "./test-support/fixtures.js";
import { realAeadDecryptError } from "./test-support/kms.js";
import { replacementAwareProvider } from "./test-support/provider.js";
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
// LARP H2 — provision() concurrent-create dedup + TOCTOU port-collision retry.
// These drive the REAL provision() body (imported via ?actual) so each guarded
// branch is exercised, not mocked away:
//   1. trySetProvisioning lost the lock but the row is already running+reachable
//      → REUSE the live container (never re-create).
//   2. lock lost AND not running → "already being provisioned", no create.
//   3. provider.create OK but the row-write hits a UNIQUE (port TOCTOU) on the
//      first attempt → ghost stop + retry → second attempt succeeds.
//   4. a NON-unique post-create error → markError + NO retry (one create only).
//   5. all MAX_PROVISION_ATTEMPTS exhausted → "Provisioning failed after 3 attempts"
//      (no "(not retryable)" marker: the last failure was a collision).
// The provider is a plain SandboxProvider fake; the post-create metadata uses a
// real DockerSandboxMetadata shape so isDockerSandboxMetadata() genuinely passes.
describe("ElizaSandboxService.provision dedup + port-collision retry (LARP H2)", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const ORG = "22222222-2222-4222-8222-222222222222";

  // A row whose DB is already provisioned (database_status==="ready") so the
  // provision() DB phase is skipped and control reaches the create/retry loop.
  function provisioningReadyRow(): AgentSandbox {
    return {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      status: "provisioning",
      sandbox_id: null,
      bridge_url: null,
      health_url: null,
      database_uri: "postgres://shared.example/railway",
      database_status: "ready",
      // Custom-tier so the post-create backup-restore HTTP 404 is tolerated and
      // ensureRuntimeAgentStarted's list endpoint is not the gating factor (it
      // is spied to a no-op below regardless).
      execution_tier: "custom",
    };
  }

  // Realistic provider handle: metadata is a genuine DockerSandboxMetadata so
  // isDockerSandboxMetadata(handle.metadata) returns true in the real method.
  function providerHandle() {
    return {
      sandboxId: "sandbox-blue-1",
      bridgeUrl: "https://runtime-blue.example",
      healthUrl: "https://runtime-blue.example/health",
      metadata: {
        provider: "docker" as const,
        nodeId: "node-2",
        hostname: "node-2.internal",
        containerName: "agent-blue-1",
        bridgePort: 21070,
        webUiPort: 23900,
        agentId: AGENT,
        volumePath: "/var/lib/eliza/agent-blue-1",
        dockerImage: "ghcr.io/example/bnancy:latest",
        imageDigest: "sha256:bluebluebluebluebluebluebluebluebluebluebluebluebluebluebluebl01",
      },
    };
  }

  test("(1) lock lost but row already running+reachable → reuse, provider.create NEVER called", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const runningRow: AgentSandbox = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      status: "running",
      bridge_url: "https://live-bridge.example",
      health_url: "https://live-bridge.example/health",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(runningRow);
    // trySetProvisioning returns undefined: someone else holds the lock.
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(
      undefined,
    );
    const create = mock(async () => providerHandle());
    const provider: SandboxProvider = {
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    try {
      const res = await new ElizaSandboxService(provider).provision(AGENT, ORG);
      expect(res.success).toBe(true);
      expect(res.sandboxRecord).toBe(runningRow);
      expect(res.bridgeUrl).toBe("https://live-bridge.example");
      expect(res.healthUrl).toBe("https://live-bridge.example/health");
      // Reusing the live container is the whole point — a second create would
      // double-provision and orphan a container.
      expect(create).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
    }
  });

  test("(2) lock lost AND not running → 'Agent is already being provisioned', no create", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const provisioningRow: AgentSandbox = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      status: "provisioning",
      bridge_url: null,
      health_url: null,
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(
      provisioningRow,
    );
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(
      undefined,
    );
    const create = mock(async () => providerHandle());
    const provider: SandboxProvider = {
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    try {
      const res = await new ElizaSandboxService(provider).provision(AGENT, ORG);
      expect(res.success).toBe(false);
      expect(res.error).toBe("Agent is already being provisioned");
      expect(res.sandboxRecord).toBe(provisioningRow);
      expect(create).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
    }
  });

  test("(3) UNIQUE (port TOCTOU) on attempt 1 → ghost stop + retry → attempt 2 succeeds", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    // The status-write is the row that races on the (node_id, bridge_port)
    // UNIQUE constraint. Fail it with a PG 23505 once, then succeed.
    let statusWrites = 0;
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => {
        if (data.status === "running") {
          statusWrites += 1;
          if (statusWrites === 1) {
            throw new Error('duplicate key value violates unique constraint "23505"');
          }
          return finalRow;
        }
        // Environment-vars persistence write (managedEnvironment.changed) — pass through.
        return { ...row, ...data };
      },
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    // ensureRuntimeAgentStarted hits the runtime over HTTP — no-op it so the
    // retry path under test is the row-write, not the runtime bring-up.
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(true);
      expect(res.sandboxRecord).toBe(finalRow);
      // Two create attempts: the first container became a ghost on the UNIQUE
      // failure and was stopped; the second is the live one.
      expect(create).toHaveBeenCalledTimes(2);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith("sandbox-blue-1");
      expect(statusWrites).toBe(2);
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("same-repo stale docker_image pin is replaced with the configured fleet image on provision", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const configuredImage = "ghcr.io/elizaos/eliza:sha-current";
    const row = {
      ...provisioningReadyRow(),
      docker_image: "ghcr.io/elizaos/eliza:sha-stale",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    const finalRow: AgentSandbox = { ...row, status: "running", docker_image: configuredImage };
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => {
        if (data.status === "running") return finalRow;
        return { ...row, ...data };
      },
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: async () => true,
    } as SandboxProvider);

    try {
      const res = await runWithCloudBindings({ ELIZA_AGENT_IMAGE: configuredImage }, () =>
        svc.provision(AGENT, ORG),
      );
      expect(res.success).toBe(true);
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        dockerImage: configuredImage,
        executionTier: "custom",
      });
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("custom-repo docker_image pin is preserved on provision", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const configuredImage = "ghcr.io/elizaos/eliza:sha-current";
    const customImage = "ghcr.io/example/custom-agent:stable";
    const row = {
      ...provisioningReadyRow(),
      docker_image: customImage,
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => {
        if (data.status === "running") return finalRow;
        return { ...row, ...data };
      },
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: async () => true,
    } as SandboxProvider);

    try {
      const res = await runWithCloudBindings({ ELIZA_AGENT_IMAGE: configuredImage }, () =>
        svc.provision(AGENT, ORG),
      );
      expect(res.success).toBe(true);
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        dockerImage: customImage,
      });
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("(4) a NON-unique post-create error → markError, NO retry (one create), failure", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue({
      ...row,
      status: "error",
    });
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => {
        if (data.status === "running") {
          // A non-retryable write failure (NOT a unique violation).
          throw new Error("connection terminated unexpectedly");
        }
        return { ...row, ...data };
      },
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    let markedMessage = "";
    const markErrorSpy = spyOn(SandboxProvision.prototype, "markError").mockImplementation(
      async (_rec, msg) => {
        markedMessage = msg;
      },
    );
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(false);
      expect(res.error).toBe("connection terminated unexpectedly");
      // A non-unique error is NOT a port collision — must not retry.
      expect(create).toHaveBeenCalledTimes(1);
      // Ghost deletion still runs once for the single failed attempt.
      expect(stop).toHaveBeenCalledTimes(1);
      expect(markErrorSpy).toHaveBeenCalledTimes(1);
      // #22508: the row must record the attempt that was actually made. Naming
      // MAX_PROVISION_ATTEMPTS here made this one-attempt failure look like an
      // exhausted retry budget and sent a live outage down the wrong path.
      expect(markedMessage).toBe(
        "Provisioning failed after 1 attempt (not retryable): connection terminated unexpectedly",
      );
    } finally {
      findSpy.mockRestore();
      findByIdSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      markErrorSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("post-create cleanup failure preserves the original readiness failure", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => ({ ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const create = mock(async () => providerHandle());
    const stopForReplacement = mock(async () => {
      throw new Error("remote absence remains unresolved");
    });
    const svc = new ElizaSandboxService();
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create,
      stopForReplacement,
      checkHealth: async () => false,
    } as SandboxProvider);

    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res).toEqual(
        expect.objectContaining({
          success: false,
          retryable: true,
          error:
            "Sandbox health check timed out; replacement cleanup remains pending: remote absence remains unresolved",
        }),
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(stopForReplacement).toHaveBeenCalledWith("sandbox-blue-1");
    } finally {
      findSpy.mockRestore();
      findByIdSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("(5) UNIQUE on every attempt → exhaustion → 'Provisioning failed after 3 attempts'", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue({
      ...row,
      status: "error",
    });
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    let statusWrites = 0;
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => {
        if (data.status === "running") {
          statusWrites += 1;
          throw new Error("duplicate key value violates unique constraint (port collision)");
        }
        return { ...row, ...data };
      },
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    let markedMessage = "";
    const markErrorSpy = spyOn(SandboxProvision.prototype, "markError").mockImplementation(
      async (_rec, msg) => {
        markedMessage = msg;
      },
    );
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(false);
      // MAX_PROVISION_ATTEMPTS = 3: three creates, three ghost stops, then give up.
      expect(create).toHaveBeenCalledTimes(3);
      expect(stop).toHaveBeenCalledTimes(3);
      expect(statusWrites).toBe(3);
      expect(markedMessage).toContain("Provisioning failed after 3 attempts: ");
    } finally {
      findSpy.mockRestore();
      findByIdSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      markErrorSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  // #10554 finding 2 — free-compute leak. A successful provision MUST re-enter
  // the billable set so a credit-suspended agent that a user tops up + resumes
  // (via the user-facing routes that don't reactivate themselves) cannot run
  // (status='running') permanently excluded from listBillableSandboxes = free
  // dedicated compute. This drives the REAL provision() success path; the writer
  // itself is proven against a real DB in agent-billing-reactivation.test.ts.
  test("(6) a successful provision re-enters the billable set", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    billing.reactivateBillingSpy.mockClear();
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(true);
      expect(res.sandboxRecord).toBe(finalRow);
      // The fix: provision() re-enters billing for the just-provisioned agent.
      expect(billing.reactivateBillingSpy).toHaveBeenCalledTimes(1);
      expect(billing.reactivateBillingSpy).toHaveBeenCalledWith(AGENT, expect.any(Date));
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("a warm-pool provision becomes running only through the final readiness CAS", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const configuredPoolImage = "ghcr.io/elizaos/eliza:stable";
    const targetDigest = `sha256:${"a".repeat(64)}`;
    const handle = {
      ...providerHandle(),
      metadata: {
        ...providerHandle().metadata,
        dockerImage: `ghcr.io/elizaos/eliza@${targetDigest}`,
        imageDigest: targetDigest,
      },
    };
    const row: AgentSandbox = {
      ...provisioningReadyRow(),
      organization_id: WARM_POOL_ORG_ID,
      user_id: WARM_POOL_USER_ID,
      execution_tier: "dedicated-always",
      pool_status: "unclaimed",
      docker_image: configuredPoolImage,
      image_digest: targetDigest,
    };
    const adoptedRow: AgentSandbox = {
      ...row,
      status: "provisioning",
      sandbox_id: handle.sandboxId,
      node_id: handle.metadata.nodeId,
      container_name: handle.metadata.containerName,
      bridge_url: handle.bridgeUrl,
      health_url: handle.healthUrl,
      docker_image: configuredPoolImage,
      image_digest: handle.metadata.imageDigest,
    };
    const readyRow: AgentSandbox = {
      ...adoptedRow,
      status: "running",
      pool_ready_at: new Date("2026-07-30T12:00:00.000Z"),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(row);
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "provisioning" ? adoptedRow : row),
    );
    const commitReadySpy = spyOn(
      agentSandboxesRepository,
      "commitPoolEntryReady",
    ).mockResolvedValue(readyRow);
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const create = mock(async () => handle);
    const provider: SandboxProvider = {
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: async () => true,
    };
    const svc = new ElizaSandboxService(provider);
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);

    try {
      const result = await svc.provision(AGENT, WARM_POOL_ORG_ID);

      expect(result.success).toBe(true);
      expect(result.sandboxRecord).toBe(readyRow);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          dockerImage: `ghcr.io/elizaos/eliza@${targetDigest}`,
        }),
      );
      expect(updateSpy).toHaveBeenCalledWith(
        AGENT,
        expect.objectContaining({
          status: "provisioning",
          docker_image: configuredPoolImage,
          image_digest: targetDigest,
        }),
      );
      expect(updateSpy.mock.calls.some(([, data]) => data.status === "running")).toBe(false);
      expect(commitReadySpy).toHaveBeenCalledTimes(1);
      expect(commitReadySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "provisioning",
          pool_ready_at: null,
          sandbox_id: handle.sandboxId,
          node_id: handle.metadata.nodeId,
          bridge_url: handle.bridgeUrl,
        }),
      );
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      updateSpy.mockRestore();
      commitReadySpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
    }
  });

  test("(7) a provision that never reaches running does NOT re-enter billing", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    // Lock lost AND row not running → bails ("already being provisioned") before
    // the success block, so billing is NOT (re)activated for a non-provisioned agent.
    const provisioningRow: AgentSandbox = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      status: "provisioning",
      bridge_url: null,
      health_url: null,
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(
      provisioningRow,
    );
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(
      undefined,
    );
    const provider: SandboxProvider = {
      create: mock(async () => providerHandle()),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    billing.reactivateBillingSpy.mockClear();
    try {
      const res = await new ElizaSandboxService(provider).provision(AGENT, ORG);
      expect(res.success).toBe(false);
      expect(billing.reactivateBillingSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
    }
  });

  test("(8) status='running' persists BEFORE the backup-restore push (#14038 wake-lag)", async () => {
    // The status column is the reachability gate: the dedicated-agent proxy
    // synthesizes 202 "starting" for every request (including the launcher's
    // /api/status poll) until status='running'. The container serves the moment
    // the health check + runtime-agent start succeed, so the flip must not wait
    // for the (potentially long) state restore — that ordering is exactly the
    // "agent answers in ~8s but launcher says waking for 90s+" prod window.
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const backup: AgentSandboxBackup = {
      id: "33333333-3333-4333-8333-333333333333",
      sandbox_record_id: row.id,
      snapshot_type: "pre-shutdown",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      state_data_key: null,
      size_bytes: 2,
      backup_kind: "full",
      parent_backup_id: null,
      content_hash: null,
      created_at: new Date("2026-06-04T12:05:00.000Z"),
    };
    const order: string[] = [];
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(backup);
    const reconstructedSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: {}, workspaceFiles: {} });
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => {
        if (data.status === "running") order.push("status-running");
        return { ...row, ...data };
      },
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const pushStateSpy = spyOn(
      svc as unknown as { pushState: () => Promise<unknown> },
      "pushState",
    ).mockImplementation(async () => {
      order.push("push-state");
      return null;
    });
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create: mock(async () => providerHandle()),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: async () => true,
    } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(true);
      expect(order).toEqual(["status-running", "push-state"]);
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      reconstructedSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
      pushStateSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("(9) restore failure after the early running-write still ends in markError", async () => {
    // 'running' must never stick on a failed provision: a restore failure takes
    // the same catch as before (ghost cleanup → markError), so the early
    // reachability flip cannot leave a broken agent advertised as running.
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row: AgentSandbox = {
      ...provisioningReadyRow(),
      execution_tier: "dedicated-lazy",
    };
    const backup: AgentSandboxBackup = {
      id: "44444444-4444-4444-8444-444444444444",
      sandbox_record_id: row.id,
      snapshot_type: "pre-shutdown",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      state_data_key: null,
      size_bytes: 2,
      backup_kind: "full",
      parent_backup_id: null,
      content_hash: null,
      created_at: new Date("2026-06-04T12:05:00.000Z"),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue({
      ...row,
      status: "error",
    });
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(backup);
    const reconstructedSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: {}, workspaceFiles: {} });
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(0);
    let runningWrites = 0;
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => {
        if (data.status === "running") runningWrites += 1;
        return { ...row, ...data };
      },
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    const markErrorSpy = spyOn(SandboxProvision.prototype, "markError").mockResolvedValue(
      undefined,
    );
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const pushStateSpy = spyOn(
      svc as unknown as { pushState: () => Promise<unknown> },
      "pushState",
    ).mockRejectedValue(new Error("State restore failed: HTTP 500"));
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create: mock(async () => providerHandle()),
      stop,
      checkHealth: async () => true,
    } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(false);
      expect(res.error).toBe("State restore failed: HTTP 500");
      expect(runningWrites).toBe(1);
      expect(markErrorSpy).toHaveBeenCalledTimes(1);
      // Ghost cleanup still stops the container whose restore failed.
      expect(stop).toHaveBeenCalledWith("sandbox-blue-1");
      // A transient 5xx must NOT be classified as unrecoverable: the snapshot
      // chain stays intact for the retry that may restore it.
      expect(pruneSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      findByIdSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      reconstructedSpy.mockRestore();
      pruneSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      markErrorSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      pushStateSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  // The KMS timebomb (HQ #14308): a provisioning worker misconfigured with the
  // ephemeral `memory` KMS backend rotates its key on every restart, orphaning
  // the pre-upgrade snapshot it wrote — decrypt then throws KeyNotFoundError on
  // resume. That must degrade to a FRESH boot (agent comes up without prior
  // in-memory state), NOT brick the whole provision closed. Drives the REAL
  // provision() body; the thrown error is from the real core KMS
  // KeyNotFoundError.
  test("(10) an orphaned snapshot (KeyNotFoundError on getLatestBackup) degrades to a fresh boot", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    // The org DEK that encrypted the snapshot is gone (memory backend restart).
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockRejectedValue(
      new KeyNotFoundError(orgKey(ORG, "dek"), 1),
    );
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(1);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const errorLogSpy = spyOn(logger, "error").mockImplementation(() => {});
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    // A fresh boot must NOT push any restore state.
    const pushStateSpy = spyOn(
      svc as unknown as { pushState: () => Promise<unknown> },
      "pushState",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      // Fresh boot: the provision SUCCEEDS instead of bricking.
      expect(res.success).toBe(true);
      expect(res.sandboxRecord).toBe(finalRow);
      expect(create).toHaveBeenCalledTimes(1);
      // Orphaned snapshot discarded (never pushed) and its dead chain dropped so
      // the next resume does not re-hit it.
      expect(pushStateSpy).not.toHaveBeenCalled();
      expect(pruneSpy).toHaveBeenCalledWith(AGENT, 0);
      // The degrade is logged with context, never silent.
      const logged = errorLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("Unrecoverable snapshot, booting fresh");
      // A degrade is not a container failure — no ghost cleanup.
      expect(stop).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      pruneSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      errorLogSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      pushStateSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  // The other undecryptable shape: a corrupt / wrong-key snapshot whose AEAD auth
  // tag will not verify surfaces as a real AeadError from reconstruction. Same
  // degrade-to-fresh-boot outcome.
  test("(11) a corrupt snapshot (AeadError on reconstruction) degrades to a fresh boot", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const aeadError = await realAeadDecryptError();
    expect(aeadError.name).toBe("AeadError"); // guard: a genuine crypto failure
    const row = provisioningReadyRow();
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const backup: AgentSandboxBackup = {
      id: "55555555-5555-4555-8555-555555555555",
      sandbox_record_id: row.id,
      snapshot_type: "pre-upgrade",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      state_data_key: null,
      size_bytes: 2,
      backup_kind: "full",
      parent_backup_id: null,
      content_hash: null,
      created_at: new Date("2026-06-04T12:05:00.000Z"),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(backup);
    const reconstructedSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockRejectedValue(aeadError);
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(2);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const errorLogSpy = spyOn(logger, "error").mockImplementation(() => {});
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const pushStateSpy = spyOn(
      svc as unknown as { pushState: () => Promise<unknown> },
      "pushState",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: async () => true,
    } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(true);
      expect(res.sandboxRecord).toBe(finalRow);
      expect(pushStateSpy).not.toHaveBeenCalled();
      expect(pruneSpy).toHaveBeenCalledWith(AGENT, 0);
      const logged = errorLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("Unrecoverable snapshot, booting fresh");
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      reconstructedSpy.mockRestore();
      pruneSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      errorLogSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      pushStateSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  // The load-bearing distinction: a transient (non-crypto) backup-read failure —
  // a DB blip, network hiccup — must NOT be swallowed. Degrading on it would
  // silently discard state a retry would have restored, so it propagates and the
  // provision fails (the resume job then retries).
  test("(12) a transient (non-crypto) backup-read failure propagates — provision fails, snapshot NOT discarded", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue({
      ...row,
      status: "error",
    });
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    // A DB blip, NOT a crypto failure — must NOT degrade.
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockRejectedValue(
      new Error("connection terminated unexpectedly"),
    );
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(0);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => ({ ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const errorLogSpy = spyOn(logger, "error").mockImplementation(() => {});
    const svc = new ElizaSandboxService();
    const markErrorSpy = spyOn(SandboxProvision.prototype, "markError").mockResolvedValue(
      undefined,
    );
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      // A transient failure fails the provision (the resume job retries), rather
      // than silently discarding recoverable state.
      expect(res.success).toBe(false);
      expect(res.error).toBe("connection terminated unexpectedly");
      expect(markErrorSpy).toHaveBeenCalledTimes(1);
      // Must NOT degrade: the snapshot chain is untouched, no degrade logged.
      expect(pruneSpy).not.toHaveBeenCalled();
      const logged = errorLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).not.toContain("Unrecoverable snapshot");
      // Ghost cleanup still stops the just-created container.
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      findByIdSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      pruneSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      errorLogSpy.mockRestore();
      markErrorSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  // The HQ 14308 incident, end to end: the restore push to the new container is
  // rejected 401 Unauthorized (bridge URL routing to a dead/rotated container),
  // which is deterministic on every attempt — retrying only burned the
  // provision attempts and bricked agent 23766030 into status=error
  // ("Provisioning failed after 1 attempt (not retryable): State restore failed: HTTP 401
  // {"error":"Unauthorized"}"). It must instead degrade to a fresh boot on the
  // FIRST detection. Drives the REAL pushState (fetch intercepted with the
  // incident's exact response) so the classified error is the code's own throw
  // shape, not a hand-rolled string.
  test("(13) restore push rejected 401 (dead/rotated container) degrades to a fresh boot on the first attempt", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row: AgentSandbox = { ...provisioningReadyRow(), execution_tier: "dedicated-lazy" };
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const backup: AgentSandboxBackup = {
      id: "66666666-6666-4666-8666-666666666666",
      sandbox_record_id: row.id,
      snapshot_type: "pre-shutdown",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      state_data_key: null,
      size_bytes: 2,
      backup_kind: "full",
      parent_backup_id: null,
      content_hash: null,
      created_at: new Date("2026-06-04T12:05:00.000Z"),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(backup);
    const reconstructedSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: {}, workspaceFiles: {} });
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(1);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const errorLogSpy = spyOn(logger, "error").mockImplementation(() => {});
    const svc = new ElizaSandboxService();
    const markErrorSpy = spyOn(SandboxProvision.prototype, "markError").mockResolvedValue(
      undefined,
    );
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    // REAL pushState: only the fetch layer is intercepted, replaying the
    // incident's exact response, so the thrown error is pushState's own
    // `State restore failed: HTTP 401 {"error":"Unauthorized"}`.
    const restoreCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      restoreCalls.push(fetchUrl(input));
      return new Response('{"error":"Unauthorized"}', { status: 401 });
    }) as typeof fetch;
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      // Fresh boot: the provision SUCCEEDS instead of bricking the agent.
      expect(res.success).toBe(true);
      expect(res.sandboxRecord).toBe(finalRow);
      // The restore POST really went to the new container's bridge.
      expect(restoreCalls).toEqual(["https://runtime-blue.example/api/restore"]);
      // Degrade on FIRST detection: one create, no retry burn, no ghost
      // cleanup of the healthy container, no markError.
      expect(create).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(markErrorSpy).not.toHaveBeenCalled();
      // A 401 is an AUTH failure — RECOVERABLE (#15263), not a permanently-lost
      // snapshot. It degrades to a fresh boot so the agent never bricks, but the
      // backup chain is PRESERVED so a later token-corrected resume can restore
      // it. Pruning here would be silent, permanent data loss (#15274), so the
      // chain-nuking `pruneBackups(agentId, 0)` must NOT fire on this path.
      expect(pruneSpy).not.toHaveBeenCalledWith(AGENT, 0);
      const logged = errorLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("Unrecoverable snapshot, booting fresh");
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      reconstructedSpy.mockRestore();
      pruneSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      errorLogSpy.mockRestore();
      markErrorSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  // A restore-endpoint 404 on a NON-custom tier is equally deterministic (the
  // image will never grow the endpoint mid-provision) — same degrade, via the
  // real pushState throw shape.
  test("(14) restore push rejected 404 on a non-custom tier degrades to a fresh boot", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row: AgentSandbox = { ...provisioningReadyRow(), execution_tier: "dedicated-lazy" };
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const backup: AgentSandboxBackup = {
      id: "77777777-7777-4777-8777-777777777777",
      sandbox_record_id: row.id,
      snapshot_type: "pre-shutdown",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      state_data_key: null,
      size_bytes: 2,
      backup_kind: "full",
      parent_backup_id: null,
      content_hash: null,
      created_at: new Date("2026-06-04T12:05:00.000Z"),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(backup);
    const reconstructedSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: {}, workspaceFiles: {} });
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(1);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const errorLogSpy = spyOn(logger, "error").mockImplementation(() => {});
    const svc = new ElizaSandboxService();
    const markErrorSpy = spyOn(SandboxProvision.prototype, "markError").mockResolvedValue(
      undefined,
    );
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as typeof fetch;
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(true);
      expect(markErrorSpy).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(pruneSpy).toHaveBeenCalledWith(AGENT, 0);
      const logged = errorLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("Unrecoverable snapshot, booting fresh");
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      reconstructedSpy.mockRestore();
      pruneSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      errorLogSpy.mockRestore();
      markErrorSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  // Custom-tier images legitimately lack /api/restore: that 404 stays the
  // designed benign skip — the snapshot is KEPT (no prune) for a future image
  // that has the endpoint. Guards the branch ordering: the skip must win over
  // the unrecoverable degrade.
  test("(15) restore push 404 on a custom tier stays a benign skip — snapshot kept, no degrade", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row = provisioningReadyRow(); // execution_tier: "custom"
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const backup: AgentSandboxBackup = {
      id: "88888888-8888-4888-8888-888888888888",
      sandbox_record_id: row.id,
      snapshot_type: "pre-shutdown",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      state_data_key: null,
      size_bytes: 2,
      backup_kind: "full",
      parent_backup_id: null,
      content_hash: null,
      created_at: new Date("2026-06-04T12:05:00.000Z"),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(backup);
    const reconstructedSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: {}, workspaceFiles: {} });
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(0);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const infoLogSpy = spyOn(logger, "info").mockImplementation(() => {});
    const errorLogSpy = spyOn(logger, "error").mockImplementation(() => {});
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as typeof fetch;
    const create = mock(async () => providerHandle());
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: async () => true,
    } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(true);
      // Benign skip, not a degrade: chain untouched, no error-level log.
      expect(pruneSpy).not.toHaveBeenCalled();
      const info = infoLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(info).toContain("custom image has no restore endpoint");
      const logged = errorLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).not.toContain("Unrecoverable snapshot");
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      reconstructedSpy.mockRestore();
      pruneSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      infoLogSpy.mockRestore();
      errorLogSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("retains a typed replacement failure for the provisioning queue", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue(row);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => ({ ...row, ...data }) as AgentSandbox,
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const meshCause = new Error(
      "Docker candidate cannot complete required Headscale registration: auth_required",
    );
    const unresolved = new SandboxReplacementCleanupUnresolvedError(
      {
        sandboxId: "replacement-sandbox",
        nodeId: "replacement-node",
        containerName: "replacement-container",
        replacementAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        containerId: "sha256:replacement",
        allocationCounted: true,
      },
      meshCause,
    );
    const create = mock(async () => {
      throw unresolved;
    });
    const svc = new ElizaSandboxService();
    const persistFenceSpy = spyOn(
      svc as unknown as {
        persistUnresolvedReplacementCleanupFence(
          agentId: string,
          orgId: string,
          error: SandboxReplacementCleanupUnresolvedError,
        ): Promise<void>;
      },
      "persistUnresolvedReplacementCleanupFence",
    ).mockResolvedValue(undefined);
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue(replacementAwareProvider({ create } as unknown as SandboxProvider));

    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res).toMatchObject({ success: false, retryable: true });
      if (res.success) throw new Error("Expected failed provision result");
      expect(res.failureCause).toBe(unresolved);
      expect(persistFenceSpy).toHaveBeenCalledWith(AGENT, ORG, unresolved);
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      findByIdSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      persistFenceSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("(9) readiness probe transport_unresolved → retryable, container NOT stopped, handle persisted, status stays provisioning (#15310 #6)", async () => {
    // The false-negative split-brain: the post-create readiness probe never
    // reaches the (likely-healthy) container. provision() must NOT tear the
    // container down and NOT markError; it must PERSIST the container handle so
    // the daemon reconciler can find + re-probe the row, and return retryable
    // so the job retries instead of permanently failing.
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue(row);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => ({ ...row, ...data }) as AgentSandbox,
    );
    const stop = mock(async () => {});
    const create = mock(async () => providerHandle());
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue(
      replacementAwareProvider({
        create,
        stop,
        checkHealth: async () => false,
        checkHealthDetailed: async () => ({
          ready: false,
          verdict: "transport_unresolved" as const,
        }),
      } as unknown as SandboxProvider),
    );

    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(false);
      expect((res as { retryable?: boolean }).retryable).toBe(true);
      // The healthy container is NEVER torn down on a transport-unresolved probe.
      expect(stop).not.toHaveBeenCalled();
      // The container handle IS persisted (so the reconciler can find the row),
      // and NO write flips it to `running` (only a confirmed re-probe may).
      const persistWrite = updateSpy.mock.calls.find(
        ([, data]) => (data as { sandbox_id?: string }).sandbox_id === "sandbox-blue-1",
      );
      expect(persistWrite).toBeDefined();
      const flippedRunning = updateSpy.mock.calls.some(
        ([, data]) => (data as { status?: string }).status === "running",
      );
      expect(flippedRunning).toBe(false);
      // Not marked error either.
      const markedError = updateSpy.mock.calls.some(
        ([, data]) => (data as { status?: string }).status === "error",
      );
      expect(markedError).toBe(false);
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      findByIdSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("(9b) transport_unresolved docker handle without node_id fails closed instead of preserving an orphan handle", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue(row);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => ({ ...row, ...data }) as AgentSandbox,
    );
    const stop = mock(async () => {});
    const create = mock(async () => ({
      ...providerHandle(),
      metadata: {
        provider: "docker" as const,
        nodeId: "",
        hostname: "node-2.internal",
        containerName: "agent-blue-1",
      },
    }));
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue(
      replacementAwareProvider({
        create,
        stop,
        checkHealth: async () => false,
        checkHealthDetailed: async () => ({
          ready: false,
          verdict: "transport_unresolved" as const,
        }),
      } as unknown as SandboxProvider),
    );

    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(false);
      expect((res as { retryable?: boolean }).retryable).not.toBe(true);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(
        updateSpy.mock.calls.some(
          ([, data]) => (data as { sandbox_id?: string }).sandbox_id === "sandbox-blue-1",
        ),
      ).toBe(false);
      const errorWrite = updateSpy.mock.calls.find(
        ([, data]) => (data as { status?: string }).status === "error",
      );
      expect(errorWrite).toBeDefined();
      if (!errorWrite) {
        throw new Error("Expected the failed-provision error write");
      }
      expect(String((errorWrite[1] as { error_message?: string }).error_message)).toContain(
        "provision attribution guard:",
      );
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      findByIdSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("(10) retry after transport_unresolved adopts the persisted container instead of re-creating it", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row: AgentSandbox = {
      ...provisioningReadyRow(),
      status: "provisioning",
      sandbox_id: "sandbox-blue-1",
      bridge_url: "https://runtime-blue.example",
      health_url: "https://runtime-blue.example/api/health",
      node_id: "node-blue",
      container_name: "agent-blue-1",
      bridge_port: 3333,
      web_ui_port: 4444,
      headscale_ip: "100.64.0.42",
    };
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(row);
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const healthInputs: Array<{ sandboxId: string }> = [];
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create,
      stop,
      checkHealth: async () => true,
      checkHealthDetailed: async (handle) => {
        healthInputs.push({ sandboxId: handle.sandboxId });
        return { ready: true, verdict: "ready" as const };
      },
    } as unknown as SandboxProvider);

    try {
      const res = await svc.provision(AGENT, ORG);

      expect(res.success).toBe(true);
      expect(create).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(healthInputs).toEqual([{ sandboxId: "sandbox-blue-1" }]);
      const runningWrite = updateSpy.mock.calls.find(
        ([, data]) => (data as { status?: string }).status === "running",
      );
      expect(runningWrite).toBeDefined();
      if (!runningWrite) {
        throw new Error("Expected the adopted sandbox running write");
      }
      expect((runningWrite[1] as { sandbox_id?: string }).sandbox_id).toBe("sandbox-blue-1");
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("(10b) retry adoption refuses persisted docker container without node_id", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row: AgentSandbox = {
      ...provisioningReadyRow(),
      status: "provisioning",
      sandbox_id: "sandbox-blue-1",
      bridge_url: "https://runtime-blue.example",
      health_url: "https://runtime-blue.example/api/health",
      node_id: null,
      container_name: "agent-blue-1",
      bridge_port: 3333,
      web_ui_port: 4444,
      headscale_ip: "100.64.0.42",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(row);
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue(row);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => ({ ...row, ...data }) as AgentSandbox,
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const healthInputs: Array<{ sandboxId: string; metadata?: Record<string, unknown> }> = [];
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue(
      replacementAwareProvider({
        create,
        stop,
        checkHealth: async () => true,
        checkHealthDetailed: async (handle) => {
          healthInputs.push({ sandboxId: handle.sandboxId, metadata: handle.metadata });
          return { ready: true, verdict: "ready" as const };
        },
      } as unknown as SandboxProvider),
    );

    try {
      const res = await svc.provision(AGENT, ORG);

      expect(res.success).toBe(false);
      expect(create).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(healthInputs).toEqual([
        {
          sandboxId: "sandbox-blue-1",
          metadata: {
            provider: "docker",
            nodeId: "",
            hostname: "",
            containerName: "agent-blue-1",
            bridgePort: 3333,
            webUiPort: 4444,
            headscaleIp: "100.64.0.42",
          },
        },
      ]);
      expect(
        updateSpy.mock.calls.some(([, data]) => (data as { status?: string }).status === "running"),
      ).toBe(false);
      const errorWrite = updateSpy.mock.calls.find(
        ([, data]) => (data as { status?: string }).status === "error",
      );
      expect(errorWrite).toBeDefined();
      if (!errorWrite) {
        throw new Error("Expected the invalid-adoption error write");
      }
      expect(String((errorWrite[1] as { error_message?: string }).error_message)).toContain(
        "provision attribution guard:",
      );
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      findByIdSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });
});
