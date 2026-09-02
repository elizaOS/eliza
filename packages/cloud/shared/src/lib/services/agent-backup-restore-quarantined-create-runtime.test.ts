import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  AGENT_BACKUP_RESTORE_QUARANTINED_CREATE_CLAIM_MS,
  type AgentBackupRestoreQuarantinedCreateDependencies,
  type AgentBackupRestoreQuarantinedCreateInput,
  buildAgentBackupRestoreExactCleanupReceiptDigestV1,
  buildAgentBackupRestoreExactProviderReceiptDigestV1,
  reconcileAgentBackupRestoreQuarantinedCreate,
  runAgentBackupRestoreQuarantinedCreate,
} from "./agent-backup-restore-quarantined-create-runtime";
import {
  buildRestoreVolumeVaultSeedReceiptV1,
  deriveRestoreStagingVolumePathV1,
} from "./agent-backup-restore-vault-seed";
import type { SandboxCreateConfig, SandboxHandle } from "./sandbox-provider-types";

const OPERATION_ID = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_ID = "00000000-0000-4000-8000-000000000003";
const BACKUP_ID = "00000000-0000-4000-8000-000000000004";
const RESTORE_ATTEMPT_ID = "00000000-0000-4000-8000-000000000005";
const LEASE_ID = "00000000-0000-4000-8000-000000000006";
const LEASE_GENERATION = "00000000-0000-4000-8000-000000000007";
const SOURCE_OPERATION_ID = "00000000-0000-4000-8000-000000000008";
const SOURCE_ACTIVATION_GENERATION = "00000000-0000-4000-8000-000000000009";
const NODE_RECORD_ID = "00000000-0000-4000-8000-00000000000a";
const NODE_INCARNATION = "00000000-0000-4000-8000-00000000000b";
const NODE_HISTORY_ID = "00000000-0000-4000-8000-00000000000c";
const REPLACEMENT_ATTEMPT_ID = "00000000-0000-4000-8000-00000000000d";
const CLAIM_GENERATIONS = [
  "00000000-0000-4000-8000-000000000010",
  "00000000-0000-4000-8000-000000000011",
  "00000000-0000-4000-8000-000000000012",
] as const;
const RECEIPT_ID = "00000000-0000-4000-8000-000000000013";
const VAULT_GENERATION_ID = "00000000-0000-4000-8000-000000000014";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const CURRENT_IMAGE_DIGEST = `sha256:${"8".repeat(64)}`;
const IMAGE_PLATFORM_DIGEST = `sha256:${"9".repeat(64)}`;
const MANIFEST_SHA256 = "b".repeat(64);
const ACTIVATION_TOKEN_SHA256 = "d".repeat(64);
const VAULT_AUTHORITY_RECEIPT = "e".repeat(64);
const CONTAINER_ID = "c".repeat(64);
const CONTAINER_NAME = `agent-restore-${AGENT_ID}-${RESTORE_ATTEMPT_ID}`;
const VOLUME_PATH = deriveRestoreStagingVolumePathV1(AGENT_ID, RESTORE_ATTEMPT_ID);
const IMAGE_REFERENCE = `ghcr.io/elizaos/eliza@${IMAGE_DIGEST}`;
const IMAGE_PLATFORM_REFERENCE = `ghcr.io/elizaos/eliza@${IMAGE_PLATFORM_DIGEST}`;
const IMAGE_PLATFORM = "linux/amd64" as const;
const PROVIDER_RECEIPT_GOLDEN_DIGEST =
  "d5e92444ad706e345f5032b3ad17066fdd1b76a784e0af39fa6448b7bd128c52";
const PROVIDER_RECEIPT_QUARANTINE_FALSE_GOLDEN_DIGEST =
  "6f148e1302419816c9befdce6f9a426db6a958169c8dd68fc2cd92fb3b2407c6";
const PROVIDER_RECEIPT_ARM64_GOLDEN_DIGEST =
  "d4f40e956fa5b416fad7680dd7cd4b6a05399da0d51548391f18af4ee4e6f6cf";
const PROVIDER_RECEIPT_ALTERNATE_NODE_GOLDEN_DIGEST =
  "cf4cfff058ecbd968a829c9f44019436594ff1d281ffcb3518192bd17248c7b2";
const IMAGE_AUTHORITY = Object.freeze({
  imageReference: IMAGE_REFERENCE,
  imageDigest: IMAGE_DIGEST,
  platform: IMAGE_PLATFORM,
  imagePlatformDigest: IMAGE_PLATFORM_DIGEST,
});

type RuntimePhase = "reserved" | "vault_seeded" | "container_created";
type ProviderHandleStage = "intent" | "created" | "final";

const INPUT: AgentBackupRestoreQuarantinedCreateInput = {
  operationId: OPERATION_ID,
  ownerId: "restore-worker",
  target: {
    nodeRecordId: NODE_RECORD_ID,
    nodeId: "restore-target",
    nodeIncarnation: NODE_INCARNATION,
    nodeHistoryId: NODE_HISTORY_ID,
  },
  replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
  activationTokenSha256: ACTIVATION_TOKEN_SHA256,
  activationTokenCiphertext: "kms:activation-token-ciphertext",
};

const RECONCILIATION_INPUT = Object.freeze({
  operationId: OPERATION_ID,
  ownerId: INPUT.ownerId,
  replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
});

function operation(
  phase: RuntimePhase,
  containerId: string | null = null,
  claimGeneration: string | null = null,
  imageAuthorityPersisted = true,
) {
  return {
    id: OPERATION_ID,
    organization_id: ORGANIZATION_ID,
    agent_id: AGENT_ID,
    backup_id: BACKUP_ID,
    restore_attempt_id: RESTORE_ATTEMPT_ID,
    lease_id: LEASE_ID,
    lease_generation: LEASE_GENERATION,
    lease_owner_id: "restore-worker",
    catalog_epoch: 9n,
    copy_role: "primary" as const,
    phase,
    expected_operation_id: SOURCE_OPERATION_ID,
    expected_manifest_sha256: MANIFEST_SHA256,
    expected_activation_generation: SOURCE_ACTIVATION_GENERATION,
    expected_lifecycle_revision: 17n,
    expected_node_record_id: NODE_RECORD_ID,
    expected_node_incarnation: NODE_INCARNATION,
    expected_node_history_id: NODE_HISTORY_ID,
    expected_container_id: containerId,
    expected_image_digest: IMAGE_DIGEST,
    expected_image_platform: IMAGE_PLATFORM,
    expected_image_reference: imageAuthorityPersisted ? IMAGE_REFERENCE : null,
    expected_image_platform_digest: imageAuthorityPersisted ? IMAGE_PLATFORM_DIGEST : null,
    claim_owner: claimGeneration ? INPUT.ownerId : null,
    claim_generation: claimGeneration,
    claim_expires_at: claimGeneration ? new Date("2026-08-29T01:00:00Z") : null,
  };
}

function locator(containerId: string | null = null) {
  return {
    replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
    sandboxId: CONTAINER_NAME,
    nodeId: "restore-target",
    containerName: CONTAINER_NAME,
    nodeRecordId: NODE_RECORD_ID,
    nodeIncarnation: NODE_INCARNATION,
    nodeHistoryId: NODE_HISTORY_ID,
    nodeHostname: "restore-target.invalid",
    nodeSshPort: 2222,
    nodeSshUser: "restore",
    nodeHostKeyFingerprint: "pinned-host-key",
    replacementSecretCleanupVersion: 1 as const,
    allocationCounted: true as const,
    vpnNodeName: null,
    vpnRegistrationStartedAt: null,
    previousVpnNodeId: null,
    containerId,
    vpnNodeId: null,
  };
}

type ExactProviderReceiptInput = Parameters<
  typeof buildAgentBackupRestoreExactProviderReceiptDigestV1
>[0];

function exactProviderReceiptInput(): ExactProviderReceiptInput {
  return {
    operation: operation("container_created", CONTAINER_ID),
    replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
    locator: locator(CONTAINER_ID),
  };
}

describe("buildAgentBackupRestoreExactProviderReceiptDigestV1", () => {
  test("matches the frozen canonical provider receipt digest", () => {
    const digest = buildAgentBackupRestoreExactProviderReceiptDigestV1(exactProviderReceiptInput());
    expect(digest).toBe(PROVIDER_RECEIPT_GOLDEN_DIGEST);

    // Independently frozen from the same canonical payload with quarantine=false.
    // The main golden therefore also catches removal or inversion of this fixed gate.
    expect(digest).not.toBe(PROVIDER_RECEIPT_QUARANTINE_FALSE_GOLDEN_DIGEST);
  });

  test("binds imagePlatform and nodeRecordId into the frozen receipt", () => {
    const arm64 = exactProviderReceiptInput();
    const alternateNode = exactProviderReceiptInput();
    const alternateNodeRecordId = "00000000-0000-4000-8000-000000000099";

    expect(
      buildAgentBackupRestoreExactProviderReceiptDigestV1({
        ...arm64,
        operation: { ...arm64.operation, expected_image_platform: "linux/arm64" },
      }),
    ).toBe(PROVIDER_RECEIPT_ARM64_GOLDEN_DIGEST);
    expect(
      buildAgentBackupRestoreExactProviderReceiptDigestV1({
        ...alternateNode,
        operation: {
          ...alternateNode.operation,
          expected_node_record_id: alternateNodeRecordId,
        },
        locator: { ...alternateNode.locator, nodeRecordId: alternateNodeRecordId },
      }),
    ).toBe(PROVIDER_RECEIPT_ALTERNATE_NODE_GOLDEN_DIGEST);
  });

  const guardCases: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (input: ExactProviderReceiptInput) => ExactProviderReceiptInput;
  }> = [
    {
      name: "a missing container id",
      mutate: (input) => ({ ...input, locator: { ...input.locator, containerId: null } }),
    },
    {
      name: "a non-canonical container id",
      mutate: (input) => ({
        ...input,
        locator: { ...input.locator, containerId: "C".repeat(64) },
      }),
    },
    {
      name: "a different locator replacement attempt",
      mutate: (input) => ({
        ...input,
        locator: {
          ...input.locator,
          replacementAttemptId: "00000000-0000-4000-8000-000000000098",
        },
      }),
    },
    {
      name: "a malformed replacement attempt authority",
      mutate: (input) => ({
        ...input,
        replacementAttemptId: "not-a-uuid",
        locator: { ...input.locator, replacementAttemptId: "not-a-uuid" },
      }),
    },
    {
      name: "node record drift",
      mutate: (input) => ({
        ...input,
        locator: {
          ...input.locator,
          nodeRecordId: "00000000-0000-4000-8000-000000000098",
        },
      }),
    },
    {
      name: "node incarnation drift",
      mutate: (input) => ({
        ...input,
        locator: {
          ...input.locator,
          nodeIncarnation: "00000000-0000-4000-8000-000000000098",
        },
      }),
    },
    {
      name: "node history drift",
      mutate: (input) => ({
        ...input,
        locator: {
          ...input.locator,
          nodeHistoryId: "00000000-0000-4000-8000-000000000098",
        },
      }),
    },
    {
      name: "container name drift",
      mutate: (input) => ({
        ...input,
        locator: { ...input.locator, containerName: `${input.locator.containerName}-forged` },
      }),
    },
    {
      name: "a missing image digest",
      mutate: (input) => ({
        ...input,
        operation: { ...input.operation, expected_image_digest: null },
      }),
    },
    {
      name: "a malformed image digest",
      mutate: (input) => ({
        ...input,
        operation: { ...input.operation, expected_image_digest: `sha256:${"A".repeat(64)}` },
      }),
    },
    {
      name: "a mutable tagged image reference",
      mutate: (input) => ({
        ...input,
        operation: {
          ...input.operation,
          expected_image_reference: "ghcr.io/elizaos/eliza:latest",
        },
      }),
    },
    {
      name: "a digest-pinned reference for another digest",
      mutate: (input) => ({
        ...input,
        operation: {
          ...input.operation,
          expected_image_reference: `ghcr.io/elizaos/eliza@${CURRENT_IMAGE_DIGEST}`,
        },
      }),
    },
    {
      name: "a missing image reference",
      mutate: (input) => ({
        ...input,
        operation: { ...input.operation, expected_image_reference: null },
      }),
    },
    {
      name: "a missing image platform",
      mutate: (input) => ({
        ...input,
        operation: { ...input.operation, expected_image_platform: null },
      }),
    },
    {
      name: "a missing platform digest",
      mutate: (input) => ({
        ...input,
        operation: { ...input.operation, expected_image_platform_digest: null },
      }),
    },
    {
      name: "a malformed platform digest",
      mutate: (input) => ({
        ...input,
        operation: {
          ...input.operation,
          expected_image_platform_digest: `sha256:${"A".repeat(64)}`,
        },
      }),
    },
  ];

  for (const guardCase of guardCases) {
    test(`rejects ${guardCase.name}`, () => {
      expect(() =>
        buildAgentBackupRestoreExactProviderReceiptDigestV1(
          guardCase.mutate(exactProviderReceiptInput()),
        ),
      ).toThrow();
    });
  }
});

function providerHandle(containerId?: string): SandboxHandle {
  return {
    sandboxId: CONTAINER_NAME,
    bridgeUrl: "",
    healthUrl: "",
    metadata: {
      provider: "docker",
      nodeId: "restore-target",
      hostname: "restore-target.invalid",
      nodeRecordId: NODE_RECORD_ID,
      nodeIncarnation: NODE_INCARNATION,
      nodeHistoryId: NODE_HISTORY_ID,
      nodeSshPort: 2222,
      nodeSshUser: "restore",
      nodeHostKeyFingerprint: "pinned-host-key",
      containerName: CONTAINER_NAME,
      agentId: AGENT_ID,
      volumePath: VOLUME_PATH,
      dockerImage: IMAGE_PLATFORM_REFERENCE,
      imageDigest: IMAGE_DIGEST,
      imageIndexReference: IMAGE_REFERENCE,
      imagePlatformDigest: IMAGE_PLATFORM_DIGEST,
      imagePlatform: IMAGE_PLATFORM,
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      restoreAttemptId: RESTORE_ATTEMPT_ID,
      replacementSecretCleanupVersion: 1,
      quarantine: true,
      allocationCounted: true,
      bridgePort: 0,
      webUiPort: 0,
      ...(containerId ? { containerId } : {}),
    },
  };
}

interface HarnessOptions {
  initialPhase?: RuntimePhase;
  initialImageAuthority?: "missing" | "persisted";
  providerAlreadyStarted?: boolean;
  providerThrowsAfterIntent?: boolean;
  providerThrowsAfterSettlement?: boolean;
  seedReceiptExists?: boolean;
  persistedProviderReceiptDigest?: string;
  sandboxImageReference?: string;
  mutateProviderHandle?: (stage: ProviderHandleStage, handle: SandboxHandle) => SandboxHandle;
}

function harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  let phase = options.initialPhase ?? "reserved";
  let attemptState: "in_flight_unresolved" | "provider_succeeded" =
    phase === "container_created" ? "provider_succeeded" : "in_flight_unresolved";
  let providerStartedAt =
    options.providerAlreadyStarted || phase === "container_created"
      ? new Date("2026-08-29T00:00:00Z")
      : null;
  let providerSucceededAt: Date | null = options.persistedProviderReceiptDigest
    ? new Date("2026-08-29T00:01:00Z")
    : null;
  let providerReceiptDigest: string | null = options.persistedProviderReceiptDigest ?? null;
  let operationContainerId = phase === "container_created" ? CONTAINER_ID : null;
  let attemptContainerId = phase === "container_created" ? CONTAINER_ID : null;
  let seedReceiptExists = options.seedReceiptExists ?? phase !== "reserved";
  let imageAuthorityPersisted =
    options.initialImageAuthority === "persisted" ||
    (options.initialImageAuthority === undefined &&
      (phase === "container_created" || options.providerAlreadyStarted === true));
  let claimIndex = 0;
  let activeClaimGeneration: string | null = null;
  let lastSeedSignal: AbortSignal | null = null;
  let sshSignal: AbortSignal | null = null;
  let sshCommand = "";
  let providerCreateCalls = 0;

  const handleFor = (stage: ProviderHandleStage, exactContainerId?: string): SandboxHandle => {
    const handle = providerHandle(exactContainerId);
    return options.mutateProviderHandle?.(stage, handle) ?? handle;
  };

  const authority = () => ({
    operation: operation(
      phase,
      operationContainerId,
      activeClaimGeneration,
      imageAuthorityPersisted,
    ),
    target: {
      nodeRecordId: NODE_RECORD_ID,
      nodeId: "restore-target",
      nodeIncarnation: NODE_INCARNATION,
      nodeHistoryId: NODE_HISTORY_ID,
      imageDigest: IMAGE_DIGEST,
      platform: IMAGE_PLATFORM,
      imageReference: imageAuthorityPersisted ? IMAGE_REFERENCE : null,
      imagePlatformDigest: imageAuthorityPersisted ? IMAGE_PLATFORM_DIGEST : null,
    },
    sandbox: {
      agentId: AGENT_ID,
      agentName: "restore-agent",
      organizationId: ORGANIZATION_ID,
      executionTier: "dedicated-always" as const,
      environmentVars: { RESTORE_TEST: "true" },
      agentConfig: { testMode: true },
      routeAgentId: "route-agent",
      dockerImageReference: options.sandboxImageReference ?? "ghcr.io/elizaos/eliza:source",
      activationTokenSha256: ACTIVATION_TOKEN_SHA256,
      activationTokenCiphertext: "kms:activation-token-ciphertext",
      activationGeneration: RESTORE_ATTEMPT_ID,
      lifecycleRevision: "18",
    },
    attempt: {
      id: REPLACEMENT_ATTEMPT_ID,
      state: attemptState,
      provider_started_at: providerStartedAt,
      provider_succeeded_at: providerSucceededAt,
      provider_receipt_digest: providerReceiptDigest,
      locator_container_id: attemptContainerId,
      cleanup_proven_at: null,
      cleanup_receipt_digest: null,
    },
    locator: locator(attemptContainerId),
    replayed: {
      target: phase !== "reserved",
      quarantine: phase !== "reserved",
      replacementIntent: phase !== "reserved",
    },
  });

  const dependencies: AgentBackupRestoreQuarantinedCreateDependencies = {
    createProvider: async () => {
      events.push("provider:factory");
      return {
        exactRestoreCreateCapability: "stopped-quarantine-v1",
        replacementCreateSettlementCapability: "exact-success",
        stopOnSpecificNodeForReplacement: async () => {
          events.push("provider:cleanup");
        },
        create: async (config: SandboxCreateConfig) => {
          providerCreateCalls += 1;
          events.push("provider:create");
          expect(config.exactRestore).toEqual({
            restoreAttemptId: RESTORE_ATTEMPT_ID,
            target: { ...INPUT.target, platform: IMAGE_PLATFORM },
            imageReference: IMAGE_REFERENCE,
            imageDigest: IMAGE_DIGEST,
            imagePlatformDigest: IMAGE_PLATFORM_DIGEST,
            quarantine: true,
          });
          expect(config.onReplacementVpnRegistered).toBeUndefined();
          await config.onReplacementCreateAttemptStarted?.({
            replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
          });
          events.push("provider:intent-callback");
          await config.onReplacementCreateIntent?.(handleFor("intent"));
          if (options.providerThrowsAfterIntent) {
            events.push("provider:ambiguous-error");
            throw new Error("ambiguous provider failure");
          }
          events.push("provider:remote-create");
          await config.onReplacementCreated?.(handleFor("created", CONTAINER_ID));
          events.push("provider:settlement-callback");
          await config.onReplacementCreateSettled?.({
            replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
            outcome: "succeeded",
          });
          if (options.providerThrowsAfterSettlement) {
            events.push("provider:settlement-response-lost");
            throw new Error("lost provider settlement response");
          }
          return handleFor("final", CONTAINER_ID);
        },
      };
    },
    claimOperation: async ({ claimMs }) => {
      events.push(`claim:${phase}`);
      expect(claimMs).toBe(AGENT_BACKUP_RESTORE_QUARANTINED_CREATE_CLAIM_MS);
      const claimGeneration = CLAIM_GENERATIONS[claimIndex++];
      if (!claimGeneration) throw new Error("unexpected extra claim");
      activeClaimGeneration = claimGeneration;
      return {
        operation: operation(phase, operationContainerId, claimGeneration, imageAuthorityPersisted),
        claimGeneration,
      };
    },
    releaseClaim: async ({ claimGeneration }) => {
      events.push(`release:${claimGeneration}`);
      activeClaimGeneration = null;
      return operation(phase, operationContainerId, null, imageAuthorityPersisted);
    },
    reserveAndLoadAuthority: async ({ claimGeneration }) => {
      events.push(`reserve:${phase}:${claimGeneration}`);
      return authority();
    },
    loadSource: async (input) => {
      events.push("source:load");
      expect(input).toMatchObject({
        operationId: SOURCE_OPERATION_ID,
        restoreAttemptId: RESTORE_ATTEMPT_ID,
        fencingToken: LEASE_GENERATION,
      });
      return {
        vaultKeyAuthority: {
          generationId: VAULT_GENERATION_ID,
          authorityReceiptDigest: VAULT_AUTHORITY_RECEIPT,
        },
      };
    },
    resolveImagePlatform: async (input) => {
      events.push("image:resolve");
      expect(input).toEqual({
        imageReference: IMAGE_REFERENCE,
        imageDigest: IMAGE_DIGEST,
        platform: IMAGE_PLATFORM,
        signal: undefined,
      });
      return IMAGE_AUTHORITY;
    },
    recordImagePlatformAuthority: async (input) => {
      events.push("db:image-authority");
      expect(input).toEqual({
        operationId: OPERATION_ID,
        ownerId: INPUT.ownerId,
        claimGeneration: activeClaimGeneration,
        imageReference: IMAGE_REFERENCE,
        imagePlatformDigest: IMAGE_PLATFORM_DIGEST,
      });
      imageAuthorityPersisted = true;
      return {
        operation: operation(phase, operationContainerId, activeClaimGeneration, true),
        target: {
          nodeRecordId: NODE_RECORD_ID,
          nodeId: "restore-target",
          nodeIncarnation: NODE_INCARNATION,
          nodeHistoryId: NODE_HISTORY_ID,
          imageDigest: IMAGE_DIGEST,
          platform: IMAGE_PLATFORM,
          imageReference: IMAGE_REFERENCE,
          imagePlatformDigest: IMAGE_PLATFORM_DIGEST,
        },
        replayed: false,
      };
    },
    withVaultPassphrase: async (input, use) => {
      events.push("vault:authorize");
      expect(input).toMatchObject({
        restoreOperationId: OPERATION_ID,
        targetNodeRecordId: NODE_RECORD_ID,
        targetNodeIncarnation: NODE_INCARNATION,
        targetNodeHistoryId: NODE_HISTORY_ID,
        vaultKeyGenerationId: VAULT_GENERATION_ID,
      });
      const controller = new AbortController();
      lastSeedSignal = controller.signal;
      const passphrase = new Uint8Array(64).fill(65);
      try {
        return await use(passphrase, controller.signal);
      } finally {
        passphrase.fill(0);
      }
    },
    createDedicatedSshClient: (config) => {
      events.push("ssh:dedicated");
      expect(config).toEqual({
        hostname: "restore-target.invalid",
        port: 2222,
        username: "restore",
        hostKeyFingerprint: "pinned-host-key",
      });
      return {
        execStdinAbortable: async (command, input, signal) => {
          events.push("ssh:stdin");
          sshCommand = command;
          sshSignal = signal;
          expect(Buffer.isBuffer(input)).toBe(true);
        },
        disconnect: async () => {
          events.push("ssh:disconnect");
        },
      };
    },
    seedVaultPassphrase: async (input) => {
      events.push("vault:seed");
      await input.execStdin("seed-vault-command", Buffer.from("framed-secret"), input.signal);
      return buildRestoreVolumeVaultSeedReceiptV1({
        agentId: input.agentId,
        restoreAttemptId: input.restoreAttemptId,
        replacementAttemptId: input.replacementAttemptId,
        passphraseByteLength: input.passphrase.byteLength,
      });
    },
    recordSeedReceipt: async (input) => {
      events.push("vault:receipt");
      expect(input.receiptId).toBe(RECEIPT_ID);
      expect(input.replacementAttemptId).toBe(REPLACEMENT_ATTEMPT_ID);
      phase = "vault_seeded";
      const replayed = seedReceiptExists;
      seedReceiptExists = true;
      if (!replayed) activeClaimGeneration = null;
      return {
        operation: operation(phase, null, activeClaimGeneration, imageAuthorityPersisted),
        replayed,
      };
    },
    markProviderStarted: async ({ locator: inputLocator }) => {
      events.push("provider:start-cas");
      expect(inputLocator).toEqual(locator());
      if (providerStartedAt) {
        return {
          operation: operation(phase),
          attempt: authority().attempt,
          locator: locator(),
          replayed: true,
        };
      }
      providerStartedAt = new Date("2026-08-29T00:00:00Z");
      return {
        operation: operation(phase),
        attempt: authority().attempt,
        locator: locator(),
        replayed: false,
      };
    },
    verifyProviderIntent: async (_reference, inputLocator) => {
      events.push("provider:intent-verify");
      expect(inputLocator).toEqual(locator());
      return { replayed: true };
    },
    recordCreated: async (input) => {
      events.push("provider:created-enrich");
      expect(input.locator.containerId).toBe(CONTAINER_ID);
      attemptContainerId = CONTAINER_ID;
      return {
        operation: operation(phase, operationContainerId),
        attempt: authority().attempt,
        locator: locator(CONTAINER_ID),
        replayed: false,
      };
    },
    recordProviderSucceeded: async (input) => {
      events.push("provider:success-cas");
      expect(input.locator).toEqual(locator(CONTAINER_ID));
      phase = "container_created";
      operationContainerId = CONTAINER_ID;
      attemptState = "provider_succeeded";
      providerSucceededAt = new Date("2026-08-29T00:01:00Z");
      providerReceiptDigest = input.receiptDigest;
      activeClaimGeneration = null;
      return {
        operation: operation(phase, operationContainerId),
        attempt: authority().attempt,
        locator: locator(CONTAINER_ID),
        replayed: false,
      };
    },
    claimCleanup: async () => {
      throw new Error("cleanup claim is outside create harness");
    },
    beginCleanup: async () => {
      throw new Error("cleanup begin is outside create harness");
    },
    finishCleanup: async () => {
      throw new Error("cleanup finish is outside create harness");
    },
    releaseCleanupClaim: async () => {
      throw new Error("cleanup release is outside create harness");
    },
    randomUuid: () => RECEIPT_ID,
  };

  return {
    dependencies,
    events,
    get lastSeedSignal() {
      return lastSeedSignal;
    },
    get sshSignal() {
      return sshSignal;
    },
    get sshCommand() {
      return sshCommand;
    },
    get providerCreateCalls() {
      return providerCreateCalls;
    },
  };
}

describe("runAgentBackupRestoreQuarantinedCreate", () => {
  test("rejects an already-aborted caller before claims or provider construction", async () => {
    const fixture = harness({ initialPhase: "vault_seeded", initialImageAuthority: "persisted" });
    const controller = new AbortController();
    const abortReason = new Error("restore create cancelled before entry");
    controller.abort(abortReason);

    try {
      await runAgentBackupRestoreQuarantinedCreate(
        { ...INPUT, signal: controller.signal },
        fixture.dependencies,
      );
      throw new Error("Expected entry cancellation");
    } catch (error) {
      // error-policy:J1 the test assertion boundary observes the caller's abort reason.
      expect(error).toBe(abortReason);
    }
    expect(fixture.events).toEqual([]);
    expect(fixture.providerCreateCalls).toBe(0);
  });

  test("combines caller cancellation with the bounded vault handoff signal", async () => {
    const fixture = harness();
    const controller = new AbortController();
    const abortReason = new Error("restore create cancelled during vault handoff");
    let observedSignal: AbortSignal | null = null;
    const dependencies: AgentBackupRestoreQuarantinedCreateDependencies = {
      ...fixture.dependencies,
      seedVaultPassphrase: async (input) => {
        observedSignal = input.signal;
        controller.abort(abortReason);
        await Promise.resolve();
        input.signal.throwIfAborted();
        throw new Error("aborted handoff unexpectedly continued");
      },
    };

    try {
      await runAgentBackupRestoreQuarantinedCreate(
        { ...INPUT, signal: controller.signal },
        dependencies,
      );
      throw new Error("Expected vault handoff cancellation");
    } catch (error) {
      // error-policy:J1 the test assertion boundary observes the caller's abort reason.
      expect(error).toBe(abortReason);
    }
    expect(observedSignal).not.toBe(fixture.lastSeedSignal);
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe(abortReason);
    expect(fixture.events.at(-1)).toBe(`release:${CLAIM_GENERATIONS[0]}`);
    expect(fixture.providerCreateCalls).toBe(0);
  });

  test("does not bind or invoke the provider after resolution observes cancellation", async () => {
    const fixture = harness({ initialPhase: "vault_seeded" });
    const controller = new AbortController();
    const abortReason = new Error("restore create cancelled after registry proof");
    const dependencies: AgentBackupRestoreQuarantinedCreateDependencies = {
      ...fixture.dependencies,
      resolveImagePlatform: async () => {
        controller.abort(abortReason);
        return IMAGE_AUTHORITY;
      },
    };

    try {
      await runAgentBackupRestoreQuarantinedCreate(
        { ...INPUT, signal: controller.signal },
        dependencies,
      );
      throw new Error("Expected post-resolution cancellation");
    } catch (error) {
      // error-policy:J1 the test assertion boundary observes the caller's abort reason.
      expect(error).toBe(abortReason);
    }
    expect(fixture.events).not.toContain("db:image-authority");
    expect(fixture.events.at(-1)).toBe(`release:${CLAIM_GENERATIONS[0]}`);
    expect(fixture.providerCreateCalls).toBe(0);
  });

  test("does not invoke the provider when cancellation races the durable image bind", async () => {
    const fixture = harness({ initialPhase: "vault_seeded" });
    const controller = new AbortController();
    const abortReason = new Error("restore create cancelled during image bind");
    const recordImagePlatformAuthority = fixture.dependencies.recordImagePlatformAuthority;
    const dependencies: AgentBackupRestoreQuarantinedCreateDependencies = {
      ...fixture.dependencies,
      resolveImagePlatform: async () => IMAGE_AUTHORITY,
      recordImagePlatformAuthority: async (input) => {
        const recorded = await recordImagePlatformAuthority(input);
        controller.abort(abortReason);
        return recorded;
      },
    };

    try {
      await runAgentBackupRestoreQuarantinedCreate(
        { ...INPUT, signal: controller.signal },
        dependencies,
      );
      throw new Error("Expected image-bind cancellation");
    } catch (error) {
      // error-policy:J1 the test assertion boundary observes the caller's abort reason.
      expect(error).toBe(abortReason);
    }
    expect(fixture.events).toContain("db:image-authority");
    expect(fixture.events.at(-1)).toBe(`release:${CLAIM_GENERATIONS[0]}`);
    expect(fixture.providerCreateCalls).toBe(0);
  });

  test("orders exact authority, dedicated cancellable seed, callbacks, and settlement", async () => {
    const fixture = harness();
    const result = await runAgentBackupRestoreQuarantinedCreate(INPUT, fixture.dependencies);

    expect(result).toMatchObject({
      status: "created",
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      containerId: CONTAINER_ID,
      replayed: false,
    });
    expect(result.status === "created" && result.providerReceiptDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.lastSeedSignal).toBe(fixture.sshSignal);
    expect(fixture.sshCommand).toContain(NODE_INCARNATION);
    expect(fixture.sshCommand).toContain("ELIZA_RESTORE_BOOT_ID_MISMATCH");
    expect(fixture.sshCommand).toContain("seed-vault-command");
    expect(fixture.events).toEqual([
      "provider:factory",
      "claim:reserved",
      `reserve:reserved:${CLAIM_GENERATIONS[0]}`,
      "source:load",
      "ssh:dedicated",
      "vault:authorize",
      "vault:seed",
      "ssh:stdin",
      "ssh:disconnect",
      "vault:receipt",
      "claim:vault_seeded",
      `reserve:vault_seeded:${CLAIM_GENERATIONS[1]}`,
      "image:resolve",
      "db:image-authority",
      "provider:create",
      "provider:start-cas",
      "provider:intent-callback",
      "provider:intent-verify",
      "provider:remote-create",
      "provider:created-enrich",
      "provider:settlement-callback",
      "provider:success-cas",
    ]);
  });

  for (const currentImageReference of [
    `ghcr.io/elizaos/eliza@${CURRENT_IMAGE_DIGEST}`,
    `ghcr.io/elizaos/eliza:production@${CURRENT_IMAGE_DIGEST}`,
  ]) {
    test(`repins historical image authority from ${currentImageReference.includes(":production") ? "tag@B" : "repo@B"} to repo@A`, async () => {
      const fixture = harness({
        initialPhase: "vault_seeded",
        sandboxImageReference: currentImageReference,
      });
      let resolvedInput:
        | Parameters<AgentBackupRestoreQuarantinedCreateDependencies["resolveImagePlatform"]>[0]
        | null = null;
      const result = await runAgentBackupRestoreQuarantinedCreate(INPUT, {
        ...fixture.dependencies,
        resolveImagePlatform: async (input) => {
          resolvedInput = input;
          return IMAGE_AUTHORITY;
        },
      });

      expect(result.status).toBe("created");
      expect(resolvedInput).toEqual({
        imageReference: IMAGE_REFERENCE,
        imageDigest: IMAGE_DIGEST,
        platform: IMAGE_PLATFORM,
        signal: undefined,
      });
    });
  }

  test("does not hide a repository change while repinning a historical digest", async () => {
    const fixture = harness({
      initialPhase: "vault_seeded",
      initialImageAuthority: "persisted",
      sandboxImageReference: `ghcr.io/other/project:production@${CURRENT_IMAGE_DIGEST}`,
    });

    await expect(
      runAgentBackupRestoreQuarantinedCreate(INPUT, fixture.dependencies),
    ).rejects.toThrow("differs from its persisted exact image generation");
    expect(fixture.providerCreateCalls).toBe(0);
  });

  for (const malformedImageReference of [
    `ghcr.io/elizaos/eliza:bad tag@${CURRENT_IMAGE_DIGEST}`,
    `ghcr.io/elizaos/eliza:production@${CURRENT_IMAGE_DIGEST}@${CURRENT_IMAGE_DIGEST}`,
    "ghcr.io/ElizaOS/eliza:production",
    "ghcr.io/elizaos/eliza",
  ]) {
    test(`rejects malformed current image reference ${malformedImageReference}`, async () => {
      const fixture = harness({
        initialPhase: "vault_seeded",
        sandboxImageReference: malformedImageReference,
      });

      await expect(
        runAgentBackupRestoreQuarantinedCreate(INPUT, fixture.dependencies),
      ).rejects.toThrow();
      expect(fixture.events).not.toContain("image:resolve");
      expect(fixture.providerCreateCalls).toBe(0);
    });
  }

  test("replays the attempt-scoped seed before a response-loss provider retry", async () => {
    const fixture = harness({ initialPhase: "vault_seeded" });
    const result = await runAgentBackupRestoreQuarantinedCreate(INPUT, fixture.dependencies);

    expect(result).toMatchObject({
      status: "created",
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      containerId: CONTAINER_ID,
      replayed: false,
    });
    expect(fixture.events.filter((event) => event.startsWith("claim:"))).toEqual([
      "claim:vault_seeded",
    ]);
    expect(fixture.events).toContain("vault:receipt");
    expect(fixture.events.filter((event) => event === "image:resolve")).toHaveLength(1);
    expect(fixture.events.indexOf("db:image-authority")).toBeLessThan(
      fixture.events.indexOf("provider:create"),
    );
    expect(fixture.events).toContain("provider:start-cas");
  });

  test("records a fresh per-replacement seed receipt after proven cleanup", async () => {
    const fixture = harness({ initialPhase: "vault_seeded", seedReceiptExists: false });
    const result = await runAgentBackupRestoreQuarantinedCreate(INPUT, fixture.dependencies);

    expect(result).toMatchObject({
      status: "created",
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      containerId: CONTAINER_ID,
      replayed: false,
    });
    expect(fixture.events.filter((event) => event.startsWith("claim:"))).toEqual([
      "claim:vault_seeded",
      "claim:vault_seeded",
    ]);
    expect(fixture.events.filter((event) => event === "vault:receipt")).toHaveLength(1);
    expect(fixture.events.filter((event) => event === "image:resolve")).toHaveLength(1);
    expect(fixture.events).toContain("provider:start-cas");
  });

  test("never replays a provider attempt whose start marker already committed", async () => {
    const fixture = harness({ initialPhase: "vault_seeded", providerAlreadyStarted: true });
    const result = await runAgentBackupRestoreQuarantinedCreate(INPUT, fixture.dependencies);

    expect(result).toEqual({
      status: "reconciliation_required",
      reason: "provider_already_started",
      operationId: OPERATION_ID,
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      containerId: null,
      claimReleased: true,
    });
    expect(fixture.providerCreateCalls).toBe(0);
    expect(fixture.events).toEqual([
      "provider:factory",
      "claim:vault_seeded",
      `reserve:vault_seeded:${CLAIM_GENERATIONS[0]}`,
      `release:${CLAIM_GENERATIONS[0]}`,
    ]);
  });

  test("returns reconciliation_required after an ambiguous post-start provider error", async () => {
    const fixture = harness({
      initialPhase: "vault_seeded",
      providerThrowsAfterIntent: true,
    });
    const result = await runAgentBackupRestoreQuarantinedCreate(INPUT, fixture.dependencies);

    expect(result).toEqual({
      status: "reconciliation_required",
      reason: "provider_outcome_ambiguous",
      operationId: OPERATION_ID,
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      containerId: null,
      claimReleased: true,
    });
    expect(fixture.providerCreateCalls).toBe(1);
    expect(fixture.events.at(-1)).toBe(`release:${CLAIM_GENERATIONS[0]}`);
  });

  test("adopts durable provider settlement after its response was lost", async () => {
    const fixture = harness({ providerThrowsAfterSettlement: true });
    const ambiguous = await runAgentBackupRestoreQuarantinedCreate(INPUT, fixture.dependencies);
    expect(ambiguous).toEqual({
      status: "reconciliation_required",
      reason: "provider_outcome_ambiguous",
      operationId: OPERATION_ID,
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      containerId: CONTAINER_ID,
      claimReleased: true,
    });

    const adopted = await runAgentBackupRestoreQuarantinedCreate(INPUT, {
      ...fixture.dependencies,
      resolveImagePlatform: async () => {
        throw new Error("settled response-loss replay must not read the registry");
      },
    });
    expect(adopted).toMatchObject({
      status: "created",
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      containerId: CONTAINER_ID,
      replayed: true,
    });
    expect(fixture.providerCreateCalls).toBe(1);
    expect(fixture.events.filter((event) => event === "image:resolve")).toHaveLength(1);
  });

  test("replays a settled container-created receipt without invoking the provider", async () => {
    const first = harness();
    const completed = await runAgentBackupRestoreQuarantinedCreate(INPUT, first.dependencies);
    if (completed.status !== "created") throw new Error("fixture did not settle provider success");

    const replay = harness({
      initialPhase: "container_created",
      persistedProviderReceiptDigest: completed.providerReceiptDigest,
    });
    const result = await runAgentBackupRestoreQuarantinedCreate(INPUT, {
      ...replay.dependencies,
      resolveImagePlatform: async () => {
        throw new Error("container-created replay must not read the registry");
      },
    });

    expect(result).toEqual({ ...completed, replayed: true });
    expect(replay.providerCreateCalls).toBe(0);
    expect(replay.events).toEqual([
      "provider:factory",
      "claim:container_created",
      `reserve:container_created:${CLAIM_GENERATIONS[0]}`,
      `release:${CLAIM_GENERATIONS[0]}`,
    ]);
  });

  test("rejects an unsupported provider before claims or remote effects", async () => {
    const fixture = harness();
    const dependencies: AgentBackupRestoreQuarantinedCreateDependencies = {
      ...fixture.dependencies,
      createProvider: async () => ({
        create: async () => {
          throw new Error("must not create");
        },
      }),
    };

    await expect(runAgentBackupRestoreQuarantinedCreate(INPUT, dependencies)).rejects.toThrow(
      "lacks exact stopped-quarantine settlement capability",
    );
    expect(fixture.events).toEqual([]);
  });

  test("does not call start, readiness, publication, routing, or billing dependencies", async () => {
    const fixture = harness({ initialPhase: "vault_seeded", providerAlreadyStarted: true });
    const forbiddenCalls: string[] = [];
    const dependencies = {
      ...fixture.dependencies,
      startSandbox: async () => forbiddenCalls.push("start"),
      checkReadiness: async () => forbiddenCalls.push("readiness"),
      publishRoute: async () => forbiddenCalls.push("routing"),
      billSandbox: async () => forbiddenCalls.push("billing"),
    };

    await runAgentBackupRestoreQuarantinedCreate(INPUT, dependencies);
    expect(forbiddenCalls).toEqual([]);
  });

  const callbackStages = ["intent", "created", "final"] as const;
  const handleAuthorityDrifts = [
    {
      name: "missing cleanup protocol",
      mutate: (metadata: Record<string, unknown>) => {
        delete metadata.replacementSecretCleanupVersion;
      },
    },
    {
      name: "agent identity drift",
      mutate: (metadata: Record<string, unknown>) => {
        metadata.agentId = "00000000-0000-4000-8000-000000000099";
      },
    },
    {
      name: "restore staging volume drift",
      mutate: (metadata: Record<string, unknown>) => {
        metadata.volumePath = `${VOLUME_PATH}-forged`;
      },
    },
    {
      name: "Headscale publication metadata",
      mutate: (metadata: Record<string, unknown>) => {
        metadata.headscaleIp = "100.64.0.42";
      },
    },
  ] as const;

  for (const stage of callbackStages) {
    for (const drift of handleAuthorityDrifts) {
      test(`rejects ${drift.name} in the ${stage} handle`, async () => {
        const fixture = harness({
          initialPhase: "vault_seeded",
          mutateProviderHandle: (currentStage, handle) => {
            if (currentStage !== stage) return handle;
            const metadata = { ...handle.metadata };
            drift.mutate(metadata);
            return { ...handle, metadata };
          },
        });

        const result = await runAgentBackupRestoreQuarantinedCreate(INPUT, fixture.dependencies);

        expect(result).toMatchObject({
          status: "reconciliation_required",
          reason: "provider_outcome_ambiguous",
          replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
        });
        if (stage === "intent") {
          expect(fixture.events).not.toContain("provider:intent-verify");
        } else if (stage === "created") {
          expect(fixture.events).not.toContain("provider:created-enrich");
        } else {
          expect(fixture.events).toContain("provider:success-cas");
        }
      });
    }
  }
});

type CleanupState =
  | "in_flight_unresolved"
  | "cleanup_in_progress"
  | "cleanup_proven"
  | "provider_succeeded";

function cleanupHarness(
  options: {
    initialState?: CleanupState;
    containerId?: string | null;
    retainsProviderSuccess?: boolean;
    providerReceiptDigest?: string;
    providerThrows?: boolean;
    loseProviderResponse?: boolean;
    loseBeginResponse?: boolean;
    loseFinishResponse?: boolean;
    loseReleaseResponse?: boolean;
  } = {},
) {
  const base = harness({ initialPhase: "vault_seeded", providerAlreadyStarted: true });
  const events: string[] = [];
  let state = options.initialState ?? "in_flight_unresolved";
  const exactContainerId = options.containerId ?? null;
  let cleanupReceiptDigest: string | null = null;
  let claimLive = false;
  let operationRearmed = state === "cleanup_proven";
  let retainsProviderSuccess = options.retainsProviderSuccess ?? state === "provider_succeeded";
  let loseBeginResponse = options.loseBeginResponse ?? false;
  let loseProviderResponse = options.loseProviderResponse ?? false;
  let loseFinishResponse = options.loseFinishResponse ?? false;
  let loseReleaseResponse = options.loseReleaseResponse ?? false;

  const providerReceiptDigest =
    options.providerReceiptDigest ??
    (exactContainerId === null
      ? "f".repeat(64)
      : buildAgentBackupRestoreExactProviderReceiptDigestV1({
          operation: operation("container_created", exactContainerId),
          replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
          locator: locator(exactContainerId),
        }));

  const cleanupOperation = () =>
    operation(
      !operationRearmed && retainsProviderSuccess ? "container_created" : "vault_seeded",
      !operationRearmed && retainsProviderSuccess ? exactContainerId : null,
      claimLive ? CLAIM_GENERATIONS[0] : null,
    );
  const cleanupAttempt = () => ({
    id: REPLACEMENT_ATTEMPT_ID,
    state,
    provider_started_at: new Date("2026-08-29T00:00:00Z"),
    provider_succeeded_at: retainsProviderSuccess ? new Date("2026-08-29T00:01:00Z") : null,
    provider_receipt_digest: retainsProviderSuccess ? providerReceiptDigest : null,
    locator_container_id: exactContainerId,
    cleanup_proven_at: state === "cleanup_proven" ? new Date("2026-08-29T00:02:00Z") : null,
    cleanup_receipt_digest: state === "cleanup_proven" ? cleanupReceiptDigest : null,
  });
  const cleanupLocator = () => locator(exactContainerId);

  if (state === "cleanup_proven") {
    cleanupReceiptDigest = buildAgentBackupRestoreExactCleanupReceiptDigestV1({
      operation: cleanupOperation(),
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      locator: cleanupLocator(),
    });
  }

  const dependencies: AgentBackupRestoreQuarantinedCreateDependencies = {
    ...base.dependencies,
    createProvider: async () => ({
      exactRestoreCreateCapability: "stopped-quarantine-v1",
      replacementCreateSettlementCapability: "exact-success",
      create: async () => {
        throw new Error("cleanup reconciliation must not create");
      },
      stopOnSpecificNodeForReplacement: async (nodeId, containerName, vpnNodeId, identity) => {
        events.push("provider:cleanup");
        expect(nodeId).toBe("restore-target");
        expect(containerName).toBe(CONTAINER_NAME);
        expect(vpnNodeId).toBeNull();
        expect(identity).toEqual({
          nodeRecordId: NODE_RECORD_ID,
          nodeIncarnation: NODE_INCARNATION,
          nodeHistoryId: NODE_HISTORY_ID,
          nodeHostname: "restore-target.invalid",
          nodeSshPort: 2222,
          nodeSshUser: "restore",
          nodeHostKeyFingerprint: "pinned-host-key",
          replacementSecretCleanupVersion: 1,
          replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
          restoreAttemptId: RESTORE_ATTEMPT_ID,
          containerId: exactContainerId,
          vpnNodeName: null,
          previousVpnNodeId: null,
          vpnRegistrationStartedAt: null,
          allocationCounted: true,
        });
        if (options.providerThrows) throw new Error("remote cleanup unresolved");
        if (loseProviderResponse) {
          loseProviderResponse = false;
          throw new Error("lost remote cleanup response");
        }
      },
    }),
    claimCleanup: async ({ claimMs }) => {
      events.push("db:claim-cleanup");
      expect(claimMs).toBe(AGENT_BACKUP_RESTORE_QUARANTINED_CREATE_CLAIM_MS);
      if (state === "cleanup_proven") {
        return {
          status: "cleanup_proven",
          operation: cleanupOperation(),
          attempt: cleanupAttempt(),
          locator: cleanupLocator(),
          claimGeneration: null,
          databaseNow: new Date("2026-08-29T00:00:00Z"),
        };
      }
      claimLive = true;
      return {
        status: "claimed",
        operation: cleanupOperation(),
        attempt: cleanupAttempt(),
        locator: cleanupLocator(),
        claimGeneration: CLAIM_GENERATIONS[0],
        databaseNow: new Date("2026-08-29T00:00:00Z"),
      };
    },
    beginCleanup: async ({ claimGeneration }) => {
      events.push("db:begin-cleanup");
      expect(claimGeneration).toBe(CLAIM_GENERATIONS[0]);
      const replayed = state === "cleanup_in_progress";
      state = "cleanup_in_progress";
      if (loseBeginResponse) {
        loseBeginResponse = false;
        throw new Error("lost cleanup-begin response");
      }
      return {
        operation: cleanupOperation(),
        attempt: cleanupAttempt(),
        locator: cleanupLocator(),
        replayed,
      };
    },
    finishCleanup: async ({ claimGeneration, cleanupReceiptDigest: receiptDigest }) => {
      events.push("db:finish-cleanup");
      expect(claimGeneration).toBe(CLAIM_GENERATIONS[0]);
      cleanupReceiptDigest = receiptDigest;
      state = "cleanup_proven";
      operationRearmed = true;
      claimLive = false;
      if (loseFinishResponse) {
        loseFinishResponse = false;
        throw new Error("lost cleanup-finish response");
      }
      return {
        operation: cleanupOperation(),
        attempt: cleanupAttempt(),
        locator: cleanupLocator(),
        replayed: false,
      };
    },
    releaseCleanupClaim: async () => {
      events.push("db:release-cleanup");
      if (!claimLive || state === "cleanup_proven") {
        throw new Error("cleanup claim already consumed");
      }
      claimLive = false;
      if (loseReleaseResponse) {
        loseReleaseResponse = false;
        throw new Error("lost cleanup-release response");
      }
      return cleanupOperation();
    },
  };
  return {
    dependencies,
    events,
    providerReceiptDigest,
    get state() {
      return state;
    },
    get operationRearmed() {
      return operationRearmed;
    },
    get retainsProviderSuccess() {
      return retainsProviderSuccess;
    },
  };
}

describe("reconcileAgentBackupRestoreQuarantinedCreate", () => {
  test("rejects a provider without exact cleanup before taking a cleanup claim", async () => {
    const fixture = cleanupHarness();
    const dependencies: AgentBackupRestoreQuarantinedCreateDependencies = {
      ...fixture.dependencies,
      createProvider: async () => ({
        exactRestoreCreateCapability: "stopped-quarantine-v1",
        replacementCreateSettlementCapability: "exact-success",
        create: async () => {
          throw new Error("must not create");
        },
      }),
    };
    await expect(
      reconcileAgentBackupRestoreQuarantinedCreate(
        {
          operationId: OPERATION_ID,
          ownerId: INPUT.ownerId,
          replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
        },
        dependencies,
      ),
    ).rejects.toThrow("lacks exact stopped-quarantine settlement capability");
    expect(fixture.events).toEqual([]);
  });

  test("releases a claimed cleanup whose DB locator is not exact", async () => {
    const fixture = cleanupHarness();
    const claimCleanup = fixture.dependencies.claimCleanup;
    const dependencies: AgentBackupRestoreQuarantinedCreateDependencies = {
      ...fixture.dependencies,
      claimCleanup: async (input) => {
        const claimed = await claimCleanup(input);
        return {
          ...claimed,
          locator: {
            ...claimed.locator,
            nodeRecordId: "00000000-0000-4000-8000-000000000099",
          },
        };
      },
    };
    await expect(
      reconcileAgentBackupRestoreQuarantinedCreate(
        {
          operationId: OPERATION_ID,
          ownerId: INPUT.ownerId,
          replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
        },
        dependencies,
      ),
    ).rejects.toThrow("non-exact replacement locator");
    expect(fixture.events).toEqual(["db:claim-cleanup", "db:release-cleanup"]);
  });

  for (const containerId of [null, CONTAINER_ID] as const) {
    test(`fences and cleans exact ${containerId ? "enriched" : "id-less"} authority`, async () => {
      const fixture = cleanupHarness({ containerId });
      const result = await reconcileAgentBackupRestoreQuarantinedCreate(
        {
          operationId: OPERATION_ID,
          ownerId: INPUT.ownerId,
          replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
        },
        fixture.dependencies,
      );

      expect(result).toMatchObject({
        status: "cleanup_proven",
        replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
        replayed: false,
      });
      expect(result.status === "cleanup_proven" && result.cleanupReceiptDigest).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(fixture.events).toEqual([
        "db:claim-cleanup",
        "db:begin-cleanup",
        "provider:cleanup",
        "db:finish-cleanup",
      ]);
    });
  }

  test("never cleans provider success that won the atomic settlement race", async () => {
    const fixture = cleanupHarness({
      initialState: "provider_succeeded",
      containerId: CONTAINER_ID,
    });
    const result = await reconcileAgentBackupRestoreQuarantinedCreate(
      {
        operationId: OPERATION_ID,
        ownerId: INPUT.ownerId,
        replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      },
      fixture.dependencies,
    );

    expect(result).toEqual({
      status: "provider_succeeded",
      operationId: OPERATION_ID,
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      containerId: CONTAINER_ID,
      providerReceiptDigest: fixture.providerReceiptDigest,
      replayed: true,
    });
    expect(fixture.events).toEqual(["db:claim-cleanup", "db:release-cleanup"]);
  });

  test("rejects a forged provider receipt, releases its claim, and never cleans", async () => {
    const fixture = cleanupHarness({
      initialState: "provider_succeeded",
      containerId: CONTAINER_ID,
      providerReceiptDigest: "f".repeat(64),
    });
    await expect(
      reconcileAgentBackupRestoreQuarantinedCreate(RECONCILIATION_INPUT, fixture.dependencies),
    ).rejects.toThrow("differs from durable exact authority");
    expect(fixture.state).toBe("provider_succeeded");
    expect(fixture.events).toEqual(["db:claim-cleanup", "db:release-cleanup"]);
  });

  test("readopts provider success after the cleanup-claim release response was lost", async () => {
    const fixture = cleanupHarness({
      initialState: "provider_succeeded",
      containerId: CONTAINER_ID,
      loseReleaseResponse: true,
    });
    await expect(
      reconcileAgentBackupRestoreQuarantinedCreate(RECONCILIATION_INPUT, fixture.dependencies),
    ).rejects.toThrow("serialized claim could not be released");

    const adopted = await reconcileAgentBackupRestoreQuarantinedCreate(
      RECONCILIATION_INPUT,
      fixture.dependencies,
    );
    expect(adopted).toMatchObject({
      status: "provider_succeeded",
      providerReceiptDigest: fixture.providerReceiptDigest,
      replayed: true,
    });
    expect(fixture.events.filter((event) => event === "provider:cleanup")).toHaveLength(0);
    expect(fixture.events.filter((event) => event === "db:claim-cleanup")).toHaveLength(2);
  });

  test("resumes cleanup_in_progress without retained provider success", async () => {
    const fixture = cleanupHarness({
      initialState: "cleanup_in_progress",
      containerId: CONTAINER_ID,
      retainsProviderSuccess: false,
    });
    const result = await reconcileAgentBackupRestoreQuarantinedCreate(
      RECONCILIATION_INPUT,
      fixture.dependencies,
    );
    expect(result).toMatchObject({ status: "cleanup_proven", replayed: true });
    expect(fixture.operationRearmed).toBe(true);
    expect(fixture.retainsProviderSuccess).toBe(false);
    expect(fixture.events).toEqual([
      "db:claim-cleanup",
      "db:begin-cleanup",
      "provider:cleanup",
      "db:finish-cleanup",
    ]);
  });

  test("resumes cleanup_in_progress with retained provider success then rearms vault_seeded", async () => {
    const fixture = cleanupHarness({
      initialState: "cleanup_in_progress",
      containerId: CONTAINER_ID,
      retainsProviderSuccess: true,
    });
    const result = await reconcileAgentBackupRestoreQuarantinedCreate(
      RECONCILIATION_INPUT,
      fixture.dependencies,
    );
    expect(result).toMatchObject({ status: "cleanup_proven", replayed: true });
    expect(fixture.operationRearmed).toBe(true);
    expect(fixture.retainsProviderSuccess).toBe(true);
    expect(fixture.events).toEqual([
      "db:claim-cleanup",
      "db:begin-cleanup",
      "provider:cleanup",
      "db:finish-cleanup",
    ]);
  });

  test("resumes cleanup after the begin response was lost", async () => {
    const fixture = cleanupHarness({ loseBeginResponse: true });
    await expect(
      reconcileAgentBackupRestoreQuarantinedCreate(RECONCILIATION_INPUT, fixture.dependencies),
    ).rejects.toThrow("lost cleanup-begin response");

    const result = await reconcileAgentBackupRestoreQuarantinedCreate(
      RECONCILIATION_INPUT,
      fixture.dependencies,
    );
    expect(result).toMatchObject({ status: "cleanup_proven", replayed: true });
    expect(fixture.events.filter((event) => event === "db:begin-cleanup")).toHaveLength(2);
    expect(fixture.events.filter((event) => event === "provider:cleanup")).toHaveLength(1);
    expect(fixture.events.filter((event) => event === "db:finish-cleanup")).toHaveLength(1);
  });

  test("replays cleanup proof without a second remote cleanup", async () => {
    const fixture = cleanupHarness({ initialState: "cleanup_proven" });
    const result = await reconcileAgentBackupRestoreQuarantinedCreate(
      {
        operationId: OPERATION_ID,
        ownerId: INPUT.ownerId,
        replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      },
      fixture.dependencies,
    );

    expect(result).toMatchObject({ status: "cleanup_proven", replayed: true });
    expect(fixture.events).toEqual(["db:claim-cleanup"]);
  });

  test("replays cleanup proof while an independent generic operation claim remains live", async () => {
    const fixture = cleanupHarness({ initialState: "cleanup_proven" });
    const claimCleanup = fixture.dependencies.claimCleanup;
    const genericClaimExpiresAt = new Date("2026-08-29T00:05:00Z");
    const dependencies: AgentBackupRestoreQuarantinedCreateDependencies = {
      ...fixture.dependencies,
      claimCleanup: async (input) => {
        const claimed = await claimCleanup(input);
        return {
          ...claimed,
          operation: {
            ...claimed.operation,
            claim_owner: "independent-worker",
            claim_generation: CLAIM_GENERATIONS[2],
            claim_expires_at: genericClaimExpiresAt,
          },
        };
      },
    };

    const result = await reconcileAgentBackupRestoreQuarantinedCreate(
      RECONCILIATION_INPUT,
      dependencies,
    );

    expect(result).toMatchObject({ status: "cleanup_proven", replayed: true });
    expect(fixture.events).toEqual(["db:claim-cleanup"]);
  });

  test("releases the serialized cleanup claim after an unresolved provider error", async () => {
    const fixture = cleanupHarness({ providerThrows: true });
    await expect(
      reconcileAgentBackupRestoreQuarantinedCreate(
        {
          operationId: OPERATION_ID,
          ownerId: INPUT.ownerId,
          replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
        },
        fixture.dependencies,
      ),
    ).rejects.toThrow("remote cleanup unresolved");
    expect(fixture.events).toEqual([
      "db:claim-cleanup",
      "db:begin-cleanup",
      "provider:cleanup",
      "db:release-cleanup",
    ]);
  });

  test("replays exact cleanup after the provider response was lost", async () => {
    const fixture = cleanupHarness({ loseProviderResponse: true });
    await expect(
      reconcileAgentBackupRestoreQuarantinedCreate(RECONCILIATION_INPUT, fixture.dependencies),
    ).rejects.toThrow("lost remote cleanup response");

    const result = await reconcileAgentBackupRestoreQuarantinedCreate(
      RECONCILIATION_INPUT,
      fixture.dependencies,
    );
    expect(result).toMatchObject({ status: "cleanup_proven", replayed: true });
    expect(fixture.events.filter((event) => event === "provider:cleanup")).toHaveLength(2);
    expect(fixture.events.filter((event) => event === "db:finish-cleanup")).toHaveLength(1);
  });

  test("adopts a cleanup proof after the finish response was lost", async () => {
    const fixture = cleanupHarness({ loseFinishResponse: true });
    await expect(
      reconcileAgentBackupRestoreQuarantinedCreate(
        {
          operationId: OPERATION_ID,
          ownerId: INPUT.ownerId,
          replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
        },
        fixture.dependencies,
      ),
    ).rejects.toThrow("serialized claim could not be released");

    const result = await reconcileAgentBackupRestoreQuarantinedCreate(
      {
        operationId: OPERATION_ID,
        ownerId: INPUT.ownerId,
        replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      },
      fixture.dependencies,
    );
    expect(result).toMatchObject({ status: "cleanup_proven", replayed: true });
    expect(fixture.events.filter((event) => event === "provider:cleanup")).toHaveLength(1);
  });
});
