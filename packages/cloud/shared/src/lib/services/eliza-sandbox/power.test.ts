/** Exercises sandbox power contracts with explicit database and replacement-authority simulations. Real durable authority is covered separately by the PGlite suites. */

import { describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSandbox, AgentSandboxBackup } from "../../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { type StoredAgentSandboxBackup } from "../../../db/schemas/agent-sandboxes";
import { apiKeysService } from "../api-keys";
import { type SandboxProvider } from "../sandbox-provider-types";
import { SandboxPower } from "./lifecycle/power.js";
import { customSandbox, fetchUrl } from "./test-support/fixtures.js";

/**
 * Covers sandbox lifecycle, state transfer, recovery, and upgrade invariants
 * using deterministic repository and provider fixtures.
 */

import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { encryptField } from "../../../db/crypto/field-crypto";
import { resetKmsClientForTests } from "../../../db/crypto/kms-client";
import * as computeStop from "../agent-compute-stop";
import {
  installSandboxBillingSimulation,
  installSandboxDatabaseSimulation,
  sandboxDirectReads,
  sandboxTransactions,
} from "./test-support/database.js";
import { KMS_TEST_COORDS, KMS_TEST_ORG } from "./test-support/kms.js";
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
describe("ElizaSandboxService wake", () => {
  test.skipIf(process.platform === "win32")(
    "skips missing state restore endpoint for web-only custom images",
    async () => {
      const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
      const now = new Date("2026-06-04T12:05:00.000Z");
      const sleepingSandbox: AgentSandbox = {
        ...customSandbox(),
        status: "sleeping",
        sandbox_id: null,
        bridge_url: null,
        health_url: null,
        node_id: null,
        container_name: null,
        bridge_port: null,
        web_ui_port: null,
        headscale_ip: null,
        updated_at: now,
      };
      const backup: AgentSandboxBackup = {
        id: "11111111-1111-4111-8111-111111111111",
        sandbox_record_id: sleepingSandbox.id,
        snapshot_type: "pre-shutdown",
        state_data: { memories: [], config: {}, workspaceFiles: {} },
        state_data_storage: "inline",
        state_data_key: null,
        size_bytes: 2,
        backup_kind: "full",
        parent_backup_id: null,
        content_hash: null,
        created_at: now,
        verification_status: null,
        verified_at: null,
        verification_error: null,
      };
      // The wake restore-integrity gate (#15603 B6) verifies the STORED row
      // before provision runs; a plaintext inline full backup with no
      // content_hash passes verification for real (legacy-row passthrough).
      const storedBackup: StoredAgentSandboxBackup = {
        ...backup,
        // Explicit nulls: the legacy-verification predicate compares against
        // null, so an absent catalog field would classify the row as
        // catalogue-managed and reject the legacy lane.
        catalog_version: null,
        catalog_state: null,
        state_data: { memories: [], config: {}, workspaceFiles: {} },
      } as StoredAgentSandboxBackup;
      const provider: SandboxProvider = {
        create: mock(async () => ({
          sandboxId: "agent-e06bb509",
          bridgeUrl: "https://runtime.example",
          healthUrl: "https://runtime.example/health",
          metadata: {
            nodeId: "node-1",
            containerName: "agent-e06bb509",
            bridgePort: 21060,
            webUiPort: 3000,
          },
        })),
        stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
        checkHealth: mock(async () => true),
      };
      const requests: string[] = [];
      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        const url = fetchUrl(input);
        requests.push(url);
        if (url === "https://runtime.example/api/agents") {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (url === "https://runtime.example/api/restore") {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        return Response.json({ ok: true });
      });
      const originalFindByIdAndOrg = agentSandboxesRepository.findByIdAndOrg;
      const originalFindByIdAndOrgForWrite = agentSandboxesRepository.findByIdAndOrgForWrite;
      const originalTrySetProvisioning = agentSandboxesRepository.trySetProvisioning;
      const originalGetLatestBackup = agentSandboxesRepository.getLatestBackup;
      const originalGetBackupById = agentSandboxesRepository.getBackupById;
      const originalGetLatestStoredBackup = agentSandboxesRepository.getLatestStoredBackup;
      const originalListBackupMetadata = agentSandboxesRepository.listBackupMetadata;
      const originalStampBackupVerification = agentSandboxesRepository.stampBackupVerification;
      const originalGetReconstructedBackupState =
        agentSandboxesRepository.getReconstructedBackupState;
      agentSandboxesRepository.findByIdAndOrg = mock(async () => sleepingSandbox);
      // executeWake reads from the PRIMARY via getAgentForWrite →
      // findByIdAndOrgForWrite; provision() (called next) reads via
      // findByIdAndOrg. Stub both so neither touches the unmigrated test DB.
      agentSandboxesRepository.findByIdAndOrgForWrite = mock(async () => sleepingSandbox);
      agentSandboxesRepository.trySetProvisioning = mock(async () => ({
        ...sleepingSandbox,
        status: "provisioning",
      }));
      agentSandboxesRepository.getLatestBackup = mock(async () => backup);
      // The wake hands provision the gate-validated backup as an explicit
      // from-backup override, so provision fetches it by id, not "latest".
      agentSandboxesRepository.getBackupById = mock(async () => backup);
      agentSandboxesRepository.getLatestStoredBackup = mock(async () => storedBackup);
      agentSandboxesRepository.listBackupMetadata = mock(async () => [
        {
          id: backup.id,
          sandbox_record_id: backup.sandbox_record_id,
          snapshot_type: backup.snapshot_type,
          state_data_storage: backup.state_data_storage,
          state_data_key: backup.state_data_key,
          size_bytes: backup.size_bytes,
          backup_kind: backup.backup_kind,
          parent_backup_id: backup.parent_backup_id,
          content_hash: backup.content_hash,
          verification_status: backup.verification_status,
          verified_at: backup.verified_at,
          verification_error: backup.verification_error,
          recovery_organization_id: null,
          recovery_agent_id: null,
          recovery_deletion_attempt_id: null,
          recovery_expires_at: null,
          created_at: backup.created_at,
        },
      ]);
      agentSandboxesRepository.stampBackupVerification = mock(async () => {});
      agentSandboxesRepository.getReconstructedBackupState = mock(async () => ({
        memories: [],
        config: {},
        workspaceFiles: {},
      }));
      const createForAgentSpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
        id: "22222222-2222-4222-8222-222222222222",
        plainKey: "eliza_test_agent_key",
        prefix: "eliza_test",
      });
      const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
        async (_id, data) => ({
          ...sleepingSandbox,
          ...data,
          updated_at: now,
        }),
      );
      const gateAuthority = spyOn(
        ElizaSandboxService.prototype as unknown as {
          revalidateContainerBackedLifecycleGeneration: () => Promise<AgentSandbox | undefined>;
        },
        "revalidateContainerBackedLifecycleGeneration",
      ).mockResolvedValue(sleepingSandbox);

      try {
        const result = await new ElizaSandboxService(provider).executeWake(
          sleepingSandbox.id,
          sleepingSandbox.organization_id,
        );

        expect(result).toEqual({
          success: true,
          reprovisioned: true,
          restoredBackupId: backup.id,
        });
        expect(requests).toContain("https://runtime.example/api/restore");
        expect(updateSpy).toHaveBeenCalledWith(
          sleepingSandbox.id,
          expect.objectContaining({ status: "running" }),
        );
      } finally {
        agentSandboxesRepository.findByIdAndOrg = originalFindByIdAndOrg;
        agentSandboxesRepository.findByIdAndOrgForWrite = originalFindByIdAndOrgForWrite;
        agentSandboxesRepository.trySetProvisioning = originalTrySetProvisioning;
        agentSandboxesRepository.getLatestBackup = originalGetLatestBackup;
        agentSandboxesRepository.getBackupById = originalGetBackupById;
        agentSandboxesRepository.getLatestStoredBackup = originalGetLatestStoredBackup;
        agentSandboxesRepository.listBackupMetadata = originalListBackupMetadata;
        agentSandboxesRepository.stampBackupVerification = originalStampBackupVerification;
        agentSandboxesRepository.getReconstructedBackupState = originalGetReconstructedBackupState;
        createForAgentSpy.mockRestore();
        updateSpy.mockRestore();
        gateAuthority.mockRestore();
      }
    },
  );
});

describe("ElizaSandboxService shutdown fails closed without a current capture (#17180 §2)", () => {
  test("a failing pre-stop capture refuses the shutdown and leaves the agent running", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec = customSandbox();
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider);
    const getForWrite = spyOn(
      svc as unknown as { getAgentForWrite: () => Promise<unknown> },
      "getAgentForWrite",
    ).mockResolvedValue(rec);
    const fetchSnap = spyOn(
      svc as unknown as { fetchSnapshotState: () => Promise<never> },
      "fetchSnapshotState",
    ).mockRejectedValue(new Error("snapshot endpoint timed out"));
    try {
      const result = await svc.shutdown(rec.id, rec.organization_id);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Refusing to stop without a current backup");
      expect(result.error).toContain("snapshot endpoint timed out");
      expect(provider.stopForDeletion).not.toHaveBeenCalled();
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
    }
  });

  test("a transient capture refusal is retryable and leaves the agent running", async () => {
    const { ElizaSandboxService, SNAPSHOT_CAPTURE_TRANSIENT } = await import(
      "../eliza-sandbox.ts?actual"
    );
    const rec = customSandbox();
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider);
    const getForWrite = spyOn(
      svc as unknown as { getAgentForWrite: () => Promise<unknown> },
      "getAgentForWrite",
    ).mockResolvedValue(rec);
    const fetchSnap = spyOn(
      svc as unknown as { fetchSnapshotState: () => Promise<never> },
      "fetchSnapshotState",
    ).mockRejectedValue(new Error(SNAPSHOT_CAPTURE_TRANSIENT));
    try {
      await expect(svc.shutdown(rec.id, rec.organization_id)).resolves.toEqual({
        success: false,
        retryable: true,
        error: `Refusing to stop without a current backup: ${SNAPSHOT_CAPTURE_TRANSIENT}`,
      });
      expect(provider.stopForDeletion).not.toHaveBeenCalled();
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
    }
  });

  test("a Shared tier observed under the lifecycle lock cannot stop or write", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const initial: AgentSandbox = {
      ...customSandbox(),
      status: "stopped",
      bridge_url: null,
      health_url: null,
    };
    const locked: AgentSandbox = { ...initial, execution_tier: "shared" };
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    type LockedShutdownService = {
      shutdown(agentId: string, orgId: string): Promise<{ success: boolean; error?: string }>;
      getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
      lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
      getAgentForLifecycleMutation(
        tx: unknown,
        agentId: string,
        orgId: string,
      ): Promise<AgentSandbox | undefined>;
    };
    const service = new ElizaSandboxService(provider) as unknown as LockedShutdownService;
    const primaryRead = spyOn(service, "getAgentForWrite").mockResolvedValue(initial);
    const lockLifecycle = spyOn(service, "lockLifecycle").mockResolvedValue(undefined);
    const lockedRead = spyOn(service, "getAgentForLifecycleMutation").mockResolvedValue(locked);
    let writeCalled = false;
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async () => {
          writeCalled = true;
          return { rows: [] };
        },
      });
    try {
      await expect(service.shutdown(initial.id, initial.organization_id)).resolves.toEqual({
        success: false,
        error: "Agent shutdown requires a container-backed execution tier",
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(writeCalled).toBe(false);
    } finally {
      sandboxTransactions.implementation = null;
      primaryRead.mockRestore();
      lockLifecycle.mockRestore();
      lockedRead.mockRestore();
    }
  });

  test("a capture from generation A cannot be persisted onto or stop generation B that reuses its bridge URL", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const captured: AgentSandbox = {
      ...customSandbox(),
      lifecycle_revision: 41,
      environment_revision: 7,
    };
    const replacement: AgentSandbox = {
      ...captured,
      // Deliberately retain the bridge URL: this is the ABA shape the former
      // URL-only correlation admitted after the remote snapshot returned.
      sandbox_id: "sandbox-generation-b",
      node_id: "node-generation-b",
      container_name: "agent-generation-b",
      environment_revision: 8,
      lifecycle_revision: 42,
    };
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    type ShutdownGenerationService = {
      shutdown(agentId: string, orgId: string): Promise<{ success: boolean; error?: string }>;
      getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
      fetchSnapshotState(rec: AgentSandbox): Promise<{
        stateData: { memories: unknown[]; config: Record<string, unknown>; workspaceFiles: object };
        sizeBytes: number;
        bridgeUrl: string;
      }>;
      lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
      getAgentForLifecycleMutation(
        tx: unknown,
        agentId: string,
        orgId: string,
      ): Promise<AgentSandbox | undefined>;
      persistSnapshotWithinTransaction(...args: unknown[]): Promise<unknown>;
    };
    const service = new ElizaSandboxService(provider) as unknown as ShutdownGenerationService;
    const primaryRead = spyOn(service, "getAgentForWrite").mockResolvedValue(captured);
    const fetchSnapshot = spyOn(service, "fetchSnapshotState").mockResolvedValue({
      stateData: { memories: [], config: {}, workspaceFiles: {} },
      sizeBytes: 2,
      bridgeUrl: captured.bridge_url!,
    });
    const lockLifecycle = spyOn(service, "lockLifecycle").mockResolvedValue(undefined);
    const lockedRead = spyOn(service, "getAgentForLifecycleMutation").mockResolvedValue(
      replacement,
    );
    const persistSnapshot = spyOn(service, "persistSnapshotWithinTransaction");
    const writes: unknown[] = [];
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
      });

    try {
      await expect(service.shutdown(captured.id, captured.organization_id)).resolves.toEqual({
        success: false,
        error:
          "Refusing to stop: the agent's lifecycle generation moved after the pre-stop capture; retry the shutdown.",
      });
      expect(fetchSnapshot).toHaveBeenCalledWith(captured);
      expect(persistSnapshot).not.toHaveBeenCalled();
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
    } finally {
      sandboxTransactions.implementation = null;
      primaryRead.mockRestore();
      fetchSnapshot.mockRestore();
      lockLifecycle.mockRestore();
      lockedRead.mockRestore();
      persistSnapshot.mockRestore();
    }
  });
});

describe("ElizaSandboxService shutdown state-loss-acknowledged override (#18228)", () => {
  function makeProvider(): SandboxProvider {
    return {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
  }

  test("a transfer-hop 500 refusal carries the hop's body, distinguishable from an agent-side capture failure", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec = customSandbox();
    const provider = makeProvider();
    const svc = new ElizaSandboxService(provider);
    const getForWrite = spyOn(
      svc as unknown as { getAgentForWrite: () => Promise<unknown> },
      "getAgentForWrite",
    ).mockResolvedValue(rec);
    // Proxy-hop failure: the agent captured successfully (its handler never
    // ran this response), and the intermediate hop answered with its own
    // error page. The refusal must surface that page so the operator can
    // tell this apart from "agent cannot snapshot".
    const fetchApi = spyOn(
      svc as unknown as { fetchAgentApi: () => Promise<Response> },
      "fetchAgentApi",
    ).mockImplementation(
      async () =>
        new Response("upstream connect error or disconnect before headers", { status: 500 }),
    );
    try {
      const hopResult = await svc.shutdown(rec.id, rec.organization_id);
      expect(hopResult.success).toBe(false);
      expect(hopResult.error).toContain("Snapshot fetch failed: HTTP 500");
      expect(hopResult.error).toContain("upstream connect error");

      // Agent-side failure: the agent's own handler returned its thrown
      // message. Same status, different diagnostic body.
      fetchApi.mockImplementation(
        async () =>
          new Response('{"error":"Snapshot failed: pglite dump write error"}', { status: 500 }),
      );
      const agentResult = await svc.shutdown(rec.id, rec.organization_id);
      expect(agentResult.success).toBe(false);
      expect(agentResult.error).toContain("Snapshot fetch failed: HTTP 500");
      expect(agentResult.error).toContain("pglite dump write error");

      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      fetchApi.mockRestore();
    }
  });

  test("stateLossAcknowledged proceeds to stop without a capture and reports the waiver", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec = customSandbox();
    const provider = makeProvider();
    const svc = new ElizaSandboxService(provider);
    const getForWrite = spyOn(
      svc as unknown as { getAgentForWrite: () => Promise<unknown> },
      "getAgentForWrite",
    ).mockResolvedValue(rec);
    const fetchApi = spyOn(
      svc as unknown as { fetchAgentApi: () => Promise<Response> },
      "fetchAgentApi",
    ).mockImplementation(
      async () =>
        new Response("upstream connect error or disconnect before headers", { status: 500 }),
    );
    const lockLifecycle = spyOn(
      svc as unknown as { lockLifecycle: () => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const getForMutation = spyOn(
      svc as unknown as { getAgentForLifecycleMutation: () => Promise<unknown> },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(rec);
    const activeProvision = spyOn(
      svc as unknown as { hasActiveProvisionJobTx: () => Promise<boolean> },
      "hasActiveProvisionJobTx",
    ).mockResolvedValue(false);
    const persistSnapshot = spyOn(
      svc as unknown as { persistSnapshotWithinTransaction: () => Promise<never> },
      "persistSnapshotWithinTransaction",
    );
    const prune = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(
      undefined as never,
    );
    const writes: unknown[] = [];
    sandboxTransactions.implementation = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
      });
    try {
      const result = await svc.shutdown(rec.id, rec.organization_id, {
        stateLossAcknowledged: true,
      });
      expect(result).toEqual({ success: true, stateLossAcknowledged: true });
      // The stop really happened; the capture was skipped, never persisted.
      expect(provider.stopForReplacement).toHaveBeenCalledWith(rec.sandbox_id);
      expect(persistSnapshot).not.toHaveBeenCalled();
      expect(writes).toHaveLength(1);
    } finally {
      sandboxTransactions.implementation = null;
      getForWrite.mockRestore();
      fetchApi.mockRestore();
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      persistSnapshot.mockRestore();
      prune.mockRestore();
    }
  });

  test("executeRestart threads the waiver into shutdown", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec = customSandbox();
    const svc = new ElizaSandboxService(makeProvider());
    const getForWrite = spyOn(
      svc as unknown as { getAgentForWrite: () => Promise<unknown> },
      "getAgentForWrite",
    ).mockResolvedValue(rec);
    const shutdownSpy = spyOn(SandboxPower.prototype, "shutdown").mockResolvedValue({
      success: true,
      stateLossAcknowledged: true,
    });
    const provisionSpy = spyOn(svc, "provision").mockResolvedValue({
      success: true,
      bridgeUrl: "https://bridge.example",
      healthUrl: "https://bridge.example/health",
    } as never);
    try {
      const res = await svc.executeRestart(rec.id, rec.organization_id, {
        stateLossAcknowledged: true,
      });
      expect(res.success).toBe(true);
      expect(shutdownSpy).toHaveBeenCalledWith(rec.id, rec.organization_id, {
        stateLossAcknowledged: true,
      });
    } finally {
      getForWrite.mockRestore();
      shutdownSpy.mockRestore();
      provisionSpy.mockRestore();
    }
  });
});

describe("ElizaSandboxService sleep refuses an unproven fallback backup (#17180 §3)", () => {
  test("capture failed and the latest stored backup cannot be verified — sleep aborts", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec = customSandbox();
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    globalThis.fetch = mock(async () => {
      throw new Error("snapshot unavailable");
    });
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(rec);
    // Unstamped row whose payload really fails decrypt: a GENUINE envelope
    // encrypted under different AAD coordinates, so the verifier's decrypt
    // (bound to this row's id) raises a real AeadError and the REAL gate
    // classifies it decrypt-failed. (A non-envelope object would pass through
    // decrypt as legacy plaintext; a malformed key id would be an infra throw.)
    resetKmsClientForTests();
    const foreignEnvelope = await encryptField(
      KMS_TEST_ORG,
      '{"memories":[],"config":{},"workspaceFiles":{}}',
      KMS_TEST_COORDS,
    );
    const storedBackup = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue(
      {
        id: "stale-unproven",
        sandbox_record_id: rec.id,
        snapshot_type: "pre-shutdown",
        state_data: {
          kind: "encrypted-agent-backup-state",
          algorithm: "kms-aes-256-gcm",
          ...foreignEnvelope,
        },
        state_data_storage: "inline",
        state_data_key: null,
        backup_kind: "full",
        parent_backup_id: null,
        content_hash: null,
        size_bytes: 2,
        verification_status: null,
        verified_at: null,
        verification_error: null,
        created_at: new Date("2026-01-01T00:00:00.000Z"),
      } as never,
    );
    const stamp = spyOn(agentSandboxesRepository, "stampBackupVerification").mockResolvedValue(
      undefined as never,
    );
    const listMeta = spyOn(agentSandboxesRepository, "listBackupMetadata").mockResolvedValue(
      [] as never,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update");
    const svc = new ElizaSandboxService(provider);
    const authority = spyOn(
      svc as unknown as {
        revalidateContainerBackedLifecycleGeneration: () => Promise<AgentSandbox | undefined>;
      },
      "revalidateContainerBackedLifecycleGeneration",
    ).mockResolvedValue(rec);
    try {
      const result = await svc.executeSleep(rec.id, rec.organization_id);

      expect(result.success).toBe(false);
      expect(result.containerRemoved).toBe(false);
      expect(result.error).toContain("Refusing to stop without a current backup");
      expect(provider.stopForDeletion).not.toHaveBeenCalled();
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      find.mockRestore();
      storedBackup.mockRestore();
      stamp.mockRestore();
      listMeta.mockRestore();
      updateSpy.mockRestore();
      authority.mockRestore();
    }
  });
});

describe("ElizaSandboxService sleep", () => {
  test("aborts deactivation when no durable backup can be created or found", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec = customSandbox();
    const provider: SandboxProvider = {
      create: mock(async () => ({
        sandboxId: "agent-e06bb509",
        bridgeUrl: "https://runtime.example",
        healthUrl: "https://runtime.example/health",
      })),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    globalThis.fetch = mock(async () => {
      throw new Error("snapshot unavailable");
    });
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      rec,
    );
    const latestBackupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    // The gate consults the un-hydrated read; nothing durable exists.
    const storedBackupSpy = spyOn(
      agentSandboxesRepository,
      "getLatestStoredBackup",
    ).mockResolvedValue(undefined);
    const createBackupSpy = spyOn(agentSandboxesRepository, "createBackup");
    const updateSpy = spyOn(agentSandboxesRepository, "update");
    const svc = new ElizaSandboxService(provider);
    const authority = spyOn(
      svc as unknown as {
        revalidateContainerBackedLifecycleGeneration: () => Promise<AgentSandbox | undefined>;
      },
      "revalidateContainerBackedLifecycleGeneration",
    ).mockResolvedValue(rec);

    try {
      const result = await svc.executeSleep(rec.id, rec.organization_id);

      expect(result).toEqual({
        success: false,
        containerRemoved: false,
        error: expect.stringContaining("Refusing to stop without a current backup"),
      });
      expect(provider.stopForDeletion).not.toHaveBeenCalled();
      expect(createBackupSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      latestBackupSpy.mockRestore();
      storedBackupSpy.mockRestore();
      createBackupSpy.mockRestore();
      updateSpy.mockRestore();
      authority.mockRestore();
    }
  });
});

// The daemon handler for the `agent_resume` job. Covers the branch logic the
// piece-wise suites don't: idempotency (an already-running agent is never
// rebuilt), delegation to provision() for a stopped agent, not-found, and
// surfacing a provision failure. Pure spy-based + ?actual import so it stays
// order-independent in the single-process cloud-shared suite. (executeSuspend /
// deleteAgent run inside dbWrite.transaction and are exercised by the live
// provisioning lifecycle in prod.)
describe("ElizaSandboxService.executeResume", () => {
  beforeEach(() => {
    // These legacy orchestration fixtures have no prepaid funding history.
    // Real funded resume and transaction replay run in the PostgreSQL/SSH suite.
    sandboxTransactions.implementation = async (fn) => {
      const tx = {
        execute: async () => ({ rows: [] }),
        select: () => ({
          from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
        }),
      };
      return fn(tx);
    };
  });
  afterEach(() => {
    sandboxTransactions.implementation = null;
  });
  const RESUME_AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const RESUME_ORG = "22222222-2222-4222-8222-222222222222";

  function resumeRow(status: AgentSandbox["status"]): AgentSandbox {
    return {
      ...customSandbox(),
      id: RESUME_AGENT,
      organization_id: RESUME_ORG,
      status,
    };
  }

  test("an already-running agent is a no-op — never re-provisioned", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      resumeRow("running"),
    );
    const provisionSpy = spyOn(svc, "provision");
    try {
      const res = await svc.executeResume(RESUME_AGENT, RESUME_ORG);
      expect(res).toEqual({ success: true, containerStarted: true, reprovisioned: false });
      // Re-provisioning a live agent would needlessly rebuild its container.
      expect(provisionSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  test("a running row with a non-container tier fails before billing or provisioning", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue({
      ...resumeRow("running"),
      execution_tier: "shared",
    });
    billing.settleLifecycleBillingSpy.mockClear();
    const provisionSpy = spyOn(svc, "provision");
    try {
      const res = await svc.executeResume(RESUME_AGENT, RESUME_ORG);
      expect(res).toEqual({
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: "Sandbox provisioning requires an explicit container-backed execution tier",
      });
      expect(billing.settleLifecycleBillingSpy).not.toHaveBeenCalled();
      expect(provisionSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  test("a stopped agent is resumed by delegating to provision()", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      resumeRow("stopped"),
    );
    const provisionSpy = spyOn(svc, "provision").mockResolvedValue({ success: true } as never);
    try {
      const res = await svc.executeResume(RESUME_AGENT, RESUME_ORG);
      expect(res).toEqual({ success: true, containerStarted: true, reprovisioned: true });
      expect(provisionSpy).toHaveBeenCalledTimes(1);
      expect(provisionSpy).toHaveBeenCalledWith(RESUME_AGENT, RESUME_ORG);
    } finally {
      findSpy.mockRestore();
    }
  });

  test("insufficient accrued debt blocks resume before provider provisioning", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      resumeRow("stopped"),
    );
    billing.settleLifecycleBillingSpy.mockResolvedValueOnce({ status: "insufficient_credits" });
    const provisionSpy = spyOn(svc, "provision");
    try {
      const res = await svc.executeResume(RESUME_AGENT, RESUME_ORG);
      expect(res).toMatchObject({
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: "Insufficient credits to settle accrued agent compute charges",
      });
      expect(provisionSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  test("an unknown agent returns not-found without provisioning", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      undefined,
    );
    const provisionSpy = spyOn(svc, "provision");
    try {
      const res = await svc.executeResume(RESUME_AGENT, RESUME_ORG);
      expect(res.success).toBe(false);
      expect(res.error).toBe("Agent not found");
      expect(provisionSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  test("a provision failure during resume is surfaced, not swallowed", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      resumeRow("stopped"),
    );
    const provisionSpy = spyOn(svc, "provision").mockResolvedValue({
      success: false,
      error: "no capacity",
    } as never);
    try {
      const res = await svc.executeResume(RESUME_AGENT, RESUME_ORG);
      expect(res.success).toBe(false);
      expect(res.reprovisioned).toBe(true);
      expect(res.error).toBe("no capacity");
      expect(provisionSpy).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
    }
  });
});

// Lifecycle bring-up (resume / wake / restart) must NOT resurrect a row that an
// agent_delete job already owns. A row in deletion_pending/deletion_failed is
// reported as "Agent not found" so the daemon completes the job as a terminal
// no-op instead of rebuilding a container being torn down.
describe("ElizaSandboxService deletion-state guards (resume/wake/restart)", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const ORG = "22222222-2222-4222-8222-222222222222";

  function row(status: AgentSandbox["status"]): AgentSandbox {
    return { ...customSandbox(), id: AGENT, organization_id: ORG, status };
  }

  for (const status of ["deletion_pending", "deletion_failed"] as const) {
    test(`executeResume bails on ${status} (not-found, no provision)`, async () => {
      const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
      const svc = new ElizaSandboxService();
      const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
        row(status),
      );
      const provisionSpy = spyOn(svc, "provision");
      try {
        const res = await svc.executeResume(AGENT, ORG);
        expect(res.success).toBe(false);
        expect(res.error).toBe("Agent not found");
        expect(provisionSpy).not.toHaveBeenCalled();
      } finally {
        findSpy.mockRestore();
      }
    });

    test(`executeWake bails on ${status} (not-found, no provision)`, async () => {
      const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
      const svc = new ElizaSandboxService();
      const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
        row(status),
      );
      const provisionSpy = spyOn(svc, "provision");
      try {
        const res = await svc.executeWake(AGENT, ORG);
        expect(res.success).toBe(false);
        expect(res.error).toBe("Agent not found");
        expect(provisionSpy).not.toHaveBeenCalled();
      } finally {
        findSpy.mockRestore();
      }
    });

    test(`executeRestart bails on ${status} before shutdown/provision`, async () => {
      const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
      const svc = new ElizaSandboxService();
      const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
        row(status),
      );
      const shutdownSpy = spyOn(SandboxPower.prototype, "shutdown");
      const provisionSpy = spyOn(svc, "provision");
      try {
        const res = await svc.executeRestart(AGENT, ORG);
        expect(res.success).toBe(false);
        expect(res.error).toBe("Agent not found");
        // Critically: never starts the stop+rebuild sequence on a doomed row.
        expect(shutdownSpy).not.toHaveBeenCalled();
        expect(provisionSpy).not.toHaveBeenCalled();
      } finally {
        findSpy.mockRestore();
      }
    });
  }

  test("legacy executeRestart propagates a transient fail-closed snapshot result", async () => {
    const { ElizaSandboxService, SNAPSHOT_CAPTURE_TRANSIENT } = await import(
      "../eliza-sandbox.ts?actual"
    );
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("Transient shutdown must not allocate");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider);
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      row("running"),
    );
    const shutdownSpy = spyOn(SandboxPower.prototype, "shutdown").mockResolvedValue({
      success: false,
      retryable: true,
      error: `Refusing to stop without a current backup: ${SNAPSHOT_CAPTURE_TRANSIENT}`,
    });
    const provisionSpy = spyOn(svc, "provision");
    try {
      const res = await svc.executeRestart(AGENT, ORG);
      expect(res).toMatchObject({
        success: false,
        retryable: true,
        containerStopped: false,
        containerStarted: false,
      });
      expect(provisionSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      shutdownSpy.mockRestore();
      provisionSpy.mockRestore();
    }
  });
});

// executeSuspend's paid-retirement routing must be a funding-STATE decision.
// Settled funding rows persist for the life of the agent, so routing on row
// existence sent every post-funded user suspend into the sleep lifecycle,
// which refuses the two states expiry reconciliation deliberately produces
// (#31312 follow-up): stopped in place without a retirement binding, and
// running with no open window. These fixtures drive the real executeSuspend
// body over the simulated database; funded ownership and settlement remain
// covered by the PostgreSQL/SSH suite.
describe("ElizaSandboxService.executeSuspend retirement routing is funding-state-bound", () => {
  const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";

  function suspendRecord(status: AgentSandbox["status"]): AgentSandbox {
    return { ...customSandbox(), status };
  }

  function stopIntentRow() {
    return {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-000000000002",
      authorization: "user_request",
      status: "pending",
      last_error: null,
      lifecycle_revision: 0,
      attempts: 0,
    };
  }

  function suspendTx(updates: Array<Record<string, unknown>>) {
    const chain = {
      from: () => chain,
      where: () => chain,
      for: () => chain,
      limit: async () => [stopIntentRow()],
    };
    return {
      select: () => chain,
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return { where: async () => undefined };
        },
      }),
      execute: async () => ({ rows: [] }),
    };
  }

  async function suspendHarness(opts: {
    status: AgentSandbox["status"];
    retirementBackupId: string | null;
    fundingRowExists?: boolean;
    sleep?: { success: boolean; containerRemoved: boolean; backupId?: string };
  }) {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec = suspendRecord(opts.status);
    const provider: SandboxProvider = {
      create: mock(async () => ({
        sandboxId: rec.sandbox_id as string,
        bridgeUrl: "https://runtime.example",
        healthUrl: "https://runtime.example/health",
      })),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
      computeFundingCapability: "host-lease-v1",
    };
    const svc = new ElizaSandboxService(provider);
    const updates: Array<Record<string, unknown>> = [];
    sandboxTransactions.implementation = async (fn) =>
      fn(suspendTx(updates) as unknown as Parameters<typeof fn>[0]);
    sandboxDirectReads.select = () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: async () =>
          opts.fundingRowExists === false ? [] : [{ retirementBackupId: opts.retirementBackupId }],
      };
      return chain;
    };
    const spies = [
      spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(rec),
      spyOn(
        svc as unknown as { lockLifecycle: (...args: unknown[]) => Promise<void> },
        "lockLifecycle",
      ).mockResolvedValue(undefined),
      spyOn(
        svc as unknown as {
          getAgentForLifecycleMutation: (...args: unknown[]) => Promise<AgentSandbox>;
        },
        "getAgentForLifecycleMutation",
      ).mockResolvedValue(rec),
      spyOn(
        svc as unknown as { hasActiveProvisionJobTx: (...args: unknown[]) => Promise<boolean> },
        "hasActiveProvisionJobTx",
      ).mockResolvedValue(false),
      spyOn(
        svc as unknown as { getReplacementCleanupLocator: (...args: unknown[]) => unknown },
        "getReplacementCleanupLocator",
      ).mockReturnValue(undefined),
      spyOn(
        svc as unknown as {
          revalidateContainerBackedLifecycleGeneration: (
            ...args: unknown[]
          ) => Promise<AgentSandbox>;
        },
        "revalidateContainerBackedLifecycleGeneration",
      ).mockResolvedValue(rec),
    ];
    const stopForReplacement = spyOn(
      svc as unknown as {
        runBoundedSandboxStopForReplacement: (...args: unknown[]) => Promise<undefined>;
      },
      "runBoundedSandboxStopForReplacement",
    ).mockResolvedValue(undefined);
    const backupGate = spyOn(SandboxPower.prototype, "prepareSuspendBackupGate").mockResolvedValue({
      outcome: "proceed",
      backupId: "cccccccc-cccc-4ccc-8ccc-000000000003",
      capturedFresh: false,
    });
    const sleepSpy = spyOn(
      SandboxPower.prototype as unknown as {
        executeSleepWithStopAuthority: (...args: unknown[]) => Promise<unknown>;
      },
      "executeSleepWithStopAuthority",
    );
    if (opts.sleep) {
      sleepSpy.mockResolvedValue(opts.sleep);
    } else {
      sleepSpy.mockImplementation(async () => {
        throw new Error("suspend was routed into paid retirement");
      });
    }
    return {
      svc,
      rec,
      updates,
      sleepSpy,
      stopForReplacement,
      restore() {
        sandboxTransactions.implementation = null;
        sandboxDirectReads.select = null;
        sleepSpy.mockRestore();
        backupGate.mockRestore();
        stopForReplacement.mockRestore();
        for (const spy of spies) spy.mockRestore();
      },
    };
  }

  test("user suspend of an expiry-stopped, unbacked agent confirms through the stopped fast path", async () => {
    // Settled window, no retirement binding: the state low-level expiry
    // reconciliation leaves behind after stopping unpaid CPU in place.
    const h = await suspendHarness({ status: "stopped", retirementBackupId: null });
    billing.settleLifecycleBillingInTransactionSpy.mockClear();
    try {
      const result = await h.svc.executeSuspend(
        h.rec.id,
        h.rec.organization_id,
        JOB,
        "user_request",
        0,
      );
      expect(result).toEqual({ success: true, containerStopped: true });
      expect(h.sleepSpy).not.toHaveBeenCalled();
      expect(billing.settleLifecycleBillingInTransactionSpy).toHaveBeenCalled();
      expect(h.updates).toContainEqual(expect.objectContaining({ status: "provider_confirmed" }));
    } finally {
      h.restore();
    }
  });

  test("user suspend of a running agent with only settled funding stops in place", async () => {
    const h = await suspendHarness({ status: "running", retirementBackupId: null });
    billing.settleLifecycleBillingInTransactionSpy.mockClear();
    try {
      const result = await h.svc.executeSuspend(
        h.rec.id,
        h.rec.organization_id,
        JOB,
        "user_request",
        0,
      );
      expect(result).toEqual({
        success: true,
        containerStopped: true,
        backupId: "cccccccc-cccc-4ccc-8ccc-000000000003",
      });
      expect(h.sleepSpy).not.toHaveBeenCalled();
      expect(h.stopForReplacement).toHaveBeenCalledWith(h.rec.sandbox_id);
      expect(billing.settleLifecycleBillingInTransactionSpy).toHaveBeenCalled();
      expect(h.updates).toContainEqual(expect.objectContaining({ status: "provider_confirmed" }));
    } finally {
      h.restore();
    }
  });

  test("a stopped agent whose latest window is retirement-bound still routes to paid retirement", async () => {
    const h = await suspendHarness({
      status: "stopped",
      retirementBackupId: "dddddddd-dddd-4ddd-8ddd-000000000004",
      sleep: { success: true, containerRemoved: false, backupId: "b-reclaim" },
    });
    try {
      const result = await h.svc.executeSuspend(
        h.rec.id,
        h.rec.organization_id,
        JOB,
        "user_request",
        0,
      );
      expect(result).toEqual({
        success: true,
        containerStopped: false,
        backupId: "b-reclaim",
      });
      expect(h.sleepSpy).toHaveBeenCalledTimes(1);
      expect(h.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      h.restore();
    }
  });

  test("an open funding window still routes to paid retirement", async () => {
    const h = await suspendHarness({
      status: "running",
      retirementBackupId: null,
      sleep: { success: true, containerRemoved: false, backupId: "b-funded" },
    });
    const funded = computeStop.hasOpenAgentComputeFunding as unknown as {
      mockResolvedValue: (value: boolean) => void;
    };
    const credits = spyOn(
      (await import("../credits")).creditsService,
      "invalidateCreditCaches",
    ).mockResolvedValue(undefined);
    funded.mockResolvedValue(true);
    try {
      const result = await h.svc.executeSuspend(
        h.rec.id,
        h.rec.organization_id,
        JOB,
        "user_request",
        0,
      );
      expect(result).toEqual({
        success: true,
        containerStopped: false,
        backupId: "b-funded",
      });
      expect(h.sleepSpy).toHaveBeenCalledTimes(1);
      expect(h.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      funded.mockResolvedValue(false);
      credits.mockRestore();
      h.restore();
    }
  });
});
