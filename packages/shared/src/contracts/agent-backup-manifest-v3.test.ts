/**
 * Exercises the runtime-agnostic manifest-v3 operation-key-bundle contract.
 * The harness uses real WebCrypto digests and the complete v2 structural/AAD
 * validator reused by v3; it does not stand in for a catalogue or restore path.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_BACKUP_CHUNK_AAD_DERIVATION,
  AGENT_BACKUP_CHUNK_ENVELOPE_V1,
  AGENT_BACKUP_MANIFEST_FORMAT,
  computeAgentBackupChunkAadDigest,
  createAgentBackupManifestV2,
  parseAgentBackupManifestV2,
} from "./agent-backup-manifest.js";
import {
  AGENT_BACKUP_MANIFEST_V3_SCHEMA_VERSION,
  AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
  AGENT_VAULT_KEY_AUTHORITY_FORMAT,
  AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
  type AgentBackupManifestV3Draft,
  canonicalizeAgentBackupManifestV3,
  canonicalizeAgentBackupOperationKeyBundleContext,
  createAgentBackupManifestV3,
  parseAgentBackupManifestV3,
} from "./agent-backup-manifest-v3.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const ACTIVATION_GENERATION = "44444444-4444-4444-8444-444444444444";
const NODE_RECORD_ID = "55555555-5555-4555-8555-555555555555";
const NODE_INCARNATION = "66666666-6666-4666-8666-666666666666";
const KEY_BUNDLE_GENERATION_ID = "77777777-7777-4777-8777-777777777777";
const VAULT_KEY_GENERATION_ID = "88888888-8888-4888-8888-888888888888";
const KEY_ID = `org:${ORGANIZATION_ID}/dek/v7`;
const COMPONENT_NAMES = [
  "character",
  "database",
  "media",
  "state-files",
  "vault",
] as const;

function digest(character: string): string {
  return character.repeat(64);
}

async function fixtureDraft(): Promise<AgentBackupManifestV3Draft> {
  const identity = {
    organizationId: ORGANIZATION_ID,
    agentId: AGENT_ID,
    activationGeneration: ACTIVATION_GENERATION,
    lifecycleRevision: "7",
  } as const;
  const components = await Promise.all(
    COMPONENT_NAMES.map(async (name, index) => {
      const contentHmacSha256 = digest(String((index + 1) % 10));
      const format = "elizaos.capture-v2-record-stream.v1";
      const compression = "none" as const;
      const chunk = {
        index: 0,
        offsetBytes: 0,
        plainBytes: 1,
        compressedBytes: 1,
        encryptedBytes:
          1 +
          AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes +
          AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes,
        contentHmacSha256,
        aadSha256: await computeAgentBackupChunkAadDigest({
          identity,
          operationId: OPERATION_ID,
          component: { name, format, compression },
          chunk: {
            index: 0,
            offsetBytes: 0,
            plainBytes: 1,
            compressedBytes: 1,
            contentHmacSha256,
          },
        }),
        sha256: digest("a"),
      };
      return {
        name,
        format,
        compression,
        payloadContentHmacSha256: contentHmacSha256,
        state: {
          kind: "full" as const,
          resultContentHmacSha256: contentHmacSha256,
        },
        totals: {
          plainBytes: 1,
          compressedBytes: 1,
          encryptedBytes: chunk.encryptedBytes,
          chunkCount: 1,
        },
        chunks: [chunk],
      };
    }),
  );
  return {
    format: AGENT_BACKUP_MANIFEST_FORMAT,
    schemaVersion: AGENT_BACKUP_MANIFEST_V3_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    createdAt: "2026-08-16T00:00:00.000Z",
    identity,
    source: {
      kind: "robot",
      provider: "hetzner",
      nodeRecordId: NODE_RECORD_ID,
      nodeIncarnation: NODE_INCARNATION,
      nodeId: "robot-01",
      containerId: "container-01",
    },
    runtime: {
      imageDigest: `sha256:${digest("b")}`,
      agentSchemaVersion: "1",
      databaseSchemaVersion: "1",
      plugins: [{ id: "@elizaos/plugin-sql", version: "1.0.0" }],
    },
    chain: {
      kind: "full",
      baseOperationId: null,
      parentOperationId: null,
      depth: 0,
    },
    components,
    watermarks: [{ namespace: "database", value: "7" }],
    totals: {
      plainBytes: COMPONENT_NAMES.length,
      compressedBytes: COMPONENT_NAMES.length,
      encryptedBytes: components.reduce(
        (total, component) => total + component.totals.encryptedBytes,
        0,
      ),
      chunkCount: COMPONENT_NAMES.length,
    },
    vaultKeyAuthority: {
      format: AGENT_VAULT_KEY_AUTHORITY_FORMAT,
      generationId: VAULT_KEY_GENERATION_ID,
      receiptDerivation: AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
      receiptDigest: digest("f"),
    },
    encryption: {
      algorithm: "AES-256-GCM",
      chunkEnvelope: AGENT_BACKUP_CHUNK_ENVELOPE_V1.name,
      nonceBytes: AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes,
      tagBytes: AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes,
      noncePlacement: AGENT_BACKUP_CHUNK_ENVELOPE_V1.noncePlacement,
      tagPlacement: AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagPlacement,
      aad: { version: 1, derivation: AGENT_BACKUP_CHUNK_AAD_DERIVATION },
      kms: { provider: "local", keyId: KEY_ID, keyVersion: 7 },
      operationKeyBundle: {
        format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
        generationId: KEY_BUNDLE_GENERATION_ID,
        plaintextBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
        dek: { ...AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.dek },
        contentHmac: { ...AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac },
        wrapped: {
          ref: `backup-key-bundle:${OPERATION_ID}`,
          bytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes,
          sha256: digest("c"),
          localReceiptDerivation:
            AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
          localReceiptDigest: digest("d"),
          contextDerivation:
            AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
        },
      },
    },
    integrity: {
      framedContentHmacSha256: digest("e"),
      contentAddressing: {
        algorithm: "HMAC-SHA-256",
        scope: "operation",
        derivation: AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
        keyBundleFormat: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
        keyOffsetBytes:
          AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.offsetBytes,
        keyBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.bytes,
      },
    },
  };
}

describe("agent backup manifest v3 operation key bundle", () => {
  it("seals and parses one complete v3 manifest with operation-scoped HMAC authority", async () => {
    const draft = await fixtureDraft();
    const manifest = await createAgentBackupManifestV3(draft);

    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.vaultKeyAuthority).toEqual({
      format: AGENT_VAULT_KEY_AUTHORITY_FORMAT,
      generationId: VAULT_KEY_GENERATION_ID,
      receiptDerivation: AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
      receiptDigest: digest("f"),
    });
    expect(manifest.encryption.operationKeyBundle).toMatchObject({
      format: "kms-aead-operation-key-bundle-v1",
      plaintextBytes: 64,
      dek: { offsetBytes: 0, bytes: 32 },
      contentHmac: { offsetBytes: 32, bytes: 32 },
      wrapped: {
        bytes: 92,
        localReceiptDerivation:
          AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
      },
    });
    expect(manifest.integrity.contentAddressing).toEqual({
      algorithm: "HMAC-SHA-256",
      scope: "operation",
      derivation: AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
      keyBundleFormat: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
      keyOffsetBytes: 32,
      keyBytes: 32,
    });
    await expect(parseAgentBackupManifestV3(manifest)).resolves.toEqual(
      manifest,
    );
    expect(canonicalizeAgentBackupManifestV3(draft)).not.toContain(
      "manifestSha256",
    );
  });

  it("keeps v2 and v3 wire contracts explicitly disjoint", async () => {
    const draft = await fixtureDraft();
    const v3 = await createAgentBackupManifestV3(draft);
    await expect(parseAgentBackupManifestV2(v3)).rejects.toThrow();

    const {
      schemaVersion: _schemaVersion,
      vaultKeyAuthority: _vaultKeyAuthority,
      encryption: _encryption,
      integrity,
      ...common
    } = draft;
    const v2 = await createAgentBackupManifestV2({
      ...common,
      schemaVersion: 2,
      encryption: {
        algorithm: "AES-256-GCM",
        dekGenerationId: KEY_BUNDLE_GENERATION_ID,
        envelopeVersion: 1,
        chunkEnvelope: AGENT_BACKUP_CHUNK_ENVELOPE_V1.name,
        nonceBytes: AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes,
        tagBytes: AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes,
        noncePlacement: AGENT_BACKUP_CHUNK_ENVELOPE_V1.noncePlacement,
        tagPlacement: AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagPlacement,
        aad: { version: 1, derivation: AGENT_BACKUP_CHUNK_AAD_DERIVATION },
        kms: { provider: "local", keyId: KEY_ID, keyVersion: 7 },
        wrappedDek: {
          format: "kms-aead-envelope-v1",
          ref: `backup-dek:${OPERATION_ID}`,
          bytes: 60,
          sha256: digest("c"),
          contextDerivation: "elizaos.agent-backup.dek-context.v1",
        },
      },
      integrity: {
        framedContentHmacSha256: integrity.framedContentHmacSha256,
        contentAddressing: {
          algorithm: "HMAC-SHA-256",
          scope: "organization",
          derivation: "elizaos.agent-backup.content-hmac.v1",
          keyId: `org:${ORGANIZATION_ID}/backup-content/v7`,
          keyVersion: 7,
        },
      },
    });
    await expect(parseAgentBackupManifestV3(v2)).rejects.toThrow();
    await expect(parseAgentBackupManifestV2(v2)).resolves.toEqual(v2);
  });

  it("rejects organization-scoped HMAC authority and a foreign wrapped reference", async () => {
    const draft = await fixtureDraft();
    await expect(
      parseAgentBackupManifestV3({
        ...draft,
        integrity: {
          ...draft.integrity,
          manifestSha256: digest("f"),
          contentAddressing: {
            ...draft.integrity.contentAddressing,
            scope: "organization",
          },
        },
      }),
    ).rejects.toThrow();
    await expect(
      createAgentBackupManifestV3({
        ...draft,
        encryption: {
          ...draft.encryption,
          operationKeyBundle: {
            ...draft.encryption.operationKeyBundle,
            wrapped: {
              ...draft.encryption.operationKeyBundle.wrapped,
              ref: "backup-key-bundle:88888888-8888-4888-8888-888888888888",
            },
          },
        },
      }),
    ).rejects.toThrow("unique to operationId");
  });

  it("pins the fixed envelope and explicitly local receipt contract", async () => {
    const manifest = await createAgentBackupManifestV3(await fixtureDraft());
    const wrapped = manifest.encryption.operationKeyBundle.wrapped;

    await expect(
      parseAgentBackupManifestV3({
        ...manifest,
        encryption: {
          ...manifest.encryption,
          operationKeyBundle: {
            ...manifest.encryption.operationKeyBundle,
            wrapped: { ...wrapped, bytes: wrapped.bytes - 1 },
          },
        },
      }),
    ).rejects.toThrow();
    await expect(
      parseAgentBackupManifestV3({
        ...manifest,
        encryption: {
          ...manifest.encryption,
          operationKeyBundle: {
            ...manifest.encryption.operationKeyBundle,
            wrapped: {
              ...wrapped,
              localReceiptDerivation: "kms-provider-attestation-v1",
            },
          },
        },
      }),
    ).rejects.toThrow();
  });

  it("binds KMS context to lifecycle, operation, source, key, and bundle generation", async () => {
    const input = {
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      activationGeneration: ACTIVATION_GENERATION,
      lifecycleRevision: "7",
      operationId: OPERATION_ID,
      keyBundleGenerationId: KEY_BUNDLE_GENERATION_ID,
      sourceKind: "robot" as const,
      sourceProvider: "hetzner" as const,
      kmsProvider: "local" as const,
      keyId: KEY_ID,
      keyVersion: 7,
    };
    const canonical = canonicalizeAgentBackupOperationKeyBundleContext(input);
    expect(canonical).toContain(
      AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
    );
    expect(canonical).not.toContain("wrappedKeyBundleSha256");
    expect(
      canonicalizeAgentBackupOperationKeyBundleContext({
        ...input,
        operationId: "88888888-8888-4888-8888-888888888888",
      }),
    ).not.toBe(canonical);
    expect(
      canonicalizeAgentBackupOperationKeyBundleContext({
        ...input,
        keyBundleGenerationId: "99999999-9999-4999-8999-999999999999",
      }),
    ).not.toBe(canonical);
  });
});
