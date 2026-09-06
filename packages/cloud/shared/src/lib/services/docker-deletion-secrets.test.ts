/** Exercises deletion secret cleanup through the real provider with substituted SSH responses. */
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  deletionResourceAuthorityHash,
  parseDeletionVolumeCaptureOutput,
  validateDeletionSecretReceipt,
  validateDeletionVolumeReceipt,
  validateDeletionVpnReceipt,
} from "../../db/repositories/agent-deletion-resource-manifest";
import type { AgentDeletionResourceManifest } from "../../db/schemas/agent-sandboxes";
import { DockerSandboxProvider } from "./docker-sandbox-provider";
import {
  getDeletionVolumeCleanupReceipt,
  getReplacementCandidateObservedReceipt,
  getReplacementSecretArtifactsCleanupReceipt,
} from "./docker-sandbox-utils";
import { DockerSSHClient } from "./docker-ssh";
import { headscaleClient } from "./headscale-client";

afterEach(() => mock.restore());
const agentId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const containerId = "a".repeat(64);

function deletionManifest(): AgentDeletionResourceManifest {
  return {
    version: 1,
    deletionAttemptId: crypto.randomUUID(),
    deletionPolicy: { kind: "account_purge", requestId: crypto.randomUUID(), lifecycleRevision: 2 },
    agentId,
    organizationId: crypto.randomUUID(),
    localStateRetention: null,
    servingPlacement: {
      version: 1,
      volumePath: `/data/agents/${agentId}`,
      locator: {
        sandboxId: `agent-${agentId}`,
        containerName: `agent-${agentId}`,
        nodeId: "original-node",
        nodeRecordId: crypto.randomUUID(),
        containerId,
        nodeHostname: "192.0.2.7",
        nodeSshPort: 2222,
        nodeSshUser: "operator",
        nodeHostKeyFingerprint: "SHA256:original",
        replacementAttemptId: attemptId,
        replacementSecretCleanupVersion: 1,
      },
    },
    resources: {
      volume: { state: "unknown" },
      vpn: { state: "unknown" },
      secrets: { state: "unknown" },
    },
  };
}

test.each([
  "valid",
  "lost-ack",
  "wrong-attempt",
  "wrong-container",
  "wrong-volume",
  "missing-host",
] as const)("deletion secret provider keeps exact authority (%s)", async (scenario) => {
  const manifest = deletionManifest();
  if (scenario === "wrong-volume")
    manifest.servingPlacement!.volumePath = `/data/agents/${crypto.randomUUID()}`;
  if (scenario === "missing-host") manifest.servingPlacement!.locator.nodeHostKeyFingerprint = null;
  const ssh = Object.create(DockerSSHClient.prototype) as DockerSSHClient;
  const connect = spyOn(DockerSSHClient, "createDedicated").mockReturnValue(ssh);
  spyOn(ssh, "disconnect").mockResolvedValue(undefined);
  const expected = getReplacementSecretArtifactsCleanupReceipt(attemptId);
  const exec = spyOn(ssh, "exec").mockImplementation(async () => {
    if (scenario === "lost-ack") throw new Error("SSH acknowledgement lost");
    if (scenario === "wrong-attempt")
      return getReplacementSecretArtifactsCleanupReceipt(crypto.randomUUID());
    if (scenario === "wrong-container")
      return `${expected}\n${getReplacementCandidateObservedReceipt(attemptId, "b".repeat(64))}`;
    return expected;
  });
  const provider = new DockerSandboxProvider();
  if (scenario !== "valid") {
    await expect(provider.cleanupDeletionSecretArtifacts(manifest)).rejects.toThrow();
    if (scenario === "wrong-volume" || scenario === "missing-host")
      expect(exec).not.toHaveBeenCalled();
    return;
  }
  const receipt = await provider.cleanupDeletionSecretArtifacts(manifest);
  validateDeletionSecretReceipt(manifest, receipt);
  expect(() =>
    validateDeletionSecretReceipt(
      { ...manifest, deletionPolicy: { kind: "recovery_required" } },
      receipt,
    ),
  ).toThrow("does not match captured authority");
  for (const changed of [
    { kind: "account_purge" as const, requestId: crypto.randomUUID(), lifecycleRevision: 2 },
    { ...manifest.deletionPolicy, lifecycleRevision: 3 },
  ]) {
    expect(() =>
      validateDeletionSecretReceipt({ ...manifest, deletionPolicy: changed }, receipt),
    ).toThrow("does not match captured authority");
  }
  expect(receipt.authorityHash).toBe(deletionResourceAuthorityHash(manifest));
  expect(connect).toHaveBeenCalledWith("192.0.2.7", 2222, "SHA256:original", "operator");
  const forged = { ...receipt, authorityHash: "b".repeat(64) };
  expect(() => validateDeletionSecretReceipt(manifest, forged)).toThrow(
    "does not match captured authority",
  );
});

test.each(["valid", "lost-ack", "wrong-receipt", "recovery-required", "uncaptured"] as const)(
  "volume cleanup provider preserves receipt authority (%s)",
  async (scenario) => {
    const manifest = deletionManifest();
    const capture = parseDeletionVolumeCaptureOutput(
      manifest,
      `ELIZA_DELETION_VOLUME_V1|${crypto.randomUUID()}|8|101|8|102|/data/agents/${agentId}`,
    );
    manifest.resources.volume = capture;
    if (scenario === "recovery-required") manifest.deletionPolicy = { kind: "recovery_required" };
    if (scenario === "uncaptured") manifest.resources.volume = { state: "unknown" };
    const ssh = Object.create(DockerSSHClient.prototype) as DockerSSHClient;
    spyOn(DockerSSHClient, "createDedicated").mockReturnValue(ssh);
    spyOn(ssh, "disconnect").mockResolvedValue(undefined);
    const exec = spyOn(ssh, "exec").mockImplementation(async () => {
      if (scenario === "lost-ack") throw new Error("SSH acknowledgement lost");
      return scenario === "wrong-receipt" ? "absent" : getDeletionVolumeCleanupReceipt(capture);
    });
    const provider = new DockerSandboxProvider();
    if (scenario !== "valid") {
      await expect(provider.cleanupDeletionVolume(manifest)).rejects.toThrow();
      if (scenario === "uncaptured" || scenario === "recovery-required")
        expect(exec).not.toHaveBeenCalled();
      return;
    }
    const receipt = await provider.cleanupDeletionVolume(manifest);
    validateDeletionVolumeReceipt(manifest, receipt);
    expect(receipt.capture).toEqual(capture);
    expect(() =>
      validateDeletionVolumeReceipt(
        { ...manifest, deletionPolicy: { kind: "recovery_required" } },
        receipt,
      ),
    ).toThrow("differs from captured authority");
  },
);

test("issued cleanup receipts cannot cross VPN enrollment authority changes", async () => {
  const manifest = deletionManifest();
  const ssh = Object.create(DockerSSHClient.prototype) as DockerSSHClient;
  spyOn(DockerSSHClient, "createDedicated").mockReturnValue(ssh);
  spyOn(ssh, "disconnect").mockResolvedValue(undefined);
  spyOn(ssh, "exec").mockResolvedValue(getReplacementSecretArtifactsCleanupReceipt(attemptId));
  const provider = new DockerSandboxProvider();
  manifest.servingPlacement!.locator.vpnNodeId = "42";
  const legacyReceipt = await provider.cleanupDeletionSecretArtifacts(manifest);
  manifest.servingPlacement!.locator.vpnAuthority = null;
  validateDeletionSecretReceipt(manifest, legacyReceipt);
  const authority = {
    server: {
      apiUrl: "https://vpn.fixture.invalid",
      enrollmentUser: "staging",
      publicKey: `mkey:${"1".repeat(64)}`,
    },
    node: { id: "42", machineKey: `mkey:${"2".repeat(64)}`, createdAt: "2026-09-06T00:00:00.000Z" },
  };
  manifest.servingPlacement!.locator.vpnNodeId = "42";
  manifest.servingPlacement!.locator.vpnAuthority = authority;
  expect(() => validateDeletionSecretReceipt(manifest, legacyReceipt)).toThrow();
  const scopedReceipt = await provider.cleanupDeletionSecretArtifacts(manifest);
  validateDeletionSecretReceipt(manifest, scopedReceipt);
  for (const changed of [
    {
      server: { ...authority.server, apiUrl: "https://other.fixture.invalid" },
      node: authority.node,
    },
    { server: { ...authority.server, enrollmentUser: "production" }, node: authority.node },
    { server: { ...authority.server, publicKey: `mkey:${"3".repeat(64)}` }, node: authority.node },
    { server: authority.server, node: { ...authority.node, machineKey: `mkey:${"4".repeat(64)}` } },
    {
      server: authority.server,
      node: { ...authority.node, createdAt: "2020-01-01T00:00:00.000Z" },
    },
    { server: authority.server, node: null },
    null,
  ]) {
    manifest.servingPlacement!.locator.vpnAuthority = changed;
    expect(() => validateDeletionSecretReceipt(manifest, scopedReceipt)).toThrow();
  }
  manifest.servingPlacement!.locator.vpnAuthority = {
    node: {
      createdAt: authority.node.createdAt,
      machineKey: authority.node.machineKey,
      id: authority.node.id,
    },
    server: {
      publicKey: authority.server.publicKey,
      enrollmentUser: authority.server.enrollmentUser,
      apiUrl: authority.server.apiUrl,
    },
  };
  validateDeletionSecretReceipt(manifest, scopedReceipt);
  manifest.servingPlacement!.locator.vpnNodeId = "43";
  expect(() => validateDeletionSecretReceipt(manifest, scopedReceipt)).toThrow(
    "disagrees with the placement node",
  );
});

test.each(["valid", "unavailable", "wrong-node", "unknown", "missing"] as const)(
  "deletion VPN provider preserves scoped absence (%s)",
  async (scenario) => {
    const manifest = deletionManifest();
    const authority = {
      server: {
        apiUrl: "https://vpn.fixture.invalid",
        enrollmentUser: "staging",
        publicKey: `mkey:${"1".repeat(64)}`,
      },
      node: {
        id: "42",
        machineKey: `mkey:${"2".repeat(64)}`,
        createdAt: "2026-09-06T00:00:00.000Z",
      },
    };
    manifest.servingPlacement!.locator.vpnNodeId = "42";
    manifest.servingPlacement!.locator.vpnAuthority =
      scenario === "missing"
        ? null
        : { ...authority, node: scenario === "unknown" ? null : authority.node };
    const remove = spyOn(headscaleClient, "deleteNodeForAuthority").mockImplementation(
      async (expected) => {
        expect(expected).toEqual(authority);
        if (scenario === "unavailable") throw new Error("Headscale readback unavailable");
        return {
          state: "absent",
          authority:
            scenario === "wrong-node"
              ? { ...authority, node: { ...authority.node, id: "43" } }
              : authority,
          observedAt: new Date().toISOString(),
        };
      },
    );
    const operation = new DockerSandboxProvider().cleanupDeletionVpn(manifest);
    if (scenario !== "valid") {
      await expect(operation).rejects.toThrow();
      if (scenario === "unknown" || scenario === "missing") expect(remove).not.toHaveBeenCalled();
      return;
    }
    const receipt = await operation;
    validateDeletionVpnReceipt(manifest, receipt);
    expect(() =>
      validateDeletionVpnReceipt({ ...manifest, deletionAttemptId: crypto.randomUUID() }, receipt),
    ).toThrow();
    expect(receipt.authority).toEqual(authority);
  },
);
