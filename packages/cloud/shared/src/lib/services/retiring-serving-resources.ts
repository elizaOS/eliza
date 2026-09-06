/** Retires exact old serving compute while retaining its captured volume under lifecycle ownership. */
import { ElizaError } from "@elizaos/core";
import {
  assertDeletionResourceManifestOwner,
  validateDeletionSecretReceipt,
  validateDeletionVolumeCapture,
  validateDeletionVpnReceipt,
} from "../../db/repositories/agent-deletion-resource-manifest";
import { servingDeletionAuthority } from "../../db/repositories/agent-serving-placement";
import type {
  AgentDeletionResourceManifest,
  AgentDeletionResourceReceipt,
  AgentDeletionVolumeCapture,
  AgentDeletionVpnReceipt,
} from "../../db/schemas/agent-sandboxes";
import type { SandboxProvider } from "./sandbox-provider-types";

export type RetiringServingResourceObservation =
  | { kind: "volume"; value: AgentDeletionVolumeCapture }
  | { kind: "secrets"; value: AgentDeletionResourceReceipt }
  | { kind: "vpn"; value: AgentDeletionVpnReceipt };

/** Every effect rechecks ownership; every observation commits before a dependent effect. */
export async function retireServingPlacementResources(input: {
  manifest: AgentDeletionResourceManifest;
  provider: SandboxProvider;
  assertCurrentOwnership: () => Promise<void>;
  persistObservation: (observation: RetiringServingResourceObservation) => Promise<void>;
}): Promise<AgentDeletionResourceManifest> {
  let manifest = structuredClone(input.manifest);
  assertDeletionResourceManifestOwner(
    manifest,
    {
      id: manifest.agentId,
      organization_id: manifest.organizationId,
    },
    manifest.deletionAttemptId,
  );
  const placement = manifest.servingPlacement;
  if (!placement || manifest.deletionPolicy.kind !== "recovery_required") {
    throw new ElizaError("Serving retirement requires a captured recovery-preserving policy", {
      code: "AGENT_RETIRING_RESOURCE_POLICY_INVALID",
    });
  }
  const authority = servingDeletionAuthority(placement, {
    agentId: manifest.agentId,
    sandboxId: placement.locator.sandboxId,
    nodeId: placement.locator.nodeId,
    containerName: placement.locator.containerName,
  });
  if (manifest.resources.volume.state === "unknown") {
    if (!input.provider.captureDeletionVolume) {
      throw new ElizaError("Serving retirement provider cannot capture volume identity", {
        code: "AGENT_RETIRING_VOLUME_CAPTURE_UNAVAILABLE",
      });
    }
    await input.assertCurrentOwnership();
    const capture = await input.provider.captureDeletionVolume(manifest);
    validateDeletionVolumeCapture(manifest, capture);
    await input.persistObservation({ kind: "volume", value: capture });
    manifest = { ...manifest, resources: { ...manifest.resources, volume: capture } };
  }
  await input.assertCurrentOwnership();
  const stopped = await input.provider.stopForDeletion(authority.sandboxId, authority);
  if (stopped.kind !== "not-running-proven") {
    throw new ElizaError("Old serving compute retirement remains unresolved", {
      code: "AGENT_RETIRING_COMPUTE_UNRESOLVED",
    });
  }
  if (manifest.resources.secrets.state === "unknown") {
    if (!input.provider.cleanupDeletionSecretArtifacts) {
      throw new ElizaError("Serving retirement provider cannot retire transient secrets", {
        code: "AGENT_RETIRING_SECRET_CLEANUP_UNAVAILABLE",
      });
    }
    await input.assertCurrentOwnership();
    const receipt = await input.provider.cleanupDeletionSecretArtifacts(manifest);
    validateDeletionSecretReceipt(manifest, receipt);
    await input.persistObservation({ kind: "secrets", value: receipt });
    manifest = { ...manifest, resources: { ...manifest.resources, secrets: receipt } };
  }
  if (manifest.resources.vpn.state === "unknown") {
    if (!input.provider.cleanupDeletionVpn) {
      throw new ElizaError("Serving retirement provider cannot retire captured VPN identity", {
        code: "AGENT_RETIRING_VPN_CLEANUP_UNAVAILABLE",
      });
    }
    await input.assertCurrentOwnership();
    const receipt = await input.provider.cleanupDeletionVpn(manifest);
    validateDeletionVpnReceipt(manifest, receipt);
    await input.persistObservation({ kind: "vpn", value: receipt });
    manifest = { ...manifest, resources: { ...manifest.resources, vpn: receipt } };
  }
  // The cleanup owner continues protecting disk until recovery and retention authorize reclamation.
  return manifest;
}
