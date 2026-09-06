/**
 * Runtime-neutral contract between the restore-v3 stream executor and an
 * isolated candidate staging implementation. This module carries no database,
 * provider, filesystem, KMS, credential, or live-sandbox dependency.
 */

import z from "zod";
import {
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  AgentBackupCaptureV2ComponentDescriptorSchema,
  type AgentBackupCaptureV2FileEntry,
  AgentBackupCaptureV2FileEntrySchema,
} from "./agent-backup-capture-v2.js";
import { AGENT_BACKUP_MANIFEST_V2_LIMITS } from "./agent-backup-manifest.js";
import {
  type AgentBackupManifestV3,
  parseAgentBackupManifestV3,
} from "./agent-backup-manifest-v3.js";
import { AGENT_BACKUP_RECORD_STREAM_V1_FORMAT } from "./agent-backup-record-stream-v1.js";

export const AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS = Object.freeze([
  "character",
  "database",
  "media",
  "state-files",
  "vault",
] as const);

export const AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS = Object.freeze([
  Object.freeze({
    name: "character",
    format: "runtime-character-json-v1",
    compression: "none",
    contentKind: "opaque",
    consistency: "best-effort",
  }),
  Object.freeze({
    name: "database",
    format: "pglite-data-dir-tar-gzip-v1",
    compression: "gzip",
    contentKind: "opaque",
    consistency: "transactional",
  }),
  Object.freeze({
    name: "media",
    format: "file-set-v1",
    compression: "none",
    contentKind: "file-set",
    consistency: "best-effort",
  }),
  Object.freeze({
    name: "state-files",
    format: "file-set-v1",
    compression: "none",
    contentKind: "file-set",
    consistency: "best-effort",
  }),
  Object.freeze({
    name: "vault",
    format: "file-set-v1",
    compression: "none",
    contentKind: "file-set",
    consistency: "best-effort",
  }),
] as const);

export const AGENT_BACKUP_RESTORE_V3_STREAM_RECEIPT_FORMAT =
  "elizaos.agent-backup.restore-v3-stream-candidate.v1" as const;
export const AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION =
  "elizaos.agent-backup.restore-v3-source-authority.v1" as const;
export const AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION =
  "elizaos.agent-backup.restore-v3-exact-read-receipt.v1" as const;

export type AgentBackupRestoreV3StreamComponentName =
  (typeof AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS)[number];

export type AgentBackupRestoreV3DeepReadonly<T> = T extends (
  ...args: never[]
) => unknown
  ? T
  : T extends readonly (infer Entry)[]
    ? readonly AgentBackupRestoreV3DeepReadonly<Entry>[]
    : T extends object
      ? { readonly [Key in keyof T]: AgentBackupRestoreV3DeepReadonly<T[Key]> }
      : T;

const UUIDSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase(), "UUID must be lowercase");
const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 hex digest");
const CanonicalUint64StringSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/, "Expected a canonical uint64 decimal")
  .refine(
    (value) => BigInt(value) <= 18_446_744_073_709_551_615n,
    "Expected a uint64 decimal",
  );
const SafeNonNegativeIntegerSchema = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .refine((value) => !Object.is(value, -0), "Expected a canonical integer");
const SafePositiveIntegerSchema = z.number().int().safe().positive();
const CopyRoleSchema = z.enum(["primary", "secondary"]);
const ComponentNameSchema = z.enum(AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS);
const ComponentIndexSchema = SafeNonNegativeIntegerSchema.max(
  AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.length - 1,
);
const ChunkIndexSchema = SafeNonNegativeIntegerSchema.max(
  AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunksPerComponent - 1,
);
const ObjectSizeSchema = SafePositiveIntegerSchema.max(
  AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkEncryptedBytes,
);
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const BoundedOpaqueTextSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) =>
      Array.from(value).every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
      }) &&
      UTF8_ENCODER.encode(value).byteLength <= 2_048 &&
      UTF8_DECODER.decode(UTF8_ENCODER.encode(value)) === value,
    "Expected bounded opaque text",
  );
const Sha256FingerprintSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "Expected a SHA-256 identity fingerprint");
const ProviderOpaqueValueSchema = BoundedOpaqueTextSchema.refine(
  (value) => value === value.trim(),
  "Provider generation values must not contain surrounding whitespace",
);
const Sha256Base64Schema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, "Expected a canonical SHA-256 base64 digest")
  .refine((value) => {
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    return alphabet.indexOf(value[42] ?? "") % 4 === 0;
  }, "Expected canonical zero padding in a SHA-256 base64 digest");
const ProviderSha256ChecksumSchema = z
  .string()
  .regex(
    /^sha256:base64:[A-Za-z0-9+/]{43}=$/,
    "Expected canonical provider SHA-256 checksum authority",
  )
  .refine(
    (value) =>
      Sha256Base64Schema.safeParse(value.slice("sha256:base64:".length))
        .success,
    "Expected canonical provider SHA-256 checksum authority",
  );

const ExactSourceCatalogSchema = z
  .strictObject({
    transport: z.enum(["worker-r2", "s3-compatible"]),
    provider: z.enum(["cloudflare-r2", "hetzner-object-storage"]),
    endpointIdentityFingerprint: Sha256FingerprintSchema,
    endpointAliasFingerprint: Sha256FingerprintSchema,
    bucketFingerprint: Sha256FingerprintSchema,
    regionFingerprint: Sha256FingerprintSchema,
    keyFingerprint: Sha256FingerprintSchema,
    providerVersionId: ProviderOpaqueValueSchema.nullable(),
    providerEtag: ProviderOpaqueValueSchema.nullable(),
    providerChecksum: ProviderSha256ChecksumSchema.nullable(),
    uploadReceiptDigest: Sha256Schema,
    ciphertextSha256: Sha256Schema,
    sizeBytes: ObjectSizeSchema,
  })
  .superRefine((catalog, context) => {
    if (
      catalog.providerVersionId === null &&
      catalog.providerEtag === null &&
      catalog.providerChecksum === null
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Exact source authority requires one immutable provider generation",
      });
    }
  });

export const AgentBackupRestoreV3AuthorityFenceSchema = z.strictObject({
  organizationId: UUIDSchema,
  agentId: UUIDSchema,
  backupId: UUIDSchema,
  operationId: UUIDSchema,
  sourceActivationGeneration: UUIDSchema,
  sourceLifecycleRevision: CanonicalUint64StringSchema,
  expectedManifestSha256: Sha256Schema,
  copyRole: CopyRoleSchema,
  restoreAttemptId: UUIDSchema,
  leaseId: UUIDSchema,
  ownerId: BoundedOpaqueTextSchema,
  fencingToken: UUIDSchema,
  catalogEpoch: CanonicalUint64StringSchema,
  leaseExpiresAtEpochMs: SafePositiveIntegerSchema,
});

/**
 * Privacy-safe canonical input for the digest carried by one source-object
 * receipt. It joins immutable catalogue authority to the exact GET completion
 * proof without exposing an object key, bucket, endpoint, or credential.
 */
export const AgentBackupRestoreV3ExactReadReceiptProofSchema = z
  .strictObject({
    derivation: z.literal(
      AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
    ),
    sourceAuthoritySha256: Sha256Schema,
    organizationId: UUIDSchema,
    backupId: UUIDSchema,
    objectId: UUIDSchema,
    componentIndex: ComponentIndexSchema,
    componentName: ComponentNameSchema,
    chunkIndex: ChunkIndexSchema,
    copyRole: CopyRoleSchema,
    catalog: ExactSourceCatalogSchema,
    completion: z.strictObject({
      transport: z.enum(["worker-r2-binding", "s3-compatible"]),
      provider: z.enum(["r2", "s3"]),
      backendIdentityFingerprint: Sha256FingerprintSchema,
      endpointAliasFingerprint: Sha256FingerprintSchema,
      bucketFingerprint: Sha256FingerprintSchema,
      regionFingerprint: Sha256FingerprintSchema,
      keyFingerprint: Sha256FingerprintSchema,
      version: ProviderOpaqueValueSchema.nullable(),
      versionSource: z.enum(["provider", "etag", "checksum", "none"]),
      sizeBytes: ObjectSizeSchema,
      checksumSha256Base64: Sha256Base64Schema,
      ciphertextSha256: Sha256Schema,
      verifiedComplete: z.literal(true),
    }),
  })
  .superRefine((proof, context) => {
    const expectedTransport =
      proof.catalog.transport === "worker-r2"
        ? "worker-r2-binding"
        : "s3-compatible";
    const expectedProvider =
      proof.catalog.provider === "cloudflare-r2" ? "r2" : "s3";
    const expectedVersion =
      proof.catalog.providerVersionId ??
      proof.catalog.providerEtag ??
      proof.catalog.providerChecksum?.slice("sha256:base64:".length) ??
      null;
    const expectedVersionSource = proof.catalog.providerVersionId
      ? "provider"
      : proof.catalog.providerEtag
        ? "etag"
        : proof.catalog.providerChecksum
          ? "checksum"
          : "none";
    const providerAuthorityValid =
      (proof.copyRole === "primary" &&
        proof.catalog.provider === "cloudflare-r2" &&
        (proof.catalog.transport === "worker-r2" ||
          proof.catalog.transport === "s3-compatible")) ||
      (proof.copyRole === "secondary" &&
        proof.catalog.provider === "hetzner-object-storage" &&
        proof.catalog.transport === "s3-compatible");
    if (
      !providerAuthorityValid ||
      proof.componentName !==
        AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS[proof.componentIndex] ||
      proof.completion.transport !== expectedTransport ||
      proof.completion.provider !== expectedProvider ||
      proof.completion.backendIdentityFingerprint !==
        proof.catalog.endpointIdentityFingerprint ||
      proof.completion.endpointAliasFingerprint !==
        proof.catalog.endpointAliasFingerprint ||
      proof.completion.bucketFingerprint !== proof.catalog.bucketFingerprint ||
      proof.completion.regionFingerprint !== proof.catalog.regionFingerprint ||
      proof.completion.keyFingerprint !== proof.catalog.keyFingerprint ||
      proof.completion.version !== expectedVersion ||
      proof.completion.versionSource !== expectedVersionSource ||
      (proof.catalog.providerChecksum !== null &&
        proof.catalog.providerChecksum !==
          `sha256:base64:${proof.completion.checksumSha256Base64}`) ||
      proof.completion.sizeBytes !== proof.catalog.sizeBytes ||
      proof.completion.ciphertextSha256 !== proof.catalog.ciphertextSha256
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Exact GET completion differs from its immutable catalogue authority",
      });
    }
  });

export const AgentBackupRestoreV3SourceAuthorityObjectSchema = z.strictObject({
  objectId: UUIDSchema,
  componentIndex: ComponentIndexSchema,
  componentName: ComponentNameSchema,
  chunkIndex: ChunkIndexSchema,
  copyRole: CopyRoleSchema,
  contentHmacSha256: Sha256Schema,
  catalog: ExactSourceCatalogSchema,
});

/**
 * Locator-free canonical projection of the exact verified catalogue generation.
 * Its digest binds every later GET completion and candidate seal to one source.
 */
export const AgentBackupRestoreV3SourceAuthoritySchema = z
  .strictObject({
    derivation: z.literal(AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION),
    organizationId: UUIDSchema,
    agentId: UUIDSchema,
    backupId: UUIDSchema,
    operationId: UUIDSchema,
    sourceActivationGeneration: UUIDSchema,
    sourceLifecycleRevision: CanonicalUint64StringSchema,
    expectedManifestSha256: Sha256Schema,
    copyRole: CopyRoleSchema,
    catalogEpoch: CanonicalUint64StringSchema,
    objects: z
      .array(AgentBackupRestoreV3SourceAuthorityObjectSchema)
      .min(AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.length)
      .max(AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunks),
  })
  .superRefine((authority, context) => {
    const objectIds = new Set<string>();
    const keyFingerprints = new Set<string>();
    let previousComponentIndex = -1;
    let previousChunkIndex = -1;
    for (const [index, object] of authority.objects.entries()) {
      const expectedName =
        AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS[object.componentIndex];
      const startsComponent = object.componentIndex !== previousComponentIndex;
      const ordered =
        object.componentIndex >= previousComponentIndex &&
        (startsComponent
          ? object.componentIndex === previousComponentIndex + 1 &&
            object.chunkIndex === 0
          : object.chunkIndex === previousChunkIndex + 1);
      const providerAuthorityValid =
        (object.copyRole === "primary" &&
          object.catalog.provider === "cloudflare-r2" &&
          (object.catalog.transport === "worker-r2" ||
            object.catalog.transport === "s3-compatible")) ||
        (object.copyRole === "secondary" &&
          object.catalog.provider === "hetzner-object-storage" &&
          object.catalog.transport === "s3-compatible");
      if (
        object.componentName !== expectedName ||
        object.copyRole !== authority.copyRole ||
        !providerAuthorityValid ||
        !ordered ||
        objectIds.has(object.objectId) ||
        keyFingerprints.has(object.catalog.keyFingerprint)
      ) {
        context.addIssue({
          code: "custom",
          path: ["objects", index],
          message:
            "Source authority objects must be exact, unique, and contiguous",
        });
      }
      objectIds.add(object.objectId);
      keyFingerprints.add(object.catalog.keyFingerprint);
      previousComponentIndex = object.componentIndex;
      previousChunkIndex = object.chunkIndex;
    }
    if (
      previousComponentIndex !==
      AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.length - 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["objects"],
        message: "Source authority must cover all five restore components",
      });
    }
  });

/** Exact immutable source generation proven after fully draining one object. */
export const AgentBackupRestoreV3SourceObjectReceiptSchema = z.strictObject({
  componentIndex: ComponentIndexSchema,
  componentName: ComponentNameSchema,
  chunkIndex: ChunkIndexSchema,
  copyRole: CopyRoleSchema,
  objectId: UUIDSchema,
  exactReadReceiptDerivation: z.literal(
    AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
  ),
  /** Digest of the privacy-safe catalogue authority plus exact GET completion receipt. */
  exactReadReceiptSha256: Sha256Schema,
  ciphertextSha256: Sha256Schema,
  sizeBytes: ObjectSizeSchema,
});

export const AgentBackupRestoreV3StageRecordReceiptSchema = z.strictObject({
  componentIndex: ComponentIndexSchema,
  componentName: ComponentNameSchema,
  dataIndex: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames - 1,
  ),
  offsetBytes: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes,
  ),
  entry: AgentBackupCaptureV2FileEntrySchema.nullable(),
  payloadBytes: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes,
  ),
  payloadSha256: Sha256Schema,
});

export const AgentBackupRestoreV3ComponentReceiptSchema = z.strictObject({
  componentIndex: ComponentIndexSchema,
  componentName: ComponentNameSchema,
  descriptor: AgentBackupCaptureV2ComponentDescriptorSchema,
  dataFrameCount: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames,
  ),
  payloadBytes: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes,
  ),
  payloadSha256: Sha256Schema,
  recordStreamContentHmacSha256: Sha256Schema,
});

export const AgentBackupRestoreV3CandidateReceiptSchema = z
  .strictObject({
    format: z.literal(AGENT_BACKUP_RESTORE_V3_STREAM_RECEIPT_FORMAT),
    restoreAttemptId: UUIDSchema,
    operationId: UUIDSchema,
    expectedManifestSha256: Sha256Schema,
    keyBundleGenerationId: UUIDSchema,
    sourceCopyRole: CopyRoleSchema,
    sourceAuthorityDerivation: z.literal(
      AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
    ),
    sourceAuthoritySha256: Sha256Schema,
    objectCount: SafePositiveIntegerSchema.max(
      AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunks,
    ),
    stagedPayloadBytes: SafeNonNegativeIntegerSchema.max(
      AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes,
    ),
    stagedDataRecordCount: SafeNonNegativeIntegerSchema.max(
      AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames,
    ),
    sourceObjects: z
      .array(AgentBackupRestoreV3SourceObjectReceiptSchema)
      .min(AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.length)
      .max(AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunks),
    components: z
      .array(AgentBackupRestoreV3ComponentReceiptSchema)
      .length(AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.length),
    authorityRevalidated: z.literal(true),
  })
  .superRefine((receipt, context) => {
    let payloadBytes = 0n;
    let dataRecordCount = 0n;
    for (const [index, component] of receipt.components.entries()) {
      const expectedName = AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS[index];
      const expectedDescriptor =
        AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[index];
      if (
        component.componentIndex !== index ||
        component.componentName !== expectedName ||
        component.descriptor.name !== expectedName ||
        !expectedDescriptor ||
        component.descriptor.format !== expectedDescriptor.format ||
        component.descriptor.compression !== expectedDescriptor.compression ||
        component.descriptor.contentKind !== expectedDescriptor.contentKind ||
        component.descriptor.consistency !== expectedDescriptor.consistency
      ) {
        context.addIssue({
          code: "custom",
          path: ["components", index],
          message:
            "Restore candidate components must use the exact full-component order",
        });
      }
      payloadBytes += BigInt(component.payloadBytes);
      dataRecordCount += BigInt(component.dataFrameCount);
    }
    if (payloadBytes !== BigInt(receipt.stagedPayloadBytes)) {
      context.addIssue({
        code: "custom",
        path: ["stagedPayloadBytes"],
        message:
          "Restore candidate payload total differs from its component receipts",
      });
    }
    if (dataRecordCount !== BigInt(receipt.stagedDataRecordCount)) {
      context.addIssue({
        code: "custom",
        path: ["stagedDataRecordCount"],
        message:
          "Restore candidate data-record total differs from its component receipts",
      });
    }
    if (receipt.sourceObjects.length !== receipt.objectCount) {
      context.addIssue({
        code: "custom",
        path: ["objectCount"],
        message:
          "Restore candidate object count differs from its exact-read ledger",
      });
    }
    let previousComponentIndex = -1;
    let previousChunkIndex = -1;
    const objectIds = new Set<string>();
    for (const [index, source] of receipt.sourceObjects.entries()) {
      const expectedName =
        AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS[source.componentIndex];
      if (
        source.componentName !== expectedName ||
        source.copyRole !== receipt.sourceCopyRole
      ) {
        context.addIssue({
          code: "custom",
          path: ["sourceObjects", index],
          message:
            "Restore source receipt differs from the candidate component or copy role",
        });
      }
      const startsComponent = source.componentIndex !== previousComponentIndex;
      const ordered =
        source.componentIndex >= previousComponentIndex &&
        (startsComponent
          ? source.componentIndex === previousComponentIndex + 1 &&
            source.chunkIndex === 0
          : source.chunkIndex === previousChunkIndex + 1);
      if (!ordered || objectIds.has(source.objectId)) {
        context.addIssue({
          code: "custom",
          path: ["sourceObjects", index],
          message:
            "Restore source receipts must be unique and contiguous by component and chunk",
        });
      }
      objectIds.add(source.objectId);
      previousComponentIndex = source.componentIndex;
      previousChunkIndex = source.chunkIndex;
    }
    if (
      previousComponentIndex !==
      AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.length - 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceObjects"],
        message: "Restore source receipts must cover all five components",
      });
    }
  });

export type AgentBackupRestoreV3AuthorityFence =
  AgentBackupRestoreV3DeepReadonly<
    z.infer<typeof AgentBackupRestoreV3AuthorityFenceSchema>
  >;
export type AgentBackupRestoreV3ExactReadReceiptProof =
  AgentBackupRestoreV3DeepReadonly<
    z.infer<typeof AgentBackupRestoreV3ExactReadReceiptProofSchema>
  >;
export type AgentBackupRestoreV3SourceAuthorityObject =
  AgentBackupRestoreV3DeepReadonly<
    z.infer<typeof AgentBackupRestoreV3SourceAuthorityObjectSchema>
  >;
export type AgentBackupRestoreV3SourceAuthority =
  AgentBackupRestoreV3DeepReadonly<
    z.infer<typeof AgentBackupRestoreV3SourceAuthoritySchema>
  >;
export type AgentBackupRestoreV3SourceObjectReceipt =
  AgentBackupRestoreV3DeepReadonly<
    z.infer<typeof AgentBackupRestoreV3SourceObjectReceiptSchema>
  >;
export type AgentBackupRestoreV3StageRecordReceipt =
  AgentBackupRestoreV3DeepReadonly<
    z.infer<typeof AgentBackupRestoreV3StageRecordReceiptSchema>
  >;
export type AgentBackupRestoreV3ComponentReceipt =
  AgentBackupRestoreV3DeepReadonly<
    z.infer<typeof AgentBackupRestoreV3ComponentReceiptSchema>
  >;
export type AgentBackupRestoreV3CandidateReceipt =
  AgentBackupRestoreV3DeepReadonly<
    z.infer<typeof AgentBackupRestoreV3CandidateReceiptSchema>
  >;

export interface AgentBackupRestoreV3OperationControl {
  readonly signal: AbortSignal;
  readonly deadlineEpochMs: number;
}

export const AgentBackupRestoreV3StagingSessionSchema = z.strictObject({
  restoreAttemptId: UUIDSchema,
  operationId: UUIDSchema,
  expectedManifestSha256: Sha256Schema,
  stagingHandle: BoundedOpaqueTextSchema,
  cleanupHandle: BoundedOpaqueTextSchema,
  executionToken: BoundedOpaqueTextSchema,
  /** Proves cleanup was durably registered before any plaintext can exist. */
  cleanupRegistered: z.literal(true),
  /** The adapter must keep all writes unreachable from a live sandbox. */
  isolatedCandidate: z.literal(true),
});

export type AgentBackupRestoreV3StagingSession =
  AgentBackupRestoreV3DeepReadonly<
    z.infer<typeof AgentBackupRestoreV3StagingSessionSchema>
  >;

export interface AgentBackupRestoreV3StagedRecord {
  readonly componentIndex: number;
  readonly componentName: AgentBackupRestoreV3StreamComponentName;
  readonly dataIndex: number;
  readonly offsetBytes: number;
  readonly entry: AgentBackupRestoreV3DeepReadonly<AgentBackupCaptureV2FileEntry> | null;
  /** Ephemeral: the adapter must copy it before acknowledging the stage call. */
  readonly payload: Uint8Array;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new TypeError("Restore receipt contains a non-canonical number");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError("Restore receipt contains a non-JSON value");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function freezeDeep<T>(value: T): AgentBackupRestoreV3DeepReadonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value as AgentBackupRestoreV3DeepReadonly<T>;
}

export function parseAgentBackupRestoreV3AuthorityFence(
  value: unknown,
): Readonly<AgentBackupRestoreV3AuthorityFence> {
  return freezeDeep(AgentBackupRestoreV3AuthorityFenceSchema.parse(value));
}

export function canonicalizeAgentBackupRestoreV3AuthorityFence(
  authority: Readonly<AgentBackupRestoreV3AuthorityFence>,
): string {
  return canonicalJson(parseAgentBackupRestoreV3AuthorityFence(authority));
}

export function parseAgentBackupRestoreV3ExactReadReceiptProof(
  value: unknown,
): AgentBackupRestoreV3ExactReadReceiptProof {
  return freezeDeep(
    AgentBackupRestoreV3ExactReadReceiptProofSchema.parse(value),
  );
}

/** Canonical preimage hashed into `exactReadReceiptSha256`. */
export function canonicalizeAgentBackupRestoreV3ExactReadReceiptProof(
  proof: AgentBackupRestoreV3ExactReadReceiptProof,
): string {
  return canonicalJson(parseAgentBackupRestoreV3ExactReadReceiptProof(proof));
}

export function parseAgentBackupRestoreV3SourceAuthority(
  value: unknown,
): AgentBackupRestoreV3SourceAuthority {
  return freezeDeep(AgentBackupRestoreV3SourceAuthoritySchema.parse(value));
}

/** Canonical locator-free catalogue generation hashed into source authority. */
export function canonicalizeAgentBackupRestoreV3SourceAuthority(
  authority: AgentBackupRestoreV3SourceAuthority,
): string {
  return canonicalJson(parseAgentBackupRestoreV3SourceAuthority(authority));
}

export function parseAgentBackupRestoreV3CandidateReceipt(
  value: unknown,
): AgentBackupRestoreV3CandidateReceipt {
  return freezeDeep(AgentBackupRestoreV3CandidateReceiptSchema.parse(value));
}

/** Byte-authoritative canonical JSON covered by candidate seal authorization. */
export function canonicalizeAgentBackupRestoreV3CandidateReceipt(
  receipt: AgentBackupRestoreV3CandidateReceipt,
): string {
  return canonicalJson(parseAgentBackupRestoreV3CandidateReceipt(receipt));
}

export function parseAgentBackupRestoreV3StagingSession(
  value: unknown,
): Readonly<AgentBackupRestoreV3StagingSession> {
  return freezeDeep(AgentBackupRestoreV3StagingSessionSchema.parse(value));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    UTF8_ENCODER.encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function sha256HexToBase64(value: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += alphabet[first >> 2];
    encoded += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    encoded +=
      second === undefined
        ? "="
        : alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    encoded += third === undefined ? "=" : alphabet[third & 63];
  }
  return encoded;
}

export async function computeAgentBackupRestoreV3SourceAuthoritySha256(
  authority: AgentBackupRestoreV3SourceAuthority,
): Promise<string> {
  return sha256Hex(canonicalizeAgentBackupRestoreV3SourceAuthority(authority));
}

export async function computeAgentBackupRestoreV3ExactReadReceiptSha256(
  proof: AgentBackupRestoreV3ExactReadReceiptProof,
): Promise<string> {
  return sha256Hex(
    canonicalizeAgentBackupRestoreV3ExactReadReceiptProof(proof),
  );
}

export async function computeAgentBackupRestoreV3CandidateReceiptSha256(
  receipt: AgentBackupRestoreV3CandidateReceipt,
): Promise<string> {
  return sha256Hex(canonicalizeAgentBackupRestoreV3CandidateReceipt(receipt));
}

export const AgentBackupRestoreV3CandidateBindingSchema = z.strictObject({
  restoreAttemptId: UUIDSchema,
  operationId: UUIDSchema,
  expectedManifestSha256: Sha256Schema,
  keyBundleGenerationId: UUIDSchema,
  sourceCopyRole: CopyRoleSchema,
  sourceAuthoritySha256: Sha256Schema,
  objectCount: SafePositiveIntegerSchema.max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunks,
  ),
  candidateReceiptSha256: Sha256Schema,
});

export type AgentBackupRestoreV3CandidateBinding =
  AgentBackupRestoreV3DeepReadonly<
    z.infer<typeof AgentBackupRestoreV3CandidateBindingSchema>
  >;

export interface AgentBackupRestoreV3CandidateContextInput {
  readonly authority: AgentBackupRestoreV3AuthorityFence;
  /** Untrusted wire input; the validator recomputes every manifest-v3 digest. */
  readonly manifest: unknown;
  readonly sourceAuthority: AgentBackupRestoreV3SourceAuthority;
  readonly exactReadProofs: readonly AgentBackupRestoreV3ExactReadReceiptProof[];
  readonly receipt: AgentBackupRestoreV3CandidateReceipt;
}

export type AgentBackupRestoreV3ValidatedCandidateContext =
  AgentBackupRestoreV3DeepReadonly<{
    authority: AgentBackupRestoreV3AuthorityFence;
    sourceAuthority: AgentBackupRestoreV3SourceAuthority;
    receipt: AgentBackupRestoreV3CandidateReceipt;
    binding: AgentBackupRestoreV3CandidateBinding;
  }>;

/**
 * Recomputes and joins the full manifest, catalogue inventory, exact GET
 * completions, and candidate receipt before any seal authorization is issued.
 */
export async function validateAgentBackupRestoreV3CandidateContext(
  input: Readonly<AgentBackupRestoreV3CandidateContextInput>,
): Promise<AgentBackupRestoreV3ValidatedCandidateContext> {
  const authority = parseAgentBackupRestoreV3AuthorityFence(input.authority);
  const manifest = await parseAgentBackupManifestV3(input.manifest);
  const sourceAuthority = parseAgentBackupRestoreV3SourceAuthority(
    input.sourceAuthority,
  );
  const receipt = parseAgentBackupRestoreV3CandidateReceipt(input.receipt);
  const exactReadProofs = freezeDeep(
    z
      .array(AgentBackupRestoreV3ExactReadReceiptProofSchema)
      .min(AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.length)
      .max(AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunks)
      .parse(input.exactReadProofs),
  );
  const sourceAuthoritySha256 =
    await computeAgentBackupRestoreV3SourceAuthoritySha256(sourceAuthority);

  if (
    manifest.chain.kind !== "full" ||
    manifest.components.length !==
      AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.length ||
    authority.organizationId !== manifest.identity.organizationId ||
    authority.agentId !== manifest.identity.agentId ||
    authority.operationId !== manifest.operationId ||
    authority.sourceActivationGeneration !==
      manifest.identity.activationGeneration ||
    authority.sourceLifecycleRevision !== manifest.identity.lifecycleRevision ||
    authority.expectedManifestSha256 !== manifest.integrity.manifestSha256 ||
    sourceAuthority.organizationId !== authority.organizationId ||
    sourceAuthority.agentId !== authority.agentId ||
    sourceAuthority.backupId !== authority.backupId ||
    sourceAuthority.operationId !== authority.operationId ||
    sourceAuthority.sourceActivationGeneration !==
      authority.sourceActivationGeneration ||
    sourceAuthority.sourceLifecycleRevision !==
      authority.sourceLifecycleRevision ||
    sourceAuthority.expectedManifestSha256 !==
      authority.expectedManifestSha256 ||
    sourceAuthority.copyRole !== authority.copyRole ||
    sourceAuthority.catalogEpoch !== authority.catalogEpoch ||
    receipt.restoreAttemptId !== authority.restoreAttemptId ||
    receipt.operationId !== authority.operationId ||
    receipt.expectedManifestSha256 !== authority.expectedManifestSha256 ||
    receipt.keyBundleGenerationId !==
      manifest.encryption.operationKeyBundle.generationId ||
    receipt.sourceCopyRole !== authority.copyRole ||
    receipt.sourceAuthoritySha256 !== sourceAuthoritySha256
  ) {
    throw new TypeError(
      "Restore candidate differs from its exact manifest or durable authority",
    );
  }

  const manifestSlots = manifest.components.flatMap(
    (component, componentIndex) => {
      const expectedName =
        AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS[componentIndex];
      if (
        component.name !== expectedName ||
        component.format !== AGENT_BACKUP_RECORD_STREAM_V1_FORMAT ||
        component.compression !== "none" ||
        component.state.kind !== "full" ||
        component.chunks.length === 0
      ) {
        throw new TypeError(
          "Restore candidate requires one exact full five-component manifest",
        );
      }
      const componentReceipt = receipt.components[componentIndex];
      if (
        !componentReceipt ||
        componentReceipt.recordStreamContentHmacSha256 !==
          component.payloadContentHmacSha256 ||
        component.state.resultContentHmacSha256 !==
          componentReceipt.recordStreamContentHmacSha256
      ) {
        throw new TypeError(
          "Restore component receipt differs from its authenticated manifest",
        );
      }
      return component.chunks.map((chunk) => ({
        componentIndex,
        componentName: expectedName,
        chunk,
      }));
    },
  );

  if (
    manifestSlots.length !== sourceAuthority.objects.length ||
    manifestSlots.length !== exactReadProofs.length ||
    manifestSlots.length !== receipt.sourceObjects.length ||
    manifestSlots.length !== receipt.objectCount
  ) {
    throw new TypeError(
      "Restore candidate object ledger is incomplete for its exact manifest",
    );
  }

  const exactReadReceiptSha256: string[] = [];
  for (
    let start = 0;
    start < exactReadProofs.length;
    start += AGENT_BACKUP_MANIFEST_V2_LIMITS.maxDigestConcurrency
  ) {
    exactReadReceiptSha256.push(
      ...(await Promise.all(
        exactReadProofs
          .slice(
            start,
            start + AGENT_BACKUP_MANIFEST_V2_LIMITS.maxDigestConcurrency,
          )
          .map((proof) =>
            computeAgentBackupRestoreV3ExactReadReceiptSha256(proof),
          ),
      )),
    );
  }

  for (const [index, slot] of manifestSlots.entries()) {
    const source = sourceAuthority.objects[index];
    const proof = exactReadProofs[index];
    const staged = receipt.sourceObjects[index];
    if (
      !source ||
      !proof ||
      !staged ||
      source.componentIndex !== slot.componentIndex ||
      source.componentName !== slot.componentName ||
      source.chunkIndex !== slot.chunk.index ||
      source.copyRole !== authority.copyRole ||
      source.contentHmacSha256 !== slot.chunk.contentHmacSha256 ||
      source.catalog.ciphertextSha256 !== slot.chunk.sha256 ||
      source.catalog.sizeBytes !== slot.chunk.encryptedBytes ||
      proof.sourceAuthoritySha256 !== sourceAuthoritySha256 ||
      proof.organizationId !== authority.organizationId ||
      proof.backupId !== authority.backupId ||
      proof.objectId !== source.objectId ||
      proof.componentIndex !== source.componentIndex ||
      proof.componentName !== source.componentName ||
      proof.chunkIndex !== source.chunkIndex ||
      proof.copyRole !== source.copyRole ||
      canonicalJson(proof.catalog) !== canonicalJson(source.catalog) ||
      proof.completion.checksumSha256Base64 !==
        sha256HexToBase64(source.catalog.ciphertextSha256) ||
      staged.componentIndex !== source.componentIndex ||
      staged.componentName !== source.componentName ||
      staged.chunkIndex !== source.chunkIndex ||
      staged.copyRole !== source.copyRole ||
      staged.objectId !== source.objectId ||
      staged.exactReadReceiptSha256 !== exactReadReceiptSha256[index] ||
      staged.ciphertextSha256 !== source.catalog.ciphertextSha256 ||
      staged.sizeBytes !== source.catalog.sizeBytes
    ) {
      throw new TypeError(
        `Restore candidate source slot ${index} differs from its exact proof`,
      );
    }
  }

  const candidateReceiptSha256 =
    await computeAgentBackupRestoreV3CandidateReceiptSha256(receipt);
  const binding = freezeDeep(
    AgentBackupRestoreV3CandidateBindingSchema.parse({
      restoreAttemptId: receipt.restoreAttemptId,
      operationId: receipt.operationId,
      expectedManifestSha256: receipt.expectedManifestSha256,
      keyBundleGenerationId: receipt.keyBundleGenerationId,
      sourceCopyRole: receipt.sourceCopyRole,
      sourceAuthoritySha256: receipt.sourceAuthoritySha256,
      objectCount: receipt.objectCount,
      candidateReceiptSha256,
    }),
  );
  return freezeDeep({ authority, sourceAuthority, receipt, binding });
}

/** Exact authority observed by the initial durable fence re-read. */
export interface AgentBackupRestoreV3AuthorityObservation {
  readonly current: true;
  readonly authority: AgentBackupRestoreV3AuthorityFence;
}

export const AgentBackupRestoreV3CandidateSealAuthorizationRequestSchema = z
  .strictObject({
    authority: AgentBackupRestoreV3AuthorityFenceSchema,
    sessionExecutionToken: BoundedOpaqueTextSchema,
    candidate: AgentBackupRestoreV3CandidateBindingSchema,
  })
  .superRefine((request, context) => {
    if (
      request.candidate.restoreAttemptId !==
        request.authority.restoreAttemptId ||
      request.candidate.operationId !== request.authority.operationId ||
      request.candidate.expectedManifestSha256 !==
        request.authority.expectedManifestSha256 ||
      request.candidate.sourceCopyRole !== request.authority.copyRole
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "Candidate binding differs from its durable authority",
      });
    }
  });

export const AgentBackupRestoreV3CandidateSealAuthorizationSchema =
  z.strictObject({
    current: z.literal(true),
    authority: AgentBackupRestoreV3AuthorityFenceSchema,
    authorizationId: UUIDSchema,
    sessionExecutionToken: BoundedOpaqueTextSchema,
    candidate: AgentBackupRestoreV3CandidateBindingSchema,
    expiresAtEpochMs: SafePositiveIntegerSchema,
    /** Bounded opaque secret authenticated and consumed only by the seal adapter. */
    proofToken: BoundedOpaqueTextSchema,
  });

export type AgentBackupRestoreV3CandidateSealAuthorizationRequest =
  AgentBackupRestoreV3DeepReadonly<
    z.infer<typeof AgentBackupRestoreV3CandidateSealAuthorizationRequestSchema>
  >;
export type AgentBackupRestoreV3CandidateSealAuthorization =
  AgentBackupRestoreV3DeepReadonly<
    z.infer<typeof AgentBackupRestoreV3CandidateSealAuthorizationSchema>
  >;

export function createAgentBackupRestoreV3CandidateSealAuthorizationRequest(
  validated: AgentBackupRestoreV3ValidatedCandidateContext,
  sessionExecutionToken: string,
): AgentBackupRestoreV3CandidateSealAuthorizationRequest {
  return parseAgentBackupRestoreV3CandidateSealAuthorizationRequest({
    authority: validated.authority,
    sessionExecutionToken,
    candidate: validated.binding,
  });
}

export function parseAgentBackupRestoreV3CandidateSealAuthorizationRequest(
  value: unknown,
): Readonly<AgentBackupRestoreV3CandidateSealAuthorizationRequest> {
  return freezeDeep(
    AgentBackupRestoreV3CandidateSealAuthorizationRequestSchema.parse(value),
  );
}

/** Canonical preimage retained only as a digest by the seal-authority repository. */
export function canonicalizeAgentBackupRestoreV3CandidateSealAuthorizationRequest(
  request: Readonly<AgentBackupRestoreV3CandidateSealAuthorizationRequest>,
): string {
  return canonicalJson(
    parseAgentBackupRestoreV3CandidateSealAuthorizationRequest(request),
  );
}

export async function computeAgentBackupRestoreV3CandidateSealAuthorizationRequestSha256(
  request: Readonly<AgentBackupRestoreV3CandidateSealAuthorizationRequest>,
): Promise<string> {
  return sha256Hex(
    canonicalizeAgentBackupRestoreV3CandidateSealAuthorizationRequest(request),
  );
}

export function parseAgentBackupRestoreV3CandidateSealAuthorization(
  value: unknown,
): Readonly<AgentBackupRestoreV3CandidateSealAuthorization> {
  return freezeDeep(
    AgentBackupRestoreV3CandidateSealAuthorizationSchema.parse(value),
  );
}

export function validateAgentBackupRestoreV3CandidateSealAuthorization(
  requestValue: unknown,
  authorizationValue: unknown,
  nowEpochMs: number,
): Readonly<AgentBackupRestoreV3CandidateSealAuthorization> {
  if (
    !Number.isSafeInteger(nowEpochMs) ||
    nowEpochMs < 0 ||
    Object.is(nowEpochMs, -0)
  ) {
    throw new TypeError(
      "Restore seal validation requires a canonical current time",
    );
  }
  const request =
    parseAgentBackupRestoreV3CandidateSealAuthorizationRequest(requestValue);
  const authorization =
    parseAgentBackupRestoreV3CandidateSealAuthorization(authorizationValue);
  if (
    canonicalJson(authorization.authority) !==
      canonicalJson(request.authority) ||
    authorization.sessionExecutionToken !== request.sessionExecutionToken ||
    canonicalJson(authorization.candidate) !==
      canonicalJson(request.candidate) ||
    authorization.expiresAtEpochMs <= nowEpochMs ||
    authorization.expiresAtEpochMs > request.authority.leaseExpiresAtEpochMs
  ) {
    throw new TypeError(
      "Restore candidate seal authorization differs from its exact request",
    );
  }
  return authorization;
}

export interface AgentBackupRestoreV3CandidateSealAuthority {
  /**
   * Issuance must transactionally lock/re-read the live lease, catalogue epoch,
   * exact source-authority digest, and active candidate execution. It may issue
   * only for the exact validated binding; a detached MAC is not authority.
   */
  authorize(
    request: AgentBackupRestoreV3CandidateSealAuthorizationRequest,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ):
    | AgentBackupRestoreV3CandidateSealAuthorization
    | Promise<AgentBackupRestoreV3CandidateSealAuthorization>;
}

export interface AgentBackupRestoreV3IsolatedCandidateStaging {
  /** Atomically claims the attempt and persists its cleanup outbox first. */
  begin(
    request: AgentBackupRestoreV3DeepReadonly<{
      authority: AgentBackupRestoreV3AuthorityFence;
      manifest: AgentBackupManifestV3;
    }>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ):
    | AgentBackupRestoreV3StagingSession
    | Promise<AgentBackupRestoreV3StagingSession>;
  /**
   * Exact retries return the deterministic non-secret record receipt. Before
   * its first yield, the adapter must synchronously copy every ephemeral field,
   * including `payload`, then atomically require this session's
   * `executionToken`, candidate state `active`, and component state `open`.
   * A stale, aborted, sealed, or closed-component call rejects without mutation.
   */
  stageRecord(
    session: Readonly<AgentBackupRestoreV3StagingSession>,
    record: Readonly<AgentBackupRestoreV3StagedRecord>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ):
    | AgentBackupRestoreV3StageRecordReceipt
    | Promise<AgentBackupRestoreV3StageRecordReceipt>;
  /**
   * Must decode/validate the staged component without publishing it. Before
   * its first yield, the adapter must synchronously copy the receipt, then
   * atomically require this session's `executionToken`, candidate state
   * `active`, and component state `open`. It may transition only that exact
   * component to finished; stale or closed calls reject without mutation.
   */
  finishComponent(
    session: Readonly<AgentBackupRestoreV3StagingSession>,
    receipt: Readonly<AgentBackupRestoreV3ComponentReceipt>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ):
    | AgentBackupRestoreV3ComponentReceipt
    | Promise<AgentBackupRestoreV3ComponentReceipt>;
  /**
   * Durable, idempotent candidate seal; it still cannot mutate live state. The
   * adapter must authenticate the opaque proof and atomically consume/persist
   * its token digest while CASing this exact execution from `active` to
   * `sealed`. In that same authoritative DB transaction it must lock/re-read
   * the exact live lease, catalogue fence, source-authority digest, candidate
   * binding, and unconsumed authorization. Alternatively, every authority
   * release, reassignment, and catalogue invalidation path must transactionally
   * revoke every active authorization. A stale authorization can never seal.
   *
   * Once the exact authorization and receipt were durably sealed, an exact
   * response-loss replay may return that identical persisted receipt even after
   * expiry or authority loss. This replay is strictly read-only: it performs no
   * transition and never rewrites or deletes the sealed candidate. Every
   * non-exact replay or other stale/closed call rejects without mutation.
   */
  seal(
    session: Readonly<AgentBackupRestoreV3StagingSession>,
    receipt: Readonly<AgentBackupRestoreV3CandidateReceipt>,
    authorization: Readonly<AgentBackupRestoreV3CandidateSealAuthorization>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ):
    | AgentBackupRestoreV3CandidateReceipt
    | Promise<AgentBackupRestoreV3CandidateReceipt>;
  /**
   * Fenced rollback. The adapter must atomically require this execution token
   * and CAS `active` to `aborted`. A stale execution or terminal candidate is
   * an acknowledged no-op and must never delete a newer retry or sealed state.
   */
  abort(
    session: Readonly<AgentBackupRestoreV3StagingSession>,
    reason: "staging-failed",
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): true | Promise<true>;
}
