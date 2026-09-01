/**
 * One disabled-first restore materialization turn.
 *
 * This composition stops after a digest-pinned Docker container is created in
 * the stopped, networkless quarantine. It deliberately has no start,
 * readiness, billing, registry-publication, or routing dependency.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import {
  type AgentBackupRestoreSourceV3Input,
  loadAgentBackupRestoreSourceV3,
} from "../../db/repositories/agent-backup-restore";
import {
  type RecordAgentVaultKeySeedReceiptInput,
  recordAgentVaultKeySeedReceipt,
} from "../../db/repositories/agent-backup-restore-history";
import {
  type AgentBackupRestoreSandboxCreateAuthority,
  type AgentBackupRestoreTargetAuthority,
  type AgentSandboxExactRestoreCleanupClaim,
  type AgentSandboxExactRestoreProviderBoundaryInput,
  type BeginAgentSandboxExactRestoreCleanupInput,
  beginAgentSandboxExactRestoreCleanup,
  claimAgentBackupRestoreOperation,
  claimAgentSandboxExactRestoreCleanup,
  type FinishAgentSandboxExactRestoreCleanupInput,
  finishAgentSandboxExactRestoreCleanup,
  markAgentSandboxExactRestoreProviderStarted,
  type RecordAgentBackupRestoreExactImagePlatformAuthorityInput,
  type RecordAgentSandboxExactRestoreProviderSucceededInput,
  type ReserveAgentBackupRestoreTargetAndStartReplacementIntentInput,
  recordAgentBackupRestoreExactImagePlatformAuthority,
  recordAgentSandboxExactRestoreProviderCreated,
  recordAgentSandboxExactRestoreProviderSucceeded,
  releaseAgentBackupRestoreOperationClaim,
  releaseAgentSandboxExactRestoreCleanupClaim,
  reserveAgentBackupRestoreTargetAndStartReplacementIntent,
} from "../../db/repositories/agent-backup-restore-operations";
import {
  type AgentSandboxReplacementAttemptReference,
  type AgentSandboxReplacementLocatorInput,
  verifyAgentSandboxExactRestoreReplacementIntent,
} from "../../db/repositories/agent-sandbox-replacement-attempts";
import {
  type AgentBackupRestoreVaultPassphraseInput,
  type AgentBackupRestoreVaultPassphraseOptions,
  withAgentBackupRestoreVaultPassphrase,
} from "../../db/repositories/agent-vault-key-authority";
import type { AgentBackupRestoreOperation } from "../../db/schemas/agent-backup-catalog";
import type { AgentSandboxReplacementAttempt } from "../../db/schemas/agent-sandbox-replacement-attempts";
import { logger } from "../utils/logger";
import {
  type AgentBackupRestoreExactImagePlatformAuthority,
  resolveAgentBackupRestoreExactImagePlatform,
} from "./agent-backup-restore-exact-image-platform";
import {
  type AgentBackupRestoreVaultVolumeSeedResult,
  deriveRestoreStagingVolumePathV1,
  type SeedRestoreVolumeVaultPassphraseBytesInput,
  seedRestoreVolumeVaultPassphraseBytes,
} from "./agent-backup-restore-vault-seed";
import {
  buildExactRestoreBootFencedCommand,
  DockerSandboxProvider,
} from "./docker-sandbox-provider";
import { DockerSSHClient, type DockerSSHConfig } from "./docker-ssh";
import type { SandboxCreateConfig, SandboxHandle, SandboxProvider } from "./sandbox-provider-types";
import { assertSandboxReplacementAttemptId } from "./sandbox-provider-types";

export const AGENT_BACKUP_RESTORE_QUARANTINED_CREATE_CLAIM_MS = 3_600_000;
export const AGENT_BACKUP_RESTORE_EXACT_PROVIDER_RECEIPT_FORMAT =
  "eliza.agent-backup-restore.exact-provider-create-receipt.v1" as const;
export const AGENT_BACKUP_RESTORE_EXACT_CLEANUP_RECEIPT_FORMAT =
  "eliza.agent-backup-restore.exact-provider-cleanup-receipt.v1" as const;

type RestoreOperationAuthority = Readonly<
  Pick<
    AgentBackupRestoreOperation,
    | "id"
    | "organization_id"
    | "agent_id"
    | "backup_id"
    | "restore_attempt_id"
    | "lease_id"
    | "lease_generation"
    | "lease_owner_id"
    | "catalog_epoch"
    | "copy_role"
    | "phase"
    | "expected_operation_id"
    | "expected_manifest_sha256"
    | "expected_activation_generation"
    | "expected_lifecycle_revision"
    | "expected_node_record_id"
    | "expected_node_incarnation"
    | "expected_node_history_id"
    | "expected_container_id"
    | "expected_image_digest"
    | "expected_image_platform"
    | "expected_image_reference"
    | "expected_image_platform_digest"
    | "claim_owner"
    | "claim_generation"
    | "claim_expires_at"
  >
>;

type ReplacementAttemptAuthority = Readonly<
  Pick<
    AgentSandboxReplacementAttempt,
    | "id"
    | "state"
    | "provider_started_at"
    | "provider_succeeded_at"
    | "provider_receipt_digest"
    | "locator_container_id"
    | "cleanup_proven_at"
    | "cleanup_receipt_digest"
  >
>;

interface RestoreOperationClaimAuthority {
  readonly operation: RestoreOperationAuthority;
  readonly claimGeneration: string;
}

interface RestoreCreateAuthority {
  readonly operation: RestoreOperationAuthority;
  readonly target: Readonly<AgentBackupRestoreTargetAuthority>;
  readonly sandbox: Readonly<AgentBackupRestoreSandboxCreateAuthority>;
  readonly attempt: ReplacementAttemptAuthority;
  readonly locator: Readonly<AgentSandboxReplacementLocatorInput>;
  readonly replayed: Readonly<{
    target: boolean;
    quarantine: boolean;
    replacementIntent: boolean;
  }>;
}

interface RestoreProviderBoundaryResult {
  readonly operation: RestoreOperationAuthority;
  readonly attempt: ReplacementAttemptAuthority;
  readonly locator: Readonly<AgentSandboxReplacementLocatorInput>;
  readonly replayed: boolean;
}

interface DedicatedRestoreSshClient {
  execStdinAbortable(command: string, input: Buffer, signal: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
}

type ExactRestoreProvider = Pick<
  SandboxProvider,
  | "create"
  | "exactRestoreCreateCapability"
  | "replacementCreateSettlementCapability"
  | "stopOnSpecificNodeForReplacement"
>;

type SupportedExactRestoreProvider = ExactRestoreProvider & {
  stopOnSpecificNodeForReplacement: NonNullable<
    SandboxProvider["stopOnSpecificNodeForReplacement"]
  >;
};

export interface AgentBackupRestoreQuarantinedCreateDependencies {
  createProvider(): Promise<ExactRestoreProvider>;
  claimOperation(input: {
    operationId: string;
    ownerId: string;
    claimMs: number;
  }): Promise<RestoreOperationClaimAuthority>;
  releaseClaim(input: {
    operationId: string;
    ownerId: string;
    claimGeneration: string;
  }): Promise<RestoreOperationAuthority>;
  reserveAndLoadAuthority(
    input: ReserveAgentBackupRestoreTargetAndStartReplacementIntentInput,
  ): Promise<RestoreCreateAuthority>;
  loadSource(input: AgentBackupRestoreSourceV3Input): Promise<
    Readonly<{
      vaultKeyAuthority: Readonly<{
        generationId: string;
        authorityReceiptDigest: string;
      }>;
    }>
  >;
  resolveImagePlatform(
    input: Readonly<{
      imageReference: string;
      imageDigest: string;
      platform: "linux/amd64" | "linux/arm64";
      signal?: AbortSignal;
    }>,
  ): Promise<AgentBackupRestoreExactImagePlatformAuthority>;
  recordImagePlatformAuthority(
    input: RecordAgentBackupRestoreExactImagePlatformAuthorityInput,
  ): Promise<
    Readonly<{
      operation: RestoreOperationAuthority;
      target: Readonly<
        AgentBackupRestoreTargetAuthority & {
          imageReference: string;
          imagePlatformDigest: string;
        }
      >;
      replayed: boolean;
    }>
  >;
  withVaultPassphrase<T>(
    input: Readonly<AgentBackupRestoreVaultPassphraseInput>,
    use: (passphrase: Uint8Array, signal: AbortSignal) => Promise<T> | T,
    options?: Readonly<AgentBackupRestoreVaultPassphraseOptions>,
  ): Promise<T>;
  createDedicatedSshClient(config: DockerSSHConfig): DedicatedRestoreSshClient;
  seedVaultPassphrase(
    input: Readonly<SeedRestoreVolumeVaultPassphraseBytesInput>,
  ): Promise<Readonly<AgentBackupRestoreVaultVolumeSeedResult>>;
  recordSeedReceipt(input: Readonly<RecordAgentVaultKeySeedReceiptInput>): Promise<{
    readonly operation: RestoreOperationAuthority;
    readonly replayed: boolean;
  }>;
  markProviderStarted(
    input: AgentSandboxExactRestoreProviderBoundaryInput,
  ): Promise<RestoreProviderBoundaryResult>;
  verifyProviderIntent(
    reference: AgentSandboxReplacementAttemptReference,
    locator: AgentSandboxReplacementLocatorInput,
  ): Promise<{ readonly replayed: boolean }>;
  recordCreated(
    input: AgentSandboxExactRestoreProviderBoundaryInput,
  ): Promise<RestoreProviderBoundaryResult>;
  recordProviderSucceeded(
    input: RecordAgentSandboxExactRestoreProviderSucceededInput,
  ): Promise<RestoreProviderBoundaryResult>;
  claimCleanup(input: {
    operationId: string;
    ownerId: string;
    replacementAttemptId: string;
    claimMs: number;
  }): Promise<AgentSandboxExactRestoreCleanupClaim>;
  beginCleanup(
    input: BeginAgentSandboxExactRestoreCleanupInput,
  ): Promise<RestoreProviderBoundaryResult>;
  finishCleanup(
    input: FinishAgentSandboxExactRestoreCleanupInput,
  ): Promise<RestoreProviderBoundaryResult>;
  releaseCleanupClaim(input: {
    operationId: string;
    ownerId: string;
    claimGeneration: string;
    replacementAttemptId: string;
  }): Promise<RestoreOperationAuthority>;
  randomUuid(): string;
}

export interface AgentBackupRestoreQuarantinedCreateInput {
  readonly operationId: string;
  readonly ownerId: string;
  readonly signal?: AbortSignal;
  readonly target: Readonly<{
    nodeRecordId: string;
    nodeId: string;
    nodeIncarnation: string;
    nodeHistoryId: string;
  }>;
  /** New candidate ID; response-loss replay adopts the already-persisted ID. */
  readonly replacementAttemptId: string;
  /** New token authority; response-loss replay adopts the already-persisted pair. */
  readonly activationTokenSha256: string;
  readonly activationTokenCiphertext: string;
}

export type AgentBackupRestoreQuarantinedCreateResult =
  | Readonly<{
      status: "created";
      operationId: string;
      replacementAttemptId: string;
      containerId: string;
      providerReceiptDigest: string;
      replayed: boolean;
    }>
  | Readonly<{
      status: "reconciliation_required";
      reason: "provider_already_started" | "provider_outcome_ambiguous";
      operationId: string;
      replacementAttemptId: string;
      containerId: string | null;
      claimReleased: boolean;
    }>;

export interface AgentBackupRestoreQuarantinedCreateReconciliationInput {
  readonly operationId: string;
  readonly ownerId: string;
  readonly replacementAttemptId: string;
}

export type AgentBackupRestoreQuarantinedCreateReconciliationResult =
  | Readonly<{
      status: "provider_succeeded";
      operationId: string;
      replacementAttemptId: string;
      containerId: string;
      providerReceiptDigest: string;
      replayed: true;
    }>
  | Readonly<{
      status: "cleanup_proven";
      operationId: string;
      replacementAttemptId: string;
      cleanupReceiptDigest: string;
      replayed: boolean;
    }>;

const PRODUCTION_DEPENDENCIES: AgentBackupRestoreQuarantinedCreateDependencies = {
  createProvider: async () => new DockerSandboxProvider(),
  claimOperation: claimAgentBackupRestoreOperation,
  releaseClaim: releaseAgentBackupRestoreOperationClaim,
  reserveAndLoadAuthority: reserveAgentBackupRestoreTargetAndStartReplacementIntent,
  loadSource: loadAgentBackupRestoreSourceV3,
  resolveImagePlatform: resolveAgentBackupRestoreExactImagePlatform,
  recordImagePlatformAuthority: recordAgentBackupRestoreExactImagePlatformAuthority,
  withVaultPassphrase: withAgentBackupRestoreVaultPassphrase,
  createDedicatedSshClient: (config) => new DockerSSHClient(config),
  seedVaultPassphrase: seedRestoreVolumeVaultPassphraseBytes,
  recordSeedReceipt: recordAgentVaultKeySeedReceipt,
  markProviderStarted: markAgentSandboxExactRestoreProviderStarted,
  verifyProviderIntent: verifyAgentSandboxExactRestoreReplacementIntent,
  recordCreated: recordAgentSandboxExactRestoreProviderCreated,
  recordProviderSucceeded: recordAgentSandboxExactRestoreProviderSucceeded,
  claimCleanup: claimAgentSandboxExactRestoreCleanup,
  beginCleanup: beginAgentSandboxExactRestoreCleanup,
  finishCleanup: finishAgentSandboxExactRestoreCleanup,
  releaseCleanupClaim: releaseAgentSandboxExactRestoreCleanupClaim,
  randomUuid: () => crypto.randomUUID(),
};

class ProviderStartReplayError extends Error {
  override readonly name = "ProviderStartReplayError";
}

interface HeldClaim {
  readonly generation: string;
}

function runtimeError(code: string, message: string, cause?: unknown): ElizaError {
  return new ElizaError(message, { code, cause, severity: "fatal" });
}

function throwIfRestoreCreateAborted(
  input: Readonly<AgentBackupRestoreQuarantinedCreateInput>,
): void {
  input.signal?.throwIfAborted();
}

function assertProviderCapabilities(
  provider: ExactRestoreProvider,
): asserts provider is SupportedExactRestoreProvider {
  if (
    provider.exactRestoreCreateCapability !== "stopped-quarantine-v1" ||
    provider.replacementCreateSettlementCapability !== "exact-success" ||
    typeof provider.stopOnSpecificNodeForReplacement !== "function"
  ) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_EXACT_PROVIDER_UNSUPPORTED",
      "Restore provider lacks exact stopped-quarantine settlement capability",
    );
  }
}

function sourceInput(operation: RestoreOperationAuthority): AgentBackupRestoreSourceV3Input {
  return {
    organizationId: operation.organization_id,
    agentId: operation.agent_id,
    backupId: operation.backup_id,
    operationId: operation.expected_operation_id,
    sourceActivationGeneration: operation.expected_activation_generation,
    sourceLifecycleRevision: operation.expected_lifecycle_revision.toString(),
    expectedManifestSha256: operation.expected_manifest_sha256,
    restoreAttemptId: operation.restore_attempt_id,
    leaseId: operation.lease_id,
    ownerId: operation.lease_owner_id,
    fencingToken: operation.lease_generation,
    catalogEpoch: operation.catalog_epoch.toString(),
    copyRole: operation.copy_role,
  };
}

function reserveInput(
  input: Readonly<AgentBackupRestoreQuarantinedCreateInput>,
  claimGeneration: string,
): ReserveAgentBackupRestoreTargetAndStartReplacementIntentInput {
  return {
    operationId: input.operationId,
    ownerId: input.ownerId,
    claimGeneration,
    targetNodeRecordId: input.target.nodeRecordId,
    targetNodeId: input.target.nodeId,
    targetNodeIncarnation: input.target.nodeIncarnation,
    targetNodeHistoryId: input.target.nodeHistoryId,
    replacementAttemptId: input.replacementAttemptId,
    activationTokenSha256: input.activationTokenSha256,
    activationTokenCiphertext: input.activationTokenCiphertext,
  };
}

const IMAGE_SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE_REPOSITORY_SEGMENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function digestPinnedImageReference(imageReference: string, imageDigest: string): string {
  if (!IMAGE_SHA256_DIGEST.test(imageDigest)) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_IMAGE_DIGEST_INVALID",
      "Restore image digest is not canonical",
    );
  }
  const trimmed = imageReference.trim();
  if (
    trimmed !== imageReference ||
    trimmed.length === 0 ||
    /\s/.test(trimmed) ||
    !trimmed.startsWith("ghcr.io/")
  ) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_IMAGE_REFERENCE_INVALID",
      "Restore image reference must use canonical ghcr.io authority",
    );
  }

  const locator = trimmed.slice("ghcr.io/".length);
  const at = locator.indexOf("@");
  let repositoryLocator: string;
  if (at === -1) {
    repositoryLocator = locator;
  } else {
    if (at !== locator.lastIndexOf("@")) {
      throw runtimeError(
        "AGENT_BACKUP_RESTORE_IMAGE_REFERENCE_INVALID",
        "Restore image reference has extra authority",
      );
    }
    repositoryLocator = locator.slice(0, at);
    if (!IMAGE_SHA256_DIGEST.test(locator.slice(at + 1))) {
      throw runtimeError(
        "AGENT_BACKUP_RESTORE_IMAGE_REFERENCE_INVALID",
        "Digest-pinned restore image reference is not canonical",
      );
    }
  }

  const lastSlash = repositoryLocator.lastIndexOf("/");
  const tagIndex = repositoryLocator.lastIndexOf(":");
  let repository: string;
  if (tagIndex > lastSlash) {
    if (!IMAGE_TAG.test(repositoryLocator.slice(tagIndex + 1))) {
      throw runtimeError(
        "AGENT_BACKUP_RESTORE_IMAGE_REFERENCE_INVALID",
        "Restore image tag locator is invalid",
      );
    }
    repository = repositoryLocator.slice(0, tagIndex);
  } else {
    if (at === -1) {
      throw runtimeError(
        "AGENT_BACKUP_RESTORE_IMAGE_REFERENCE_INVALID",
        "Restore image locator must include a tag or digest",
      );
    }
    repository = repositoryLocator;
  }

  const repositorySegments = repository.split("/");
  if (
    repository.length > 255 ||
    repositorySegments.length < 2 ||
    repositorySegments.some((segment) => !IMAGE_REPOSITORY_SEGMENT.test(segment))
  ) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_IMAGE_REFERENCE_INVALID",
      "Restore image repository is not canonical lowercase GHCR authority",
    );
  }
  return `ghcr.io/${repository}@${imageDigest}`;
}

function exactImageAuthorityFromOperation(
  operation: Readonly<RestoreOperationAuthority>,
): Readonly<AgentBackupRestoreExactImagePlatformAuthority> {
  const imageDigest = operation.expected_image_digest;
  const imageReference = operation.expected_image_reference;
  const imagePlatformDigest = operation.expected_image_platform_digest;
  const platform = operation.expected_image_platform;
  if (
    imageDigest === null ||
    imageReference === null ||
    imagePlatformDigest === null ||
    (platform !== "linux/amd64" && platform !== "linux/arm64") ||
    !/^sha256:[0-9a-f]{64}$/.test(imagePlatformDigest) ||
    !imageReference.startsWith("ghcr.io/") ||
    digestPinnedImageReference(imageReference, imageDigest) !== imageReference
  ) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_EXACT_IMAGE_AUTHORITY_INCOMPLETE",
      "Restore operation lacks its complete write-once exact image authority",
    );
  }
  return Object.freeze({ imageReference, imageDigest, imagePlatformDigest, platform });
}

function platformImageReference(
  authority: Readonly<AgentBackupRestoreExactImagePlatformAuthority>,
): string {
  const separator = authority.imageReference.indexOf("@");
  if (separator < 1) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_EXACT_IMAGE_AUTHORITY_INCOMPLETE",
      "Restore exact image authority lacks its parent digest separator",
    );
  }
  return `${authority.imageReference.slice(0, separator)}@${authority.imagePlatformDigest}`;
}

function assertResolvedImageAuthorityMatchesCreate(
  authority: Readonly<RestoreCreateAuthority>,
  image: Readonly<AgentBackupRestoreExactImagePlatformAuthority>,
): void {
  const sandboxReference = digestPinnedImageReference(
    authority.sandbox.dockerImageReference,
    authority.target.imageDigest,
  );
  if (
    authority.target.imageDigest !== image.imageDigest ||
    authority.target.platform !== image.platform ||
    sandboxReference !== image.imageReference
  ) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_IMAGE_AUTHORITY_MISMATCH",
      "Restore registry generation differs from its reserved sandbox authority",
    );
  }
}

function durableImageAuthorityFromCreate(
  authority: Readonly<RestoreCreateAuthority>,
): Readonly<AgentBackupRestoreExactImagePlatformAuthority> {
  const image = exactImageAuthorityFromOperation(authority.operation);
  if (
    authority.target.imageDigest !== image.imageDigest ||
    authority.target.platform !== image.platform ||
    authority.target.imageReference !== image.imageReference ||
    authority.target.imagePlatformDigest !== image.imagePlatformDigest ||
    digestPinnedImageReference(
      authority.sandbox.dockerImageReference,
      authority.target.imageDigest,
    ) !== image.imageReference
  ) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_IMAGE_AUTHORITY_MISMATCH",
      "Restore create authority differs from its persisted exact image generation",
    );
  }
  return image;
}

function assertMetadataValue(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
  expected: string | number | boolean,
): void {
  if (metadata[key] !== expected) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_PROVIDER_HANDLE_MISMATCH",
      `Restore provider handle changed ${key}`,
    );
  }
}

function exactLocatorFromHandle(params: {
  handle: Readonly<SandboxHandle>;
  authority: Readonly<RestoreCreateAuthority>;
  requireContainerId: boolean;
}): AgentSandboxReplacementLocatorInput {
  const { handle, authority } = params;
  const image = durableImageAuthorityFromCreate(authority);
  const metadata = handle.metadata;
  if (!metadata || handle.bridgeUrl !== "" || handle.healthUrl !== "") {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_PROVIDER_HANDLE_ROUTABLE",
      "Restore provider returned a routable or metadata-free quarantine handle",
    );
  }
  if (handle.sandboxId !== authority.locator.sandboxId) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_PROVIDER_HANDLE_MISMATCH",
      "Restore provider changed the deterministic sandbox identity",
    );
  }
  const exactVolumePath = deriveRestoreStagingVolumePathV1(
    authority.operation.agent_id,
    authority.operation.restore_attempt_id,
  );
  for (const [key, expected] of [
    ["provider", "docker"],
    ["nodeId", authority.locator.nodeId],
    ["hostname", authority.locator.nodeHostname],
    ["nodeRecordId", authority.locator.nodeRecordId],
    ["nodeIncarnation", authority.locator.nodeIncarnation],
    ["nodeHistoryId", authority.locator.nodeHistoryId],
    ["nodeSshPort", authority.locator.nodeSshPort],
    ["nodeSshUser", authority.locator.nodeSshUser],
    ["nodeHostKeyFingerprint", authority.locator.nodeHostKeyFingerprint],
    ["containerName", authority.locator.containerName],
    ["agentId", authority.operation.agent_id],
    ["volumePath", exactVolumePath],
    ["dockerImage", platformImageReference(image)],
    ["imageDigest", authority.target.imageDigest],
    ["imageIndexReference", image.imageReference],
    ["imagePlatformDigest", image.imagePlatformDigest],
    ["imagePlatform", image.platform],
    ["replacementAttemptId", authority.attempt.id],
    ["restoreAttemptId", authority.operation.restore_attempt_id],
    ["replacementSecretCleanupVersion", 1],
    ["quarantine", true],
    ["allocationCounted", true],
    ["bridgePort", 0],
    ["webUiPort", 0],
  ] as const) {
    assertMetadataValue(metadata, key, expected);
  }
  for (const key of [
    "headscaleIp",
    "vpnNodeId",
    "vpnNodeName",
    "previousVpnNodeId",
    "vpnRegistrationStartedAt",
  ] as const) {
    if (key in metadata) {
      throw runtimeError(
        "AGENT_BACKUP_RESTORE_PROVIDER_HANDLE_PUBLICATION_FORBIDDEN",
        "Restore quarantine provider returned publication metadata",
      );
    }
  }
  const containerId = metadata.containerId;
  if (params.requireContainerId) {
    if (typeof containerId !== "string" || !/^[0-9a-f]{64}$/.test(containerId)) {
      throw runtimeError(
        "AGENT_BACKUP_RESTORE_PROVIDER_CONTAINER_ID_INVALID",
        "Restore provider did not return the full immutable Docker container ID",
      );
    }
  } else if (containerId !== undefined && containerId !== null) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_PROVIDER_PRECREATE_ID_FORBIDDEN",
      "Restore provider intent callback already carried a container ID",
    );
  }
  return {
    ...authority.locator,
    containerId: params.requireContainerId ? (containerId as string) : null,
  };
}

export function buildAgentBackupRestoreExactProviderReceiptDigestV1(params: {
  operation: Readonly<RestoreOperationAuthority>;
  replacementAttemptId: string;
  locator: Readonly<AgentSandboxReplacementLocatorInput>;
}): string {
  const image = exactImageAuthorityFromOperation(params.operation);
  const containerId = params.locator.containerId;
  if (
    !containerId ||
    !/^[0-9a-f]{64}$/.test(containerId) ||
    params.locator.replacementAttemptId !== params.replacementAttemptId ||
    params.locator.nodeRecordId !== params.operation.expected_node_record_id ||
    params.locator.nodeIncarnation !== params.operation.expected_node_incarnation ||
    params.locator.nodeHistoryId !== params.operation.expected_node_history_id ||
    params.locator.containerName !==
      `agent-restore-${params.operation.agent_id}-${params.operation.restore_attempt_id}`
  ) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_PROVIDER_RECEIPT_INCOMPLETE",
      "Restore provider receipt requires exact image and container authority",
    );
  }
  assertSandboxReplacementAttemptId(params.replacementAttemptId);
  const operation = params.operation;
  return createHash("sha256")
    .update(
      JSON.stringify({
        format: AGENT_BACKUP_RESTORE_EXACT_PROVIDER_RECEIPT_FORMAT,
        outcome: "succeeded",
        quarantine: true,
        operationId: operation.id,
        organizationId: operation.organization_id,
        agentId: operation.agent_id,
        backupId: operation.backup_id,
        restoreAttemptId: operation.restore_attempt_id,
        replacementAttemptId: params.replacementAttemptId,
        nodeRecordId: params.locator.nodeRecordId,
        nodeId: params.locator.nodeId,
        nodeIncarnation: params.locator.nodeIncarnation,
        nodeHistoryId: params.locator.nodeHistoryId,
        containerName: params.locator.containerName,
        containerId,
        imageReference: image.imageReference,
        imageDigest: image.imageDigest,
        imagePlatform: image.platform,
        imagePlatformDigest: image.imagePlatformDigest,
      }),
      "utf8",
    )
    .digest("hex");
}

/** Deterministic proof identity retained only after exact remote absence. */
export function buildAgentBackupRestoreExactCleanupReceiptDigestV1(params: {
  operation: Readonly<RestoreOperationAuthority>;
  replacementAttemptId: string;
  locator: Readonly<AgentSandboxReplacementLocatorInput>;
}): string {
  const { operation, locator } = params;
  assertSandboxReplacementAttemptId(params.replacementAttemptId);
  if (
    locator.replacementAttemptId !== params.replacementAttemptId ||
    !/^sha256:[0-9a-f]{64}$/.test(operation.expected_image_digest ?? "")
  ) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_CLEANUP_RECEIPT_AUTHORITY_INVALID",
      "Restore cleanup receipt lacks canonical exact authority",
    );
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        format: AGENT_BACKUP_RESTORE_EXACT_CLEANUP_RECEIPT_FORMAT,
        outcome: "remote_absence_proven",
        quarantine: true,
        operationId: operation.id,
        organizationId: operation.organization_id,
        agentId: operation.agent_id,
        backupId: operation.backup_id,
        restoreAttemptId: operation.restore_attempt_id,
        replacementAttemptId: params.replacementAttemptId,
        imageDigest: operation.expected_image_digest,
        stagingVolumePath: deriveRestoreStagingVolumePathV1(
          operation.agent_id,
          operation.restore_attempt_id,
        ),
        nodeRecordId: locator.nodeRecordId,
        nodeId: locator.nodeId,
        nodeIncarnation: locator.nodeIncarnation,
        nodeHistoryId: locator.nodeHistoryId,
        nodeHostname: locator.nodeHostname,
        nodeSshPort: locator.nodeSshPort,
        nodeSshUser: locator.nodeSshUser,
        nodeHostKeyFingerprint: locator.nodeHostKeyFingerprint,
        containerName: locator.containerName,
        containerId: locator.containerId,
        replacementSecretCleanupVersion: locator.replacementSecretCleanupVersion,
        allocationCounted: locator.allocationCounted,
        vpnNodeName: locator.vpnNodeName,
        vpnRegistrationStartedAt: locator.vpnRegistrationStartedAt,
        previousVpnNodeId: locator.previousVpnNodeId,
        vpnNodeId: locator.vpnNodeId,
      }),
      "utf8",
    )
    .digest("hex");
}

async function releaseHeldClaim(
  input: Readonly<AgentBackupRestoreQuarantinedCreateInput>,
  state: { current: HeldClaim | null },
  dependencies: Readonly<AgentBackupRestoreQuarantinedCreateDependencies>,
): Promise<void> {
  const current = state.current;
  if (!current) return;
  await dependencies.releaseClaim({
    operationId: input.operationId,
    ownerId: input.ownerId,
    claimGeneration: current.generation,
  });
  state.current = null;
}

async function releaseHeldClaimSafely(
  input: Readonly<AgentBackupRestoreQuarantinedCreateInput>,
  state: { current: HeldClaim | null },
  dependencies: Readonly<AgentBackupRestoreQuarantinedCreateDependencies>,
): Promise<boolean> {
  try {
    await releaseHeldClaim(input, state, dependencies);
    return true;
  } catch (error) {
    // error-policy:J6 reconciliation remains explicit while claim-release
    // teardown is best effort; retain diagnostics for the stuck claim.
    logger.warn("[AgentBackupRestoreQuarantinedCreate] Failed to release operation claim", {
      error,
      operationId: input.operationId,
      replacementAttemptId: input.replacementAttemptId,
    });
    return false;
  }
}

async function claim(
  input: Readonly<AgentBackupRestoreQuarantinedCreateInput>,
  state: { current: HeldClaim | null },
  dependencies: Readonly<AgentBackupRestoreQuarantinedCreateDependencies>,
): Promise<RestoreOperationClaimAuthority> {
  throwIfRestoreCreateAborted(input);
  const claimed = await dependencies.claimOperation({
    operationId: input.operationId,
    ownerId: input.ownerId,
    claimMs: AGENT_BACKUP_RESTORE_QUARANTINED_CREATE_CLAIM_MS,
  });
  state.current = { generation: claimed.claimGeneration };
  throwIfRestoreCreateAborted(input);
  return claimed;
}

function reconciledSuccess(params: {
  input: Readonly<AgentBackupRestoreQuarantinedCreateInput>;
  authority: Readonly<RestoreCreateAuthority>;
}): AgentBackupRestoreQuarantinedCreateResult {
  const containerId = params.authority.locator.containerId;
  if (
    params.authority.operation.phase !== "container_created" ||
    params.authority.attempt.state !== "provider_succeeded" ||
    params.authority.attempt.provider_started_at === null ||
    params.authority.attempt.provider_succeeded_at === null ||
    params.authority.attempt.provider_receipt_digest === null ||
    !containerId ||
    params.authority.attempt.locator_container_id !== containerId
  ) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_PROVIDER_REPLAY_INCOMPLETE",
      "Restore provider replay lacks exact settled container authority",
    );
  }
  const expectedDigest = buildAgentBackupRestoreExactProviderReceiptDigestV1({
    operation: params.authority.operation,
    replacementAttemptId: params.authority.attempt.id,
    locator: params.authority.locator,
  });
  if (params.authority.attempt.provider_receipt_digest !== expectedDigest) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_PROVIDER_RECEIPT_MISMATCH",
      "Restore provider replay receipt differs from deterministic authority",
    );
  }
  return Object.freeze({
    status: "created",
    operationId: params.input.operationId,
    replacementAttemptId: params.authority.attempt.id,
    containerId,
    providerReceiptDigest: expectedDigest,
    replayed: true,
  });
}

function exactLocatorsMatch(
  left: Readonly<AgentSandboxReplacementLocatorInput>,
  right: Readonly<AgentSandboxReplacementLocatorInput>,
): boolean {
  return (
    left.replacementAttemptId === right.replacementAttemptId &&
    left.sandboxId === right.sandboxId &&
    left.nodeId === right.nodeId &&
    left.containerName === right.containerName &&
    left.nodeRecordId === right.nodeRecordId &&
    left.nodeIncarnation === right.nodeIncarnation &&
    left.nodeHistoryId === right.nodeHistoryId &&
    left.nodeHostname === right.nodeHostname &&
    left.nodeSshPort === right.nodeSshPort &&
    left.nodeSshUser === right.nodeSshUser &&
    left.nodeHostKeyFingerprint === right.nodeHostKeyFingerprint &&
    left.replacementSecretCleanupVersion === right.replacementSecretCleanupVersion &&
    left.allocationCounted === right.allocationCounted &&
    left.vpnNodeName === right.vpnNodeName &&
    left.vpnRegistrationStartedAt === right.vpnRegistrationStartedAt &&
    left.previousVpnNodeId === right.previousVpnNodeId &&
    left.containerId === right.containerId &&
    left.vpnNodeId === right.vpnNodeId
  );
}

function attemptRetainsProviderSuccess(attempt: Readonly<ReplacementAttemptAuthority>): boolean {
  const hasTimestamp = attempt.provider_succeeded_at !== null;
  const hasReceipt = attempt.provider_receipt_digest !== null;
  if (hasTimestamp !== hasReceipt) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_PROVIDER_RECEIPT_PARTIAL",
      "Restore replacement attempt has partial provider success authority",
    );
  }
  return hasReceipt;
}

function nullableDatesMatch(left: Date | null, right: Date | null): boolean {
  return left === null ? right === null : right !== null && left.getTime() === right.getTime();
}

function assertExactCleanupAuthority(params: {
  input: Readonly<AgentBackupRestoreQuarantinedCreateReconciliationInput>;
  operation: Readonly<RestoreOperationAuthority>;
  attempt: Readonly<ReplacementAttemptAuthority>;
  locator: Readonly<AgentSandboxReplacementLocatorInput>;
}): void {
  const { input, operation, attempt, locator } = params;
  if (
    operation.id !== input.operationId ||
    attempt.id !== input.replacementAttemptId ||
    locator.replacementAttemptId !== input.replacementAttemptId ||
    locator.replacementSecretCleanupVersion !== 1 ||
    locator.allocationCounted !== true ||
    locator.nodeRecordId !== operation.expected_node_record_id ||
    locator.nodeIncarnation !== operation.expected_node_incarnation ||
    locator.nodeHistoryId !== operation.expected_node_history_id ||
    locator.vpnNodeName !== null ||
    locator.vpnRegistrationStartedAt !== null ||
    locator.previousVpnNodeId !== null ||
    locator.vpnNodeId !== null
  ) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_CLEANUP_AUTHORITY_MISMATCH",
      "Restore cleanup claim returned a non-exact replacement locator",
    );
  }
}

function assertCleanupClaimReleased(params: {
  input: Readonly<AgentBackupRestoreQuarantinedCreateReconciliationInput>;
  claimed: Readonly<RestoreOperationAuthority>;
  released: Readonly<RestoreOperationAuthority>;
}): void {
  const { input, claimed, released } = params;
  if (
    released.id !== input.operationId ||
    released.organization_id !== claimed.organization_id ||
    released.agent_id !== claimed.agent_id ||
    released.backup_id !== claimed.backup_id ||
    released.restore_attempt_id !== claimed.restore_attempt_id ||
    released.lease_id !== claimed.lease_id ||
    released.lease_generation !== claimed.lease_generation ||
    released.phase !== claimed.phase ||
    released.expected_node_record_id !== claimed.expected_node_record_id ||
    released.expected_node_incarnation !== claimed.expected_node_incarnation ||
    released.expected_node_history_id !== claimed.expected_node_history_id ||
    released.expected_container_id !== claimed.expected_container_id ||
    released.expected_image_digest !== claimed.expected_image_digest ||
    released.expected_image_platform !== claimed.expected_image_platform ||
    released.expected_image_reference !== claimed.expected_image_reference ||
    released.expected_image_platform_digest !== claimed.expected_image_platform_digest ||
    released.claim_owner !== null ||
    released.claim_generation !== null ||
    released.claim_expires_at !== null
  ) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_CLEANUP_RELEASE_INVALID",
      "Restore cleanup claim release changed exact durable authority",
    );
  }
}

/**
 * Reconcile one ambiguous exact create by fencing callbacks before remote
 * cleanup. The DB supplies the locator; caller/error metadata is never remote
 * cleanup authority. A retry after cleanup must use a new replacement ID.
 */
export async function reconcileAgentBackupRestoreQuarantinedCreate(
  input: Readonly<AgentBackupRestoreQuarantinedCreateReconciliationInput>,
  dependencies: Readonly<AgentBackupRestoreQuarantinedCreateDependencies> = PRODUCTION_DEPENDENCIES,
): Promise<AgentBackupRestoreQuarantinedCreateReconciliationResult> {
  assertSandboxReplacementAttemptId(input.replacementAttemptId);
  const provider = await dependencies.createProvider();
  assertProviderCapabilities(provider);

  const claimed = await dependencies.claimCleanup({
    operationId: input.operationId,
    ownerId: input.ownerId,
    replacementAttemptId: input.replacementAttemptId,
    claimMs: AGENT_BACKUP_RESTORE_QUARANTINED_CREATE_CLAIM_MS,
  });

  if (claimed.status === "cleanup_proven") {
    assertExactCleanupAuthority({ input, ...claimed });
    attemptRetainsProviderSuccess(claimed.attempt);
    const deterministicCleanupDigest = buildAgentBackupRestoreExactCleanupReceiptDigestV1({
      operation: claimed.operation,
      replacementAttemptId: input.replacementAttemptId,
      locator: claimed.locator,
    });
    if (
      claimed.operation.phase !== "vault_seeded" ||
      claimed.attempt.state !== "cleanup_proven" ||
      claimed.attempt.cleanup_proven_at === null ||
      claimed.attempt.cleanup_receipt_digest !== deterministicCleanupDigest
    ) {
      throw runtimeError(
        "AGENT_BACKUP_RESTORE_CLEANUP_REPLAY_INVALID",
        "Restore cleanup replay differs from deterministic remote-absence authority",
      );
    }
    return Object.freeze({
      status: "cleanup_proven",
      operationId: input.operationId,
      replacementAttemptId: input.replacementAttemptId,
      cleanupReceiptDigest: deterministicCleanupDigest,
      replayed: true,
    });
  }

  if (claimed.status !== "claimed" || claimed.claimGeneration === null) {
    throw runtimeError(
      "AGENT_BACKUP_RESTORE_CLEANUP_CLAIM_INVALID",
      "Restore cleanup claim returned an unknown reconciliation state",
    );
  }
  const claimGeneration = claimed.claimGeneration;
  let cleanupClaimHeld = true;
  try {
    assertExactCleanupAuthority({ input, ...claimed });
    const claimedRetainsProviderSuccess = attemptRetainsProviderSuccess(claimed.attempt);
    if (claimed.attempt.state === "provider_succeeded") {
      const containerId = claimed.locator.containerId;
      const persistedReceiptDigest = claimed.attempt.provider_receipt_digest;
      if (
        !claimedRetainsProviderSuccess ||
        claimed.operation.phase !== "container_created" ||
        claimed.attempt.provider_started_at === null ||
        !containerId ||
        claimed.operation.expected_container_id !== containerId ||
        claimed.attempt.locator_container_id !== containerId ||
        persistedReceiptDigest === null
      ) {
        throw runtimeError(
          "AGENT_BACKUP_RESTORE_CLEANUP_PROVIDER_SUCCESS_INVALID",
          "Restore cleanup reconciliation found incomplete provider success",
        );
      }
      const expectedReceiptDigest = buildAgentBackupRestoreExactProviderReceiptDigestV1({
        operation: claimed.operation,
        replacementAttemptId: input.replacementAttemptId,
        locator: claimed.locator,
      });
      if (persistedReceiptDigest !== expectedReceiptDigest) {
        throw runtimeError(
          "AGENT_BACKUP_RESTORE_PROVIDER_RECEIPT_MISMATCH",
          "Restore provider reconciliation receipt differs from durable exact authority",
        );
      }
      const released = await dependencies.releaseCleanupClaim({
        operationId: input.operationId,
        ownerId: input.ownerId,
        claimGeneration,
        replacementAttemptId: input.replacementAttemptId,
      });
      cleanupClaimHeld = false;
      assertCleanupClaimReleased({ input, claimed: claimed.operation, released });
      return Object.freeze({
        status: "provider_succeeded",
        operationId: input.operationId,
        replacementAttemptId: input.replacementAttemptId,
        containerId,
        providerReceiptDigest: expectedReceiptDigest,
        replayed: true,
      });
    }
    if (
      claimed.attempt.state !== "in_flight_unresolved" &&
      claimed.attempt.state !== "cleanup_in_progress"
    ) {
      throw runtimeError(
        "AGENT_BACKUP_RESTORE_CLEANUP_CLAIM_INVALID",
        "Restore cleanup claim returned an unsupported attempt state",
      );
    }
    if (claimed.attempt.state === "in_flight_unresolved" && claimedRetainsProviderSuccess) {
      throw runtimeError(
        "AGENT_BACKUP_RESTORE_CLEANUP_PROVIDER_SUCCESS_INVALID",
        "Unsettled restore cleanup unexpectedly retained provider success",
      );
    }
    const expectedFencedPhase = claimedRetainsProviderSuccess
      ? "container_created"
      : "vault_seeded";
    const expectedFencedContainerId = claimedRetainsProviderSuccess
      ? claimed.locator.containerId
      : null;
    if (
      (claimedRetainsProviderSuccess &&
        (claimed.attempt.provider_started_at === null ||
          claimed.locator.containerId === null ||
          claimed.attempt.locator_container_id !== claimed.locator.containerId)) ||
      claimed.operation.phase !== expectedFencedPhase ||
      claimed.operation.expected_container_id !== expectedFencedContainerId
    ) {
      throw runtimeError(
        "AGENT_BACKUP_RESTORE_CLEANUP_CLAIM_INVALID",
        "Restore cleanup claim phase differs from retained provider authority",
      );
    }
    const fenced = await dependencies.beginCleanup({
      operationId: input.operationId,
      ownerId: input.ownerId,
      claimGeneration,
      replacementAttemptId: input.replacementAttemptId,
    });
    assertExactCleanupAuthority({ input, ...fenced });
    const fencedRetainsProviderSuccess = attemptRetainsProviderSuccess(fenced.attempt);
    if (
      fenced.operation.phase !== expectedFencedPhase ||
      fenced.operation.expected_container_id !== expectedFencedContainerId ||
      fenced.attempt.state !== "cleanup_in_progress" ||
      fencedRetainsProviderSuccess !== claimedRetainsProviderSuccess ||
      !nullableDatesMatch(
        fenced.attempt.provider_succeeded_at,
        claimed.attempt.provider_succeeded_at,
      ) ||
      fenced.attempt.provider_receipt_digest !== claimed.attempt.provider_receipt_digest ||
      fenced.operation.claim_owner !== input.ownerId ||
      fenced.operation.claim_generation !== claimGeneration ||
      !exactLocatorsMatch(claimed.locator, fenced.locator)
    ) {
      throw runtimeError(
        "AGENT_BACKUP_RESTORE_CLEANUP_FENCE_INVALID",
        "Restore cleanup-begin did not retain its serialized exact authority",
      );
    }

    const locator = fenced.locator;
    await provider.stopOnSpecificNodeForReplacement(
      locator.nodeId,
      locator.containerName,
      locator.vpnNodeId,
      {
        nodeRecordId: locator.nodeRecordId,
        nodeIncarnation: locator.nodeIncarnation,
        nodeHistoryId: locator.nodeHistoryId,
        nodeHostname: locator.nodeHostname,
        nodeSshPort: locator.nodeSshPort,
        nodeSshUser: locator.nodeSshUser,
        nodeHostKeyFingerprint: locator.nodeHostKeyFingerprint,
        replacementSecretCleanupVersion: locator.replacementSecretCleanupVersion,
        replacementAttemptId: locator.replacementAttemptId,
        restoreAttemptId: fenced.operation.restore_attempt_id,
        containerId: locator.containerId,
        vpnNodeName: locator.vpnNodeName,
        previousVpnNodeId: locator.previousVpnNodeId,
        vpnRegistrationStartedAt: locator.vpnRegistrationStartedAt,
        allocationCounted: locator.allocationCounted,
      },
    );

    const cleanupReceiptDigest = buildAgentBackupRestoreExactCleanupReceiptDigestV1({
      operation: fenced.operation,
      replacementAttemptId: input.replacementAttemptId,
      locator,
    });
    const finished = await dependencies.finishCleanup({
      operationId: input.operationId,
      ownerId: input.ownerId,
      claimGeneration,
      replacementAttemptId: input.replacementAttemptId,
      locator,
      cleanupReceiptDigest,
    });
    cleanupClaimHeld = false;
    assertExactCleanupAuthority({ input, ...finished });
    if (
      finished.operation.phase !== "vault_seeded" ||
      finished.operation.claim_owner !== null ||
      finished.operation.claim_generation !== null ||
      finished.operation.claim_expires_at !== null ||
      finished.operation.expected_container_id !== null ||
      finished.attempt.state !== "cleanup_proven" ||
      finished.attempt.cleanup_proven_at === null ||
      finished.attempt.cleanup_receipt_digest !== cleanupReceiptDigest ||
      attemptRetainsProviderSuccess(finished.attempt) !== claimedRetainsProviderSuccess ||
      !nullableDatesMatch(
        finished.attempt.provider_succeeded_at,
        claimed.attempt.provider_succeeded_at,
      ) ||
      finished.attempt.provider_receipt_digest !== claimed.attempt.provider_receipt_digest ||
      !exactLocatorsMatch(locator, finished.locator)
    ) {
      throw runtimeError(
        "AGENT_BACKUP_RESTORE_CLEANUP_SETTLEMENT_INVALID",
        "Restore cleanup settlement did not release exact serialized authority",
      );
    }
    return Object.freeze({
      status: "cleanup_proven",
      operationId: input.operationId,
      replacementAttemptId: input.replacementAttemptId,
      cleanupReceiptDigest,
      replayed: fenced.replayed || finished.replayed,
    });
  } catch (error) {
    // error-policy:J2 preserve the primary cleanup failure while releasing its claim.
    if (!cleanupClaimHeld) throw error;
    try {
      await dependencies.releaseCleanupClaim({
        operationId: input.operationId,
        ownerId: input.ownerId,
        claimGeneration,
        replacementAttemptId: input.replacementAttemptId,
      });
    } catch (releaseError) {
      // error-policy:J2 retain both the primary and claim-release failures.
      throw new AggregateError(
        [error, releaseError],
        "Restore cleanup failed and its serialized claim could not be released",
      );
    }
    throw error;
  }
}

/**
 * Create one exact restore candidate and stop at the quarantine boundary.
 *
 * Once the provider-start CAS commits, every error becomes an explicit
 * reconciliation result. The same provider attempt is never invoked twice.
 */
export async function runAgentBackupRestoreQuarantinedCreate(
  input: Readonly<AgentBackupRestoreQuarantinedCreateInput>,
  dependencies: Readonly<AgentBackupRestoreQuarantinedCreateDependencies> = PRODUCTION_DEPENDENCIES,
): Promise<AgentBackupRestoreQuarantinedCreateResult> {
  assertSandboxReplacementAttemptId(input.replacementAttemptId);
  throwIfRestoreCreateAborted(input);
  const provider = await dependencies.createProvider();
  throwIfRestoreCreateAborted(input);
  assertProviderCapabilities(provider);
  const claimState: { current: HeldClaim | null } = { current: null };

  try {
    const initialClaim = await claim(input, claimState, dependencies);
    let authority = await dependencies.reserveAndLoadAuthority(
      reserveInput(input, initialClaim.claimGeneration),
    );
    throwIfRestoreCreateAborted(input);

    // A response may be lost after a retry intent commits but before its
    // attempt-scoped vault receipt does. Re-seeding the same deterministic
    // passphrase is safe while the provider start fence is still empty, and
    // the receipt writer distinguishes a replay (claim retained) from a new
    // receipt (claim consumed). This also gives every post-cleanup replacement
    // attempt its own seed receipt without rewinding the operation phase.
    if (
      authority.attempt.state === "in_flight_unresolved" &&
      authority.attempt.provider_started_at === null &&
      (authority.operation.phase === "reserved" || authority.operation.phase === "vault_seeded")
    ) {
      throwIfRestoreCreateAborted(input);
      const source = await dependencies.loadSource(sourceInput(authority.operation));
      throwIfRestoreCreateAborted(input);
      const ssh = dependencies.createDedicatedSshClient({
        hostname: authority.locator.nodeHostname,
        port: authority.locator.nodeSshPort,
        username: authority.locator.nodeSshUser,
        hostKeyFingerprint: authority.locator.nodeHostKeyFingerprint,
      });
      let seed: Readonly<AgentBackupRestoreVaultVolumeSeedResult>;
      try {
        seed = await dependencies.withVaultPassphrase(
          {
            ...sourceInput(authority.operation),
            restoreOperationId: authority.operation.id,
            restoreClaimGeneration: initialClaim.claimGeneration,
            targetNodeRecordId: authority.target.nodeRecordId,
            targetNodeIncarnation: authority.target.nodeIncarnation,
            targetNodeHistoryId: authority.target.nodeHistoryId,
            expectedActivationTokenSha256: authority.sandbox.activationTokenSha256,
            vaultKeyGenerationId: source.vaultKeyAuthority.generationId,
            vaultKeyAuthorityReceiptDigest: source.vaultKeyAuthority.authorityReceiptDigest,
          },
          async (passphrase, signal) => {
            const handoffSignal = input.signal ? AbortSignal.any([signal, input.signal]) : signal;
            handoffSignal.throwIfAborted();
            return await dependencies.seedVaultPassphrase({
              agentId: authority.operation.agent_id,
              restoreAttemptId: authority.operation.restore_attempt_id,
              replacementAttemptId: authority.attempt.id,
              passphrase,
              signal: handoffSignal,
              execStdin: async (command, stdin, execSignal) => {
                if (execSignal !== handoffSignal) {
                  throw runtimeError(
                    "AGENT_BACKUP_RESTORE_VAULT_SIGNAL_DRIFT",
                    "Restore vault seed changed its mandatory cancellation signal",
                  );
                }
                await ssh.execStdinAbortable(
                  buildExactRestoreBootFencedCommand(authority.target.nodeIncarnation, command),
                  stdin,
                  execSignal,
                );
              },
            });
          },
        );
      } finally {
        await ssh.disconnect();
      }

      throwIfRestoreCreateAborted(input);

      const recordedSeed = await dependencies.recordSeedReceipt({
        receiptId: dependencies.randomUuid(),
        receiptDigest: seed.receiptDigest,
        organizationId: authority.operation.organization_id,
        agentId: authority.operation.agent_id,
        backupId: authority.operation.backup_id,
        restoreAttemptId: authority.operation.restore_attempt_id,
        replacementAttemptId: authority.attempt.id,
        leaseId: authority.operation.lease_id,
        leaseOwnerId: authority.operation.lease_owner_id,
        leaseFencingToken: authority.operation.lease_generation,
        restoreOperationId: authority.operation.id,
        restoreClaimGeneration: initialClaim.claimGeneration,
        targetActivationGeneration: authority.operation.restore_attempt_id,
        targetNodeRecordId: authority.target.nodeRecordId,
        targetNodeIncarnation: authority.target.nodeIncarnation,
        targetNodeHistoryId: authority.target.nodeHistoryId,
        targetImageDigest: authority.target.imageDigest,
        expectedActivationTokenSha256: authority.sandbox.activationTokenSha256,
      });
      if (!recordedSeed.replayed) {
        // A newly appended first-seed or retry-seed receipt consumes its claim
        // atomically. A byte-identical replay intentionally retains the live
        // claim, so the provider start CAS can use it without a release gap.
        claimState.current = null;
        throwIfRestoreCreateAborted(input);
        const providerClaim = await claim(input, claimState, dependencies);
        authority = await dependencies.reserveAndLoadAuthority(
          reserveInput(input, providerClaim.claimGeneration),
        );
        throwIfRestoreCreateAborted(input);
      } else {
        throwIfRestoreCreateAborted(input);
      }
    }

    if (
      (authority.target.imageReference === null) !==
      (authority.target.imagePlatformDigest === null)
    ) {
      throw runtimeError(
        "AGENT_BACKUP_RESTORE_EXACT_IMAGE_AUTHORITY_INCOMPLETE",
        "Restore target returned a partial exact image platform authority",
      );
    }
    if (authority.target.imageReference === null) {
      if (
        authority.operation.phase !== "vault_seeded" ||
        authority.attempt.provider_started_at !== null ||
        !claimState.current
      ) {
        throw runtimeError(
          "AGENT_BACKUP_RESTORE_EXACT_IMAGE_BIND_PHASE_INVALID",
          "Restore exact image authority must bind before the first provider effect",
        );
      }
      const targetImageReference = digestPinnedImageReference(
        authority.sandbox.dockerImageReference,
        authority.target.imageDigest,
      );
      const resolvedImage = await dependencies.resolveImagePlatform({
        imageReference: targetImageReference,
        imageDigest: authority.target.imageDigest,
        platform: authority.target.platform,
        signal: input.signal,
      });
      throwIfRestoreCreateAborted(input);
      assertResolvedImageAuthorityMatchesCreate(authority, resolvedImage);
      const targetBeforeBinding = authority.target;
      const recordedImage = await dependencies.recordImagePlatformAuthority({
        operationId: input.operationId,
        ownerId: input.ownerId,
        claimGeneration: claimState.current.generation,
        imageReference: resolvedImage.imageReference,
        imagePlatformDigest: resolvedImage.imagePlatformDigest,
      });
      throwIfRestoreCreateAborted(input);
      if (
        recordedImage.operation.id !== authority.operation.id ||
        recordedImage.operation.phase !== "vault_seeded" ||
        recordedImage.operation.expected_container_id !== null ||
        recordedImage.operation.claim_owner !== input.ownerId ||
        recordedImage.operation.claim_generation !== claimState.current.generation ||
        recordedImage.target.nodeRecordId !== targetBeforeBinding.nodeRecordId ||
        recordedImage.target.nodeId !== targetBeforeBinding.nodeId ||
        recordedImage.target.nodeIncarnation !== targetBeforeBinding.nodeIncarnation ||
        recordedImage.target.nodeHistoryId !== targetBeforeBinding.nodeHistoryId ||
        recordedImage.target.imageDigest !== resolvedImage.imageDigest ||
        recordedImage.target.platform !== resolvedImage.platform ||
        recordedImage.target.imageReference !== resolvedImage.imageReference ||
        recordedImage.target.imagePlatformDigest !== resolvedImage.imagePlatformDigest
      ) {
        throw runtimeError(
          "AGENT_BACKUP_RESTORE_EXACT_IMAGE_BIND_MISMATCH",
          "Restore exact image writer changed its reserved durable authority",
        );
      }
      authority = {
        ...authority,
        operation: recordedImage.operation,
        target: recordedImage.target,
      };
    }
    throwIfRestoreCreateAborted(input);
    const image = durableImageAuthorityFromCreate(authority);

    if (authority.operation.phase === "container_created") {
      if (authority.attempt.state !== "provider_succeeded") {
        if (
          authority.attempt.state !== "in_flight_unresolved" ||
          authority.attempt.provider_started_at === null ||
          !authority.locator.containerId
        ) {
          throw runtimeError(
            "AGENT_BACKUP_RESTORE_PROVIDER_REPLAY_INCONSISTENT",
            "Container-created restore lacks an exact started provider fence",
          );
        }
        const claimReleased = await releaseHeldClaimSafely(input, claimState, dependencies);
        return Object.freeze({
          status: "reconciliation_required",
          reason: "provider_already_started",
          operationId: input.operationId,
          replacementAttemptId: authority.attempt.id,
          containerId: authority.locator.containerId,
          claimReleased,
        });
      }
      const result = reconciledSuccess({ input, authority });
      await releaseHeldClaim(input, claimState, dependencies);
      return result;
    }
    if (authority.operation.phase !== "vault_seeded") {
      throw runtimeError(
        "AGENT_BACKUP_RESTORE_CREATE_PHASE_INVALID",
        `Restore create cannot run in phase ${authority.operation.phase}`,
      );
    }
    if (authority.attempt.provider_started_at !== null) {
      const claimReleased = await releaseHeldClaimSafely(input, claimState, dependencies);
      return Object.freeze({
        status: "reconciliation_required",
        reason: "provider_already_started",
        operationId: input.operationId,
        replacementAttemptId: authority.attempt.id,
        containerId: authority.locator.containerId,
        claimReleased,
      });
    }

    const providerState: {
      boundaryEntered: boolean;
      createdLocator: AgentSandboxReplacementLocatorInput | null;
      settledReceiptDigest: string | null;
    } = {
      boundaryEntered: false,
      createdLocator: null,
      settledReceiptDigest: null,
    };
    try {
      const config: SandboxCreateConfig = {
        agentId: authority.sandbox.agentId,
        agentName: authority.sandbox.agentName,
        organizationId: authority.sandbox.organizationId,
        executionTier: authority.sandbox.executionTier,
        environmentVars: { ...authority.sandbox.environmentVars },
        agentConfig: authority.sandbox.agentConfig ? { ...authority.sandbox.agentConfig } : null,
        routeAgentId: authority.sandbox.routeAgentId,
        dockerImage: image.imageReference,
        replacementAttemptId: authority.attempt.id,
        exactRestore: {
          restoreAttemptId: authority.operation.restore_attempt_id,
          target: {
            nodeRecordId: authority.target.nodeRecordId,
            nodeId: authority.target.nodeId,
            nodeIncarnation: authority.target.nodeIncarnation,
            nodeHistoryId: authority.target.nodeHistoryId,
            platform: image.platform,
          },
          imageReference: image.imageReference,
          imageDigest: image.imageDigest,
          imagePlatformDigest: image.imagePlatformDigest,
          quarantine: true,
        },
        onReplacementCreateAttemptStarted: async (started) => {
          providerState.boundaryEntered = true;
          if (started.replacementAttemptId !== authority.attempt.id || !claimState.current) {
            throw runtimeError(
              "AGENT_BACKUP_RESTORE_PROVIDER_START_IDENTITY_MISMATCH",
              "Restore provider start callback changed durable authority",
            );
          }
          const recorded = await dependencies.markProviderStarted({
            operationId: input.operationId,
            ownerId: input.ownerId,
            claimGeneration: claimState.current.generation,
            replacementAttemptId: authority.attempt.id,
            locator: authority.locator,
          });
          if (recorded.replayed) {
            throw new ProviderStartReplayError(
              "Exact restore provider attempt was already started",
            );
          }
        },
        onReplacementCreateIntent: async (handle) => {
          const locator = exactLocatorFromHandle({
            handle,
            authority,
            requireContainerId: false,
          });
          const verified = await dependencies.verifyProviderIntent(
            {
              attemptId: authority.attempt.id,
              organizationId: authority.operation.organization_id,
              agentId: authority.operation.agent_id,
            },
            locator,
          );
          if (!verified.replayed) {
            throw runtimeError(
              "AGENT_BACKUP_RESTORE_PROVIDER_INTENT_NOT_PREEXISTING",
              "Restore provider callback attempted to create S0 authority",
            );
          }
        },
        onReplacementCreated: async (handle) => {
          const locator = exactLocatorFromHandle({
            handle,
            authority,
            requireContainerId: true,
          });
          if (!locator.containerId || !claimState.current) {
            throw runtimeError(
              "AGENT_BACKUP_RESTORE_PROVIDER_CREATED_AUTHORITY_MISSING",
              "Restore created callback lacks its claim or full container ID",
            );
          }
          const recorded = await dependencies.recordCreated({
            operationId: input.operationId,
            ownerId: input.ownerId,
            claimGeneration: claimState.current.generation,
            replacementAttemptId: authority.attempt.id,
            locator,
          });
          if (
            recorded.replayed ||
            recorded.operation.phase !== "vault_seeded" ||
            recorded.attempt.id !== authority.attempt.id ||
            recorded.attempt.state !== "in_flight_unresolved" ||
            recorded.attempt.locator_container_id !== locator.containerId ||
            recorded.locator.containerId !== locator.containerId
          ) {
            throw runtimeError(
              "AGENT_BACKUP_RESTORE_PROVIDER_CREATED_PERSISTENCE_MISMATCH",
              "Restore created callback did not retain exact pre-settlement authority",
            );
          }
          // This is locator enrichment only. The operation and sandbox remain
          // pre-create until the provider success settlement composes all
          // ledgers atomically under this same live claim.
          providerState.createdLocator = locator;
        },
        onReplacementCreateSettled: async (settlement) => {
          if (
            settlement.replacementAttemptId !== authority.attempt.id ||
            settlement.outcome !== "succeeded" ||
            !providerState.createdLocator
          ) {
            throw runtimeError(
              "AGENT_BACKUP_RESTORE_PROVIDER_SETTLEMENT_MISMATCH",
              "Restore provider settlement changed exact created authority",
            );
          }
          if (!claimState.current) {
            throw runtimeError(
              "AGENT_BACKUP_RESTORE_PROVIDER_SETTLEMENT_CLAIM_MISSING",
              "Restore provider settlement lost its create claim",
            );
          }
          const receiptDigest = buildAgentBackupRestoreExactProviderReceiptDigestV1({
            operation: authority.operation,
            replacementAttemptId: authority.attempt.id,
            locator: providerState.createdLocator,
          });
          const recorded = await dependencies.recordProviderSucceeded({
            operationId: input.operationId,
            ownerId: input.ownerId,
            claimGeneration: claimState.current.generation,
            replacementAttemptId: authority.attempt.id,
            locator: providerState.createdLocator,
            receiptDigest,
          });
          if (
            recorded.operation.phase !== "container_created" ||
            recorded.operation.expected_container_id !== providerState.createdLocator.containerId ||
            recorded.attempt.id !== authority.attempt.id ||
            recorded.attempt.state !== "provider_succeeded" ||
            recorded.attempt.provider_receipt_digest !== receiptDigest ||
            recorded.locator.containerId !== providerState.createdLocator.containerId
          ) {
            throw runtimeError(
              "AGENT_BACKUP_RESTORE_PROVIDER_SETTLEMENT_PERSISTENCE_MISMATCH",
              "Restore provider settlement did not compose exact container authority",
            );
          }
          // Success settlement atomically records provider success, composes
          // the quarantined container, and consumes the claim.
          claimState.current = null;
          providerState.settledReceiptDigest = receiptDigest;
        },
      };

      throwIfRestoreCreateAborted(input);
      const handle = await provider.create(config);
      const finalLocator = exactLocatorFromHandle({
        handle,
        authority,
        requireContainerId: true,
      });
      if (
        !providerState.createdLocator ||
        finalLocator.containerId !== providerState.createdLocator.containerId ||
        !providerState.settledReceiptDigest
      ) {
        throw runtimeError(
          "AGENT_BACKUP_RESTORE_PROVIDER_COMPLETION_INCOMPLETE",
          "Restore provider returned without exact create settlement",
        );
      }
      return Object.freeze({
        status: "created",
        operationId: input.operationId,
        replacementAttemptId: authority.attempt.id,
        containerId: finalLocator.containerId!,
        providerReceiptDigest: providerState.settledReceiptDigest,
        replayed: false,
      });
    } catch (error) {
      // error-policy:J1 post-provider uncertainty becomes an explicit reconciliation result.
      if (!providerState.boundaryEntered) throw error;
      const claimReleased = await releaseHeldClaimSafely(input, claimState, dependencies);
      return Object.freeze({
        status: "reconciliation_required",
        reason:
          error instanceof ProviderStartReplayError
            ? "provider_already_started"
            : "provider_outcome_ambiguous",
        operationId: input.operationId,
        replacementAttemptId: authority.attempt.id,
        containerId: providerState.createdLocator?.containerId ?? null,
        claimReleased,
      });
    }
  } catch (error) {
    // error-policy:J2 preserve the primary create failure while releasing its claim.
    const held = claimState.current;
    if (!held) throw error;
    try {
      await releaseHeldClaim(input, claimState, dependencies);
    } catch (releaseError) {
      // error-policy:J2 retain both the primary and claim-release failures.
      throw new AggregateError(
        [error, releaseError],
        "Restore quarantined-create failed and its operation claim could not be released",
      );
    }
    throw error;
  }
}
