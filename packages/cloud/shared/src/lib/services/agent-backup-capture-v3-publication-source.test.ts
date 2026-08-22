import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KmsAeadOperationKeyBundleProvider, LocalKmsAdapter } from "@elizaos/core/security/kms";
import {
  AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
  AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
  AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
  type AgentBackupCaptureV2ComponentDescriptor,
  type AgentBackupCaptureV2Frame,
  type AgentBackupCaptureV2Request,
  canonicalizeAgentBackupOperationKeyBundleContext,
} from "@elizaos/shared";
import type { AgentBackupOperationClaim } from "../../db/repositories/agent-backup-catalog";
import {
  type AgentBackupCaptureV3Artifacts,
  type AgentBackupCaptureV3ManifestAuthority,
  deriveAgentBackupCaptureV3SpoolAuthorityDigests,
  runAgentBackupCaptureV2Pipeline,
} from "./agent-backup-capture-v2-pipeline";
import type {
  AgentBackupCaptureV3SpoolConfig,
  AgentBackupCaptureV3SpoolLockAuthority,
} from "./agent-backup-capture-v2-spool";
import { AgentBackupCaptureV3Spool } from "./agent-backup-capture-v2-spool";
import {
  createAgentBackupCaptureV3PublicationSourceResolver,
  deriveAgentBackupCaptureV3SpoolAuthorityFromCatalogBackup,
} from "./agent-backup-capture-v3-publication-source";
import { createAgentBackupCaptureV3SpoolCleanupJanitor } from "./agent-backup-capture-v3-spool-cleanup";

const ORGANIZATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const BACKUP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const ACTIVATION_GENERATION = "33333333-3333-4333-8333-333333333333";
const CAPTURE_EXECUTION = "66666666-6666-4666-8666-666666666666";
const PUBLICATION_EXECUTION = "77777777-7777-4777-8777-777777777777";
const RETRY_EXECUTION = "99999999-9999-4999-8999-999999999999";
const NODE_RECORD_ID = "44444444-4444-4444-8444-444444444444";
const NODE_INCARNATION = "55555555-5555-4555-8555-555555555555";
const VAULT_KEY_GENERATION_ID = "88888888-8888-4888-8888-888888888888";
const CONTAINER_ID = "c".repeat(64);
const NOW_MS = Date.parse("2026-08-15T10:01:00.000Z");
const COMPONENTS = ["character", "database", "media", "state-files", "vault"] as const;

setDefaultTimeout(30_000);

const request: AgentBackupCaptureV2Request = {
  format: AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
  schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
  operationId: OPERATION_ID,
  agentId: AGENT_ID,
  activationGeneration: ACTIVATION_GENERATION,
  lifecycleRevision: "42",
  deadlineEpochMs: NOW_MS + 60_000,
};

const authority: AgentBackupCaptureV3ManifestAuthority = {
  createdAt: "2026-08-15T10:00:00.000Z",
  organizationId: ORGANIZATION_ID,
  source: {
    kind: "cloud",
    provider: "hetzner",
    nodeRecordId: NODE_RECORD_ID,
    nodeIncarnation: NODE_INCARNATION,
    nodeId: "cloud-node-9",
    containerId: CONTAINER_ID,
    providerServerId: "1234",
  },
  runtime: {
    imageDigest: `sha256:${"a".repeat(64)}`,
    agentSchemaVersion: "agent-v2",
    databaseSchemaVersion: "pglite-v1",
    plugins: [{ id: "@elizaos/plugin-sql", version: "2.0.0" }],
  },
  chain: {
    kind: "full",
    baseOperationId: null,
    parentOperationId: null,
    depth: 0,
  },
  watermarks: [{ namespace: "database.lsn", value: "snapshot-42" }],
  vaultKeyAuthority: {
    format: "kms-aead-vault-passphrase-v1",
    generationId: VAULT_KEY_GENERATION_ID,
    receiptDerivation: "elizaos.agent-vault-key.authority-receipt.v1",
    receiptDigest: "f".repeat(64),
  },
  kms: {
    provider: "steward",
    keyId: `org:${ORGANIZATION_ID}/dek/v1`,
    keyVersion: 1,
  },
};

function descriptor(name: (typeof COMPONENTS)[number]): AgentBackupCaptureV2ComponentDescriptor {
  return {
    name,
    format: "synthetic-v1",
    compression: "none",
    contentKind: "opaque",
    consistency: "transactional",
  };
}

function frame(header: AgentBackupCaptureV2Frame["header"], payload = new Uint8Array(0)) {
  return { header, payload, frameSha256: "0".repeat(64) } satisfies AgentBackupCaptureV2Frame;
}

async function* captureFrames(payloadOffset = 0): AsyncGenerator<AgentBackupCaptureV2Frame> {
  let sequence = 0;
  let totalPlainBytes = 0;
  yield frame({
    format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
    sequence: sequence++,
    kind: "capture-start",
    operationId: OPERATION_ID,
    agentId: AGENT_ID,
    activationGeneration: ACTIVATION_GENERATION,
    lifecycleRevision: "42",
    createdAt: "2026-08-15T10:00:01.000Z",
    componentCount: COMPONENTS.length,
    maxFramePayloadBytes: 256 * 1024,
  });
  for (const [componentIndex, name] of COMPONENTS.entries()) {
    yield frame({
      format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
      schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
      sequence: sequence++,
      kind: "component-start",
      componentIndex,
      component: descriptor(name),
    });
    const payload = new Uint8Array([componentIndex + 1 + payloadOffset]);
    yield frame(
      {
        format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
        schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
        sequence: sequence++,
        kind: "data",
        componentIndex,
        componentName: name,
        dataIndex: 0,
        offsetBytes: 0,
        payloadBytes: payload.byteLength,
      },
      payload,
    );
    yield frame({
      format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
      schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
      sequence: sequence++,
      kind: "component-end",
      componentIndex,
      componentName: name,
      dataFrameCount: 1,
      plainBytes: payload.byteLength,
      payloadSha256: createHash("sha256").update(payload).digest("hex"),
    });
    totalPlainBytes += payload.byteLength;
  }
  yield frame({
    format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
    sequence,
    kind: "capture-end",
    componentCount: COMPONENTS.length,
    dataFrameCount: COMPONENTS.length,
    plainBytes: totalPlainBytes,
    frameDigestChainSha256: "0".repeat(64),
  });
}

async function* partialCaptureFrames(): AsyncGenerator<AgentBackupCaptureV2Frame> {
  for await (const captured of captureFrames()) {
    yield captured;
    if (captured.header.kind === "component-end") return;
  }
}

function lockAuthority(): AgentBackupCaptureV3SpoolLockAuthority {
  return {
    async currentProcessIdentity() {
      return {
        linuxBootId: "88888888-8888-4888-8888-888888888888",
        pid: 4242,
        processStartTime: "100",
      };
    },
    async isProcessIdentityAlive() {
      return true;
    },
  };
}

async function stateDirectory(): Promise<string> {
  return fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.homedir(), ".eliza-v3-publication-source-test-")),
  );
}

function spoolConfig(directory: string): AgentBackupCaptureV3SpoolConfig {
  return {
    stateDirectory: directory,
    maxSpoolBytes: 8 * 1024 * 1024,
    minFreeBytes: 0,
    lockAuthority: lockAuthority(),
  };
}

async function capturedFixture(directory: string): Promise<AgentBackupCaptureV3Artifacts> {
  let captured: AgentBackupCaptureV3Artifacts | undefined;
  await runAgentBackupCaptureV2Pipeline({
    request,
    runtimePrincipalSha256: "3".repeat(64),
    executionToken: CAPTURE_EXECUTION,
    authority,
    openCapture: () => captureFrames(),
    spool: spoolConfig(directory),
    keyBundle: new KmsAeadOperationKeyBundleProvider(
      new LocalKmsAdapter({ rootKey: new Uint8Array(32).fill(0xa5) }),
    ),
    publication: {
      mode: "capture-only",
      async recordCaptured(artifacts) {
        captured = artifacts;
        return true;
      },
    },
    heartbeat: () => true,
    now: () => NOW_MS,
  });
  if (!captured) throw new Error("capture fixture did not record manifest");
  return captured;
}

function claim(
  artifacts: AgentBackupCaptureV3Artifacts,
  generation = PUBLICATION_EXECUTION,
): AgentBackupOperationClaim {
  const manifest = artifacts.manifest;
  const catalog = artifacts.catalogManifest;
  const bundle = manifest.encryption.operationKeyBundle;
  const context = canonicalizeAgentBackupOperationKeyBundleContext({
    organizationId: ORGANIZATION_ID,
    agentId: AGENT_ID,
    activationGeneration: ACTIVATION_GENERATION,
    lifecycleRevision: "42",
    operationId: OPERATION_ID,
    keyBundleGenerationId: bundle.generationId,
    sourceKind: "cloud",
    sourceProvider: "hetzner",
    kmsProvider: "steward",
    keyId: authority.kms.keyId,
    keyVersion: authority.kms.keyVersion,
  });
  return {
    ownerId: "publication-worker-1",
    generation,
    backup: {
      id: BACKUP_ID,
      catalog_version: 2,
      catalog_state: "uploading",
      catalog_organization_id: ORGANIZATION_ID,
      catalog_agent_id: AGENT_ID,
      backup_operation_id: OPERATION_ID,
      lifecycle_generation: ACTIVATION_GENERATION,
      lifecycle_revision: 42n,
      source_provider: "hetzner-cloud",
      source_node_record_id: NODE_RECORD_ID,
      source_node_id: "cloud-node-9",
      source_node_incarnation: NODE_INCARNATION,
      source_provider_server_id: "1234",
      source_provider_handle: "agent-cloud-42",
      source_container_id: CONTAINER_ID,
      manifest_format: catalog.format,
      manifest_version: catalog.version,
      manifest_digest: catalog.digest,
      manifest_canonical_draft: catalog.canonicalManifestDraft,
      manifest_object_count: catalog.objectCount,
      object_inventory_digest: catalog.objectInventoryDigest,
      image_digest: catalog.imageDigest,
      database_schema_version: catalog.databaseSchemaVersion,
      plugin_set_digest: catalog.pluginSetDigest,
      watermark_digest: catalog.watermarkDigest,
      raw_size_bytes: catalog.rawSizeBytes,
      compressed_size_bytes: catalog.compressedSizeBytes,
      encrypted_size_bytes: catalog.encryptedSizeBytes,
      kms_key_id: catalog.kmsKeyId,
      kms_key_version: catalog.kmsKeyVersion,
      wrapped_dek_ref: null,
      wrapped_dek_ciphertext_base64: null,
      wrapped_dek_sha256: null,
      wrapped_dek_size_bytes: null,
      wrapped_dek_receipt_digest: null,
      operation_key_bundle_generation_id: catalog.wrappedKeyBundleGenerationId,
      operation_key_bundle_format: bundle.format,
      operation_key_bundle_ref: bundle.wrapped.ref,
      operation_key_bundle_ciphertext_base64: catalog.wrappedKeyBundleCiphertextBase64,
      operation_key_bundle_sha256: catalog.wrappedKeyBundleSha256,
      operation_key_bundle_size_bytes: bundle.wrapped.bytes,
      operation_key_bundle_context: context,
      operation_key_bundle_context_derivation: bundle.wrapped.contextDerivation,
      operation_key_bundle_local_receipt_derivation: bundle.wrapped.localReceiptDerivation,
      operation_key_bundle_local_receipt_digest: catalog.wrappedKeyBundleLocalReceiptDigest,
      vault_key_generation_id: catalog.vaultKeyGenerationId,
      vault_key_authority_receipt_digest: catalog.vaultKeyAuthorityReceiptDigest,
      catalog_lease_owner: "publication-worker-1",
      catalog_lease_generation: generation,
      catalog_lease_expires_at: new Date(NOW_MS + 60_000),
      created_at: new Date(authority.createdAt),
    },
  } as AgentBackupOperationClaim;
}

describe("capture-v3 publication source", () => {
  test("reopens capture-only handoff, verifies bytes, and resumes partial publication", async () => {
    const directory = await stateDirectory();
    try {
      const artifacts = await capturedFixture(directory);
      const resolve = createAgentBackupCaptureV3PublicationSourceResolver({
        spool: spoolConfig(directory),
        now: () => NOW_MS,
      });
      const firstClaim = claim(artifacts);
      const first = await resolve({
        claim: firstClaim,
        execution: { ownerId: firstClaim.ownerId, generation: firstClaim.generation },
      });
      expect(first.chunks).toHaveLength(5);
      await first.beginPrimaryPublication();
      const firstChunk = first.chunks[0]!;
      const bytes = await first.readCiphertextChunk(firstChunk);
      expect(bytes.byteLength).toBe(firstChunk.sizeBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(firstChunk.ciphertextSha256);
      bytes.fill(0);
      await first.markPrimaryChunkUploaded(firstChunk);
      // Simulate response/process loss after one immutable PUT receipt. Close
      // releases only ownership; it does not remove the sealed operation.
      await first.close();

      const retryClaim = claim(artifacts, RETRY_EXECUTION);
      const retry = await resolve({
        claim: retryClaim,
        execution: { ownerId: retryClaim.ownerId, generation: retryClaim.generation },
      });
      await retry.beginPrimaryPublication();
      for (const chunk of retry.chunks) await retry.markPrimaryChunkUploaded(chunk);
      await retry.markPrimaryPublished();
      await retry.close();

      const replayGeneration = "12121212-1212-4212-8212-121212121212";
      const replayClaim = claim(artifacts, replayGeneration);
      replayClaim.backup.catalog_state = "primary_uploaded";
      const replay = await resolve({
        claim: replayClaim,
        execution: { ownerId: replayClaim.ownerId, generation: replayClaim.generation },
      });
      expect(replay.chunks).toEqual(retry.chunks);
      await replay.beginPrimaryPublication();
      await replay.markPrimaryPublished();
      await replay.close();
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  test("repairs a lost recordCaptured response before captured advances to uploading", async () => {
    const directory = await stateDirectory();
    try {
      const artifacts = await capturedFixture(directory);
      const operationDirectory = path.join(directory, "agent-backup-capture-v3", OPERATION_ID);
      const journalPath = path.join(operationDirectory, "journal.json");
      const journal = JSON.parse(await fs.promises.readFile(journalPath, "utf8")) as {
        recordCaptured: "pending" | "confirmed";
        committedBytes: number;
        catalogManifest?: { bytes: number };
      };
      expect(journal.recordCaptured).toBe("confirmed");
      expect(journal.catalogManifest).toBeDefined();
      journal.committedBytes -= journal.catalogManifest?.bytes ?? 0;
      journal.recordCaptured = "pending";
      delete journal.catalogManifest;
      await fs.promises.unlink(path.join(operationDirectory, "catalog-manifest.json"));
      await fs.promises.writeFile(journalPath, `${JSON.stringify(journal)}\n`);

      let terminalAuthorizations = 0;
      const janitor = createAgentBackupCaptureV3SpoolCleanupJanitor(
        { spool: spoolConfig(directory), batchSize: 1 },
        {
          now: () => NOW_MS,
          executionToken: () => RETRY_EXECUTION,
          authorizeTerminal: async () => {
            terminalAuthorizations += 1;
            throw new Error("recordCaptured won; terminal cleanup must not authorize");
          },
        },
      );
      await janitor.stageTerminalFailure({
        authority: {
          organizationId: ORGANIZATION_ID,
          agentId: AGENT_ID,
          backupId: BACKUP_ID,
          operationId: OPERATION_ID,
          activationGeneration: ACTIVATION_GENERATION,
          lifecycleRevision: "42",
          ...deriveAgentBackupCaptureV3SpoolAuthorityDigests({ request, authority }),
          runtimePrincipalSha256: "3".repeat(64),
        },
        terminalErrorCode: "BACKUP_CAPTURE_V2_TERMINAL",
      });

      const resolve = createAgentBackupCaptureV3PublicationSourceResolver({
        spool: spoolConfig(directory),
        now: () => NOW_MS,
      });
      const capturedClaim = claim(artifacts);
      capturedClaim.backup.catalog_state = "captured";
      const source = await resolve({
        claim: capturedClaim,
        execution: {
          ownerId: capturedClaim.ownerId,
          generation: capturedClaim.generation,
        },
      });
      await source.close();

      const repaired = JSON.parse(await fs.promises.readFile(journalPath, "utf8")) as {
        recordCaptured: string;
        catalogManifest?: { file: string; bytes: number; sha256: string };
      };
      expect(repaired.recordCaptured).toBe("confirmed");
      expect(repaired.catalogManifest).toMatchObject({
        file: "catalog-manifest.json",
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const reconciled = await janitor.runCycle();
      expect(reconciled.completed).toBe(0);
      expect(terminalAuthorizations).toBe(0);
      expect(
        await fs.promises.readdir(
          path.join(directory, "agent-backup-capture-v3-terminal-cleanup-candidates"),
        ),
      ).toEqual([]);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects stale execution before taking the spool lock", async () => {
    const directory = await stateDirectory();
    try {
      const artifacts = await capturedFixture(directory);
      const resolve = createAgentBackupCaptureV3PublicationSourceResolver({
        spool: spoolConfig(directory),
        now: () => NOW_MS,
      });
      const ownedClaim = claim(artifacts);
      await expect(
        resolve({
          claim: ownedClaim,
          execution: { ownerId: ownedClaim.ownerId, generation: RETRY_EXECUTION },
        }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V3_PUBLICATION_EXECUTION_STALE" });

      const source = await resolve({
        claim: ownedClaim,
        execution: { ownerId: ownedClaim.ownerId, generation: ownedClaim.generation },
      });
      await source.close();
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  test("stops the cleanup janitor after abort during its first await without starting another action", async () => {
    const directory = await stateDirectory();
    const controller = new AbortController();
    const reason = new Error("shutdown during spool discovery");
    const actions: string[] = [];
    let releaseDiscovery!: () => void;
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    const discoveryRelease = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    try {
      const janitor = createAgentBackupCaptureV3SpoolCleanupJanitor(
        { spool: spoolConfig(directory), batchSize: 4 },
        {
          async listDurableOperations() {
            actions.push("list-durable");
            markDiscoveryStarted();
            await discoveryRelease;
            return [];
          },
          async listCandidates() {
            actions.push("list-candidates");
            return [];
          },
          async authorize() {
            actions.push("authorize-protected");
            throw new Error("aborted janitor must not authorize protected cleanup");
          },
          async authorizeTerminal() {
            actions.push("authorize-terminal");
            throw new Error("aborted janitor must not authorize terminal cleanup");
          },
          async deriveAuthority() {
            actions.push("derive-authority");
            throw new Error("aborted janitor must not derive another authority");
          },
          async openExisting() {
            actions.push("open-cleanup");
            return undefined;
          },
        },
      );

      const cycle = janitor.runCycle(controller.signal);
      await discoveryStarted;
      controller.abort(reason);
      releaseDiscovery();

      await expect(cycle).rejects.toBe(reason);
      expect(actions).toEqual(["list-durable"]);
      expect(await fs.promises.readdir(directory)).toEqual([]);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  test("propagates abort during cleanup without starting a catch-path close", async () => {
    const directory = await stateDirectory();
    const controller = new AbortController();
    const reason = new Error("shutdown during spool cleanup");
    let releaseCleanup!: () => void;
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    const cleanupRelease = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupCalls = 0;
    let closeCalls = 0;
    try {
      const artifacts = await capturedFixture(directory);
      const protectedBackup = {
        ...claim(artifacts).backup,
        catalog_state: "protected" as const,
        catalog_lease_owner: null,
        catalog_lease_generation: null,
        catalog_lease_expires_at: null,
        secondary_verified_at: new Date(NOW_MS),
      };
      const protectedAuthority =
        await deriveAgentBackupCaptureV3SpoolAuthorityFromCatalogBackup(protectedBackup);
      const janitor = createAgentBackupCaptureV3SpoolCleanupJanitor(
        { spool: spoolConfig(directory), batchSize: 1 },
        {
          now: () => NOW_MS,
          executionToken: () => RETRY_EXECUTION,
          listDurableOperations: async () => [
            {
              operationId: protectedAuthority.operationId,
              requestSha256: protectedAuthority.requestSha256,
              authoritySha256: protectedAuthority.authoritySha256,
              phase: "published",
              recordCaptured: true,
            },
          ],
          listCandidates: async () => [protectedBackup],
          authorize: async () => protectedBackup,
          openExisting: async () =>
            ({
              operationId: protectedAuthority.operationId,
              phase: "published",
              recordCaptured: true,
              async cleanup() {
                cleanupCalls += 1;
                markCleanupStarted();
                await cleanupRelease;
                return { operationId: protectedAuthority.operationId, status: "pending" };
              },
              async close() {
                closeCalls += 1;
              },
            }) as unknown as AgentBackupCaptureV3Spool,
        },
      );

      const cycle = janitor.runCycle(controller.signal);
      await cleanupStarted;
      controller.abort(reason);
      releaseCleanup();

      await expect(cycle).rejects.toBe(reason);
      expect(cleanupCalls).toBe(1);
      expect(closeCalls).toBe(0);
      expect(
        await fs.promises.readdir(path.join(directory, "agent-backup-capture-v3-cleanup-outbox")),
      ).toContain(`${OPERATION_ID}.json`);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps published spool until authoritative protected proof, then removes it", async () => {
    const directory = await stateDirectory();
    try {
      const artifacts = await capturedFixture(directory);
      const resolve = createAgentBackupCaptureV3PublicationSourceResolver({
        spool: spoolConfig(directory),
        now: () => NOW_MS,
      });
      const publicationClaim = claim(artifacts);
      const source = await resolve({
        claim: publicationClaim,
        execution: {
          ownerId: publicationClaim.ownerId,
          generation: publicationClaim.generation,
        },
      });
      await source.beginPrimaryPublication();
      for (const chunk of source.chunks) await source.markPrimaryChunkUploaded(chunk);
      await source.markPrimaryPublished();
      await source.close();

      const protectedBackup = {
        ...publicationClaim.backup,
        catalog_state: "protected" as const,
        catalog_lease_owner: null,
        catalog_lease_generation: null,
        catalog_lease_expires_at: null,
        secondary_verified_at: new Date(NOW_MS),
      };
      const spoolAuthority =
        await deriveAgentBackupCaptureV3SpoolAuthorityFromCatalogBackup(protectedBackup);
      let protectedVisible = false;
      const janitor = createAgentBackupCaptureV3SpoolCleanupJanitor(
        { spool: spoolConfig(directory), batchSize: 4 },
        {
          now: () => NOW_MS,
          listCandidates: async () => (protectedVisible ? [protectedBackup] : []),
          authorize: async () => {
            if (!protectedVisible) throw new Error("secondary_pending has no cleanup authority");
            return protectedBackup;
          },
        },
      );
      const beforeProtection = await janitor.runCycle();
      expect(beforeProtection).toMatchObject({ completed: 0, skippedUnprotected: 1 });
      expect(
        await AgentBackupCaptureV3Spool.listDurableOperationAuthorities(spoolConfig(directory)),
      ).toHaveLength(1);

      protectedVisible = true;
      const protectedCleanup = await janitor.runCycle();
      expect(protectedCleanup).toMatchObject({ authorized: 1, completed: 1, pending: 0 });
      expect(
        await AgentBackupCaptureV3Spool.listDurableOperationAuthorities(spoolConfig(directory)),
      ).toHaveLength(0);
      await expect(
        resolve({
          claim: publicationClaim,
          execution: {
            ownerId: publicationClaim.ownerId,
            generation: publicationClaim.generation,
          },
        }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V3_PUBLICATION_HANDOFF_MISSING" });
      expect(
        await AgentBackupCaptureV3Spool.openExisting(spoolConfig(directory), {
          ...spoolAuthority,
          executionToken: "13131313-1313-4313-8313-131313131313",
        }),
      ).toBeUndefined();
      expect(
        await AgentBackupCaptureV3Spool.listDurableOperationAuthorities(spoolConfig(directory)),
      ).toHaveLength(0);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  test("retains changed partial replay until terminal settlement authorizes bounded cleanup", async () => {
    const directory = await stateDirectory();
    const pipelineInput = {
      request,
      runtimePrincipalSha256: "3".repeat(64),
      authority,
      spool: spoolConfig(directory),
      keyBundle: new KmsAeadOperationKeyBundleProvider(
        new LocalKmsAdapter({ rootKey: new Uint8Array(32).fill(0xa5) }),
      ),
      publication: {
        mode: "capture-only" as const,
        async recordCaptured() {
          throw new Error("Partial capture must not reach recordCaptured");
        },
      },
      heartbeat: () => true as const,
      now: () => NOW_MS,
    };
    try {
      await expect(
        runAgentBackupCaptureV2Pipeline({
          ...pipelineInput,
          executionToken: CAPTURE_EXECUTION,
          openCapture: () => partialCaptureFrames(),
        }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V2_CAPTURE_TRUNCATED" });

      await expect(
        runAgentBackupCaptureV2Pipeline({
          ...pipelineInput,
          executionToken: RETRY_EXECUTION,
          openCapture: () => captureFrames(10),
        }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V2_SPOOL_REPLAY_CONFLICT" });

      const terminalAuthority = {
        organizationId: ORGANIZATION_ID,
        agentId: AGENT_ID,
        backupId: BACKUP_ID,
        operationId: OPERATION_ID,
        activationGeneration: ACTIVATION_GENERATION,
        lifecycleRevision: "42",
        ...deriveAgentBackupCaptureV3SpoolAuthorityDigests({ request, authority }),
        runtimePrincipalSha256: "3".repeat(64),
      };
      const terminalBackup = {
        id: BACKUP_ID,
        catalog_version: 2,
        catalog_state: "failed_terminal",
        catalog_resume_state: "capturing",
        catalog_organization_id: ORGANIZATION_ID,
        catalog_agent_id: AGENT_ID,
        backup_operation_id: OPERATION_ID,
        lifecycle_generation: ACTIVATION_GENERATION,
        lifecycle_revision: 42n,
        catalog_last_error_code: "BACKUP_CAPTURE_V2_TERMINAL",
        manifest_digest: null,
        manifest_canonical_draft: null,
        object_inventory_digest: null,
      } as AgentBackupOperationClaim["backup"];
      let terminalSettled = false;
      let terminalProofStable = false;
      let terminalProofs = 0;
      const janitor = createAgentBackupCaptureV3SpoolCleanupJanitor(
        { spool: spoolConfig(directory), batchSize: 1 },
        {
          now: () => NOW_MS,
          executionToken: () => RETRY_EXECUTION,
          authorizeTerminal: async () => {
            if (!terminalSettled) throw new Error("terminal CAS is not yet visible");
            terminalProofs += 1;
            if (terminalProofs > 1 && !terminalProofStable) {
              throw new Error("terminal authority changed before cleanup");
            }
            return terminalBackup;
          },
        },
      );

      const beforeSettlement = await janitor.runCycle();
      expect(beforeSettlement).toMatchObject({
        discovered: 1,
        completed: 0,
        skippedUnprotected: 1,
      });
      expect(
        await AgentBackupCaptureV3Spool.listDurableOperationAuthorities(spoolConfig(directory)),
      ).toHaveLength(1);

      await expect(
        janitor.stageTerminalFailure({
          authority: { ...terminalAuthority, requestSha256: "f".repeat(64) },
          terminalErrorCode: "BACKUP_CAPTURE_V2_TERMINAL",
        }),
      ).rejects.toThrow("Terminal spool cleanup candidate differs from durable capture state");
      expect(
        await AgentBackupCaptureV3Spool.listDurableOperationAuthorities(spoolConfig(directory)),
      ).toHaveLength(1);
      await janitor.stageTerminalFailure({
        authority: terminalAuthority,
        terminalErrorCode: "BACKUP_CAPTURE_V2_TERMINAL",
      });
      const terminalCandidates = path.join(
        directory,
        "agent-backup-capture-v3-terminal-cleanup-candidates",
      );
      const terminalOutbox = path.join(
        directory,
        "agent-backup-capture-v3-terminal-cleanup-outbox",
      );
      expect(await fs.promises.readdir(terminalCandidates)).toEqual([`${OPERATION_ID}.json`]);
      expect(await fs.promises.readdir(terminalOutbox)).toEqual([]);

      const ambiguous = await janitor.runCycle();
      expect(ambiguous).toMatchObject({ completed: 0, pending: 1 });
      expect(await fs.promises.readdir(terminalCandidates)).toEqual([`${OPERATION_ID}.json`]);
      expect(
        await AgentBackupCaptureV3Spool.listDurableOperationAuthorities(spoolConfig(directory)),
      ).toHaveLength(1);

      terminalSettled = true;
      const changedBeforeCleanup = await janitor.runCycle();
      expect(changedBeforeCleanup).toMatchObject({ authorized: 1, completed: 0, pending: 1 });
      expect(await fs.promises.readdir(terminalCandidates)).toEqual([]);
      expect(await fs.promises.readdir(terminalOutbox)).toEqual([`${OPERATION_ID}.json`]);
      expect(
        await AgentBackupCaptureV3Spool.listDurableOperationAuthorities(spoolConfig(directory)),
      ).toHaveLength(1);

      terminalProofStable = true;
      const cleaned = await janitor.runCycle();
      expect(cleaned).toMatchObject({ authorized: 0, completed: 1, pending: 0 });
      expect(await fs.promises.readdir(terminalOutbox)).toEqual([]);
      expect(
        await AgentBackupCaptureV3Spool.listDurableOperationAuthorities(spoolConfig(directory)),
      ).toHaveLength(0);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  test("retains a durable cleanup intent across retention expiry and retries it", async () => {
    const directory = await stateDirectory();
    try {
      const artifacts = await capturedFixture(directory);
      const protectedBackup = {
        ...claim(artifacts).backup,
        catalog_state: "protected" as const,
        catalog_lease_owner: null,
        catalog_lease_generation: null,
        catalog_lease_expires_at: null,
        secondary_verified_at: new Date(NOW_MS),
      };
      const authority =
        await deriveAgentBackupCaptureV3SpoolAuthorityFromCatalogBackup(protectedBackup);
      let cleanupStatus: "complete" | "pending" = "pending";
      let authorizedBackup: AgentBackupOperationClaim["backup"] = protectedBackup;
      let authorizations = 0;
      let closes = 0;
      const janitor = createAgentBackupCaptureV3SpoolCleanupJanitor(
        { spool: spoolConfig(directory), batchSize: 1 },
        {
          now: () => NOW_MS,
          executionToken: () => RETRY_EXECUTION,
          listDurableOperations: async () => [
            {
              operationId: authority.operationId,
              requestSha256: authority.requestSha256,
              authoritySha256: authority.authoritySha256,
              phase: "published",
              recordCaptured: true,
            },
          ],
          listCandidates: async () => [protectedBackup],
          authorize: async () => {
            authorizations += 1;
            return authorizedBackup;
          },
          openExisting: async () =>
            ({
              operationId: authority.operationId,
              phase: "published",
              recordCaptured: true,
              async cleanup() {
                return { operationId: authority.operationId, status: cleanupStatus };
              },
              async close() {
                closes += 1;
              },
            }) as unknown as AgentBackupCaptureV3Spool,
        },
      );

      const pending = await janitor.runCycle();
      expect(pending).toMatchObject({ authorized: 1, completed: 0, pending: 1 });
      expect(closes).toBe(1);
      const outbox = path.join(directory, "agent-backup-capture-v3-cleanup-outbox");
      expect(await fs.promises.readdir(outbox)).toContain(`${OPERATION_ID}.json`);

      authorizedBackup = {
        ...protectedBackup,
        catalog_state: "deleting",
        retention_until: new Date(NOW_MS - 1),
      };
      cleanupStatus = "complete";
      const completed = await janitor.runCycle();
      expect(completed).toMatchObject({ authorized: 0, completed: 1, pending: 0 });
      expect(await fs.promises.readdir(outbox)).toEqual([]);
      expect(authorizations).toBe(3);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });
});
