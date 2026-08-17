/**
 * Defines the parallel v3 sandbox-backup manifest contract. It preserves every
 * v2 topology, chunk, accounting, and ordering invariant while replacing the
 * reusable organization HMAC key with one random operation-scoped key bundle.
 * V2 remains a separate wire contract; no catalogue or restore callsite is
 * implicitly upgraded by exporting this module.
 */

import z from "zod";
import {
  AGENT_BACKUP_CHUNK_AAD_DERIVATION,
  AGENT_BACKUP_CHUNK_ENVELOPE_V1,
  AGENT_BACKUP_CONTENT_HMAC_DERIVATION,
  AGENT_BACKUP_DEK_CONTEXT_DERIVATION,
  AGENT_BACKUP_MANIFEST_FORMAT,
  AGENT_BACKUP_MANIFEST_V2_LIMITS,
  type AgentBackupManifestV2Draft,
  type AgentBackupManifestV2KmsProvider,
  createAgentBackupManifestV2,
  parseAgentBackupManifestV2Draft,
} from "./agent-backup-manifest.js";

export const AGENT_BACKUP_MANIFEST_V3_SCHEMA_VERSION = 3 as const;
export const AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT =
  "kms-aead-operation-key-bundle-v1" as const;
export const AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION =
  "elizaos.agent-backup.operation-key-bundle-context.v1" as const;
export const AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION =
  "elizaos.kms-aead-operation-key-bundle.local-receipt.v1" as const;
export const AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION =
  "elizaos.agent-backup.content-hmac.operation-key-bundle.v1" as const;
export const AGENT_VAULT_KEY_AUTHORITY_FORMAT =
  "kms-aead-vault-passphrase-v1" as const;
export const AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION =
  "elizaos.agent-vault-key.authority-receipt.v1" as const;

/** Exact plaintext layout before the whole 64-byte bundle is KMS-wrapped. */
export const AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1 = Object.freeze({
  format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
  plaintextBytes: 64 as const,
  wrappedBytes: 92 as const,
  dek: Object.freeze({ offsetBytes: 0 as const, bytes: 32 as const }),
  contentHmac: Object.freeze({ offsetBytes: 32 as const, bytes: 32 as const }),
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ORG_DEK_KEY_ID_PATTERN = /^org:([A-Za-z0-9_.-]+)\/dek\/v([1-9][0-9]*)$/;
const PRINTABLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const CANONICAL_UINT64_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;

const Sha256Schema = z.string().regex(SHA256_PATTERN);
const UuidSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase(), "UUID must be lowercase");
const SafePositiveIntegerSchema = z.number().int().safe().positive();
const CanonicalUint64StringSchema = z
  .string()
  .regex(CANONICAL_UINT64_PATTERN)
  .refine(
    (value) => BigInt(value) <= 18_446_744_073_709_551_615n,
    "Expected a uint64 decimal",
  );
const DurableKmsProviderSchema = z.enum(["local", "steward"]);
const KmsSchema = z.strictObject({
  provider: DurableKmsProviderSchema,
  keyId: z.string().min(1).max(512).regex(ORG_DEK_KEY_ID_PATTERN),
  keyVersion: SafePositiveIntegerSchema,
});

const OperationKeyBundleSchema = z.strictObject({
  format: z.literal(AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT),
  generationId: UuidSchema,
  plaintextBytes: z.literal(
    AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
  ),
  dek: z.strictObject({
    offsetBytes: z.literal(
      AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.dek.offsetBytes,
    ),
    bytes: z.literal(AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.dek.bytes),
  }),
  contentHmac: z.strictObject({
    offsetBytes: z.literal(
      AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.offsetBytes,
    ),
    bytes: z.literal(AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.bytes),
  }),
  wrapped: z.strictObject({
    ref: z.string().min(1).max(512).regex(PRINTABLE_ASCII_PATTERN),
    bytes: z.literal(AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes),
    sha256: Sha256Schema,
    localReceiptDerivation: z.literal(
      AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
    ),
    localReceiptDigest: Sha256Schema,
    contextDerivation: z.literal(
      AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
    ),
  }),
});

/**
 * Immutable control-plane authority for the master passphrase that encrypted
 * the vault component. The passphrase and its KMS envelope deliberately stay
 * outside the backup manifest; this authenticated pointer is sufficient to
 * select exactly one retained generation during a cross-node restore.
 */
const VaultKeyAuthoritySchema = z.strictObject({
  format: z.literal(AGENT_VAULT_KEY_AUTHORITY_FORMAT),
  generationId: UuidSchema,
  receiptDerivation: z.literal(AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION),
  receiptDigest: Sha256Schema,
});

const EncryptionV3Schema = z.strictObject({
  algorithm: z.literal("AES-256-GCM"),
  chunkEnvelope: z.literal(AGENT_BACKUP_CHUNK_ENVELOPE_V1.name),
  nonceBytes: z.literal(AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes),
  tagBytes: z.literal(AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes),
  noncePlacement: z.literal(AGENT_BACKUP_CHUNK_ENVELOPE_V1.noncePlacement),
  tagPlacement: z.literal(AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagPlacement),
  aad: z.strictObject({
    version: z.literal(1),
    derivation: z.literal(AGENT_BACKUP_CHUNK_AAD_DERIVATION),
  }),
  kms: KmsSchema,
  operationKeyBundle: OperationKeyBundleSchema,
});

const ContentAddressingV3Schema = z.strictObject({
  algorithm: z.literal("HMAC-SHA-256"),
  scope: z.literal("operation"),
  derivation: z.literal(AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION),
  keyBundleFormat: z.literal(AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT),
  keyOffsetBytes: z.literal(
    AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.offsetBytes,
  ),
  keyBytes: z.literal(AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.bytes),
});

const DraftIntegrityV3Schema = z.strictObject({
  framedContentHmacSha256: Sha256Schema,
  contentAddressing: ContentAddressingV3Schema,
});

const IntegrityV3Schema = DraftIntegrityV3Schema.extend({
  manifestSha256: Sha256Schema,
});

const ManifestV3DraftShellSchema = z.strictObject({
  format: z.literal(AGENT_BACKUP_MANIFEST_FORMAT),
  schemaVersion: z.literal(AGENT_BACKUP_MANIFEST_V3_SCHEMA_VERSION),
  operationId: z.unknown(),
  createdAt: z.unknown(),
  identity: z.unknown(),
  source: z.unknown(),
  runtime: z.unknown(),
  chain: z.unknown(),
  components: z.unknown(),
  watermarks: z.unknown(),
  totals: z.unknown(),
  vaultKeyAuthority: VaultKeyAuthoritySchema,
  encryption: EncryptionV3Schema,
  integrity: DraftIntegrityV3Schema,
});

const ManifestV3ShellSchema = ManifestV3DraftShellSchema.extend({
  integrity: IntegrityV3Schema,
});

type EncryptionV3 = z.infer<typeof EncryptionV3Schema>;
export type AgentVaultKeyAuthorityManifestRef = z.infer<
  typeof VaultKeyAuthoritySchema
>;
type DraftIntegrityV3 = z.infer<typeof DraftIntegrityV3Schema>;
type IntegrityV3 = z.infer<typeof IntegrityV3Schema>;
type ManifestV3DraftShell = z.infer<typeof ManifestV3DraftShellSchema>;

const OrganizationIdentitySchema = z.object({ organizationId: UuidSchema });

type ManifestV3Common = Omit<
  AgentBackupManifestV2Draft,
  "schemaVersion" | "encryption" | "integrity"
>;

export type AgentBackupManifestV3Draft = ManifestV3Common & {
  schemaVersion: typeof AGENT_BACKUP_MANIFEST_V3_SCHEMA_VERSION;
  vaultKeyAuthority: AgentVaultKeyAuthorityManifestRef;
  encryption: EncryptionV3;
  integrity: DraftIntegrityV3;
};

export type AgentBackupManifestV3 = ManifestV3Common & {
  schemaVersion: typeof AGENT_BACKUP_MANIFEST_V3_SCHEMA_VERSION;
  vaultKeyAuthority: AgentVaultKeyAuthorityManifestRef;
  encryption: EncryptionV3;
  integrity: IntegrityV3;
};

export type AgentBackupManifestV3KmsProvider = AgentBackupManifestV2KmsProvider;

const OperationKeyBundleContextSchema = z
  .strictObject({
    organizationId: UuidSchema,
    agentId: UuidSchema,
    activationGeneration: UuidSchema,
    lifecycleRevision: CanonicalUint64StringSchema,
    operationId: UuidSchema,
    keyBundleGenerationId: UuidSchema,
    sourceKind: z.enum(["robot", "cloud"]),
    sourceProvider: z.literal("hetzner"),
    kmsProvider: DurableKmsProviderSchema,
    keyId: z.string().min(1).max(512).regex(ORG_DEK_KEY_ID_PATTERN),
    keyVersion: SafePositiveIntegerSchema,
  })
  .superRefine((value, context) => {
    const keyMatch = ORG_DEK_KEY_ID_PATTERN.exec(value.keyId);
    if (keyMatch?.[1] !== value.organizationId) {
      context.addIssue({
        code: "custom",
        path: ["keyId"],
        message: "Operation key-bundle KEK must be scoped to organizationId",
      });
    }
    if (Number(keyMatch?.[2]) !== value.keyVersion) {
      context.addIssue({
        code: "custom",
        path: ["keyVersion"],
        message: "KMS keyVersion must match the version embedded in keyId",
      });
    }
  });

export type AgentBackupOperationKeyBundleContextInput = z.infer<
  typeof OperationKeyBundleContextSchema
>;

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new TypeError(
        "Canonical backup JSON only permits safe, non-negative integers",
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (!isJsonRecord(value)) {
    throw new TypeError("Canonical backup JSON contains a non-JSON value");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function projectV3ShellToV2Draft(
  shell: ManifestV3DraftShell,
): AgentBackupManifestV2Draft {
  const { organizationId } = OrganizationIdentitySchema.parse(shell.identity);
  const { vaultKeyAuthority: _vaultKeyAuthority, ...v2Shell } = shell;
  return parseAgentBackupManifestV2Draft({
    ...v2Shell,
    schemaVersion: 2,
    encryption: {
      algorithm: shell.encryption.algorithm,
      dekGenerationId: shell.encryption.operationKeyBundle.generationId,
      envelopeVersion: 1,
      chunkEnvelope: shell.encryption.chunkEnvelope,
      nonceBytes: shell.encryption.nonceBytes,
      tagBytes: shell.encryption.tagBytes,
      noncePlacement: shell.encryption.noncePlacement,
      tagPlacement: shell.encryption.tagPlacement,
      aad: shell.encryption.aad,
      kms: shell.encryption.kms,
      wrappedDek: {
        format: "kms-aead-envelope-v1",
        ref: `backup-dek:${String(shell.operationId)}`,
        bytes: shell.encryption.operationKeyBundle.wrapped.bytes,
        sha256: shell.encryption.operationKeyBundle.wrapped.sha256,
        contextDerivation: AGENT_BACKUP_DEK_CONTEXT_DERIVATION,
      },
    },
    integrity: {
      framedContentHmacSha256: shell.integrity.framedContentHmacSha256,
      contentAddressing: {
        algorithm: "HMAC-SHA-256",
        scope: "organization",
        derivation: AGENT_BACKUP_CONTENT_HMAC_DERIVATION,
        keyId: `org:${organizationId}/backup-content/v${shell.encryption.kms.keyVersion}`,
        keyVersion: shell.encryption.kms.keyVersion,
      },
    },
  });
}

function assertV3KeyAuthority(draft: AgentBackupManifestV3Draft): void {
  const keyMatch = ORG_DEK_KEY_ID_PATTERN.exec(draft.encryption.kms.keyId);
  if (keyMatch?.[1] !== draft.identity.organizationId) {
    throw new Error(
      "Operation key-bundle KEK must be scoped to identity.organizationId",
    );
  }
  if (Number(keyMatch?.[2]) !== draft.encryption.kms.keyVersion) {
    throw new Error("KMS keyVersion must match the version embedded in keyId");
  }
  if (
    draft.encryption.operationKeyBundle.wrapped.ref !==
    `backup-key-bundle:${draft.operationId}`
  ) {
    throw new Error(
      "Wrapped operation key-bundle reference must be unique to operationId",
    );
  }
}

function normalizeV3Draft(input: unknown): AgentBackupManifestV3Draft {
  const shell = ManifestV3DraftShellSchema.parse(input);
  const projected = projectV3ShellToV2Draft(shell);
  const {
    schemaVersion: _schemaVersion,
    encryption: _encryption,
    integrity: _integrity,
    ...common
  } = projected;
  const draft: AgentBackupManifestV3Draft = {
    ...common,
    schemaVersion: AGENT_BACKUP_MANIFEST_V3_SCHEMA_VERSION,
    vaultKeyAuthority: shell.vaultKeyAuthority,
    encryption: shell.encryption,
    integrity: shell.integrity,
  };
  assertV3KeyAuthority(draft);
  return draft;
}

async function verifyCommonSelfDigests(
  draft: AgentBackupManifestV3Draft,
): Promise<void> {
  const shell = ManifestV3DraftShellSchema.parse(draft);
  await createAgentBackupManifestV2(projectV3ShellToV2Draft(shell));
}

/** Canonical KEK AAD; wrapped bytes and their digest are deliberately absent. */
export function canonicalizeAgentBackupOperationKeyBundleContext(
  input: AgentBackupOperationKeyBundleContextInput,
): string {
  return canonicalJson({
    derivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
    ...OperationKeyBundleContextSchema.parse(input),
  });
}

export function canonicalizeAgentBackupManifestV3(
  draftInput: AgentBackupManifestV3Draft,
): string {
  return canonicalJson(normalizeV3Draft(draftInput));
}

export async function computeAgentBackupManifestV3Digest(
  draftInput: AgentBackupManifestV3Draft,
): Promise<string> {
  const canonical = canonicalizeAgentBackupManifestV3(draftInput);
  if (
    new TextEncoder().encode(canonical).byteLength >
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxManifestBytes
  ) {
    throw new RangeError(
      `Backup manifest exceeds ${AGENT_BACKUP_MANIFEST_V2_LIMITS.maxManifestBytes} bytes`,
    );
  }
  return sha256Hex(canonical);
}

/** Seal a v3 manifest without making it acceptable to any v2-only consumer. */
export async function createAgentBackupManifestV3(
  draftInput: AgentBackupManifestV3Draft,
): Promise<AgentBackupManifestV3> {
  const draft = normalizeV3Draft(draftInput);
  await verifyCommonSelfDigests(draft);
  return {
    ...draft,
    integrity: {
      ...draft.integrity,
      manifestSha256: await computeAgentBackupManifestV3Digest(draft),
    },
  };
}

/** Validate a complete v3 manifest and recompute every common and v3 digest. */
export async function parseAgentBackupManifestV3(
  input: unknown,
): Promise<AgentBackupManifestV3> {
  const shell = ManifestV3ShellSchema.parse(input);
  const { manifestSha256, ...draftIntegrity } = shell.integrity;
  const draft = normalizeV3Draft({ ...shell, integrity: draftIntegrity });
  await verifyCommonSelfDigests(draft);
  const expected = await computeAgentBackupManifestV3Digest(draft);
  if (manifestSha256 !== expected) {
    throw new Error("Canonical manifest digest mismatch");
  }
  return { ...draft, integrity: { ...draft.integrity, manifestSha256 } };
}
