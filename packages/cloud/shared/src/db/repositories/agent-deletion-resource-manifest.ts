/** Captures deletion resource ownership before compute removal and preserves unresolved cleanup across retries. */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import {
  getDeletionVolumeCleanupReceipt,
  getReplacementSecretArtifactsCleanupReceipt,
} from "../../lib/services/docker-sandbox-utils";
import {
  mergeHeadscaleEnrollmentAuthority,
  parseHeadscaleEnrollmentAuthority,
} from "../../lib/services/headscale-client";
import type {
  AgentDeletionResourceManifest,
  AgentDeletionResourcePolicy,
  AgentDeletionResourceReceipt,
  AgentDeletionVolumeCapture,
  AgentDeletionVolumeReceipt,
  AgentDeletionVpnReceipt,
  AgentSandbox,
} from "../schemas/agent-sandboxes";

const deletionPolicySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("account_purge"),
    requestId: z.string().uuid(),
    lifecycleRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  z.object({ kind: z.literal("recovery_required") }),
]);

function policyIdentity(policy: AgentDeletionResourcePolicy): string {
  return JSON.stringify(
    policy.kind === "account_purge"
      ? [policy.kind, policy.requestId, policy.lifecycleRevision]
      : [policy.kind],
  );
}

const secretReceiptSchema = z.object({
  state: z.literal("absent"),
  authorityHash: z.string().regex(/^[0-9a-f]{64}$/),
  observedAt: z.iso.datetime(),
  providerReceipt: z.string(),
});
const volumeCaptureSchema = z.object({
  state: z.literal("captured"),
  authorityHash: z.string().regex(/^[0-9a-f]{64}$/),
  observedAt: z.iso.datetime(),
  path: z.string(),
  nodeBootId: z.string().uuid(),
  rootDevice: z.string().regex(/^[0-9]+$/),
  rootInode: z.string().regex(/^[1-9][0-9]*$/),
  stateDevice: z.string().regex(/^[0-9]+$/),
  stateInode: z.string().regex(/^[1-9][0-9]*$/),
});
const volumeReceiptSchema = secretReceiptSchema.extend({ capture: volumeCaptureSchema });
const resourceStatesSchema = z.object({
  volume: z.union([
    z.object({ state: z.literal("unknown") }),
    volumeCaptureSchema,
    volumeReceiptSchema,
  ]),
  vpn: z.union([
    z.object({ state: z.literal("unknown") }),
    secretReceiptSchema.extend({ authority: z.unknown() }),
  ]),
  secrets: z.union([z.object({ state: z.literal("unknown") }), secretReceiptSchema]),
});

/** Existing generations retain their original resource observations, never a fresh empty manifest. */
export function captureDeletionResourceManifest(
  agent: AgentSandbox,
  deletionAttemptId: string,
  deletionPolicy?: AgentDeletionResourcePolicy,
): AgentDeletionResourceManifest | null {
  const existing = agent.deletion_resource_manifest;
  if (existing) {
    assertDeletionResourceManifestOwner(existing, agent, deletionAttemptId);
    if (
      deletionPolicy &&
      policyIdentity(existing.deletionPolicy) !== policyIdentity(deletionPolicy)
    ) {
      throw new ElizaError("Deletion resource policy cannot change within an admitted generation", {
        code: "AGENT_DELETE_RESOURCE_POLICY_CHANGED",
        context: { agentId: agent.id, deletionAttemptId },
      });
    }
    if (
      resourceIdentity(existing.localStateRetention, existing.servingPlacement) !==
      resourceIdentity(agent.local_state_retention, agent.serving_placement)
    ) {
      throw new ElizaError("Deletion resources changed after their manifest was captured", {
        code: "AGENT_DELETE_RESOURCE_PLACEMENT_CHANGED",
        context: { agentId: agent.id, deletionAttemptId },
      });
    }
    return existing;
  }
  if (!agent.serving_placement && !agent.local_state_retention) return null;
  if (!deletionPolicy)
    throw new ElizaError("Deletion resource admission requires an explicit policy", {
      code: "AGENT_DELETE_RESOURCE_POLICY_REQUIRED",
      context: { agentId: agent.id, deletionAttemptId },
    });
  return {
    version: 1,
    deletionAttemptId,
    deletionPolicy,
    agentId: agent.id,
    organizationId: agent.organization_id,
    servingPlacement: agent.serving_placement,
    localStateRetention: agent.local_state_retention,
    // Placement identity does not prove provider-side resources are absent.
    resources: {
      volume: { state: "unknown" },
      vpn: { state: "unknown" },
      secrets: { state: "unknown" },
    },
  };
}

/** The deletion generation, tenant and agent must still own the captured resources. */
export function assertDeletionResourceManifestOwner(
  manifest: AgentDeletionResourceManifest,
  agent: Pick<AgentSandbox, "id" | "organization_id">,
  deletionAttemptId: string,
): void {
  if (
    !deletionPolicySchema.safeParse(manifest.deletionPolicy).success ||
    !resourceStatesSchema.safeParse(manifest.resources).success ||
    manifest.version !== 1 ||
    manifest.agentId !== agent.id ||
    manifest.organizationId !== agent.organization_id ||
    manifest.deletionAttemptId !== deletionAttemptId
  ) {
    throw new ElizaError("Deletion resource manifest belongs to a different lifecycle authority", {
      code: "AGENT_DELETE_RESOURCE_AUTHORITY_MISMATCH",
      context: { agentId: agent.id, organizationId: agent.organization_id, deletionAttemptId },
    });
  }
  if (manifest.resources.volume.state === "captured")
    validateDeletionVolumeCapture(manifest, manifest.resources.volume);
  if (manifest.resources.volume.state === "absent")
    validateDeletionVolumeReceipt(manifest, manifest.resources.volume);
  if (manifest.resources.vpn.state === "absent")
    validateDeletionVpnReceipt(manifest, manifest.resources.vpn);
  if (manifest.resources.secrets.state === "absent")
    validateDeletionSecretReceipt(manifest, manifest.resources.secrets);
}

/** Ordered authority fields avoid JSON object-key ordering changing retry identity. */
function resourceIdentity(
  retained: AgentDeletionResourceManifest["localStateRetention"],
  serving: AgentDeletionResourceManifest["servingPlacement"],
): string {
  const locator = serving?.locator;
  const vpnAuthority =
    locator?.vpnAuthority == null
      ? null
      : parseHeadscaleEnrollmentAuthority(locator.vpnAuthority, locator.vpnNodeId ?? null);
  return JSON.stringify([
    retained && [
      retained.agentId,
      retained.containerId,
      retained.containerName,
      retained.nodeId,
      retained.nodeRecordId,
      retained.hostname,
      retained.sshPort,
      retained.sshUser,
      retained.hostKeyFingerprint,
    ],
    locator && [
      serving?.volumePath,
      locator.sandboxId,
      locator.containerId,
      locator.containerName,
      locator.nodeId,
      locator.nodeRecordId,
      locator.nodeIncarnation,
      locator.nodeHistoryId,
      locator.nodeHostname,
      locator.nodeSshPort,
      locator.nodeSshUser,
      locator.nodeHostKeyFingerprint,
      locator.replacementAttemptId,
      locator.replacementSecretCleanupVersion,
      locator.restoreAttemptId,
      locator.vpnNodeId,
      locator.vpnNodeName,
      locator.previousVpnNodeId,
      locator.vpnRegistrationStartedAt,
    ],
    // Preserve hashes of issued scope-less receipts; a newly captured scope changes authority.
    ...(vpnAuthority
      ? [
          [
            "headscale-enrollment-v1",
            vpnAuthority.server.apiUrl,
            vpnAuthority.server.enrollmentUser,
            vpnAuthority.server.publicKey,
            vpnAuthority.node && [
              vpnAuthority.node.id,
              vpnAuthority.node.machineKey,
              vpnAuthority.node.createdAt,
            ],
          ],
        ]
      : []),
  ]);
}

/** Receipt hashes bind the operation, tenant and complete captured provider identities. */
export function deletionResourceAuthorityHash(manifest: AgentDeletionResourceManifest): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        manifest.version,
        manifest.organizationId,
        manifest.agentId,
        manifest.deletionAttemptId,
        policyIdentity(manifest.deletionPolicy),
        resourceIdentity(manifest.localStateRetention, manifest.servingPlacement),
      ]),
    )
    .digest("hex");
}

/** Accept only the secret protocol proof for this exact captured attempt. */
export function validateDeletionSecretReceipt(
  manifest: AgentDeletionResourceManifest,
  receipt: AgentDeletionResourceReceipt,
): void {
  const parsed = secretReceiptSchema.safeParse(receipt);
  const attempt = manifest.servingPlacement?.locator.replacementAttemptId;
  if (
    !parsed.success ||
    !attempt ||
    manifest.servingPlacement?.locator.replacementSecretCleanupVersion !== 1 ||
    parsed.data.authorityHash !== deletionResourceAuthorityHash(manifest) ||
    parsed.data.providerReceipt !== getReplacementSecretArtifactsCleanupReceipt(attempt) ||
    Date.parse(parsed.data.observedAt) > Date.now()
  ) {
    throw new ElizaError("Deletion secret cleanup receipt does not match captured authority", {
      code: "AGENT_DELETE_SECRET_RECEIPT_INVALID",
      context: { agentId: manifest.agentId },
    });
  }
}

/** Reject volume observations that cannot belong to the admitted container placement. */
export function validateDeletionVolumeCapture(
  manifest: AgentDeletionResourceManifest,
  capture: AgentDeletionVolumeCapture,
): void {
  const parsed = volumeCaptureSchema.safeParse(capture);
  const root = `/data/agents/${manifest.agentId}`;
  const restorePrefix = `/data/agents/.restore/${manifest.agentId}/`;
  const pathValid =
    parsed.success &&
    (parsed.data.path === root ||
      (parsed.data.path.startsWith(restorePrefix) &&
        z.string().uuid().safeParse(parsed.data.path.slice(restorePrefix.length)).success));
  const placement = manifest.servingPlacement;
  if (
    !parsed.success ||
    !pathValid ||
    capture.authorityHash !== deletionResourceAuthorityHash(manifest) ||
    Date.parse(capture.observedAt) > Date.now() ||
    (placement?.volumePath && capture.path !== placement.volumePath) ||
    (placement?.locator.restoreAttemptId &&
      capture.nodeBootId !== placement.locator.nodeIncarnation)
  ) {
    throw new ElizaError("Deletion volume observation differs from captured authority", {
      code: "AGENT_DELETE_VOLUME_CAPTURE_INVALID",
      context: { agentId: manifest.agentId },
    });
  }
}

/** Parse the complete host response; missing or additional fields never become absence evidence. */
export function parseDeletionVolumeCaptureOutput(
  manifest: AgentDeletionResourceManifest,
  output: string,
): AgentDeletionVolumeCapture {
  const fields = output.trim().split("|");
  if (fields.length !== 7 || fields[0] !== "ELIZA_DELETION_VOLUME_V1")
    throw new ElizaError("Deletion volume response is malformed", {
      code: "AGENT_DELETE_VOLUME_CAPTURE_INVALID",
      context: { agentId: manifest.agentId },
    });
  const capture: AgentDeletionVolumeCapture = {
    state: "captured",
    authorityHash: deletionResourceAuthorityHash(manifest),
    observedAt: new Date().toISOString(),
    nodeBootId: fields[1],
    rootDevice: fields[2],
    rootInode: fields[3],
    stateDevice: fields[4],
    stateInode: fields[5],
    path: fields[6],
  };
  validateDeletionVolumeCapture(manifest, capture);
  return capture;
}

/** Accept only absence for the exact previously captured ordinary volume under account purge. */
export function validateDeletionVolumeReceipt(
  manifest: AgentDeletionResourceManifest,
  receipt: AgentDeletionVolumeReceipt,
): void {
  const parsed = volumeReceiptSchema.safeParse(receipt);
  const volume = manifest.resources.volume;
  const expected =
    volume.state === "captured" ? volume : volume.state === "absent" ? volume.capture : null;
  if (
    !parsed.success ||
    !expected ||
    manifest.deletionPolicy.kind !== "account_purge" ||
    parsed.data.capture.path !== `/data/agents/${manifest.agentId}` ||
    parsed.data.authorityHash !== deletionResourceAuthorityHash(manifest) ||
    parsed.data.providerReceipt !== getDeletionVolumeCleanupReceipt(expected) ||
    getDeletionVolumeCleanupReceipt(parsed.data.capture) !==
      getDeletionVolumeCleanupReceipt(expected) ||
    Date.parse(parsed.data.observedAt) > Date.now() ||
    Date.parse(parsed.data.observedAt) < Date.parse(parsed.data.capture.observedAt)
  ) {
    throw new ElizaError("Deletion volume absence receipt differs from captured authority", {
      code: "AGENT_DELETE_VOLUME_RECEIPT_INVALID",
      context: { agentId: manifest.agentId },
    });
  }
  validateDeletionVolumeCapture(manifest, parsed.data.capture);
}

/** Accept only scoped registration absence for the immutable deletion manifest. */
export function validateDeletionVpnReceipt(
  manifest: AgentDeletionResourceManifest,
  receipt: AgentDeletionVpnReceipt,
): void {
  const parsed = secretReceiptSchema.safeParse(receipt);
  const locator = manifest.servingPlacement?.locator;
  if (
    !parsed.success ||
    !locator?.vpnAuthority ||
    parsed.data.providerReceipt !== "HEADSCALE_NODE_ABSENT_V1" ||
    parsed.data.authorityHash !== deletionResourceAuthorityHash(manifest) ||
    Date.parse(parsed.data.observedAt) > Date.now()
  ) {
    throw new ElizaError("Deletion VPN receipt differs from captured authority", {
      code: "AGENT_DELETE_VPN_RECEIPT_INVALID",
      context: { agentId: manifest.agentId },
    });
  }
  const captured = parseHeadscaleEnrollmentAuthority(
    locator.vpnAuthority,
    locator.vpnNodeId ?? null,
  );
  const observed = parseHeadscaleEnrollmentAuthority(receipt.authority, locator.vpnNodeId ?? null);
  if (!captured.node || !observed.node)
    throw new ElizaError("Deletion VPN receipt lacks a captured registration", {
      code: "AGENT_DELETE_VPN_RECEIPT_INVALID",
    });
  mergeHeadscaleEnrollmentAuthority(captured, observed);
}
