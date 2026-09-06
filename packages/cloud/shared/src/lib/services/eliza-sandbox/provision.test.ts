/** Exercises sandbox provision contracts with explicit database and replacement-authority simulations. Real durable authority is covered separately by the PGlite suites. */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSandbox, AgentSandboxBackup } from "../../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { CONTAINER_BACKED_EXECUTION_TIERS } from "../../../db/schemas/agent-sandboxes";
import { apiKeysService } from "../api-keys";
import { type SandboxHandle, type SandboxProvider } from "../sandbox-provider-types";
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
// The from-backup override contract (#15603 B6), exercised through the REAL
// provision() restore step: an explicitly-requested backup must NEVER degrade
// to a fresh boot or prune the chain — the provision fails (retryable by the
// wake job) with every backup intact. Repository reads/writes are stubbed at
// the seam and the provider/runtime fetches are fakes, but the restore errors
// are genuine (real AEAD decrypt failure, real HTTP restore rejection) and the
// code under test is provision()'s own catch ladder, not a stand-in.
describe("ElizaSandboxService provision — from-backup override (#15603 B6)", () => {
  const FROM_BACKUP_ID = "44444444-4444-4444-8444-444444444444";

  function sleepingSandboxRec(): AgentSandbox {
    return {
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
    };
  }

  function backupRow(sandboxRecordId: string): AgentSandboxBackup {
    return {
      id: FROM_BACKUP_ID,
      sandbox_record_id: sandboxRecordId,
      snapshot_type: "pre-shutdown",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      state_data_key: null,
      size_bytes: 2,
      backup_kind: "full",
      parent_backup_id: null,
      content_hash: null,
      created_at: new Date("2026-06-04T12:05:00.000Z"),
      verification_status: "verified",
      verified_at: new Date("2026-06-04T12:05:00.000Z"),
      verification_error: null,
    };
  }

  async function armFromBackupProvision(opts: {
    backupSandboxRecordId?: string;
    reconstructError?: Error;
    restoreHttpStatus?: number;
    createError?: Error;
  }) {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec = sleepingSandboxRec();
    const backup = backupRow(opts.backupSandboxRecordId ?? rec.id);
    const provider: SandboxProvider = {
      create: mock(async () => {
        if (opts.createError) throw opts.createError;
        return {
          sandboxId: "agent-e06bb509",
          bridgeUrl: "https://runtime.example",
          healthUrl: "https://runtime.example/health",
          metadata: {
            nodeId: "node-1",
            containerName: "agent-e06bb509",
            bridgePort: 21060,
            webUiPort: 3000,
          },
        };
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = fetchUrl(input);
      if (url === "https://runtime.example/api/agents") {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      if (url === "https://runtime.example/api/restore" && opts.restoreHttpStatus) {
        return Response.json({ error: "restore rejected" }, { status: opts.restoreHttpStatus });
      }
      return Response.json({ ok: true });
    });
    const originals = {
      findByIdAndOrg: agentSandboxesRepository.findByIdAndOrg,
      findById: agentSandboxesRepository.findById,
      trySetProvisioning: agentSandboxesRepository.trySetProvisioning,
      getBackupById: agentSandboxesRepository.getBackupById,
      getLatestBackup: agentSandboxesRepository.getLatestBackup,
      getReconstructedBackupState: agentSandboxesRepository.getReconstructedBackupState,
    };
    // Ordinary provisions (no override) read the LATEST backup, not an id.
    agentSandboxesRepository.getLatestBackup = mock(async () => backup);
    agentSandboxesRepository.findByIdAndOrg = mock(async () => rec);
    agentSandboxesRepository.findById = mock(async () => rec);
    agentSandboxesRepository.trySetProvisioning = mock(async () => ({
      ...rec,
      status: "provisioning",
    }));
    const getBackupByIdMock = mock(async () => backup);
    agentSandboxesRepository.getBackupById = getBackupByIdMock;
    const reconstructMock = mock(async () => {
      if (opts.reconstructError) throw opts.reconstructError;
      return { memories: [], config: {}, workspaceFiles: {} };
    });
    agentSandboxesRepository.getReconstructedBackupState = reconstructMock;
    const createForAgentSpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => ({ ...rec, ...data, updated_at: rec.updated_at }),
    );
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups");
    return {
      svc: new ElizaSandboxService(provider),
      rec,
      provider,
      getBackupByIdMock,
      reconstructMock,
      updateSpy,
      pruneSpy,
      restore: () => {
        agentSandboxesRepository.findByIdAndOrg = originals.findByIdAndOrg;
        agentSandboxesRepository.findById = originals.findById;
        agentSandboxesRepository.trySetProvisioning = originals.trySetProvisioning;
        agentSandboxesRepository.getBackupById = originals.getBackupById;
        agentSandboxesRepository.getLatestBackup = originals.getLatestBackup;
        agentSandboxesRepository.getReconstructedBackupState =
          originals.getReconstructedBackupState;
        createForAgentSpy.mockRestore();
        updateSpy.mockRestore();
        pruneSpy.mockRestore();
      },
    };
  }

  test("provider creation failures preserve the original cause for the job boundary", async () => {
    const transport = new Error("provider socket failed");
    const creation = new Error("RequestTimeoutError", { cause: transport });
    const h = await armFromBackupProvision({ createError: creation });
    try {
      const result = await h.svc.provision(h.rec.id, h.rec.organization_id);
      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected provision failure");
      expect(result.failureCause).toBe(creation);
      expect((result.failureCause as Error).cause).toBe(transport);
      expect(h.pruneSpy).not.toHaveBeenCalled();
    } finally {
      h.restore();
    }
  });

  test("an unreconstructable explicit backup FAILS the provision — no fresh boot, no prune", async () => {
    // A REAL AeadError: without the override this exact error is classified
    // unrecoverable and degrades to a fresh boot + pruneBackups(rec.id, 0).
    const aead = await realAeadDecryptError();
    const h = await armFromBackupProvision({ reconstructError: aead });
    try {
      const result = await h.svc.provision(h.rec.id, h.rec.organization_id, {
        kind: "from-backup",
        backupId: FROM_BACKUP_ID,
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected provision failure");
      expect(result.error).toBe(aead.message);
      // The degrade path never fired: the chain survives for the retry.
      expect(h.pruneSpy).not.toHaveBeenCalled();
      // The row is flipped out of `running` (markError), and the half-built
      // container is torn down per the post-create-failure convention.
      expect(h.updateSpy).toHaveBeenCalledWith(
        h.rec.id,
        expect.objectContaining({ status: "error" }),
      );
      expect(h.provider.stopForReplacement).toHaveBeenCalled();
    } finally {
      h.restore();
    }
  });

  test("a restore push the runtime rejects FAILS a from-backup provision (custom-image 404 skip stays 404-only)", async () => {
    const h = await armFromBackupProvision({ restoreHttpStatus: 500 });
    try {
      const result = await h.svc.provision(h.rec.id, h.rec.organization_id, {
        kind: "from-backup",
        backupId: FROM_BACKUP_ID,
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected provision failure");
      expect(result.error).toContain("State restore failed: HTTP 500");
      expect(h.pruneSpy).not.toHaveBeenCalled();
      expect(h.updateSpy).toHaveBeenCalledWith(
        h.rec.id,
        expect.objectContaining({ status: "error" }),
      );
    } finally {
      h.restore();
    }
  });

  test("a backup belonging to another sandbox is rejected in provision (defense in depth behind the gate)", async () => {
    const h = await armFromBackupProvision({
      backupSandboxRecordId: "55555555-5555-4555-8555-555555555555",
    });
    try {
      const result = await h.svc.provision(h.rec.id, h.rec.organization_id, {
        kind: "from-backup",
        backupId: FROM_BACKUP_ID,
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected provision failure");
      expect(result.error).toBe(`Restore backup ${FROM_BACKUP_ID} not found for this agent`);
      // Rejected before any state was read or touched.
      expect(h.reconstructMock).not.toHaveBeenCalled();
      expect(h.pruneSpy).not.toHaveBeenCalled();
    } finally {
      h.restore();
    }
  });

  test("an oversized restore FAILS an ORDINARY provision closed — no silent fresh boot (#17180 §1)", async () => {
    // The chain is intact, only too large. Booting empty would silently drop
    // every byte of it, so the refusal must look exactly like the explicit
    // from-backup failure: status error, container torn down, chain unpruned.
    const { SnapshotPayloadTooLargeError } = await import("@elizaos/shared/agent-backup-limits");
    const h = await armFromBackupProvision({
      reconstructError: new SnapshotPayloadTooLargeError(200 * 1024 * 1024, 128 * 1024 * 1024),
    });
    try {
      const result = await h.svc.provision(h.rec.id, h.rec.organization_id);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected provision failure");
      expect(result.error).toContain("forceFreshBoot");
      expect(h.updateSpy).toHaveBeenCalledWith(
        h.rec.id,
        expect.objectContaining({ status: "error" }),
      );
      expect(h.provider.stopForReplacement).toHaveBeenCalled();
      expect(h.pruneSpy).not.toHaveBeenCalled();
    } finally {
      h.restore();
    }
  });

  test("an oversized restore PUSH also fails an ordinary provision closed (#17180 §1)", async () => {
    const { SnapshotPayloadTooLargeError } = await import("@elizaos/shared/agent-backup-limits");
    const h = await armFromBackupProvision({});
    // The push-side refusal fires from the serialized body size inside
    // pushState; injecting at the method boundary avoids materializing 128 MiB
    // in the test while exercising the provision branch that catches it.
    const pushSpy = spyOn(
      h.svc as unknown as { pushState: () => Promise<void> },
      "pushState",
    ).mockRejectedValue(new SnapshotPayloadTooLargeError(200 * 1024 * 1024, 128 * 1024 * 1024));
    try {
      const result = await h.svc.provision(h.rec.id, h.rec.organization_id);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected provision failure");
      expect(result.error).toContain("forceFreshBoot");
      expect(h.updateSpy).toHaveBeenCalledWith(
        h.rec.id,
        expect.objectContaining({ status: "error" }),
      );
      expect(h.pruneSpy).not.toHaveBeenCalled();
    } finally {
      pushSpy.mockRestore();
      h.restore();
    }
  });
});

// C1b attribution guard (audit §C1b/§C5): provision() must NOT flip a docker-
// backed sandbox to `running` when the provider handle carries no durable
// node_id (metadata shape drift, or an empty-string nodeId). Such a row would be
// an unattributable orphan the node recount undercounts (#15378) and the orphan
// reconciler provably cannot reap (allHaveNodeAndStamp skips live null-node
// rows). The guard must fail LOUD + NON-retryable, and the container must be
// torn down per the standard post-create-failure convention.
describe("ElizaSandboxService provision — node attribution guard (C1b)", () => {
  function dedicatedProvisionTarget(): AgentSandbox {
    // A dedicated agent mid-provision: DB already ready (so provision() skips
    // provisionAgentDatabase), no node yet. Non-shared tier so the guard applies.
    return {
      ...customSandbox(),
      execution_tier: "dedicated-always",
      status: "provisioning",
      sandbox_id: null,
      bridge_url: null,
      health_url: null,
      node_id: null,
      container_name: null,
      bridge_port: null,
      web_ui_port: null,
      headscale_ip: null,
      environment_vars: {},
    };
  }

  async function runProvisionWithMetadata(metadata: Record<string, unknown>) {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec = dedicatedProvisionTarget();
    const now = new Date("2026-07-07T12:00:00.000Z");

    const create = mock(async () => ({
      sandboxId: "agent-e06bb509",
      bridgeUrl: "https://runtime.example",
      healthUrl: "https://runtime.example/health",
      metadata,
    }));
    const stop = mock(async () => {});
    const provider = replacementAwareProvider({
      create,
      stop,
      checkHealth: mock(async () => true),
    } as SandboxProvider);

    // A 404 on GET /api/agents makes listRuntimeAgents report the runtime as
    // unsupported, so ensureRuntimeAgentStarted short-circuits (returns null)
    // and the success path proceeds straight to the running-flip (same shape
    // the wake suite uses to drive provision() offline).
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = fetchUrl(input);
      if (url.endsWith("/api/agents")) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return Response.json({ ok: true });
    });

    const originalFindByIdAndOrg = agentSandboxesRepository.findByIdAndOrg;
    const originalTrySetProvisioning = agentSandboxesRepository.trySetProvisioning;
    const originalFindById = agentSandboxesRepository.findById;
    const originalGetLatestBackup = agentSandboxesRepository.getLatestBackup;
    // No snapshot to restore — keeps the success path free of the backup-restore
    // machinery (out of scope for the attribution guard).
    agentSandboxesRepository.getLatestBackup = mock(async () => undefined);
    agentSandboxesRepository.findByIdAndOrg = mock(async () => rec);
    agentSandboxesRepository.trySetProvisioning = mock(async () => ({
      ...rec,
      status: "provisioning",
    }));
    // markError re-reads via findById for the returned record.
    agentSandboxesRepository.findById = mock(async () => ({ ...rec, status: "error" }));
    // Direct property override (not spyOn) so it lands on the SAME singleton the
    // ?actual eliza-sandbox module holds — matching the other stubs above.
    const originalUpdate = agentSandboxesRepository.update;
    const updateSpy = mock(async (_id: string, data: Record<string, unknown>) => ({
      ...rec,
      ...data,
      updated_at: now,
    }));
    agentSandboxesRepository.update =
      updateSpy as unknown as typeof agentSandboxesRepository.update;
    // prepareManagedElizaEnvironment mints an agent API key via createForAgent,
    // whose revoke path calls dbWrite.delete — unsupported by this file's
    // transaction-only dbWrite swap. Stub it like the wake suite does so
    // provision() reaches the guard without touching a real DB.
    const createForAgentSpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });

    try {
      const result = await new ElizaSandboxService(provider).provision(rec.id, rec.organization_id);
      return { result, create, stop, updateSpy };
    } finally {
      agentSandboxesRepository.findByIdAndOrg = originalFindByIdAndOrg;
      agentSandboxesRepository.trySetProvisioning = originalTrySetProvisioning;
      agentSandboxesRepository.findById = originalFindById;
      agentSandboxesRepository.update = originalUpdate;
      agentSandboxesRepository.getLatestBackup = originalGetLatestBackup;
      createForAgentSpy.mockRestore();
    }
  }

  test.skipIf(process.platform === "win32")(
    "docker-backed handle with EMPTY nodeId: no running+null row, non-retryable, container stopped",
    async () => {
      const { result, create, stop, updateSpy } = await runProvisionWithMetadata({
        // Docker-backed by provider tag, but the strict guard fails (empty
        // nodeId) so dockerMeta is undefined — the exact C1b drift.
        provider: "docker",
        nodeId: "",
        hostname: "host-1",
        containerName: "agent-e06bb509",
        bridgePort: 21060,
        webUiPort: 3000,
      });

      // Provision fails (not a fabricated success).
      expect(result.success).toBe(false);

      // NEVER minted a running row.
      for (const call of updateSpy.mock.calls) {
        expect((call[1] as { status?: string }).status).not.toBe("running");
      }

      // markError ran with the distinguishable, non-retryable prefix.
      const errorUpdate = updateSpy.mock.calls.find(
        (c) => (c[1] as { status?: string }).status === "error",
      );
      expect(errorUpdate).toBeDefined();
      if (!errorUpdate) {
        throw new Error("Expected the empty-node attribution error update");
      }
      expect((errorUpdate[1] as { error_message?: string }).error_message).toContain(
        "provision attribution guard:",
      );

      // Non-retryable: the guard message matches none of the port-collision
      // retry patterns, so create() ran exactly once (no retry loop).
      expect(create).toHaveBeenCalledTimes(1);

      // Container torn down per the post-create-failure convention (not leaked,
      // not left invisible-but-alive).
      expect(stop).toHaveBeenCalledTimes(1);
    },
  );

  test.skipIf(process.platform === "win32")(
    "docker-backed handle with MISSING fields (type-guard miss): same refusal",
    async () => {
      const { result, create, stop, updateSpy } = await runProvisionWithMetadata({
        // Provider tag present but hostname/containerName absent => strict guard
        // fails => dockerMeta undefined, yet it IS docker-backed.
        provider: "docker",
        nodeId: "node-1",
      });

      expect(result.success).toBe(false);
      for (const call of updateSpy.mock.calls) {
        expect((call[1] as { status?: string }).status).not.toBe("running");
      }
      const errorUpdate = updateSpy.mock.calls.find(
        (c) => (c[1] as { status?: string }).status === "error",
      );
      expect(errorUpdate).toBeDefined();
      if (!errorUpdate) {
        throw new Error("Expected the incomplete-metadata attribution error update");
      }
      expect((errorUpdate[1] as { error_message?: string }).error_message).toContain(
        "provision attribution guard:",
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
    },
  );

  test.skipIf(process.platform === "win32")(
    "docker-backed handle WITH a real nodeId: flips running normally (guard does not misfire)",
    async () => {
      const { result, updateSpy } = await runProvisionWithMetadata({
        provider: "docker",
        nodeId: "node-1",
        hostname: "host-1",
        containerName: "agent-e06bb509",
        bridgePort: 21060,
        webUiPort: 3000,
        dockerImage: "ghcr.io/example/bnancy:latest",
        imageDigest: null,
      });

      expect(result.success).toBe(true);
      const runningUpdate = updateSpy.mock.calls.find(
        (c) => (c[1] as { status?: string }).status === "running",
      );
      expect(runningUpdate).toBeDefined();
      if (!runningUpdate) {
        throw new Error("Expected the running sandbox update");
      }
      expect((runningUpdate[1] as { node_id?: string }).node_id).toBe("node-1");
    },
  );
});

/**
 * Provision admission is a fail-closed service boundary as well as a provider
 * boundary. These rows carry every early-repair tripwire so a rejected tier
 * cannot mutate lifecycle, environment, or credentials before provider.create.
 */
describe("ElizaSandboxService.provision execution-tier admission", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const ORG = "22222222-2222-4222-8222-222222222222";

  type ProvisionAdmissionService = {
    provision(
      agentId: string,
      orgId: string,
    ): Promise<{ success: boolean; sandboxRecord?: AgentSandbox; error?: string }>;
    executeResume(
      agentId: string,
      orgId: string,
    ): Promise<{
      success: boolean;
      containerStarted: boolean;
      reprovisioned: boolean;
      error?: string;
    }>;
    retireFailedWarmClaimForRetry(
      agentId: string,
      orgId: string,
    ): Promise<{ success: true } | { success: false; error: string }>;
    retirePersistedReplacementCleanup(agentId: string, orgId: string): Promise<string>;
    provisionAgentDatabase(
      rec: AgentSandbox,
    ): Promise<{ success: boolean; connectionUri?: string; error?: string }>;
  };

  function rejectedRow(executionTier: unknown): AgentSandbox {
    return {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      execution_tier: executionTier as AgentSandbox["execution_tier"],
      status: "error",
      error_message: "preserve-this-lifecycle-error",
      database_uri: null,
      database_status: "provisioning",
      database_error: "preserve-this-database-error",
      environment_vars: {
        ELIZA_API_TOKEN: "preserve-this-token",
        ELIZAOS_CLOUD_API_KEY: "preserve-this-credential",
      },
      environment_revision: 41,
      lifecycle_revision: 73,
      claimed_at: new Date("2026-08-20T10:00:00.000Z"),
      warm_claim_credential_state: "failed",
      warm_claim_source_pool_id: "77777777-7777-4777-8777-777777777777",
      warm_claim_key_fingerprint: "preserve-this-fingerprint",
      warm_claim_cleanup_completed_at: new Date("2026-08-20T10:05:00.000Z"),
      replacement_cleanup_sandbox_id: "preserve-replacement-sandbox",
      replacement_cleanup_node_id: "preserve-replacement-node",
      replacement_cleanup_container_name: "preserve-replacement-container",
      replacement_cleanup_attempt_id: "88888888-8888-4888-8888-888888888888",
      replacement_cleanup_allocation_counted: true,
      replacement_cleanup_created_at: new Date("2026-08-20T10:06:00.000Z"),
    };
  }

  function untouchedProvider() {
    const create = mock(async (): Promise<SandboxHandle> => {
      throw new Error("execution-tier admission was bypassed");
    });
    const stopForDeletion = mock(async () => ({ kind: "not-running-proven" as const }));
    const stopForReplacement = mock(async () => {});
    const stopOnSpecificNodeForReplacement = mock(async () => {});
    const checkHealth = mock(async () => true);
    const provider: SandboxProvider = {
      create,
      stopForDeletion,
      stopForReplacement,
      stopOnSpecificNodeForReplacement,
      checkHealth,
    };
    return {
      provider,
      create,
      stopForDeletion,
      stopForReplacement,
      stopOnSpecificNodeForReplacement,
      checkHealth,
    };
  }

  for (const [label, executionTier] of [
    ["shared", "shared"],
    ["unknown", "future-container-tier"],
    ["malformed", { tier: "custom" }],
    ["missing", undefined],
  ] as const) {
    test(`rejects ${label} before every observable provision side effect`, async () => {
      const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
      const row = rejectedRow(executionTier);
      const bytesBefore = JSON.stringify(row);
      const provider = untouchedProvider();
      const svc = new ElizaSandboxService(
        provider.provider,
      ) as unknown as ProvisionAdmissionService;
      const find = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
      const retireWarmClaim = spyOn(svc, "retireFailedWarmClaimForRetry").mockResolvedValue({
        success: true,
      });
      const retireReplacement = spyOn(svc, "retirePersistedReplacementCleanup").mockResolvedValue(
        "retired",
      );
      const lock = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
        ...row,
        status: "provisioning",
      });
      const provisionDatabase = spyOn(svc, "provisionAgentDatabase").mockResolvedValue({
        success: true,
        connectionUri: "postgres://must-not-be-assigned",
      });
      const update = spyOn(agentSandboxesRepository, "update").mockResolvedValue(row);
      const findById = spyOn(agentSandboxesRepository, "findById").mockResolvedValue(row);
      const createCredential = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
        apiKey: {} as never,
        plainKey: "must-not-be-minted",
        revokedKeyHashes: [],
      });
      const revokeCredential = spyOn(apiKeysService, "revokeForAgent").mockResolvedValue([]);
      billing.reactivateBillingSpy.mockClear();

      try {
        const result = await svc.provision(AGENT, ORG);
        expect(result).toEqual({
          success: false,
          sandboxRecord: row,
          error: "Sandbox provisioning requires an explicit container-backed execution tier",
        });
        expect(JSON.stringify(row)).toBe(bytesBefore);
        expect(find).toHaveBeenCalledTimes(1);
        expect(retireWarmClaim).not.toHaveBeenCalled();
        expect(retireReplacement).not.toHaveBeenCalled();
        expect(lock).not.toHaveBeenCalled();
        expect(provisionDatabase).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(findById).not.toHaveBeenCalled();
        expect(createCredential).not.toHaveBeenCalled();
        expect(revokeCredential).not.toHaveBeenCalled();
        expect(billing.reactivateBillingSpy).not.toHaveBeenCalled();
        expect(provider.create).not.toHaveBeenCalled();
        expect(provider.stopForDeletion).not.toHaveBeenCalled();
        expect(provider.stopForReplacement).not.toHaveBeenCalled();
        expect(provider.stopOnSpecificNodeForReplacement).not.toHaveBeenCalled();
        expect(provider.checkHealth).not.toHaveBeenCalled();
      } finally {
        find.mockRestore();
        retireWarmClaim.mockRestore();
        retireReplacement.mockRestore();
        lock.mockRestore();
        provisionDatabase.mockRestore();
        update.mockRestore();
        findById.mockRestore();
        createCredential.mockRestore();
        revokeCredential.mockRestore();
      }
    });
  }

  for (const executionTier of CONTAINER_BACKED_EXECUTION_TIERS) {
    test(`admits canonical ${executionTier} rows to the atomic provisioning lock`, async () => {
      const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
      const row: AgentSandbox = {
        ...customSandbox(),
        id: AGENT,
        organization_id: ORG,
        execution_tier: executionTier,
        status: "stopped",
        bridge_url: null,
        health_url: null,
        claimed_at: null,
        warm_claim_credential_state: null,
      };
      const provider = untouchedProvider();
      const find = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
      const lock = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(
        undefined,
      );
      try {
        const result = await new ElizaSandboxService(provider.provider).provision(AGENT, ORG);
        expect(result).toEqual({
          success: false,
          sandboxRecord: row,
          error: "Agent is already being provisioned",
        });
        expect(lock).toHaveBeenCalledTimes(1);
        expect(lock).toHaveBeenCalledWith(AGENT);
        expect(provider.create).not.toHaveBeenCalled();
      } finally {
        find.mockRestore();
        lock.mockRestore();
      }
    });
  }

  test("service-key resume applies the same admission before billing or provision", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const row: AgentSandbox = {
      ...rejectedRow("shared"),
      status: "stopped",
      claimed_at: null,
      warm_claim_credential_state: null,
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_node_id: null,
      replacement_cleanup_container_name: null,
      replacement_cleanup_attempt_id: null,
      replacement_cleanup_allocation_counted: null,
      replacement_cleanup_created_at: null,
    };
    const bytesBefore = JSON.stringify(row);
    const provider = untouchedProvider();
    const svc = new ElizaSandboxService(provider.provider) as unknown as ProvisionAdmissionService;
    const getForWrite = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      row,
    );
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lock = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(undefined);
    billing.settleLifecycleBillingSpy.mockClear();
    try {
      const result = await svc.executeResume(AGENT, ORG);
      expect(result).toEqual({
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: "Sandbox provisioning requires an explicit container-backed execution tier",
      });
      expect(JSON.stringify(row)).toBe(bytesBefore);
      expect(billing.settleLifecycleBillingSpy).not.toHaveBeenCalled();
      expect(find).not.toHaveBeenCalled();
      expect(lock).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.stopForDeletion).not.toHaveBeenCalled();
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(provider.stopOnSpecificNodeForReplacement).not.toHaveBeenCalled();
      expect(provider.checkHealth).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      find.mockRestore();
      lock.mockRestore();
    }
  });
});
