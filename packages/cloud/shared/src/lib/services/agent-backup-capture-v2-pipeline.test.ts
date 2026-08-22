/**
 * Exercises capture-v2 composition into a durable manifest-v3 spool using the
 * real local KMS operation-key-bundle adapter and bounded synthetic ingress.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type KmsAeadOperationKeyBundleHandle,
  KmsAeadOperationKeyBundleProvider,
  LocalKmsAdapter,
} from "@elizaos/core/security/kms";
import {
  AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
  AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
  type AgentBackupCaptureV2ComponentDescriptor,
  type AgentBackupCaptureV2Frame,
  type AgentBackupCaptureV2Request,
} from "@elizaos/shared";
import {
  type AgentBackupCaptureV2PublicationBoundary,
  type AgentBackupCaptureV3Artifacts,
  type AgentBackupCaptureV3KeyBundleProvider,
  type AgentBackupCaptureV3ManifestAuthority,
  deriveAgentBackupCaptureV3RuntimePrincipalSha256,
  runAgentBackupCaptureV2Pipeline,
} from "./agent-backup-capture-v2-pipeline";
import {
  AgentBackupCaptureV3Spool,
  type AgentBackupCaptureV3SpoolLockAuthority,
  type AgentBackupCaptureV3SpoolProcessIdentity,
} from "./agent-backup-capture-v2-spool";

const MIB = 1024 * 1024;
const FRAME_BYTES = 256 * 1024;
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVATION_ID = "33333333-3333-4333-8333-333333333333";
const EXECUTION_TOKEN = "66666666-6666-4666-8666-666666666666";
const NEXT_EXECUTION_TOKEN = "77777777-7777-4777-8777-777777777777";
const TEST_BOOT_ID = "88888888-8888-4888-8888-888888888888";
const VAULT_KEY_GENERATION_ID = "99999999-9999-4999-8999-999999999999";
const RUNTIME_AGENT_A = "aaaaaaaa-1111-4111-8111-111111111111";
const RUNTIME_AGENT_B = "bbbbbbbb-2222-4222-8222-222222222222";

const request: AgentBackupCaptureV2Request = {
  format: "elizaos.agent-backup.capture-request",
  schemaVersion: 2,
  operationId: OPERATION_ID,
  agentId: AGENT_ID,
  activationGeneration: ACTIVATION_ID,
  lifecycleRevision: "42",
  deadlineEpochMs: 2_000_000,
};

const authority: AgentBackupCaptureV3ManifestAuthority = {
  createdAt: "2026-08-15T10:00:00.000Z",
  organizationId: ORGANIZATION_ID,
  source: {
    kind: "cloud",
    provider: "hetzner",
    nodeRecordId: "44444444-4444-4444-8444-444444444444",
    nodeIncarnation: "55555555-5555-4555-8555-555555555555",
    nodeId: "cloud-node-9",
    containerId: "agent-container-42",
    providerServerId: "1234",
  },
  runtime: {
    imageDigest: `sha256:${"a".repeat(64)}`,
    agentSchemaVersion: "agent-v2",
    databaseSchemaVersion: "pglite-v1",
    plugins: [{ id: "@elizaos/plugin-sql", version: "2.0.0" }],
  },
  chain: { kind: "full", baseOperationId: null, parentOperationId: null, depth: 0 },
  watermarks: [{ namespace: "database.lsn", value: "snapshot-42" }],
  vaultKeyAuthority: {
    format: "kms-aead-vault-passphrase-v1",
    generationId: VAULT_KEY_GENERATION_ID,
    receiptDerivation: "elizaos.agent-vault-key.authority-receipt.v1",
    receiptDigest: "f".repeat(64),
  },
  kms: {
    provider: "local",
    keyId: `org:${ORGANIZATION_ID}/dek/v1`,
    keyVersion: 1,
  },
};

const COMPONENTS = ["character", "database", "media", "state-files", "vault"] as const;

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

async function* syntheticCapture(
  totalPayloadBytes: number,
): AsyncGenerator<AgentBackupCaptureV2Frame> {
  let sequence = 0;
  let dataFrameCount = 0;
  let totalPlainBytes = 0;
  yield frame({
    format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
    sequence: sequence++,
    kind: "capture-start",
    operationId: OPERATION_ID,
    agentId: AGENT_ID,
    activationGeneration: ACTIVATION_ID,
    lifecycleRevision: "42",
    createdAt: "2026-08-15T10:00:01.000Z",
    componentCount: COMPONENTS.length,
    maxFramePayloadBytes: FRAME_BYTES,
  });

  const databaseBytes = Math.max(1, totalPayloadBytes - (COMPONENTS.length - 1));
  for (const [componentIndex, name] of COMPONENTS.entries()) {
    yield frame({
      format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
      schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
      sequence: sequence++,
      kind: "component-start",
      componentIndex,
      component: descriptor(name),
    });
    const componentBytes = name === "database" ? databaseBytes : 1;
    const payloadHash = createHash("sha256");
    let componentOffset = 0;
    let componentFrames = 0;
    while (componentOffset < componentBytes) {
      const length = Math.min(FRAME_BYTES, componentBytes - componentOffset);
      const payload = new Uint8Array(length);
      payload.fill((componentIndex * 37 + componentFrames) & 0xff);
      payloadHash.update(payload);
      yield frame(
        {
          format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
          schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
          sequence: sequence++,
          kind: "data",
          componentIndex,
          componentName: name,
          dataIndex: componentFrames,
          offsetBytes: componentOffset,
          payloadBytes: payload.byteLength,
        },
        payload,
      );
      componentOffset += payload.byteLength;
      componentFrames += 1;
      dataFrameCount += 1;
      totalPlainBytes += payload.byteLength;
    }
    yield frame({
      format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
      schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
      sequence: sequence++,
      kind: "component-end",
      componentIndex,
      componentName: name,
      dataFrameCount: componentFrames,
      plainBytes: componentBytes,
      payloadSha256: payloadHash.digest("hex"),
    });
  }
  yield frame({
    format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
    sequence: sequence++,
    kind: "capture-end",
    componentCount: COMPONENTS.length,
    dataFrameCount,
    plainBytes: totalPlainBytes,
    frameDigestChainSha256: "0".repeat(64),
  });
}

function keyBundleProvider(): AgentBackupCaptureV3KeyBundleProvider {
  return new KmsAeadOperationKeyBundleProvider(
    new LocalKmsAdapter({ rootKey: new Uint8Array(32).fill(0xa5) }),
  );
}

interface PublicationProbe {
  boundary: AgentBackupCaptureV2PublicationBoundary;
  recordCalls: AgentBackupCaptureV3Artifacts[];
  uploaded: Map<string, { sha256: string; bytes: number }>;
  maxRss: () => number;
}

function publicationProbe(options: { loseFirstUploadResponse?: boolean } = {}): PublicationProbe {
  const recordCalls: AgentBackupCaptureV3Artifacts[] = [];
  const uploaded = new Map<string, { sha256: string; bytes: number }>();
  let lost = false;
  let observedMaxRss = process.memoryUsage.rss();
  return {
    recordCalls,
    uploaded,
    maxRss: () => observedMaxRss,
    boundary: {
      async recordCaptured(input) {
        recordCalls.push(input);
        return true;
      },
      async uploadPrimary(input) {
        observedMaxRss = Math.max(observedMaxRss, process.memoryUsage.rss());
        const key = `${input.component}:${input.chunkIndex}`;
        const observed = {
          sha256: createHash("sha256").update(input.body).digest("hex"),
          bytes: input.body.byteLength,
        };
        expect(observed.sha256).toBe(input.ciphertextSha256);
        expect(observed.bytes).toBe(input.encryptedBytes);
        const prior = uploaded.get(key);
        if (prior) expect(observed).toEqual(prior);
        uploaded.set(key, observed);
        if (options.loseFirstUploadResponse && !lost) {
          lost = true;
          throw new Error("synthetic response loss after immutable PUT");
        }
        return true;
      },
    },
  };
}

async function stateDirectory(): Promise<string> {
  const created = await fs.promises.mkdtemp(
    path.join(os.homedir(), ".eliza-capture-v2-spool-test-"),
  );
  return fs.promises.realpath(created);
}

async function removeStateDirectory(directory: string): Promise<void> {
  await fs.promises.rm(directory, { recursive: true, force: true });
}

function testLockAuthority(
  current: { value: AgentBackupCaptureV3SpoolProcessIdentity } = {
    value: { linuxBootId: TEST_BOOT_ID, pid: 4242, processStartTime: "100" },
  },
): AgentBackupCaptureV3SpoolLockAuthority {
  return {
    async currentProcessIdentity() {
      return { ...current.value };
    },
    async isProcessIdentityAlive(identity) {
      return (
        identity.linuxBootId === current.value.linuxBootId &&
        identity.pid === current.value.pid &&
        identity.processStartTime === current.value.processStartTime
      );
    },
  };
}

function pipelineInput(
  directory: string,
  bytes: number,
  publication: AgentBackupCaptureV2PublicationBoundary,
  openCount: { value: number },
) {
  return {
    request,
    runtimePrincipalSha256: "3".repeat(64),
    executionToken: EXECUTION_TOKEN,
    authority,
    openCapture() {
      openCount.value += 1;
      return syntheticCapture(bytes);
    },
    spool: {
      stateDirectory: directory,
      maxSpoolBytes: 700 * MIB,
      minFreeBytes: 0,
      lockAuthority: testLockAuthority(),
    },
    keyBundle: keyBundleProvider(),
    publication,
    heartbeat: () => true as const,
    now: () => 1_000_000,
  };
}

function directSpoolInput(executionToken: string) {
  return {
    operationId: OPERATION_ID,
    executionToken,
    requestSha256: "1".repeat(64),
    authoritySha256: "2".repeat(64),
    runtimePrincipalSha256: "3".repeat(64),
  };
}

describe("runAgentBackupCaptureV2Pipeline", () => {
  it("fences a partial spool to its canonical runtime wire principal before replay appends", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe();
    const openCount = { value: 0 };
    const base = pipelineInput(directory, 2 * MIB, probe.boundary, openCount);
    const principalA = deriveAgentBackupCaptureV3RuntimePrincipalSha256(RUNTIME_AGENT_A);
    const principalB = deriveAgentBackupCaptureV3RuntimePrincipalSha256(RUNTIME_AGENT_B);
    try {
      await expect(
        runAgentBackupCaptureV2Pipeline({
          ...base,
          runtimePrincipalSha256: principalA,
          async *openCapture() {
            openCount.value += 1;
            for await (const capturedFrame of syntheticCapture(2 * MIB)) {
              yield capturedFrame;
              if (capturedFrame.header.kind === "component-end") {
                throw new Error("synthetic partial capture after one durable component");
              }
            }
          },
        }),
      ).rejects.toThrow("synthetic partial capture after one durable component");

      const journalPath = path.join(
        directory,
        "agent-backup-capture-v3",
        OPERATION_ID,
        "journal.json",
      );
      const before = await fs.promises.readFile(journalPath, "utf8");
      const journal = JSON.parse(before) as {
        runtimePrincipalSha256: string;
        chunks: unknown[];
        recordCaptured: string;
      };
      expect(journal.runtimePrincipalSha256).toBe(principalA);
      expect(journal.chunks.length).toBeGreaterThan(0);
      expect(journal.recordCaptured).toBe("pending");

      await expect(
        runAgentBackupCaptureV2Pipeline({
          ...base,
          executionToken: NEXT_EXECUTION_TOKEN,
          runtimePrincipalSha256: principalB,
          openCapture() {
            openCount.value += 1;
            return syntheticCapture(2 * MIB);
          },
        }),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_V3_RUNTIME_PRINCIPAL_REPLAY_CONFLICT",
      });
      expect(openCount.value).toBe(1);
      expect(probe.recordCalls).toHaveLength(0);
      expect(await fs.promises.readFile(journalPath, "utf8")).toBe(before);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("rejects incremental authority before opening capture or allocating a spool", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe();
    const openCount = { value: 0 };
    try {
      const input = pipelineInput(directory, MIB, probe.boundary, openCount);
      await expect(
        runAgentBackupCaptureV2Pipeline({
          ...input,
          authority: {
            ...input.authority,
            chain: {
              kind: "incremental",
              baseOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
              parentOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac",
              depth: 1,
            },
          },
        }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V3_INCREMENTAL_CAPTURE_UNSUPPORTED" });
      expect(openCount.value).toBe(0);
      expect(await fs.promises.readdir(directory)).toEqual([]);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("streams and publishes a real 10 MiB capture with explicit pending cleanup", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe();
    const openCount = { value: 0 };
    try {
      const result = await runAgentBackupCaptureV2Pipeline(
        pipelineInput(directory, 10 * MIB, probe.boundary, openCount),
      );
      expect(result.state).toBe("published-cleanup-pending");
      expect(result.cleanup).toBe("pending");
      expect(result.chunkCount).toBeGreaterThan(5);
      expect(openCount.value).toBe(1);
      expect(probe.recordCalls).toHaveLength(1);
      expect(probe.uploaded.size).toBe(result.chunkCount);
      expect(probe.recordCalls[0]?.manifest.components.map((entry) => entry.name)).toEqual([
        "character",
        "database",
        "media",
        "state-files",
        "vault",
      ]);
      expect(await result.spool.cleanup()).toEqual({
        operationId: OPERATION_ID,
        status: "complete",
      });
    } finally {
      await removeStateDirectory(directory);
    }
  }, 30_000);

  it("stops after durable recordCaptured without starting upload or permitting cleanup", async () => {
    const directory = await stateDirectory();
    const recordCalls: AgentBackupCaptureV3Artifacts[] = [];
    const openCount = { value: 0 };
    const publication = {
      mode: "capture-only" as const,
      async recordCaptured(input: AgentBackupCaptureV3Artifacts) {
        recordCalls.push(input);
        return true as const;
      },
    };
    try {
      const firstInput = pipelineInput(directory, 2 * MIB, publication, openCount);
      const captured = await runAgentBackupCaptureV2Pipeline(firstInput);
      expect(captured).toMatchObject({
        state: "captured-upload-pending",
        cleanup: "blocked-on-upload",
      });
      expect(captured.spool.phase).toBe("sealed");
      expect(captured.spool.recordCaptured).toBe(true);
      expect(captured.spool.chunks.every((chunk) => !captured.spool.isChunkUploaded(chunk))).toBe(
        true,
      );
      expect(recordCalls).toHaveLength(1);
      expect(recordCalls[0]?.manifest.schemaVersion).toBe(3);
      expect(recordCalls[0]?.manifest.encryption.operationKeyBundle.wrapped.bytes).toBe(92);
      expect(await captured.spool.cleanup()).toEqual({
        operationId: OPERATION_ID,
        status: "pending",
      });

      const publicationProbeAfterCapture = publicationProbe();
      const resumed = await runAgentBackupCaptureV2Pipeline({
        ...firstInput,
        executionToken: NEXT_EXECUTION_TOKEN,
        request: { ...firstInput.request, deadlineEpochMs: 2_500_000 },
        publication: publicationProbeAfterCapture.boundary,
      });
      expect(resumed.state).toBe("published-cleanup-pending");
      expect(openCount.value).toBe(1);
      expect(recordCalls).toHaveLength(1);
      expect(publicationProbeAfterCapture.recordCalls).toHaveLength(0);
      expect(publicationProbeAfterCapture.uploaded.size).toBe(resumed.chunkCount);
      await resumed.spool.cleanup();
    } finally {
      await removeStateDirectory(directory);
    }
  }, 30_000);

  it("rejects a byte-changed catalogue handoff before reopening publication", async () => {
    const directory = await stateDirectory();
    const openCount = { value: 0 };
    const captureBoundary = {
      mode: "capture-only" as const,
      async recordCaptured() {
        return true as const;
      },
    };
    try {
      const input = pipelineInput(directory, MIB, captureBoundary, openCount);
      await runAgentBackupCaptureV2Pipeline(input);
      const catalogPath = path.join(
        directory,
        "agent-backup-capture-v3",
        OPERATION_ID,
        "catalog-manifest.json",
      );
      const bytes = new Uint8Array(await fs.promises.readFile(catalogPath));
      bytes[Math.floor(bytes.byteLength / 2)] ^= 1;
      await fs.promises.writeFile(catalogPath, bytes);
      await expect(
        runAgentBackupCaptureV2Pipeline({
          ...input,
          executionToken: NEXT_EXECUTION_TOKEN,
          publication: publicationProbe().boundary,
        }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V3_SPOOL_CATALOG_INVALID" });
      expect(openCount.value).toBe(1);
    } finally {
      await removeStateDirectory(directory);
    }
  }, 30_000);

  it("rejects journal chunk metadata that differs from the sealed v3 manifest", async () => {
    const directory = await stateDirectory();
    const openCount = { value: 0 };
    const captureBoundary = {
      mode: "capture-only" as const,
      async recordCaptured() {
        return true as const;
      },
    };
    try {
      const input = pipelineInput(directory, MIB, captureBoundary, openCount);
      await runAgentBackupCaptureV2Pipeline(input);
      const journalPath = path.join(
        directory,
        "agent-backup-capture-v3",
        OPERATION_ID,
        "journal.json",
      );
      const journal = JSON.parse(await fs.promises.readFile(journalPath, "utf8")) as {
        chunks: Array<{ ciphertextSha256: string }>;
      };
      const firstChunk = journal.chunks[0];
      expect(firstChunk).toBeDefined();
      if (firstChunk) firstChunk.ciphertextSha256 = "f".repeat(64);
      await fs.promises.writeFile(journalPath, JSON.stringify(journal));

      await expect(
        runAgentBackupCaptureV2Pipeline({
          ...input,
          executionToken: NEXT_EXECUTION_TOKEN,
          publication: publicationProbe().boundary,
        }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V3_SPOOL_INVENTORY_CONFLICT" });
      expect(openCount.value).toBe(1);
    } finally {
      await removeStateDirectory(directory);
    }
  }, 30_000);

  it("adopts an exact ciphertext orphan after a crash before its journal commit", async () => {
    const directory = await stateDirectory();
    const openCount = { value: 0 };
    const capturedArtifacts: AgentBackupCaptureV3Artifacts[] = [];
    const captureBoundary = {
      mode: "capture-only" as const,
      async recordCaptured(artifacts: AgentBackupCaptureV3Artifacts) {
        capturedArtifacts.push(artifacts);
        return true as const;
      },
    };
    try {
      const input = pipelineInput(directory, 2 * MIB, captureBoundary, openCount);
      const first = await runAgentBackupCaptureV2Pipeline(input);
      expect(capturedArtifacts).toHaveLength(1);
      const journalPath = path.join(
        directory,
        "agent-backup-capture-v3",
        OPERATION_ID,
        "journal.json",
      );
      const journal = JSON.parse(await fs.promises.readFile(journalPath, "utf8")) as {
        phase: string;
        chunks: Array<{ encryptedBytes: number; file: string }>;
        manifest?: { bytes: number };
        catalogManifest?: { bytes: number };
        recordCaptured: string;
        uploadedChunkKeys: string[];
        committedBytes: number;
      };
      const orphan = journal.chunks.pop();
      expect(orphan).toBeDefined();
      expect(journal.manifest).toBeDefined();
      expect(journal.catalogManifest).toBeDefined();
      const orphanPath = path.join(
        directory,
        "agent-backup-capture-v3",
        OPERATION_ID,
        orphan?.file ?? "missing",
      );
      const orphanDigest = createHash("sha256")
        .update(await fs.promises.readFile(orphanPath))
        .digest("hex");
      journal.committedBytes -=
        (orphan?.encryptedBytes ?? 0) +
        (journal.manifest?.bytes ?? 0) +
        (journal.catalogManifest?.bytes ?? 0);
      journal.phase = "capturing";
      journal.recordCaptured = "pending";
      journal.uploadedChunkKeys = [];
      delete journal.manifest;
      delete journal.catalogManifest;
      await fs.promises.writeFile(journalPath, JSON.stringify(journal));

      const publicationAfterCrash = publicationProbe();
      const resumed = await runAgentBackupCaptureV2Pipeline({
        ...input,
        executionToken: NEXT_EXECUTION_TOKEN,
        publication: publicationAfterCrash.boundary,
      });
      expect(resumed.manifestSha256).toBe(first.manifestSha256);
      expect(resumed.chunkCount).toBe(first.chunkCount);
      expect(openCount.value).toBe(2);
      expect(publicationAfterCrash.uploaded.size).toBe(first.chunkCount);
      expect(
        createHash("sha256")
          .update(await fs.promises.readFile(orphanPath))
          .digest("hex"),
      ).toBe(orphanDigest);
      await resumed.spool.cleanup();
    } finally {
      await removeStateDirectory(directory);
    }
  }, 30_000);

  it("replays identical ciphertext and manifest after an upload response is lost", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe({ loseFirstUploadResponse: true });
    const openCount = { value: 0 };
    const input = pipelineInput(directory, 2 * MIB, probe.boundary, openCount);
    try {
      await expect(runAgentBackupCaptureV2Pipeline(input)).rejects.toThrow(
        "synthetic response loss after immutable PUT",
      );
      const firstManifest = probe.recordCalls[0]?.catalogManifest;
      const firstUpload = [...probe.uploaded.entries()][0];
      const resumed = await runAgentBackupCaptureV2Pipeline({
        ...input,
        executionToken: NEXT_EXECUTION_TOKEN,
      });
      expect(openCount.value).toBe(1);
      expect(probe.recordCalls).toHaveLength(1);
      expect(probe.recordCalls[0]?.catalogManifest).toEqual(firstManifest);
      expect([...probe.uploaded.entries()][0]).toEqual(firstUpload);
      expect(resumed.state).toBe("published-cleanup-pending");
      await resumed.spool.cleanup();
    } finally {
      await removeStateDirectory(directory);
    }
  }, 30_000);

  it("keeps RSS bounded while encrypting and publishing 128 MiB", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe();
    const openCount = { value: 0 };
    const baselineRss = process.memoryUsage.rss();
    try {
      const result = await runAgentBackupCaptureV2Pipeline(
        pipelineInput(directory, 128 * MIB, probe.boundary, openCount),
      );
      expect(result.chunkCount).toBeGreaterThanOrEqual(32);
      expect(probe.uploaded.size).toBe(result.chunkCount);
      expect(probe.maxRss() - baselineRss).toBeLessThan(192 * MIB);
      await result.spool.cleanup();
    } finally {
      await removeStateDirectory(directory);
    }
  }, 120_000);

  it("fails before capture when the lease heartbeat is not acknowledged", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe();
    const openCount = { value: 0 };
    try {
      const input = pipelineInput(directory, MIB, probe.boundary, openCount);
      await expect(
        runAgentBackupCaptureV2Pipeline({ ...input, heartbeat: () => false as const }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V2_PIPELINE_LEASE_LOST" });
      expect(openCount.value).toBe(0);
      expect(probe.recordCalls).toHaveLength(0);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("honors abort before opening a capture source", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe();
    const openCount = { value: 0 };
    const controller = new AbortController();
    controller.abort(new Error("lease execution superseded"));
    try {
      const input = pipelineInput(directory, MIB, probe.boundary, openCount);
      await expect(
        runAgentBackupCaptureV2Pipeline({ ...input, signal: controller.signal }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V2_PIPELINE_ABORTED" });
      expect(openCount.value).toBe(0);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("cancels a stuck capture read, bounds close, and erases late ingress", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe();
    const openCount = { value: 0 };
    const controller = new AbortController();
    const latePayload = new Uint8Array(64).fill(0x5a);
    let resolveNext: ((result: IteratorResult<AgentBackupCaptureV2Frame>) => void) | undefined;
    let notifyReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      notifyReadStarted = resolve;
    });
    let returnCalls = 0;
    try {
      const input = pipelineInput(directory, MIB, probe.boundary, openCount);
      const running = runAgentBackupCaptureV2Pipeline({
        ...input,
        signal: controller.signal,
        openCapture() {
          openCount.value += 1;
          return {
            [Symbol.asyncIterator]() {
              return {
                next: () => {
                  notifyReadStarted?.();
                  return new Promise<IteratorResult<AgentBackupCaptureV2Frame>>((resolve) => {
                    resolveNext = resolve;
                  });
                },
                return: () => {
                  returnCalls += 1;
                  return new Promise<IteratorResult<AgentBackupCaptureV2Frame>>(() => undefined);
                },
              };
            },
          };
        },
      });
      await readStarted;
      const started = Date.now();
      controller.abort(new Error("capture lease superseded"));
      await expect(running).rejects.toMatchObject({
        code: "AGENT_BACKUP_V2_PIPELINE_ABORTED",
      });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(returnCalls).toBe(1);
      expect(resolveNext).toBeDefined();
      resolveNext?.({
        done: false,
        value: frame(
          {
            format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
            schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
            sequence: 1,
            kind: "data",
            componentIndex: 0,
            componentName: "database",
            dataIndex: 0,
            offsetBytes: 0,
            payloadBytes: latePayload.byteLength,
          },
          latePayload,
        ),
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(latePayload.every((byte) => byte === 0)).toBe(true);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("does not let a stuck capture read outlive the operation deadline", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe();
    const openCount = { value: 0 };
    let returnCalls = 0;
    try {
      const input = pipelineInput(directory, MIB, probe.boundary, openCount);
      await expect(
        runAgentBackupCaptureV2Pipeline({
          ...input,
          request: { ...input.request, deadlineEpochMs: 1_000_250 },
          openCapture() {
            openCount.value += 1;
            return {
              [Symbol.asyncIterator]() {
                return {
                  next: () =>
                    new Promise<IteratorResult<AgentBackupCaptureV2Frame>>(() => undefined),
                  return: async () => {
                    returnCalls += 1;
                    return { done: true as const, value: undefined };
                  },
                };
              },
            };
          },
        }),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_V2_PIPELINE_DEADLINE_EXCEEDED",
      });
      expect(openCount.value).toBe(1);
      expect(returnCalls).toBe(1);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("releases and erases a key bundle returned after cancellation", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe();
    const openCount = { value: 0 };
    const controller = new AbortController();
    const base = keyBundleProvider();
    let unblock: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let notifyAcquired: (() => void) | undefined;
    const acquired = new Promise<void>((resolve) => {
      notifyAcquired = resolve;
    });
    let notifyReleased: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      notifyReleased = resolve;
    });
    const observed: Uint8Array[] = [];
    const provider: AgentBackupCaptureV3KeyBundleProvider = {
      async acquire(input) {
        const result = await base.acquire(input);
        observed.push(result.handle.dek, result.handle.contentHmacKey);
        notifyAcquired?.();
        await gate;
        return result;
      },
      unwrap: (input) => base.unwrap(input),
      release(handle) {
        const result = base.release(handle);
        notifyReleased?.();
        return result;
      },
    };
    try {
      const input = pipelineInput(directory, MIB, probe.boundary, openCount);
      const running = runAgentBackupCaptureV2Pipeline({
        ...input,
        signal: controller.signal,
        keyBundle: provider,
      });
      await acquired;
      controller.abort(new Error("cancel delayed KMS response"));
      await expect(running).rejects.toMatchObject({
        code: "AGENT_BACKUP_V2_PIPELINE_ABORTED",
      });
      expect(observed).toHaveLength(2);
      expect(observed.some((view) => view.some((byte) => byte !== 0))).toBe(true);
      unblock?.();
      await released;
      for (const view of observed) expect(view.every((byte) => byte === 0)).toBe(true);
      expect(openCount.value).toBe(0);
    } finally {
      unblock?.();
      await removeStateDirectory(directory);
    }
  });

  it("rejects a tampered fresh key-bundle envelope and zeroizes its handle", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe();
    const openCount = { value: 0 };
    const base = keyBundleProvider();
    const observed: Uint8Array[] = [];
    const observedEnvelopes: Uint8Array[] = [];
    const provider: AgentBackupCaptureV3KeyBundleProvider = {
      async acquire(input) {
        const acquired = await base.acquire(input);
        observed.push(acquired.handle.dek, acquired.handle.contentHmacKey);
        observedEnvelopes.push(acquired.wrapped.wrappedKeyBundle);
        acquired.wrapped.wrappedKeyBundle[0] ^= 0xff;
        return acquired;
      },
      unwrap: (input) => base.unwrap(input),
      release: (handle) => base.release(handle),
    };
    try {
      const input = pipelineInput(directory, MIB, probe.boundary, openCount);
      await expect(
        runAgentBackupCaptureV2Pipeline({ ...input, keyBundle: provider }),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_V3_KEY_BUNDLE_ENVELOPE_INVALID",
      });
      expect(openCount.value).toBe(0);
      expect(observed).toHaveLength(2);
      for (const key of observed) expect(key.every((byte) => byte === 0)).toBe(true);
      expect(observedEnvelopes).toHaveLength(1);
      expect(observedEnvelopes[0]?.every((byte) => byte === 0)).toBe(true);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("recomputes the local key-bundle receipt before persisting the envelope", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe();
    const openCount = { value: 0 };
    const base = keyBundleProvider();
    const observed: Uint8Array[] = [];
    const provider: AgentBackupCaptureV3KeyBundleProvider = {
      async acquire(input) {
        const acquired = await base.acquire(input);
        observed.push(
          acquired.handle.dek,
          acquired.handle.contentHmacKey,
          acquired.wrapped.wrappedKeyBundle,
        );
        return {
          ...acquired,
          wrapped: { ...acquired.wrapped, localReceiptDigest: "f".repeat(64) },
        };
      },
      unwrap: (input) => base.unwrap(input),
      release: (handle) => base.release(handle),
    };
    try {
      const input = pipelineInput(directory, MIB, probe.boundary, openCount);
      await expect(
        runAgentBackupCaptureV2Pipeline({ ...input, keyBundle: provider }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V3_KEY_BUNDLE_RECEIPT_INVALID" });
      expect(openCount.value).toBe(0);
      expect(observed).toHaveLength(3);
      for (const bytes of observed) expect(bytes.every((byte) => byte === 0)).toBe(true);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("zeroizes fresh and crash-replayed operation key bundles", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe();
    const openCount = { value: 0 };
    const base = keyBundleProvider();
    const observed: Uint8Array[] = [];
    const provider: AgentBackupCaptureV3KeyBundleProvider = {
      async acquire(input) {
        const acquired = await base.acquire(input);
        observed.push(acquired.handle.dek, acquired.handle.contentHmacKey);
        return acquired;
      },
      async unwrap(input) {
        const handle = await base.unwrap(input);
        observed.push(handle.dek, handle.contentHmacKey);
        return handle;
      },
      release: (handle) => base.release(handle),
    };
    try {
      const input = pipelineInput(directory, MIB, probe.boundary, openCount);
      await expect(
        runAgentBackupCaptureV2Pipeline({
          ...input,
          keyBundle: provider,
          async *openCapture() {
            openCount.value += 1;
            yield frame({
              format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
              schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
              sequence: 0,
              kind: "capture-start",
              operationId: OPERATION_ID,
              agentId: AGENT_ID,
              activationGeneration: ACTIVATION_ID,
              lifecycleRevision: "42",
              createdAt: "2026-08-15T10:00:01.000Z",
              componentCount: COMPONENTS.length,
              maxFramePayloadBytes: FRAME_BYTES,
            });
            throw new Error("synthetic capture crash");
          },
        }),
      ).rejects.toThrow("synthetic capture crash");
      const resumed = await runAgentBackupCaptureV2Pipeline({
        ...input,
        executionToken: NEXT_EXECUTION_TOKEN,
        keyBundle: provider,
      });
      expect(resumed.state).toBe("published-cleanup-pending");
      expect(observed).toHaveLength(4);
      for (const key of observed) expect(key.every((byte) => byte === 0)).toBe(true);
      await resumed.spool.cleanup();
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("zeroizes both key slices even when provider release throws", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe();
    const openCount = { value: 0 };
    const base = keyBundleProvider();
    const observed: Uint8Array[] = [];
    const provider: AgentBackupCaptureV3KeyBundleProvider = {
      async acquire(input) {
        const acquired = await base.acquire(input);
        observed.push(acquired.handle.dek, acquired.handle.contentHmacKey);
        return acquired;
      },
      unwrap: (input) => base.unwrap(input),
      release(handle: KmsAeadOperationKeyBundleHandle) {
        base.release(handle);
        throw new Error("synthetic key-bundle release failure");
      },
    };
    try {
      const input = pipelineInput(directory, MIB, probe.boundary, openCount);
      await expect(
        runAgentBackupCaptureV2Pipeline({ ...input, keyBundle: provider }),
      ).rejects.toThrow("synthetic key-bundle release failure");
      expect(observed).toHaveLength(2);
      for (const key of observed) expect(key.every((byte) => byte === 0)).toBe(true);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("rejects a StateDirectory inside the system temporary tree", async () => {
    const created = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "eliza-capture-v2-spool-rejected-"),
    );
    const directory = await fs.promises.realpath(created);
    const probe = publicationProbe();
    const openCount = { value: 0 };
    try {
      await expect(
        runAgentBackupCaptureV2Pipeline(pipelineInput(directory, MIB, probe.boundary, openCount)),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_V2_SPOOL_STATE_DIRECTORY_TEMPORARY",
      });
      expect(openCount.value).toBe(0);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("rejects an operation that would exceed its durable spool quota", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe();
    const openCount = { value: 0 };
    try {
      const input = pipelineInput(directory, 2 * MIB, probe.boundary, openCount);
      await expect(
        runAgentBackupCaptureV2Pipeline({
          ...input,
          spool: { ...input.spool, maxSpoolBytes: 512 * 1024 },
        }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V2_SPOOL_QUOTA_EXCEEDED" });
      expect(probe.recordCalls).toHaveLength(0);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("returns cleanup pending when deletion and parent fsync cannot be proven", async () => {
    const directory = await stateDirectory();
    const probe = publicationProbe();
    const openCount = { value: 0 };
    try {
      const result = await runAgentBackupCaptureV2Pipeline(
        pipelineInput(directory, MIB, probe.boundary, openCount),
      );
      await fs.promises.mkdir(path.join(result.spool.operationDirectory, "unexpected-directory"));
      expect(await result.spool.cleanup()).toEqual({
        operationId: OPERATION_ID,
        status: "pending",
      });
    } finally {
      await removeStateDirectory(directory);
    }
  });
});

describe("AgentBackupCaptureV3Spool execution fencing", () => {
  it("quarantines a legacy v2 spool without mutating or promoting it", async () => {
    const directory = await stateDirectory();
    const legacyOperation = path.join(directory, "agent-backup-capture-v2", OPERATION_ID);
    const legacyJournal = JSON.stringify({
      format: "elizaos.agent-backup.capture-v2-spool",
      version: 2,
      operationId: OPERATION_ID,
    });
    try {
      await fs.promises.mkdir(legacyOperation, { recursive: true });
      await fs.promises.writeFile(path.join(legacyOperation, "journal.json"), legacyJournal);
      await expect(
        AgentBackupCaptureV3Spool.open(
          {
            stateDirectory: directory,
            maxSpoolBytes: 8 * MIB,
            minFreeBytes: 0,
            lockAuthority: testLockAuthority(),
          },
          directSpoolInput(EXECUTION_TOKEN),
        ),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_V3_LEGACY_SPOOL_QUARANTINED",
      });
      expect(await fs.promises.readFile(path.join(legacyOperation, "journal.json"), "utf8")).toBe(
        legacyJournal,
      );
      await expect(
        fs.promises.lstat(path.join(directory, "agent-backup-capture-v3", OPERATION_ID)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("never steals an old lock from a live process and hands off only after close", async () => {
    const directory = await stateDirectory();
    const lockAuthority = testLockAuthority();
    const config = {
      stateDirectory: directory,
      maxSpoolBytes: 8 * MIB,
      minFreeBytes: 0,
      lockAuthority,
    };
    let first: AgentBackupCaptureV3Spool | undefined;
    let second: AgentBackupCaptureV3Spool | undefined;
    try {
      first = await AgentBackupCaptureV3Spool.open(config, directSpoolInput(EXECUTION_TOKEN));
      const ownerPath = path.join(first.namespaceDirectory, `.${OPERATION_ID}.lock`, "owner.json");
      expect(JSON.parse(await fs.promises.readFile(ownerPath, "utf8"))).toMatchObject({
        executionToken: EXECUTION_TOKEN,
      });
      await fs.promises.utimes(ownerPath, new Date(0), new Date(0));
      await expect(
        AgentBackupCaptureV3Spool.open(config, directSpoolInput(NEXT_EXECUTION_TOKEN)),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V2_SPOOL_LOCKED" });

      await first.close();
      const temporary = path.join(first.operationDirectory, `.journal.json.${"a".repeat(24)}.tmp`);
      await fs.promises.writeFile(temporary, "abandoned");
      second = await AgentBackupCaptureV3Spool.open(config, directSpoolInput(NEXT_EXECUTION_TOKEN));
      expect(JSON.parse(await fs.promises.readFile(ownerPath, "utf8"))).toMatchObject({
        executionToken: NEXT_EXECUTION_TOKEN,
      });
      await expect(fs.promises.lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(first.markPublishing()).rejects.toMatchObject({
        code: "AGENT_BACKUP_V2_SPOOL_CLOSED",
      });
      expect(await second.cleanup()).toEqual({
        operationId: OPERATION_ID,
        status: "complete",
      });
    } finally {
      await first?.close();
      await second?.close();
      await removeStateDirectory(directory);
    }
  });

  it("reclaims a PID-reused owner and fences the stale writer", async () => {
    const directory = await stateDirectory();
    const current = {
      value: {
        linuxBootId: TEST_BOOT_ID,
        pid: 4242,
        processStartTime: "100",
      },
    };
    const config = {
      stateDirectory: directory,
      maxSpoolBytes: 8 * MIB,
      minFreeBytes: 0,
      lockAuthority: testLockAuthority(current),
    };
    let stale: AgentBackupCaptureV3Spool | undefined;
    let successor: AgentBackupCaptureV3Spool | undefined;
    try {
      stale = await AgentBackupCaptureV3Spool.open(config, directSpoolInput(EXECUTION_TOKEN));
      current.value = { ...current.value, processStartTime: "200" };
      successor = await AgentBackupCaptureV3Spool.open(
        config,
        directSpoolInput(NEXT_EXECUTION_TOKEN),
      );
      await expect(stale.markPublishing()).rejects.toMatchObject({
        code: "AGENT_BACKUP_V2_SPOOL_LOCK_LOST",
      });
      expect(await successor.cleanup()).toEqual({
        operationId: OPERATION_ID,
        status: "complete",
      });
    } finally {
      await stale?.close();
      await successor?.close();
      await removeStateDirectory(directory);
    }
  });

  it("fails closed when exact owner liveness cannot be inspected", async () => {
    const directory = await stateDirectory();
    const firstAuthority = testLockAuthority();
    const config = {
      stateDirectory: directory,
      maxSpoolBytes: 8 * MIB,
      minFreeBytes: 0,
      lockAuthority: firstAuthority,
    };
    let first: AgentBackupCaptureV3Spool | undefined;
    try {
      first = await AgentBackupCaptureV3Spool.open(config, directSpoolInput(EXECUTION_TOKEN));
      await expect(
        AgentBackupCaptureV3Spool.open(
          {
            ...config,
            lockAuthority: {
              async currentProcessIdentity() {
                return {
                  linuxBootId: TEST_BOOT_ID,
                  pid: 5252,
                  processStartTime: "200",
                };
              },
              async isProcessIdentityAlive() {
                throw Object.assign(new Error("synthetic /proc permission failure"), {
                  code: "EACCES",
                });
              },
            },
          },
          directSpoolInput(NEXT_EXECUTION_TOKEN),
        ),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_V2_SPOOL_LOCK_LIVENESS_UNPROVABLE",
      });
      await expect(first.markPublishing()).rejects.toMatchObject({
        code: "AGENT_BACKUP_V2_SPOOL_MANIFEST_MISSING",
      });
    } finally {
      await first?.close();
      await removeStateDirectory(directory);
    }
  });
});
