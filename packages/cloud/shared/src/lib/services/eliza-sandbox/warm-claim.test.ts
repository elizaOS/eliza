/** Exercises sandbox warm claim contracts with explicit database and replacement-authority simulations. Real durable authority is covered separately by the PGlite suites. */

import { describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { type SandboxProvider } from "../sandbox-provider-types";
import { SandboxLifecycleAuthority } from "./lifecycle/authority.js";
import { customSandbox } from "./test-support/fixtures.js";

/**
 * Covers sandbox lifecycle, state transfer, recovery, and upgrade invariants
 * using deterministic repository and provider fixtures.
 */

import { afterAll, afterEach, beforeAll } from "bun:test";
import { apiKeysService } from "../api-keys";
import {
  installSandboxBillingSimulation,
  installSandboxDatabaseSimulation,
  sandboxTransactions,
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
describe("failed warm-claim replacement teardown", () => {
  type RetrySvc = {
    provision(agentId: string, orgId: string): Promise<unknown>;
    retireFailedWarmClaimForRetry(
      agentId: string,
      orgId: string,
    ): Promise<{ success: true } | { success: false; error: string }>;
    lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
    getAgentForLifecycleMutation(
      tx: unknown,
      agentId: string,
      orgId: string,
    ): Promise<AgentSandbox | undefined>;
    ensureRuntimeAgentStarted(): Promise<unknown>;
  };

  function failedWarmClaim(): AgentSandbox {
    return {
      ...customSandbox(),
      status: "error",
      claimed_at: new Date("2026-07-23T00:00:00.000Z"),
      warm_claim_credential_state: "failed",
      warm_claim_cleanup_completed_at: new Date("2026-07-23T00:05:00.000Z"),
      sandbox_id: "old-warm-container",
      node_id: "unreachable-node",
      container_name: "old-warm-container",
    };
  }

  test("an unreachable old container preserves the fence and never creates a replacement", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const failed = failedWarmClaim();
    const create = mock(async () => {
      throw new Error("replacement must not be created");
    });
    const stop = mock(async () => {});
    const stopForReplacement = mock(async () => {
      throw new Error("node unreachable; absence unresolved");
    });
    const provider: SandboxProvider = {
      create,
      stop,
      stopForReplacement,
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider) as unknown as RetrySvc;
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(failed);
    const lockLifecycle = spyOn(
      SandboxLifecycleAuthority.prototype,
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const getForMutation = spyOn(
      SandboxLifecycleAuthority.prototype,
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(failed);
    const writes: unknown[] = [];
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
      });

    try {
      const result = (await svc.provision(failed.id, failed.organization_id)) as {
        success: boolean;
        error?: string;
      };
      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: "Failed to retire the previous warm-claim container",
        }),
      );
      expect(stopForReplacement).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
      expect(create).not.toHaveBeenCalled();
    } finally {
      sandboxTransactions.implementation = null;
      find.mockRestore();
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
    }
  });

  test("a partial old locator fails closed before teardown or reset", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const failed = failedWarmClaim();
    const create = mock(async () => {
      throw new Error("replacement must not be created");
    });
    const stopForReplacement = mock(async () => {});
    const provider: SandboxProvider = {
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement,
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider) as unknown as RetrySvc;
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(failed);
    const partial = { ...failed, sandbox_id: null };
    const lockLifecycle = spyOn(
      SandboxLifecycleAuthority.prototype,
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const getForMutation = spyOn(
      SandboxLifecycleAuthority.prototype,
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(partial);
    const writes: unknown[] = [];
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
      });

    try {
      const result = (await svc.provision(failed.id, failed.organization_id)) as {
        success: boolean;
        error?: string;
      };
      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: "Previous warm-claim container locator is incomplete",
        }),
      );
      expect(stopForReplacement).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
      expect(create).not.toHaveBeenCalled();
    } finally {
      sandboxTransactions.implementation = null;
      find.mockRestore();
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
    }
  });

  test("a proven stop resets the exact handle and creates one cold replacement", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const failed = failedWarmClaim();
    const resetRow: AgentSandbox = {
      ...failed,
      status: "stopped",
      claimed_at: null,
      warm_claim_credential_state: null,
      warm_claim_source_pool_id: null,
      warm_claim_key_fingerprint: null,
      warm_claim_attested_at: null,
      warm_claim_attested_environment_revision: null,
      warm_claim_cleanup_completed_at: null,
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
      database_uri: "postgres://shared.example/railway",
      database_status: "ready",
      execution_tier: "custom",
    };
    const finalRow: AgentSandbox = {
      ...resetRow,
      status: "running",
      sandbox_id: "replacement-sandbox",
      node_id: "replacement-node",
      container_name: "replacement-container",
      bridge_url: "https://replacement.example",
      health_url: "https://replacement.example/api",
    };
    const order: string[] = [];
    const stopForReplacement = mock(async () => {
      order.push("strict-stop");
    });
    const create = mock(async () => {
      order.push("create");
      return {
        sandboxId: "replacement-sandbox",
        bridgeUrl: "https://replacement.example",
        healthUrl: "https://replacement.example/api",
        metadata: {
          provider: "docker",
          nodeId: "replacement-node",
          hostname: "replacement.internal",
          containerName: "replacement-container",
          bridgePort: 21070,
          webUiPort: 23900,
          agentId: failed.id,
          volumePath: "/var/lib/eliza/replacement",
          dockerImage: "ghcr.io/elizaos/eliza:sha-current",
          imageDigest: "sha256:replacement",
        },
      };
    });
    const provider: SandboxProvider = {
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement,
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider) as unknown as RetrySvc;
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrg")
      .mockResolvedValueOnce(failed)
      .mockResolvedValue(resetRow);
    const lockLifecycle = spyOn(
      SandboxLifecycleAuthority.prototype,
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const getForMutation = spyOn(
      SandboxLifecycleAuthority.prototype,
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(failed);
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async () => {
          order.push("cas-reset");
          return { rows: [{ id: failed.id }] };
        },
      });
    const lock = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...resetRow,
      status: "provisioning",
    });
    const backup = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(undefined);
    const update = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...resetRow, ...data }),
    );
    const mint = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const ensureStarted = spyOn(svc, "ensureRuntimeAgentStarted").mockResolvedValue(null);

    try {
      const result = (await svc.provision(failed.id, failed.organization_id)) as {
        success: boolean;
        sandboxRecord?: AgentSandbox;
      };
      expect(result.success).toBe(true);
      expect(result.sandboxRecord).toBe(finalRow);
      expect(order).toEqual(["strict-stop", "cas-reset", "create"]);
      expect(stopForReplacement).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      sandboxTransactions.implementation = null;
      find.mockRestore();
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      lock.mockRestore();
      backup.mockRestore();
      update.mockRestore();
      mint.mockRestore();
      ensureStarted.mockRestore();
    }
  });

  test("two failed-claim retries serialize teardown ownership and create one replacement", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const failed = failedWarmClaim();
    const resetRow: AgentSandbox = {
      ...failed,
      status: "stopped",
      claimed_at: null,
      warm_claim_credential_state: null,
      warm_claim_source_pool_id: null,
      warm_claim_key_fingerprint: null,
      warm_claim_attested_at: null,
      warm_claim_attested_environment_revision: null,
      warm_claim_cleanup_completed_at: null,
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
      database_uri: "postgres://shared.example/railway",
      database_status: "ready",
      execution_tier: "custom",
    };
    const finalRow: AgentSandbox = {
      ...resetRow,
      status: "running",
      sandbox_id: "replacement-sandbox",
      node_id: "replacement-node",
      container_name: "replacement-container",
      bridge_url: "https://replacement.example",
      health_url: "https://replacement.example/api",
    };

    let releaseInitialReads!: () => void;
    const bothInitialReads = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    let initialReadCount = 0;
    let lifecycleRow = failed;
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockImplementation(async () => {
      if (initialReadCount < 2) {
        initialReadCount += 1;
        if (initialReadCount === 2) releaseInitialReads();
        await bothInitialReads;
        return failed;
      }
      return lifecycleRow;
    });

    let releaseStrictStop!: () => void;
    const strictStopMayFinish = new Promise<void>((resolve) => {
      releaseStrictStop = resolve;
    });
    let signalStrictStopStarted!: () => void;
    const strictStopStarted = new Promise<void>((resolve) => {
      signalStrictStopStarted = resolve;
    });
    const stopForReplacement = mock(async () => {
      signalStrictStopStarted();
      await strictStopMayFinish;
    });
    const create = mock(async () => ({
      sandboxId: "replacement-sandbox",
      bridgeUrl: "https://replacement.example",
      healthUrl: "https://replacement.example/api",
      metadata: {
        provider: "docker",
        nodeId: "replacement-node",
        hostname: "replacement.internal",
        containerName: "replacement-container",
        bridgePort: 21070,
        webUiPort: 23900,
        agentId: failed.id,
        volumePath: "/var/lib/eliza/replacement",
        dockerImage: "ghcr.io/elizaos/eliza:sha-current",
        imageDigest: "sha256:replacement",
      },
    }));
    const provider: SandboxProvider = {
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement,
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider) as unknown as RetrySvc;
    const lockLifecycle = spyOn(
      SandboxLifecycleAuthority.prototype,
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const getForMutation = spyOn(
      SandboxLifecycleAuthority.prototype,
      "getAgentForLifecycleMutation",
    ).mockImplementation(async () => lifecycleRow);

    let transactionTail = Promise.resolve();
    sandboxTransactions.implementation = async (fn) => {
      const previous = transactionTail;
      let releaseTransaction!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });
      await previous;
      try {
        return await fn({
          execute: async () => {
            lifecycleRow = resetRow;
            return { rows: [{ id: failed.id }] };
          },
        });
      } finally {
        releaseTransaction();
      }
    };

    const setProvisioning = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(
      { ...resetRow, status: "provisioning" },
    );
    const backup = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(undefined);
    const update = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...resetRow, ...data }),
    );
    const mint = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const ensureStarted = spyOn(svc, "ensureRuntimeAgentStarted").mockResolvedValue(null);

    try {
      const first = svc.provision(failed.id, failed.organization_id);
      const second = svc.provision(failed.id, failed.organization_id);
      await strictStopStarted;
      await Promise.resolve();
      releaseStrictStop();
      const results = (await Promise.all([first, second])) as Array<{
        success: boolean;
        error?: string;
      }>;

      expect(results.filter((result) => result.success)).toHaveLength(1);
      expect(results.filter((result) => !result.success)).toEqual([
        expect.objectContaining({
          error: "Warm-claim retry ownership changed before teardown",
        }),
      ]);
      expect(stopForReplacement).toHaveBeenCalledTimes(1);
      expect(stopForReplacement).toHaveBeenCalledWith(failed.sandbox_id);
      expect(create).toHaveBeenCalledTimes(1);
      expect(setProvisioning).toHaveBeenCalledTimes(1);
    } finally {
      sandboxTransactions.implementation = null;
      find.mockRestore();
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      setProvisioning.mockRestore();
      backup.mockRestore();
      update.mockRestore();
      mint.mockRestore();
      ensureStarted.mockRestore();
    }
  });
});
