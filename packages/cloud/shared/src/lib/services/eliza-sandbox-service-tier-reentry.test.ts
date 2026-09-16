/**
 * Proves direct lifecycle-service re-entry cannot turn a forged Shared row
 * into container capture, billing, provider, credential, or persistence work.
 */
import { describe, expect, mock, spyOn, test } from "bun:test";

import { agentBillingRepository } from "../../db/repositories/agent-billing";
import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import { apiKeysService } from "./api-keys";
import { ElizaSandboxService } from "./eliza-sandbox";
import { provisioningJobService } from "./provisioning-jobs";
import type { SandboxProvider } from "./sandbox-provider-types";

const AGENT_ID = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IMAGE = "ghcr.io/elizaos/eliza-agent:latest";
const FROM_DIGEST = `sha256:${"0".repeat(64)}`;
const TO_DIGEST = `sha256:${"1".repeat(64)}`;

function forgedNonContainerRow(
  status: AgentSandbox["status"],
  executionTier: string,
): AgentSandbox {
  return {
    id: AGENT_ID,
    organization_id: ORGANIZATION_ID,
    user_id: "33333333-3333-4333-8333-333333333333",
    execution_tier: executionTier as AgentSandbox["execution_tier"],
    agent_name: "forged-agent",
    agent_config: { name: "forged-agent" },
    environment_vars: { ELIZA_API_TOKEN: "forged-transport-token" },
    status,
    sandbox_id: "forged-shared-sandbox",
    node_id: "forged-shared-node",
    container_name: "forged-shared-container",
    bridge_url: "https://forged-shared.example",
    health_url: "https://forged-shared.example/health",
    deletion_attempt_id: null,
    deleted_at: null,
    pool_status: null,
    // A complete forged cleanup locator proves the tier guard also runs before
    // upgrade/downgrade cleanup tries to retire provider resources.
    replacement_cleanup_sandbox_id: "forged-replacement-sandbox",
    replacement_cleanup_node_id: "forged-replacement-node",
    replacement_cleanup_container_name: "forged-replacement-container",
    replacement_cleanup_attempt_id: null,
    replacement_cleanup_container_id: null,
    replacement_cleanup_vpn_node_id: null,
    replacement_cleanup_vpn_node_name: null,
    replacement_cleanup_preserved_vpn_node_id: null,
    replacement_cleanup_vpn_registration_started_at: null,
    replacement_cleanup_allocation_counted: true,
    replacement_cleanup_created_at: new Date("2026-08-24T00:00:00.000Z"),
  } as AgentSandbox;
}

describe("ElizaSandboxService container-tier re-entry", () => {
  for (const { label, tier } of [
    { label: "Shared", tier: "shared" },
    { label: "unknown", tier: "future-container-tier" },
  ]) {
    test(`forged ${label} rows stop before capture, billing, provider, credential, or write effects`, async () => {
      const providerEffects = {
        create: mock(async () => {
          throw new Error("forged Shared row reached provider.create");
        }),
        stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
        stopForReplacement: mock(async () => {}),
        stopOnSpecificNodeForReplacement: mock(async () => {}),
        checkHealth: mock(async () => true),
        fetchLogs: mock(async () => "must-not-be-read"),
      };
      const service = new ElizaSandboxService(providerEffects as SandboxProvider);

      const statuses: AgentSandbox["status"][] = [
        "provisioning",
        "running",
        "running",
        "running",
        "disconnected",
        "sleeping",
        "running",
        "running",
        "running",
        "running",
      ];
      let primaryReadIndex = 0;
      const primaryRead = spyOn(
        agentSandboxesRepository,
        "findByIdAndOrgForWrite",
      ).mockImplementation(async () => forgedNonContainerRow(statuses[primaryReadIndex++]!, tier));
      const findRunning = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
        forgedNonContainerRow("running", tier),
      );
      const replicaRead = spyOn(agentSandboxesRepository, "findByIdAndOrg");
      const settleBilling = spyOn(agentBillingRepository, "settleAccruedBillingBeforeLifecycle");
      const update = spyOn(agentSandboxesRepository, "update");
      const createBackup = spyOn(agentSandboxesRepository, "createBackup");
      const stampBackup = spyOn(agentSandboxesRepository, "stampBackupVerification");
      const provisioningCas = spyOn(agentSandboxesRepository, "trySetProvisioning");
      const recoveryCas = spyOn(agentSandboxesRepository, "markRunningFromProvisioning");
      const latestBackup = spyOn(agentSandboxesRepository, "getLatestStoredBackup");
      const nodeRead = spyOn(dockerNodesRepository, "findByNodeId");
      const createCredential = spyOn(apiKeysService, "createForAgent");
      const revokeCredential = spyOn(apiKeysService, "revokeForAgent");
      const enqueueRestart = spyOn(provisioningJobService, "enqueueAgentRestartOnce");
      const originalFetch = globalThis.fetch;
      const networkFetch = mock(async () => {
        throw new Error("forged Shared row reached snapshot/network capture");
      });
      globalThis.fetch = networkFetch as typeof fetch;

      try {
        expect(await service.reconcileStuckProvisioning(AGENT_ID, ORGANIZATION_ID)).toBe("gone");
        expect(await service.shutdown(AGENT_ID, ORGANIZATION_ID)).toEqual({
          success: false,
          error: "Agent shutdown requires a container-backed execution tier",
        });
        expect(
          await service.executeSuspend(AGENT_ID, ORGANIZATION_ID, JOB_ID, "user_request"),
        ).toEqual({
          success: false,
          containerStopped: false,
          error: "Agent suspend requires a container-backed execution tier",
        });
        expect(await service.executeSleep(AGENT_ID, ORGANIZATION_ID)).toEqual({
          success: false,
          containerRemoved: false,
          error: "Agent sleep requires a container-backed execution tier",
        });
        expect(await service.executeWake(AGENT_ID, ORGANIZATION_ID)).toEqual({
          success: false,
          reprovisioned: false,
          error: "Agent wake requires a container-backed execution tier",
        });
        expect(await service.executeRestart(AGENT_ID, ORGANIZATION_ID)).toEqual({
          success: false,
          containerStopped: false,
          containerStarted: false,
          error: "Agent restart requires a container-backed execution tier",
        });
        expect(
          await service.executeUpgrade(AGENT_ID, ORGANIZATION_ID, TO_DIGEST, IMAGE, FROM_DIGEST),
        ).toEqual({
          success: false,
          rolledBack: true,
          error: "Agent upgrade requires a container-backed execution tier",
        });
        expect(
          await service.executeDowngrade(AGENT_ID, ORGANIZATION_ID, IMAGE, FROM_DIGEST),
        ).toEqual({
          success: false,
          rolledBack: true,
          error: "Agent downgrade requires a container-backed execution tier",
        });
        expect(await service.executeLogs(AGENT_ID, ORGANIZATION_ID, 100)).toEqual({
          success: false,
          status: "running",
          error: "Agent logs requires a container-backed execution tier",
        });
        expect(await service.recoverDisconnected(AGENT_ID, ORGANIZATION_ID)).toBe("gone");
        expect(await service.heartbeat(AGENT_ID, ORGANIZATION_ID)).toBe(false);
        await expect(
          service.pushClaimedWarmContainerCharacter(forgedNonContainerRow("running", tier)),
        ).rejects.toThrow("requires a container-backed execution tier");

        expect(primaryRead).toHaveBeenCalledTimes(statuses.length);
        expect(replicaRead).not.toHaveBeenCalled();
        expect(settleBilling).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(createBackup).not.toHaveBeenCalled();
        expect(stampBackup).not.toHaveBeenCalled();
        expect(provisioningCas).not.toHaveBeenCalled();
        expect(recoveryCas).not.toHaveBeenCalled();
        expect(latestBackup).not.toHaveBeenCalled();
        expect(nodeRead).not.toHaveBeenCalled();
        expect(createCredential).not.toHaveBeenCalled();
        expect(revokeCredential).not.toHaveBeenCalled();
        expect(enqueueRestart).not.toHaveBeenCalled();
        expect(networkFetch).not.toHaveBeenCalled();
        for (const effect of Object.values(providerEffects)) {
          expect(effect).not.toHaveBeenCalled();
        }
      } finally {
        globalThis.fetch = originalFetch;
        primaryRead.mockRestore();
        findRunning.mockRestore();
        replicaRead.mockRestore();
        settleBilling.mockRestore();
        update.mockRestore();
        createBackup.mockRestore();
        stampBackup.mockRestore();
        provisioningCas.mockRestore();
        recoveryCas.mockRestore();
        latestBackup.mockRestore();
        nodeRead.mockRestore();
        createCredential.mockRestore();
        revokeCredential.mockRestore();
        enqueueRestart.mockRestore();
      }
    });
  }

  test("logs and stuck-provisioning revalidate a canonical snapshot before provider reads", async () => {
    const canonical = forgedNonContainerRow("provisioning", "dedicated-always");
    const shared = forgedNonContainerRow("provisioning", "shared");
    const provider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      checkHealth: mock(async () => true),
      checkHealthDetailed: mock(async () => ({ ready: true })),
      fetchLogs: mock(async () => "must-not-be-read"),
    };
    const service = new ElizaSandboxService(provider as SandboxProvider);
    const primary = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite");
    const reconcileCas = spyOn(
      agentSandboxesRepository,
      "markRunningFromProvisioning",
    ).mockResolvedValue(undefined);
    try {
      primary.mockResolvedValueOnce(canonical).mockResolvedValueOnce(shared);
      await expect(service.reconcileStuckProvisioning(AGENT_ID, ORGANIZATION_ID)).resolves.toBe(
        "gone",
      );
      expect(provider.checkHealth).not.toHaveBeenCalled();
      expect(provider.checkHealthDetailed).not.toHaveBeenCalled();
      expect(reconcileCas).not.toHaveBeenCalled();

      const runningCanonical = { ...canonical, status: "running" as const };
      const runningShared = { ...shared, status: "running" as const };
      primary.mockResolvedValueOnce(runningCanonical).mockResolvedValueOnce(runningShared);
      await expect(service.executeLogs(AGENT_ID, ORGANIZATION_ID, 100)).resolves.toEqual({
        success: false,
        status: "running",
        error: "Agent logs requires a container-backed execution tier",
      });
      expect(provider.fetchLogs).not.toHaveBeenCalled();
    } finally {
      primary.mockRestore();
      reconcileCas.mockRestore();
    }
  });
});
