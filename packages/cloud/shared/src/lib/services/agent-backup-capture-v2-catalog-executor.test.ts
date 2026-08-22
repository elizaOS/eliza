/**
 * @file Tests the owned catalogue capture boundary against the manifest-v3
 * operation key-bundle pipeline.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { KmsAeadOperationKeyBundleProvider, LocalKmsAdapter } from "@elizaos/core/security/kms";
import {
  AGENT_BACKUP_CAPTURE_V2_CONTENT_TYPE,
  AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
  AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
  AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
  type AgentBackupCaptureV2FrameHeader,
  type AgentBackupCaptureV2Request,
  readAgentBackupCaptureV2FrameDigest,
  serializeAgentBackupCaptureV2Frame,
} from "@elizaos/shared";
import type { AgentBackupOperationClaim } from "../../db/repositories/agent-backup-catalog";
import {
  type AgentBackupCaptureV2CatalogExecutionContext,
  type AgentBackupCaptureV2RuntimeAttestation,
  createAgentBackupCaptureV2CatalogExecutor,
  type ExecuteAgentBackupCaptureV2CatalogClaimDependencies,
  executeAgentBackupCaptureV2CatalogClaim,
} from "./agent-backup-capture-v2-catalog-executor";
import {
  isTrustedAgentBackupCaptureV2TerminalDisposition,
  normalizeAgentBackupCaptureV2TerminalFailure,
} from "./agent-backup-capture-v2-failure-disposition";
import {
  type AgentBackupCaptureV3KeyBundleProvider,
  deriveAgentBackupCaptureV3RuntimePrincipalSha256,
  deriveAgentBackupCaptureV3SpoolAuthorityDigests,
} from "./agent-backup-capture-v2-pipeline";
import { createAgentBackupCaptureV3RuntimeContextResolver } from "./agent-backup-capture-v3-runtime-context";

const ORGANIZATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BACKUP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RUNTIME_AGENT_ID = "88888888-8888-4888-8888-888888888888";
const ACTIVATION_GENERATION = "33333333-3333-4333-8333-333333333333";
const CLAIM_GENERATION = "44444444-4444-4444-8444-444444444444";
const NODE_RECORD_ID = "55555555-5555-4555-8555-555555555555";
const NODE_INCARNATION = "66666666-6666-4666-8666-666666666666";
const CONTAINER_ID = "c".repeat(64);
const VAULT_KEY_GENERATION_ID = "77777777-7777-4777-8777-777777777777";

const vaultKeyAuthority = {
  format: "kms-aead-vault-passphrase-v1" as const,
  generationId: VAULT_KEY_GENERATION_ID,
  receiptDerivation: "elizaos.agent-vault-key.authority-receipt.v1" as const,
  receiptDigest: "f".repeat(64),
};

describe("capture-v3 legacy-writer rollout fence", () => {
  const dependencies = {} as ExecuteAgentBackupCaptureV2CatalogClaimDependencies;

  it("refuses activation without a canonical deployment drain receipt", () => {
    expect(() =>
      createAgentBackupCaptureV2CatalogExecutor(dependencies, {
        format: "elizaos.agent-backup.capture-v3-legacy-writer-drain.v1",
        deploymentId: "rollout-42",
        drainedAt: "not-a-timestamp",
      }),
    ).toThrow("legacy-writer drain receipt");
  });

  it("binds the executor only after the deployment drain receipt is valid", () => {
    const executor = createAgentBackupCaptureV2CatalogExecutor(dependencies, {
      format: "elizaos.agent-backup.capture-v3-legacy-writer-drain.v1",
      deploymentId: "rollout-42",
      drainedAt: "2026-08-17T00:00:00.000Z",
    });
    expect(executor.execute).toBeTypeOf("function");
  });
});

function claim(): AgentBackupOperationClaim {
  return {
    ownerId: "capture-worker-1",
    generation: CLAIM_GENERATION,
    backup: {
      id: BACKUP_ID,
      catalog_state: "capturing",
      catalog_organization_id: ORGANIZATION_ID,
      catalog_agent_id: AGENT_ID,
      backup_operation_id: OPERATION_ID,
      lifecycle_generation: ACTIVATION_GENERATION,
      lifecycle_revision: 7n,
      source_provider: "hetzner-cloud",
      source_node_record_id: NODE_RECORD_ID,
      source_node_id: "cloud-node-9",
      source_node_incarnation: NODE_INCARNATION,
      source_provider_server_id: "1234",
      source_provider_handle: "agent-runtime-name",
      source_container_id: CONTAINER_ID,
      catalog_attempts: 0,
      created_at: new Date("2026-08-15T10:00:00.000Z"),
    },
  } as AgentBackupOperationClaim;
}

function attestation(): AgentBackupCaptureV2RuntimeAttestation {
  return {
    organizationId: ORGANIZATION_ID,
    catalogAgentId: AGENT_ID,
    runtimeAgentId: RUNTIME_AGENT_ID,
    activationGeneration: ACTIVATION_GENERATION,
    lifecycleRevision: "7",
    source: {
      kind: "cloud",
      provider: "hetzner",
      nodeRecordId: NODE_RECORD_ID,
      nodeId: "cloud-node-9",
      nodeIncarnation: NODE_INCARNATION,
      containerId: CONTAINER_ID,
      providerServerId: "1234",
    },
    runtime: {
      imageDigest: `sha256:${"a".repeat(64)}`,
      agentSchemaVersion: "agent-v2",
      databaseSchemaVersion: "pglite-v1",
      plugins: [{ id: "@elizaos/plugin-sql", version: "2.0.0" }],
    },
    watermarks: [{ namespace: "database.lsn", value: "snapshot-7" }],
  };
}

async function wireFrames(request: AgentBackupCaptureV2Request): Promise<Uint8Array[]> {
  const components = ["character", "database", "media", "state-files", "vault"] as const;
  const frames: Uint8Array[] = [];
  const digests: Uint8Array[] = [];
  const push = async (header: AgentBackupCaptureV2FrameHeader, payload?: Uint8Array) => {
    const wire = await serializeAgentBackupCaptureV2Frame({ header, payload });
    frames.push(wire);
    digests.push(readAgentBackupCaptureV2FrameDigest(wire));
  };
  await push({
    format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
    sequence: 0,
    kind: "capture-start",
    operationId: request.operationId,
    agentId: request.agentId,
    activationGeneration: request.activationGeneration,
    lifecycleRevision: request.lifecycleRevision,
    createdAt: "2026-08-15T10:00:01.000Z",
    componentCount: components.length,
    maxFramePayloadBytes: 256 * 1024,
  });
  let sequence = 1;
  let plainBytes = 0;
  for (const [componentIndex, name] of components.entries()) {
    await push({
      format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
      schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
      sequence: sequence++,
      kind: "component-start",
      componentIndex,
      component: {
        name,
        format: "opaque-v1",
        compression: "none",
        contentKind: "opaque",
        consistency: "transactional",
      },
    });
    const payload = new TextEncoder().encode(`durable ${name} state`);
    await push(
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
    await push({
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
    plainBytes += payload.byteLength;
  }
  const chain = createHash("sha256");
  for (const digest of digests) chain.update(digest);
  await push({
    format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
    sequence,
    kind: "capture-end",
    componentCount: components.length,
    dataFrameCount: components.length,
    plainBytes,
    frameDigestChainSha256: chain.digest("hex"),
  });
  return frames;
}

function responseFor(request: AgentBackupCaptureV2Request, frames: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = frames.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": AGENT_BACKUP_CAPTURE_V2_CONTENT_TYPE,
        "X-Eliza-Backup-Operation-Id": request.operationId,
      },
    },
  );
}

function keyBundle(): AgentBackupCaptureV3KeyBundleProvider {
  return new KmsAeadOperationKeyBundleProvider(
    new LocalKmsAdapter({ rootKey: new Uint8Array(32).fill(0xa5) }),
  );
}

async function stateDirectory(): Promise<string> {
  return fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.homedir(), ".eliza-catalog-capture-test-")),
  );
}

async function removeStateDirectory(directory: string): Promise<void> {
  await fs.promises.rm(directory, { recursive: true, force: true });
}

function inertContext(
  directory: string,
  overrides: Partial<AgentBackupCaptureV2CatalogExecutionContext> = {},
): AgentBackupCaptureV2CatalogExecutionContext {
  const initialAttestation = attestation();
  return {
    attestation: initialAttestation,
    async revalidateAttestation() {
      return structuredClone(initialAttestation);
    },
    transport: {
      agentApiBaseUrl: "https://exact-agent.invalid",
      apiToken: "exact-agent-token",
      fetch: (async () => {
        throw new Error("HTTP capture must not start");
      }) as typeof fetch,
    },
    spool: {
      stateDirectory: directory,
      maxSpoolBytes: 8 * 1024 * 1024,
      minFreeBytes: 0,
      lockAuthority: {
        async currentProcessIdentity() {
          return {
            linuxBootId: "77777777-7777-4777-8777-777777777777",
            pid: 4242,
            processStartTime: "100",
          };
        },
        async isProcessIdentityAlive() {
          return true;
        },
      },
    },
    keyBundle: keyBundle(),
    kms: {
      provider: "steward",
      keyId: `org:${ORGANIZATION_ID}/dek/v1`,
      keyVersion: 1,
    },
    vaultKeyAuthority,
    ...overrides,
  };
}

describe("executeAgentBackupCaptureV2CatalogClaim", () => {
  it("uses the authenticated HTTP client, heartbeats, spools, and records captured only", async () => {
    const directory = await stateDirectory();
    const heartbeats: unknown[] = [];
    const records: unknown[] = [];
    let revalidations = 0;
    let fetches = 0;
    const initialAttestation = attestation();
    let observedRuntimeRequest: AgentBackupCaptureV2Request | undefined;
    try {
      const result = await executeAgentBackupCaptureV2CatalogClaim({
        claim: claim(),
        leaseMs: 240_000,
        dependencies: {
          now: () => 1_000_000,
          heartbeatOperation: async (input) => {
            heartbeats.push(input);
            return claim().backup;
          },
          loadManifestChainAuthority: async () => ({
            kind: "full",
            baseOperationId: null,
            parentOperationId: null,
            depth: 0,
          }),
          recordCaptured: async (input) => {
            records.push(input);
            return claim().backup;
          },
          async resolveContext(input) {
            expect(input.expectedSource).toEqual(initialAttestation.source);
            const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
              fetches += 1;
              const headers = new Headers(init?.headers);
              expect(headers.get("authorization")).toBe("Bearer exact-agent-token");
              const request = JSON.parse(String(init?.body)) as AgentBackupCaptureV2Request;
              observedRuntimeRequest = request;
              expect(request.agentId).toBe(RUNTIME_AGENT_ID);
              expect(request.agentId).not.toBe(AGENT_ID);
              return responseFor(request, await wireFrames(request));
            }) as typeof fetch;
            return {
              attestation: initialAttestation,
              async revalidateAttestation() {
                revalidations += 1;
                return structuredClone(initialAttestation);
              },
              transport: {
                agentApiBaseUrl: "https://exact-agent.invalid",
                apiToken: "exact-agent-token",
                fetch: fetchStub,
              },
              spool: {
                stateDirectory: directory,
                maxSpoolBytes: 8 * 1024 * 1024,
                minFreeBytes: 0,
                lockAuthority: {
                  async currentProcessIdentity() {
                    return {
                      linuxBootId: "77777777-7777-4777-8777-777777777777",
                      pid: 4242,
                      processStartTime: "100",
                    };
                  },
                  async isProcessIdentityAlive() {
                    return true;
                  },
                },
              },
              keyBundle: keyBundle(),
              kms: {
                provider: "steward",
                keyId: `org:${ORGANIZATION_ID}/dek/v1`,
                keyVersion: 1,
              },
              vaultKeyAuthority,
            } satisfies AgentBackupCaptureV2CatalogExecutionContext;
          },
        },
      });

      expect(result).toMatchObject({
        state: "captured-upload-pending",
        cleanup: "blocked-on-upload",
      });
      expect(result.spool.phase).toBe("sealed");
      expect(result.spool.chunks.every((chunk) => !result.spool.isChunkUploaded(chunk))).toBe(true);
      const durableManifest = JSON.parse(
        await fs.promises.readFile(
          path.join(result.spool.operationDirectory, "manifest.json"),
          "utf8",
        ),
      ) as { identity: { agentId: string } };
      expect(durableManifest.identity.agentId).toBe(AGENT_ID);
      expect(durableManifest.identity.agentId).not.toBe(RUNTIME_AGENT_ID);
      const keyBundleContext = result.spool.getOperationKeyBundleMetadata()?.canonicalContext;
      expect(keyBundleContext).toContain(`"agentId":"${AGENT_ID}"`);
      expect(keyBundleContext).not.toContain(RUNTIME_AGENT_ID);
      if (!observedRuntimeRequest) throw new Error("Runtime request was not observed");
      const journal = JSON.parse(
        await fs.promises.readFile(
          path.join(result.spool.operationDirectory, "journal.json"),
          "utf8",
        ),
      ) as { requestSha256: string; runtimePrincipalSha256: string };
      expect(journal.runtimePrincipalSha256).toBe(
        deriveAgentBackupCaptureV3RuntimePrincipalSha256(RUNTIME_AGENT_ID),
      );
      const durableAuthority = {
        createdAt: "2026-08-15T10:00:00.000Z",
        organizationId: ORGANIZATION_ID,
        source: initialAttestation.source,
        runtime: initialAttestation.runtime,
        chain: { kind: "full" as const, baseOperationId: null, parentOperationId: null, depth: 0 },
        watermarks: initialAttestation.watermarks,
        kms: {
          provider: "steward" as const,
          keyId: `org:${ORGANIZATION_ID}/dek/v1`,
          keyVersion: 1,
        },
        vaultKeyAuthority,
      };
      const catalogRequest = {
        ...observedRuntimeRequest,
        format: AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
        agentId: AGENT_ID,
      };
      expect(journal.requestSha256).toBe(
        deriveAgentBackupCaptureV3SpoolAuthorityDigests({
          request: catalogRequest,
          authority: durableAuthority,
        }).requestSha256,
      );
      expect(journal.requestSha256).not.toBe(
        deriveAgentBackupCaptureV3SpoolAuthorityDigests({
          request: observedRuntimeRequest,
          authority: durableAuthority,
        }).requestSha256,
      );
      expect(fetches).toBe(1);
      expect(heartbeats.length).toBeGreaterThan(3);
      expect(revalidations).toBe(heartbeats.length - 1);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        organizationId: ORGANIZATION_ID,
        backupId: BACKUP_ID,
        operationId: OPERATION_ID,
        expectedActivationGeneration: ACTIVATION_GENERATION,
        expectedLifecycleRevision: "7",
        manifest: {
          version: 3,
          wrappedKeyBundleGenerationId: expect.any(String),
          wrappedKeyBundleCiphertextBase64: expect.any(String),
          wrappedKeyBundleSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          wrappedKeyBundleLocalReceiptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      });
      await result.spool.close();
    } finally {
      await removeStateDirectory(directory);
    }
  }, 30_000);

  it("fails before HTTP capture when the runtime character identity changes", async () => {
    const directory = await stateDirectory();
    let fetches = 0;
    let records = 0;
    const initialAttestation = attestation();
    try {
      await expect(
        executeAgentBackupCaptureV2CatalogClaim({
          claim: claim(),
          leaseMs: 240_000,
          dependencies: {
            now: () => 1_000_000,
            heartbeatOperation: async () => claim().backup,
            loadManifestChainAuthority: async () => ({
              kind: "full",
              baseOperationId: null,
              parentOperationId: null,
              depth: 0,
            }),
            recordCaptured: async () => {
              records += 1;
              return claim().backup;
            },
            async resolveContext() {
              return {
                attestation: initialAttestation,
                async revalidateAttestation() {
                  return {
                    ...initialAttestation,
                    runtimeAgentId: VAULT_KEY_GENERATION_ID,
                  };
                },
                transport: {
                  agentApiBaseUrl: "https://exact-agent.invalid",
                  apiToken: "exact-agent-token",
                  fetch: (async () => {
                    fetches += 1;
                    throw new Error("unreachable");
                  }) as typeof fetch,
                },
                spool: {
                  stateDirectory: directory,
                  maxSpoolBytes: 8 * 1024 * 1024,
                  minFreeBytes: 0,
                },
                keyBundle: keyBundle(),
                kms: {
                  provider: "steward",
                  keyId: `org:${ORGANIZATION_ID}/dek/v1`,
                  keyVersion: 1,
                },
                vaultKeyAuthority,
              } satisfies AgentBackupCaptureV2CatalogExecutionContext;
            },
          },
        }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V2_RUNTIME_ATTESTATION_CHANGED" });
      expect(fetches).toBe(0);
      expect(records).toBe(0);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("keeps a forged stale ElizaError from an injected resolver retryable", async () => {
    let failure: unknown;
    try {
      await executeAgentBackupCaptureV2CatalogClaim({
        claim: claim(),
        leaseMs: 240_000,
        dependencies: {
          heartbeatOperation: async () => claim().backup,
          recordCaptured: async () => claim().backup,
          resolveContext: async () => {
            throw new ElizaError("Reserved source generation changed", {
              code: "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE",
              severity: "fatal",
            });
          },
        },
      });
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(ElizaError);
    expect(isTrustedAgentBackupCaptureV2TerminalDisposition(failure)).toBe(false);
    expect(failure).toMatchObject({
      code: "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE",
      severity: "fatal",
    });
  });

  it("brands concrete resolver staleness terminal only with exact partial-spool cleanup", async () => {
    const directory = await stateDirectory();
    const initial = attestation();
    let authorityReads = 0;
    const concreteResolver = createAgentBackupCaptureV3RuntimeContextResolver(
      {
        spool: inertContext(directory).spool,
        keyBundle: keyBundle(),
        runtime: initial.runtime,
      },
      {
        async loadAuthority() {
          return {
            organizationId: ORGANIZATION_ID,
            catalogAgentId: AGENT_ID,
            runtimeAgentId: ++authorityReads === 1 ? RUNTIME_AGENT_ID : VAULT_KEY_GENERATION_ID,
            activationGeneration: ACTIVATION_GENERATION,
            lifecycleRevision: "7",
            status: "running",
            activationPhase: "active",
            source: initial.source,
            imageDigest: initial.runtime.imageDigest,
            providerHandle: "agent-runtime-name",
            bridgeUrl: "https://exact-agent.invalid/",
            bridgePort: null,
            headscaleIp: null,
            nodeHostname: "cloud-node-9",
            environmentVars: { ELIZA_API_TOKEN: "encrypted-token" },
          };
        },
        async loadVaultAuthority() {
          return {
            kms: {
              provider: "steward" as const,
              keyId: `org:${ORGANIZATION_ID}/dek/v1`,
              keyVersion: 1,
            },
            vaultKeyAuthority,
          };
        },
        async decryptEnvironmentVars() {
          return { ELIZA_API_TOKEN: "exact-agent-token" };
        },
        async authorizePublicUrl(rawUrl) {
          return new URL(rawUrl);
        },
      },
    );
    const catalogRequest: AgentBackupCaptureV2Request = {
      format: AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
      schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
      operationId: OPERATION_ID,
      agentId: AGENT_ID,
      activationGeneration: ACTIVATION_GENERATION,
      lifecycleRevision: "7",
      deadlineEpochMs: Date.now() + 60_000,
    };
    const concreteContext = await concreteResolver({
      claim: claim(),
      request: catalogRequest,
      expectedSource: initial.source,
      heartbeat: async () => true,
    });
    let brandedStale: unknown;
    try {
      await concreteContext.revalidateAttestation();
    } catch (cause) {
      brandedStale = cause;
    }
    expect(brandedStale).toMatchObject({
      code: "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE",
    });
    expect(normalizeAgentBackupCaptureV2TerminalFailure(brandedStale)).toBeUndefined();

    let revalidations = 0;
    let failure: unknown;
    try {
      await executeAgentBackupCaptureV2CatalogClaim({
        claim: claim(),
        leaseMs: 240_000,
        dependencies: {
          heartbeatOperation: async () => claim().backup,
          loadManifestChainAuthority: async () => ({
            kind: "full",
            baseOperationId: null,
            parentOperationId: null,
            depth: 0,
          }),
          recordCaptured: async () => {
            throw new Error("stale partial spool must not reach recordCaptured");
          },
          resolveContext: async () =>
            inertContext(directory, {
              async revalidateAttestation() {
                revalidations += 1;
                if (revalidations >= 3) throw brandedStale;
                return structuredClone(initial);
              },
            }),
        },
      });
    } catch (cause) {
      failure = cause;
    }

    expect(isTrustedAgentBackupCaptureV2TerminalDisposition(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE",
      terminal: true,
      terminalSpoolCleanup: {
        runtimePrincipalSha256: deriveAgentBackupCaptureV3RuntimePrincipalSha256(RUNTIME_AGENT_ID),
      },
    });
    const journal = JSON.parse(
      await fs.promises.readFile(
        path.join(directory, "agent-backup-capture-v3", OPERATION_ID, "journal.json"),
        "utf8",
      ),
    ) as { recordCaptured: string; runtimePrincipalSha256: string };
    expect(journal.recordCaptured).toBe("pending");
    expect(journal.runtimePrincipalSha256).toBe(
      deriveAgentBackupCaptureV3RuntimePrincipalSha256(RUNTIME_AGENT_ID),
    );
    await removeStateDirectory(directory);
  });

  it("attaches exact spool authority to a validated terminal Agent response", async () => {
    const directory = await stateDirectory();
    let records = 0;
    try {
      const context = inertContext(directory, {
        transport: {
          agentApiBaseUrl: "https://exact-agent.invalid",
          apiToken: "exact-agent-token",
          fetch: (async () =>
            new Response(
              JSON.stringify({
                error: "PGlite physical bytes exceed the bounded exporter limit",
                code: "AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT",
              }),
              {
                status: 413,
                headers: { "Content-Type": "application/json" },
              },
            )) as typeof fetch,
        },
      });
      await expect(
        executeAgentBackupCaptureV2CatalogClaim({
          claim: claim(),
          leaseMs: 240_000,
          dependencies: {
            heartbeatOperation: async () => claim().backup,
            loadManifestChainAuthority: async () => ({
              kind: "full",
              baseOperationId: null,
              parentOperationId: null,
              depth: 0,
            }),
            recordCaptured: async () => {
              records += 1;
              return claim().backup;
            },
            resolveContext: async () => context,
          },
        }),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT",
        terminal: true,
        terminalSpoolCleanup: {
          organizationId: ORGANIZATION_ID,
          agentId: AGENT_ID,
          backupId: BACKUP_ID,
          operationId: OPERATION_ID,
          activationGeneration: ACTIVATION_GENERATION,
          lifecycleRevision: "7",
          requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          authoritySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      });
      expect(records).toBe(0);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("preserves exact terminal authority through an AggregateError cleanup failure", async () => {
    const directory = await stateDirectory();
    const baseKeyBundle = keyBundle();
    const releaseFailure = new Error("KMS release acknowledgement was lost");
    const failingReleaseKeyBundle: AgentBackupCaptureV3KeyBundleProvider = {
      acquire: (input) => baseKeyBundle.acquire(input),
      unwrap: (input) => baseKeyBundle.unwrap(input),
      release(handle): never {
        baseKeyBundle.release(handle);
        throw releaseFailure;
      },
    };
    let failure: unknown;
    try {
      const context = inertContext(directory, {
        keyBundle: failingReleaseKeyBundle,
        transport: {
          agentApiBaseUrl: "https://exact-agent.invalid",
          apiToken: "exact-agent-token",
          fetch: (async () =>
            new Response(
              JSON.stringify({
                error: "PGlite physical bytes exceed the bounded exporter limit",
                code: "AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT",
              }),
              {
                status: 413,
                headers: { "Content-Type": "application/json" },
              },
            )) as typeof fetch,
        },
      });
      try {
        await executeAgentBackupCaptureV2CatalogClaim({
          claim: claim(),
          leaseMs: 240_000,
          dependencies: {
            heartbeatOperation: async () => claim().backup,
            loadManifestChainAuthority: async () => ({
              kind: "full",
              baseOperationId: null,
              parentOperationId: null,
              depth: 0,
            }),
            recordCaptured: async () => claim().backup,
            resolveContext: async () => context,
          },
        });
      } catch (cause) {
        failure = cause;
      }

      expect(isTrustedAgentBackupCaptureV2TerminalDisposition(failure)).toBe(true);
      const aggregateCause = (failure as Error).cause;
      expect(aggregateCause).toBeInstanceOf(AggregateError);
      expect((aggregateCause as AggregateError).errors).toContain(releaseFailure);
      expect(failure).toMatchObject({
        code: "AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT",
        terminal: true,
        terminalSpoolCleanup: {
          organizationId: ORGANIZATION_ID,
          agentId: AGENT_ID,
          backupId: BACKUP_ID,
          operationId: OPERATION_ID,
          activationGeneration: ACTIVATION_GENERATION,
          lifecycleRevision: "7",
          requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          authoritySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      });
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("applies the absolute deadline to a never-settling context resolver", async () => {
    const directory = await stateDirectory();
    let chainLoads = 0;
    let records = 0;
    let resolverSignal: AbortSignal | undefined;
    try {
      await expect(
        executeAgentBackupCaptureV2CatalogClaim({
          claim: claim(),
          leaseMs: 240_000,
          dependencies: {
            captureDeadlineMs: 20,
            heartbeatOperation: async () => claim().backup,
            loadManifestChainAuthority: async () => {
              chainLoads += 1;
              throw new Error("Manifest chain must not load");
            },
            recordCaptured: async () => {
              records += 1;
              return claim().backup;
            },
            resolveContext(input) {
              resolverSignal = input.signal;
              return new Promise<AgentBackupCaptureV2CatalogExecutionContext>(() => undefined);
            },
          },
        }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED" });
      expect(resolverSignal?.aborted).toBe(true);
      expect(chainLoads).toBe(0);
      expect(records).toBe(0);
      expect(await fs.promises.readdir(directory)).toEqual([]);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("applies the absolute deadline to the first catalogue heartbeat", async () => {
    let contextResolutions = 0;
    await expect(
      executeAgentBackupCaptureV2CatalogClaim({
        claim: claim(),
        leaseMs: 240_000,
        dependencies: {
          captureDeadlineMs: 20,
          heartbeatOperation: () => new Promise(() => undefined),
          recordCaptured: async () => claim().backup,
          resolveContext: async () => {
            contextResolutions += 1;
            throw new Error("Context must not resolve");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED" });
    expect(contextResolutions).toBe(0);
  });

  it("applies the absolute deadline to manifest chain authority loading", async () => {
    const directory = await stateDirectory();
    let fetches = 0;
    let records = 0;
    try {
      const context = inertContext(directory, {
        transport: {
          agentApiBaseUrl: "https://exact-agent.invalid",
          apiToken: "exact-agent-token",
          fetch: (async () => {
            fetches += 1;
            throw new Error("HTTP capture must not start");
          }) as typeof fetch,
        },
      });
      await expect(
        executeAgentBackupCaptureV2CatalogClaim({
          claim: claim(),
          leaseMs: 240_000,
          dependencies: {
            captureDeadlineMs: 20,
            heartbeatOperation: async () => claim().backup,
            loadManifestChainAuthority: () => new Promise(() => undefined),
            recordCaptured: async () => {
              records += 1;
              return claim().backup;
            },
            resolveContext: async () => context,
          },
        }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED" });
      expect(fetches).toBe(0);
      expect(records).toBe(0);
      expect(await fs.promises.readdir(directory)).toEqual([]);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("propagates caller cancellation through the same pre-HTTP authority", async () => {
    const directory = await stateDirectory();
    const caller = new AbortController();
    let resolverSignal: AbortSignal | undefined;
    let markResolverStarted: (() => void) | undefined;
    const resolverStarted = new Promise<void>((resolve) => {
      markResolverStarted = resolve;
    });
    try {
      const execution = executeAgentBackupCaptureV2CatalogClaim({
        claim: claim(),
        leaseMs: 240_000,
        signal: caller.signal,
        dependencies: {
          heartbeatOperation: async () => claim().backup,
          recordCaptured: async () => claim().backup,
          resolveContext(input) {
            resolverSignal = input.signal;
            markResolverStarted?.();
            return new Promise<AgentBackupCaptureV2CatalogExecutionContext>(() => undefined);
          },
        },
      });
      await resolverStarted;
      caller.abort(new Error("operator stopped the capture"));
      await expect(execution).rejects.toMatchObject({ code: "AGENT_BACKUP_V2_CAPTURE_ABORTED" });
      expect(resolverSignal?.aborted).toBe(true);
      expect(await fs.promises.readdir(directory)).toEqual([]);
    } finally {
      await removeStateDirectory(directory);
    }
  });

  it("stops before chain, HTTP, spool, and record when revalidation never settles", async () => {
    const directory = await stateDirectory();
    let chainLoads = 0;
    let fetches = 0;
    let records = 0;
    let revalidationSignal: AbortSignal | undefined;
    try {
      const context = inertContext(directory, {
        async revalidateAttestation(signal) {
          revalidationSignal = signal;
          return new Promise<AgentBackupCaptureV2RuntimeAttestation>(() => undefined);
        },
        transport: {
          agentApiBaseUrl: "https://exact-agent.invalid",
          apiToken: "exact-agent-token",
          fetch: (async () => {
            fetches += 1;
            throw new Error("HTTP capture must not start");
          }) as typeof fetch,
        },
      });
      await expect(
        executeAgentBackupCaptureV2CatalogClaim({
          claim: claim(),
          leaseMs: 240_000,
          dependencies: {
            captureDeadlineMs: 20,
            heartbeatOperation: async () => claim().backup,
            loadManifestChainAuthority: async () => {
              chainLoads += 1;
              throw new Error("Manifest chain must not load");
            },
            recordCaptured: async () => {
              records += 1;
              return claim().backup;
            },
            resolveContext: async () => context,
          },
        }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED" });
      expect(revalidationSignal?.aborted).toBe(true);
      expect(chainLoads).toBe(0);
      expect(fetches).toBe(0);
      expect(records).toBe(0);
      expect(await fs.promises.readdir(directory)).toEqual([]);
    } finally {
      await removeStateDirectory(directory);
    }
  });
});
