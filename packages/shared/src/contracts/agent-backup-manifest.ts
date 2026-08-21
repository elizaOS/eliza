/**
 * Defines the provider-neutral, content-addressed manifest contract for
 * bounded v2 sandbox backups. It describes immutable encrypted chunks without
 * embedding payload bytes, storage keys, credentials, or KMS ciphertext.
 */

import z from "zod";

export const AGENT_BACKUP_MANIFEST_FORMAT = "elizaos.agent-backup" as const;
export const AGENT_BACKUP_MANIFEST_V2_SCHEMA_VERSION = 2 as const;
export const AGENT_BACKUP_CHUNK_AAD_DERIVATION =
  "elizaos.agent-backup.chunk-aad.v1" as const;
export const AGENT_BACKUP_PAYLOAD_DIGEST_DERIVATION =
  "elizaos.agent-backup.payload.v1" as const;
export const AGENT_BACKUP_DEK_CONTEXT_DERIVATION =
  "elizaos.agent-backup.dek-context.v1" as const;
export const AGENT_BACKUP_CONTENT_HMAC_DERIVATION =
  "elizaos.agent-backup.content-hmac.v1" as const;

/** Exact encrypted chunk layout: random nonce || ciphertext || auth tag. */
export const AGENT_BACKUP_CHUNK_ENVELOPE_V1 = Object.freeze({
  name: "aes-256-gcm-v1" as const,
  nonceBytes: 12 as const,
  tagBytes: 16 as const,
  noncePlacement: "prefix" as const,
  tagPlacement: "suffix" as const,
});

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Hard bounds; raising them requires every capture and restore lane to agree. */
export const AGENT_BACKUP_MANIFEST_V2_LIMITS = Object.freeze({
  maxPlainBytes: GIB,
  maxCompressedBytes: GIB + 64 * MIB,
  maxEncryptedBytes:
    GIB +
    64 * MIB +
    8192 *
      (AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes +
        AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes),
  maxChunkPlainBytes: 16 * MIB,
  maxChunkCompressedBytes: 17 * MIB,
  maxChunkEncryptedBytes:
    17 * MIB +
    AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes +
    AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes,
  maxChunksPerComponent: 4096,
  maxChunks: 8192,
  maxComponents: 64,
  maxPlugins: 256,
  maxWatermarks: 256,
  maxDeltaTombstones: 1_000_000,
  maxIncrementalDepth: 20,
  maxManifestBytes: 4 * MIB,
  maxManifestWireBytes: 4 * MIB,
  maxDigestConcurrency: 32,
  maxPlaintextFragmentsPerChunk: 65_536,
  maxChainPlainBytes: 4 * GIB,
  maxChainCompressedBytes: 5 * GIB,
  maxChainEncryptedBytes: 6 * GIB,
  maxChainChunks: 32_768,
  maxChainManifests: 21,
  maxChainManifestBytes: 32 * MIB,
  maxChainWrappedDekBytes: 21 * 16 * 1024,
  maxChainFragments: 1_000_000,
  maxWrappedDekBytes: 16 * 1024,
});

const REQUIRED_FULL_COMPONENTS = [
  "character",
  "database",
  "media",
  "state-files",
  "vault",
] as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/;
const COMPONENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const PLUGIN_ID_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const WATERMARK_NAMESPACE_PATTERN = /^[a-z][a-z0-9._:-]{0,127}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const ORG_DEK_KEY_ID_PATTERN = /^org:([A-Za-z0-9_.-]+)\/dek\/v([1-9][0-9]*)$/;
const ORG_CONTENT_HMAC_KEY_ID_PATTERN =
  /^org:([A-Za-z0-9_.-]+)\/backup-content\/v([1-9][0-9]*)$/;
const CANONICAL_UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const SafeNonNegativeIntegerSchema = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .refine((value) => !Object.is(value, -0), "Expected a canonical integer");
const SafePositiveIntegerSchema = z.number().int().safe().positive();
const CanonicalUint64StringSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/, "Expected a canonical uint64 decimal")
  .refine((value) => {
    if (!/^(?:0|[1-9][0-9]{0,19})$/.test(value)) return false;
    return BigInt(value) <= 18_446_744_073_709_551_615n;
  }, "Expected a uint64 decimal");
const CanonicalPositiveUint64StringSchema = CanonicalUint64StringSchema.refine(
  (value) => value !== "0",
  "Expected a positive uint64 decimal",
);
const Sha256Schema = z
  .string()
  .regex(SHA256_PATTERN, "Expected a lowercase sha256 hex digest");
const UuidSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase(), "UUID must be lowercase");
const OpaqueIdentifierSchema = z
  .string()
  .max(128)
  .regex(ID_PATTERN, "Expected a canonical identifier");
const VersionSchema = z
  .string()
  .max(128)
  .regex(VERSION_PATTERN, "Expected a canonical version");
const ComponentNameSchema = z.string().max(64).regex(COMPONENT_NAME_PATTERN);
const WatermarkNamespaceSchema = z
  .string()
  .max(128)
  .regex(WATERMARK_NAMESPACE_PATTERN);
const CanonicalTimestampSchema = z
  .string()
  .regex(
    CANONICAL_UTC_TIMESTAMP_PATTERN,
    "Expected an ISO-8601 UTC timestamp with milliseconds",
  )
  .refine((value) => {
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
  }, "Expected a real canonical UTC timestamp");

const ByteTotalsSchema = z.strictObject({
  plainBytes: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxPlainBytes,
  ),
  compressedBytes: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxCompressedBytes,
  ),
  encryptedBytes: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxEncryptedBytes,
  ),
  chunkCount: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunks,
  ),
});

const ChunkSchema = z.strictObject({
  index: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunksPerComponent - 1,
  ),
  offsetBytes: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxPlainBytes,
  ),
  plainBytes: SafePositiveIntegerSchema.max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkPlainBytes,
  ),
  compressedBytes: SafePositiveIntegerSchema.max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkCompressedBytes,
  ),
  encryptedBytes: SafePositiveIntegerSchema.max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkEncryptedBytes,
  ),
  /** Tenant-keyed content address; safe against cross-tenant hash probing. */
  contentHmacSha256: Sha256Schema,
  /** Hash of canonical AAD derived from immutable descriptor metadata. */
  aadSha256: Sha256Schema,
  /** Hash of the exact encrypted immutable chunk envelope. */
  sha256: Sha256Schema,
});

const FullComponentStateSchema = z.strictObject({
  kind: z.literal("full"),
  resultContentHmacSha256: Sha256Schema,
});

const DeltaComponentStateSchema = z.strictObject({
  kind: z.literal("delta"),
  baseContentHmacSha256: Sha256Schema,
  resultContentHmacSha256: Sha256Schema,
  tombstoneCount: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxDeltaTombstones,
  ),
  overlayOrder: z.literal("delete-then-upsert"),
});

const ComponentSchema = z.strictObject({
  name: ComponentNameSchema,
  format: VersionSchema,
  compression: z.enum(["none", "gzip", "zstd"]),
  /** Tenant-keyed digest of this operation's snapshot or encoded delta. */
  payloadContentHmacSha256: Sha256Schema,
  state: z.discriminatedUnion("kind", [
    FullComponentStateSchema,
    DeltaComponentStateSchema,
  ]),
  totals: ByteTotalsSchema,
  chunks: z
    .array(ChunkSchema)
    .max(AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunksPerComponent),
});

const PluginVersionSchema = z.strictObject({
  id: z
    .string()
    .max(214)
    .regex(PLUGIN_ID_PATTERN, "Expected a canonical npm plugin id"),
  version: VersionSchema,
});

const WatermarkSchema = z.strictObject({
  namespace: WatermarkNamespaceSchema,
  value: z
    .string()
    .min(1)
    .max(256)
    .regex(PRINTABLE_ASCII_PATTERN, "Watermarks must be printable ASCII")
    .refine(
      (value) => value.normalize("NFC") === value,
      "Watermark must use NFC normalization",
    ),
});

const DurableKmsProviderSchema = z.enum(["local", "steward"]);

const EncryptionSchema = z.strictObject({
  algorithm: z.literal("AES-256-GCM"),
  /** Fresh per-operation DEK generation identity, never a reusable KEK id. */
  dekGenerationId: UuidSchema,
  envelopeVersion: z.literal(1),
  chunkEnvelope: z.literal(AGENT_BACKUP_CHUNK_ENVELOPE_V1.name),
  nonceBytes: z.literal(AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes),
  tagBytes: z.literal(AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes),
  noncePlacement: z.literal(AGENT_BACKUP_CHUNK_ENVELOPE_V1.noncePlacement),
  tagPlacement: z.literal(AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagPlacement),
  aad: z.strictObject({
    version: z.literal(1),
    derivation: z.literal(AGENT_BACKUP_CHUNK_AAD_DERIVATION),
  }),
  kms: z.strictObject({
    /** `memory` and other ephemeral providers are unrepresentable. */
    provider: DurableKmsProviderSchema,
    /** Core KMS namespace: org:<organizationId>/dek/v<keyVersion>. */
    keyId: z.string().min(1).max(512).regex(ORG_DEK_KEY_ID_PATTERN),
    keyVersion: SafePositiveIntegerSchema,
  }),
  /** Per-operation DEK envelope stored outside the manifest payload. */
  wrappedDek: z.strictObject({
    format: z.literal("kms-aead-envelope-v1"),
    ref: z.string().min(1).max(512).regex(PRINTABLE_ASCII_PATTERN),
    bytes: SafePositiveIntegerSchema.max(
      AGENT_BACKUP_MANIFEST_V2_LIMITS.maxWrappedDekBytes,
    ),
    sha256: Sha256Schema,
    contextDerivation: z.literal(AGENT_BACKUP_DEK_CONTEXT_DERIVATION),
  }),
});

const SourceBaseShape = {
  provider: z.literal("hetzner"),
  /** UUID of the durable control-plane node ledger record. */
  nodeRecordId: UuidSchema,
  /** Exact Linux boot UUID attested through the node's pinned SSH identity. */
  nodeIncarnation: UuidSchema,
  /** Opaque Robot/Cloud runtime identifier. */
  nodeId: OpaqueIdentifierSchema,
  containerId: OpaqueIdentifierSchema,
} as const;

const RobotSourceSchema = z.strictObject({
  kind: z.literal("robot"),
  ...SourceBaseShape,
});

const CloudSourceSchema = z.strictObject({
  kind: z.literal("cloud"),
  ...SourceBaseShape,
  /** Canonical Hetzner Cloud server id, retained independently from nodeId. */
  providerServerId: CanonicalPositiveUint64StringSchema,
});

const SourceSchema = z.discriminatedUnion("kind", [
  RobotSourceSchema,
  CloudSourceSchema,
]);

const RuntimeSchema = z.strictObject({
  imageDigest: z.string().regex(IMAGE_DIGEST_PATTERN),
  agentSchemaVersion: VersionSchema,
  databaseSchemaVersion: VersionSchema,
  plugins: z
    .array(PluginVersionSchema)
    .max(AGENT_BACKUP_MANIFEST_V2_LIMITS.maxPlugins),
});

const FullChainSchema = z.strictObject({
  kind: z.literal("full"),
  baseOperationId: z.null(),
  parentOperationId: z.null(),
  depth: z.literal(0),
});

const IncrementalChainSchema = z.strictObject({
  kind: z.literal("incremental"),
  baseOperationId: UuidSchema,
  parentOperationId: UuidSchema,
  depth: SafePositiveIntegerSchema.max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxIncrementalDepth,
  ),
});

const ManifestCoreShape = {
  format: z.literal(AGENT_BACKUP_MANIFEST_FORMAT),
  schemaVersion: z.literal(AGENT_BACKUP_MANIFEST_V2_SCHEMA_VERSION),
  operationId: UuidSchema,
  createdAt: CanonicalTimestampSchema,
  identity: z.strictObject({
    organizationId: UuidSchema,
    agentId: UuidSchema,
    /** UUID of the activation/sandbox incarnation that produced the backup. */
    activationGeneration: UuidSchema,
    /** Monotone control-plane lifecycle revision at capture time. */
    lifecycleRevision: CanonicalUint64StringSchema,
  }),
  source: SourceSchema,
  runtime: RuntimeSchema,
  chain: z.discriminatedUnion("kind", [
    FullChainSchema,
    IncrementalChainSchema,
  ]),
  components: z
    .array(ComponentSchema)
    .min(1)
    .max(AGENT_BACKUP_MANIFEST_V2_LIMITS.maxComponents),
  watermarks: z
    .array(WatermarkSchema)
    .min(1)
    .max(AGENT_BACKUP_MANIFEST_V2_LIMITS.maxWatermarks),
  totals: ByteTotalsSchema,
  encryption: EncryptionSchema,
} as const;

const ManifestCoreSchema = z.strictObject(ManifestCoreShape);

const ManifestDraftIntegritySchema = z.strictObject({
  /** Tenant-keyed digest of framed payload bytes carried by this operation. */
  framedContentHmacSha256: Sha256Schema,
  contentAddressing: z.strictObject({
    algorithm: z.literal("HMAC-SHA-256"),
    scope: z.literal("organization"),
    derivation: z.literal(AGENT_BACKUP_CONTENT_HMAC_DERIVATION),
    keyId: z.string().min(1).max(512).regex(ORG_CONTENT_HMAC_KEY_ID_PATTERN),
    keyVersion: SafePositiveIntegerSchema,
  }),
});

const ManifestIntegritySchema = ManifestDraftIntegritySchema.extend({
  /** Hash of canonical metadata, excluding this field itself. */
  manifestSha256: Sha256Schema,
});

type ManifestCore = z.infer<typeof ManifestCoreSchema>;
type ManifestWithDraftIntegrity = ManifestCore & {
  integrity: z.infer<typeof ManifestDraftIntegritySchema>;
};

function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function isStrictlySorted(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) return false;
  }
  return true;
}

function safeSum(
  values: readonly number[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): number | null {
  let total = 0;
  for (const value of values) {
    if (total > Number.MAX_SAFE_INTEGER - value) {
      addIssue(
        context,
        path,
        "Byte accounting exceeds Number.MAX_SAFE_INTEGER",
      );
      return null;
    }
    total += value;
  }
  return total;
}

function validateManifestStructure(
  manifest: ManifestWithDraftIntegrity,
  context: z.RefinementCtx,
): void {
  const pluginIds = manifest.runtime.plugins.map((plugin) => plugin.id);
  if (!isStrictlySorted(pluginIds)) {
    addIssue(
      context,
      ["runtime", "plugins"],
      "Plugins must be unique and sorted by id",
    );
  }

  const componentNames = manifest.components.map((component) => component.name);
  if (!isStrictlySorted(componentNames)) {
    addIssue(
      context,
      ["components"],
      "Components must be unique and sorted by name",
    );
  }

  if (manifest.chain.kind === "full") {
    const componentSet = new Set(componentNames);
    for (const required of REQUIRED_FULL_COMPONENTS) {
      if (!componentSet.has(required)) {
        addIssue(
          context,
          ["components"],
          `Full backup is missing required component ${required}`,
        );
      }
    }
  } else {
    if (manifest.chain.baseOperationId === manifest.operationId) {
      addIssue(
        context,
        ["chain", "baseOperationId"],
        "Incremental backup cannot use itself as its base",
      );
    }
    if (manifest.chain.parentOperationId === manifest.operationId) {
      addIssue(
        context,
        ["chain", "parentOperationId"],
        "Incremental backup cannot use itself as its parent",
      );
    }
    if (
      manifest.chain.depth === 1 &&
      manifest.chain.parentOperationId !== manifest.chain.baseOperationId
    ) {
      addIssue(
        context,
        ["chain", "parentOperationId"],
        "Depth-1 incremental parent must equal its full base",
      );
    }
    if (
      manifest.chain.depth > 1 &&
      manifest.chain.parentOperationId === manifest.chain.baseOperationId
    ) {
      addIssue(
        context,
        ["chain", "parentOperationId"],
        "Depth greater than 1 must not skip directly to the full base",
      );
    }
  }

  const keyMatch = ORG_DEK_KEY_ID_PATTERN.exec(manifest.encryption.kms.keyId);
  const keyPrincipal = keyMatch?.[1];
  const keyVersion = keyMatch?.[2] ? Number(keyMatch[2]) : Number.NaN;
  if (keyPrincipal !== manifest.identity.organizationId) {
    addIssue(
      context,
      ["encryption", "kms", "keyId"],
      "Backup DEK must be scoped to identity.organizationId",
    );
  }
  if (
    !Number.isSafeInteger(keyVersion) ||
    keyVersion !== manifest.encryption.kms.keyVersion
  ) {
    addIssue(
      context,
      ["encryption", "kms", "keyVersion"],
      "KMS keyVersion must match the version embedded in keyId",
    );
  }
  if (
    manifest.encryption.wrappedDek.ref !== `backup-dek:${manifest.operationId}`
  ) {
    addIssue(
      context,
      ["encryption", "wrappedDek", "ref"],
      "Wrapped DEK reference must be unique to operationId",
    );
  }
  const contentKeyMatch = ORG_CONTENT_HMAC_KEY_ID_PATTERN.exec(
    manifest.integrity.contentAddressing.keyId,
  );
  if (contentKeyMatch?.[1] !== manifest.identity.organizationId) {
    addIssue(
      context,
      ["integrity", "contentAddressing", "keyId"],
      "Backup content HMAC key must be scoped to identity.organizationId",
    );
  }
  const contentKeyVersion = contentKeyMatch?.[2]
    ? Number(contentKeyMatch[2])
    : Number.NaN;
  if (
    !Number.isSafeInteger(contentKeyVersion) ||
    contentKeyVersion !== manifest.integrity.contentAddressing.keyVersion
  ) {
    addIssue(
      context,
      ["integrity", "contentAddressing", "keyVersion"],
      "Content HMAC keyVersion must match the version embedded in keyId",
    );
  }

  const watermarkNamespaces = manifest.watermarks.map(
    (watermark) => watermark.namespace,
  );
  if (!isStrictlySorted(watermarkNamespaces)) {
    addIssue(
      context,
      ["watermarks"],
      "Watermarks must be unique and sorted by namespace",
    );
  }

  for (const [componentIndex, component] of manifest.components.entries()) {
    if (manifest.chain.kind === "full" && component.state.kind !== "full") {
      addIssue(
        context,
        ["components", componentIndex, "state", "kind"],
        "Full manifests require full component snapshots",
      );
    }
    if (
      manifest.chain.kind === "incremental" &&
      component.state.kind !== "delta"
    ) {
      addIssue(
        context,
        ["components", componentIndex, "state", "kind"],
        "Incremental manifests carry delta-only component payloads",
      );
    }
    if (
      component.state.kind === "full" &&
      component.state.resultContentHmacSha256 !==
        component.payloadContentHmacSha256
    ) {
      addIssue(
        context,
        ["components", componentIndex, "state", "resultContentHmacSha256"],
        "Full component result content HMAC must equal its payload content HMAC",
      );
    }
    if (component.state.kind === "delta" && component.chunks.length === 0) {
      addIssue(
        context,
        ["components", componentIndex, "chunks"],
        "Delta components must encode tombstones/upserts in at least one chunk",
      );
    }
    let expectedOffset = 0;
    for (const [chunkIndex, chunk] of component.chunks.entries()) {
      if (chunk.index !== chunkIndex) {
        addIssue(
          context,
          ["components", componentIndex, "chunks", chunkIndex, "index"],
          `Chunk index must be contiguous; expected ${chunkIndex}`,
        );
      }
      if (chunk.offsetBytes !== expectedOffset) {
        addIssue(
          context,
          ["components", componentIndex, "chunks", chunkIndex, "offsetBytes"],
          `Chunk offset must be contiguous; expected ${expectedOffset}`,
        );
      }
      if (expectedOffset <= Number.MAX_SAFE_INTEGER - chunk.plainBytes) {
        expectedOffset += chunk.plainBytes;
      } else {
        addIssue(
          context,
          ["components", componentIndex, "chunks"],
          "Chunk offsets exceed Number.MAX_SAFE_INTEGER",
        );
      }
      if (
        component.compression === "none" &&
        chunk.compressedBytes !== chunk.plainBytes
      ) {
        addIssue(
          context,
          [
            "components",
            componentIndex,
            "chunks",
            chunkIndex,
            "compressedBytes",
          ],
          "Uncompressed chunks must preserve their plaintext byte length",
        );
      }
      const expectedEncryptedBytes =
        chunk.compressedBytes +
        AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes +
        AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes;
      if (chunk.encryptedBytes !== expectedEncryptedBytes) {
        addIssue(
          context,
          [
            "components",
            componentIndex,
            "chunks",
            chunkIndex,
            "encryptedBytes",
          ],
          `Encrypted byte length must include the ${AGENT_BACKUP_CHUNK_ENVELOPE_V1.name} nonce and tag; expected ${expectedEncryptedBytes}`,
        );
      }
    }

    const plainBytes = safeSum(
      component.chunks.map((chunk) => chunk.plainBytes),
      context,
      ["components", componentIndex, "totals", "plainBytes"],
    );
    const compressedBytes = safeSum(
      component.chunks.map((chunk) => chunk.compressedBytes),
      context,
      ["components", componentIndex, "totals", "compressedBytes"],
    );
    const encryptedBytes = safeSum(
      component.chunks.map((chunk) => chunk.encryptedBytes),
      context,
      ["components", componentIndex, "totals", "encryptedBytes"],
    );

    if (component.totals.chunkCount !== component.chunks.length) {
      addIssue(
        context,
        ["components", componentIndex, "totals", "chunkCount"],
        "Component chunkCount does not match its chunk descriptors",
      );
    }
    if (plainBytes !== null && component.totals.plainBytes !== plainBytes) {
      addIssue(
        context,
        ["components", componentIndex, "totals", "plainBytes"],
        "Component plainBytes does not match its chunks",
      );
    }
    if (
      compressedBytes !== null &&
      component.totals.compressedBytes !== compressedBytes
    ) {
      addIssue(
        context,
        ["components", componentIndex, "totals", "compressedBytes"],
        "Component compressedBytes does not match its chunks",
      );
    }
    if (
      encryptedBytes !== null &&
      component.totals.encryptedBytes !== encryptedBytes
    ) {
      addIssue(
        context,
        ["components", componentIndex, "totals", "encryptedBytes"],
        "Component encryptedBytes does not match its chunks",
      );
    }
  }

  const totalPlainBytes = safeSum(
    manifest.components.map((component) => component.totals.plainBytes),
    context,
    ["totals", "plainBytes"],
  );
  const totalCompressedBytes = safeSum(
    manifest.components.map((component) => component.totals.compressedBytes),
    context,
    ["totals", "compressedBytes"],
  );
  const totalEncryptedBytes = safeSum(
    manifest.components.map((component) => component.totals.encryptedBytes),
    context,
    ["totals", "encryptedBytes"],
  );
  const totalChunks = safeSum(
    manifest.components.map((component) => component.chunks.length),
    context,
    ["totals", "chunkCount"],
  );

  if (
    totalPlainBytes !== null &&
    manifest.totals.plainBytes !== totalPlainBytes
  ) {
    addIssue(
      context,
      ["totals", "plainBytes"],
      "Backup plainBytes does not match components",
    );
  }
  if (
    totalCompressedBytes !== null &&
    manifest.totals.compressedBytes !== totalCompressedBytes
  ) {
    addIssue(
      context,
      ["totals", "compressedBytes"],
      "Backup compressedBytes does not match components",
    );
  }
  if (
    totalEncryptedBytes !== null &&
    manifest.totals.encryptedBytes !== totalEncryptedBytes
  ) {
    addIssue(
      context,
      ["totals", "encryptedBytes"],
      "Backup encryptedBytes does not match components",
    );
  }
  if (totalChunks !== null && manifest.totals.chunkCount !== totalChunks) {
    addIssue(
      context,
      ["totals", "chunkCount"],
      "Backup chunkCount does not match components",
    );
  }
  if (
    totalChunks !== null &&
    totalChunks > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunks
  ) {
    addIssue(
      context,
      ["totals", "chunkCount"],
      `Backup exceeds the ${AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunks}-chunk limit`,
    );
  }
}

const AgentBackupManifestV2DraftSchema = z
  .strictObject({
    ...ManifestCoreShape,
    integrity: ManifestDraftIntegritySchema,
  })
  .superRefine(validateManifestStructure);

const AgentBackupManifestV2StructuralSchema = z
  .strictObject({ ...ManifestCoreShape, integrity: ManifestIntegritySchema })
  .superRefine(validateManifestStructure);

export type AgentBackupManifestV2Draft = z.infer<
  typeof AgentBackupManifestV2DraftSchema
>;
export type AgentBackupManifestV2 = z.infer<
  typeof AgentBackupManifestV2StructuralSchema
>;
export type AgentBackupManifestV2Chunk = z.infer<typeof ChunkSchema>;
export type AgentBackupManifestV2Component = z.infer<typeof ComponentSchema>;
export type AgentBackupManifestV2KmsProvider = z.infer<
  typeof DurableKmsProviderSchema
>;
export type AgentBackupManifestV2Source = ManifestCore["source"];
export type AgentBackupManifestV2Runtime = ManifestCore["runtime"];
export type AgentBackupManifestV2Watermark = z.infer<typeof WatermarkSchema>;

/**
 * Validate and normalize a v2 draft without sealing it. This is exported so a
 * future manifest version can reuse every common topology, accounting, and
 * ordering invariant without weakening or duplicating the v2 contract.
 */
export function parseAgentBackupManifestV2Draft(
  input: unknown,
): AgentBackupManifestV2Draft {
  return AgentBackupManifestV2DraftSchema.parse(input);
}

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

async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256Hex(value: string): Promise<string> {
  return sha256BytesHex(new TextEncoder().encode(value));
}

const AgentBackupChunkAadInputSchema = z.strictObject({
  identity: z.strictObject({
    organizationId: UuidSchema,
    agentId: UuidSchema,
    activationGeneration: UuidSchema,
    lifecycleRevision: CanonicalUint64StringSchema,
  }),
  operationId: UuidSchema,
  component: z.strictObject({
    name: ComponentNameSchema,
    format: VersionSchema,
    compression: z.enum(["none", "gzip", "zstd"]),
  }),
  chunk: z.strictObject({
    index: SafeNonNegativeIntegerSchema.max(
      AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunksPerComponent - 1,
    ),
    offsetBytes: SafeNonNegativeIntegerSchema.max(
      AGENT_BACKUP_MANIFEST_V2_LIMITS.maxPlainBytes,
    ),
    plainBytes: SafePositiveIntegerSchema.max(
      AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkPlainBytes,
    ),
    compressedBytes: SafePositiveIntegerSchema.max(
      AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkCompressedBytes,
    ),
    contentHmacSha256: Sha256Schema,
  }),
});

export type AgentBackupChunkAadInput = z.infer<
  typeof AgentBackupChunkAadInputSchema
>;

const AgentBackupDekContextInputSchema = z.strictObject({
  organizationId: UuidSchema,
  agentId: UuidSchema,
  activationGeneration: UuidSchema,
  lifecycleRevision: CanonicalUint64StringSchema,
  operationId: UuidSchema,
  dekGenerationId: UuidSchema,
  sourceKind: z.enum(["robot", "cloud"]),
  sourceProvider: z.literal("hetzner"),
  kmsProvider: DurableKmsProviderSchema,
  keyId: z.string().min(1).max(512).regex(ORG_DEK_KEY_ID_PATTERN),
  keyVersion: SafePositiveIntegerSchema,
});

export type AgentBackupDekContextInput = z.infer<
  typeof AgentBackupDekContextInputSchema
>;

/** Canonical KMS KEK context that binds one wrapped DEK to one operation. */
export function canonicalizeAgentBackupDekContext(
  input: AgentBackupDekContextInput,
): string {
  return canonicalJson({
    derivation: AGENT_BACKUP_DEK_CONTEXT_DERIVATION,
    ...AgentBackupDekContextInputSchema.parse(input),
  });
}

/**
 * Return normative AES-GCM AAD. It binds ciphertext to tenant, lifecycle,
 * operation, component and chunk position, so chunks cannot cross operations.
 */
export function canonicalizeAgentBackupChunkAad(
  input: AgentBackupChunkAadInput,
): string {
  const parsed = AgentBackupChunkAadInputSchema.parse(input);
  return canonicalJson({
    format: "elizaos.agent-backup.chunk-aad",
    version: 1,
    ...parsed,
  });
}

export async function computeAgentBackupChunkAadDigest(
  input: AgentBackupChunkAadInput,
): Promise<string> {
  return sha256Hex(canonicalizeAgentBackupChunkAad(input));
}

function chunkAadInput(
  manifest: ManifestCore,
  component: AgentBackupManifestV2Component,
  chunk: AgentBackupManifestV2Chunk,
): AgentBackupChunkAadInput {
  return {
    identity: manifest.identity,
    operationId: manifest.operationId,
    component: {
      name: component.name,
      format: component.format,
      compression: component.compression,
    },
    chunk: {
      index: chunk.index,
      offsetBytes: chunk.offsetBytes,
      plainBytes: chunk.plainBytes,
      compressedBytes: chunk.compressedBytes,
      contentHmacSha256: chunk.contentHmacSha256,
    },
  };
}

function dekContextInput(
  manifest: AgentBackupManifestV2,
): AgentBackupDekContextInput {
  return {
    organizationId: manifest.identity.organizationId,
    agentId: manifest.identity.agentId,
    activationGeneration: manifest.identity.activationGeneration,
    lifecycleRevision: manifest.identity.lifecycleRevision,
    operationId: manifest.operationId,
    dekGenerationId: manifest.encryption.dekGenerationId,
    sourceKind: manifest.source.kind,
    sourceProvider: manifest.source.provider,
    kmsProvider: manifest.encryption.kms.provider,
    keyId: manifest.encryption.kms.keyId,
    keyVersion: manifest.encryption.kms.keyVersion,
  };
}

function draftFromManifest(
  manifest: AgentBackupManifestV2,
): AgentBackupManifestV2Draft {
  const { manifestSha256: _manifestSha256, ...integrity } = manifest.integrity;
  return { ...manifest, integrity };
}

export function canonicalizeAgentBackupManifestV2(
  draft: AgentBackupManifestV2Draft,
): string {
  return canonicalJson(AgentBackupManifestV2DraftSchema.parse(draft));
}

export async function computeAgentBackupManifestV2Digest(
  draft: AgentBackupManifestV2Draft,
): Promise<string> {
  const canonical = canonicalizeAgentBackupManifestV2(draft);
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

function assertManifestCanonicalBytes(manifest: AgentBackupManifestV2): void {
  const byteLength = new TextEncoder().encode(
    canonicalJson(manifest),
  ).byteLength;
  if (byteLength > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxManifestBytes) {
    throw new RangeError(
      `Backup manifest exceeds ${AGENT_BACKUP_MANIFEST_V2_LIMITS.maxManifestBytes} bytes`,
    );
  }
}

async function verifyManifestSelfDigests(
  manifest: AgentBackupManifestV2,
  control?: Readonly<AgentBackupManifestV2OperationControl>,
): Promise<void> {
  assertManifestCanonicalBytes(manifest);

  // Global preflight occurs before any digest promises are created.
  const chunkCount = manifest.components.reduce(
    (total, component) => total + component.chunks.length,
    0,
  );
  if (chunkCount > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunks) {
    throw new RangeError(
      `Backup exceeds the ${AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunks}-chunk limit`,
    );
  }

  const entries = manifest.components.flatMap((component, componentIndex) =>
    component.chunks.map((chunk, chunkIndex) => ({
      component,
      componentIndex,
      chunk,
      chunkIndex,
    })),
  );
  const concurrency = AGENT_BACKUP_MANIFEST_V2_LIMITS.maxDigestConcurrency;
  for (let start = 0; start < entries.length; start += concurrency) {
    const batch = entries.slice(start, start + concurrency);
    const pendingDigests = Promise.all(
      batch.map(({ component, chunk }) =>
        computeAgentBackupChunkAadDigest(
          chunkAadInput(manifest, component, chunk),
        ),
      ),
    );
    const expectedDigests = control
      ? await awaitWithOperationControl(pendingDigests, control)
      : await pendingDigests;
    for (const [index, entry] of batch.entries()) {
      const expected = expectedDigests[index];
      if (entry.chunk.aadSha256 !== expected) {
        throw new Error(
          `Chunk AAD digest mismatch at components[${entry.componentIndex}].chunks[${entry.chunkIndex}]`,
        );
      }
    }
  }

  const pendingManifestSha256 = computeAgentBackupManifestV2Digest(
    draftFromManifest(manifest),
  );
  const expectedManifestSha256 = control
    ? await awaitWithOperationControl(pendingManifestSha256, control)
    : await pendingManifestSha256;
  if (manifest.integrity.manifestSha256 !== expectedManifestSha256) {
    throw new Error("Canonical manifest digest mismatch");
  }
}

/**
 * Seal a v2 manifest. Only durable core KMS provider names are accepted;
 * `memory`, `ephemeral`, and arbitrary provider names are rejected.
 */
export async function createAgentBackupManifestV2(
  draft: AgentBackupManifestV2Draft,
): Promise<AgentBackupManifestV2> {
  const parsed = AgentBackupManifestV2DraftSchema.parse(draft);
  const manifest = AgentBackupManifestV2StructuralSchema.parse({
    ...parsed,
    integrity: {
      ...parsed.integrity,
      manifestSha256: await computeAgentBackupManifestV2Digest(parsed),
    },
  });
  await verifyManifestSelfDigests(manifest);
  return manifest;
}

/**
 * Validate self-consistent v2 metadata. This recomputes AAD and the embedded
 * digest, but does NOT authenticate it: an attacker replacing metadata can
 * recompute both. This object API is for already-decoded internal values; every
 * external JSON boundary MUST use `parseAgentBackupManifestV2Json` so the wire
 * cap is enforced before `JSON.parse`. Restore must then use trusted authority.
 */
export async function parseAgentBackupManifestV2(
  input: unknown,
): Promise<AgentBackupManifestV2> {
  const manifest = AgentBackupManifestV2StructuralSchema.parse(input);
  await verifyManifestSelfDigests(manifest);
  return manifest;
}

async function parseAgentBackupManifestV2WithControl(
  input: unknown,
  control: Readonly<AgentBackupManifestV2OperationControl>,
): Promise<AgentBackupManifestV2> {
  assertOperationActive(control);
  const manifest = AgentBackupManifestV2StructuralSchema.parse(input);
  await verifyManifestSelfDigests(manifest, control);
  assertOperationActive(control);
  return manifest;
}

/** Enforce the public UTF-8 wire cap before allocation-heavy JSON parsing. */
export function assertAgentBackupManifestV2WireBytes(byteLength: number): void {
  SafeNonNegativeIntegerSchema.parse(byteLength);
  if (byteLength > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxManifestWireBytes) {
    throw new RangeError(
      `Backup manifest wire payload exceeds ${AGENT_BACKUP_MANIFEST_V2_LIMITS.maxManifestWireBytes} bytes`,
    );
  }
}

export interface AgentBackupManifestV2WireIngressBudget {
  /** Account a non-empty transport fragment before retaining it in memory. */
  acceptFragment(byteLength: number): number;
  /** Require the streamed length to match the declared Content-Length, if any. */
  finish(): number;
}

/**
 * HTTP/body adapters MUST create this guard from a parsed Content-Length before
 * reading the body, then account each non-empty fragment before buffering it.
 * This is the transport seam that enforces the wire cap before JSON parsing.
 */
export function createAgentBackupManifestV2WireIngressBudget(
  declaredContentLength?: number,
): AgentBackupManifestV2WireIngressBudget {
  if (declaredContentLength !== undefined) {
    assertAgentBackupManifestV2WireBytes(declaredContentLength);
  }
  let receivedBytes = 0;
  return Object.freeze({
    acceptFragment(byteLength: number): number {
      SafePositiveIntegerSchema.parse(byteLength);
      if (receivedBytes > Number.MAX_SAFE_INTEGER - byteLength) {
        throw new RangeError("Backup manifest wire byte count overflowed");
      }
      receivedBytes += byteLength;
      assertAgentBackupManifestV2WireBytes(receivedBytes);
      return receivedBytes;
    },
    finish(): number {
      if (
        declaredContentLength !== undefined &&
        receivedBytes !== declaredContentLength
      ) {
        throw new Error("Backup manifest Content-Length mismatch");
      }
      return receivedBytes;
    },
  });
}

export async function parseAgentBackupManifestV2Json(
  json: string,
): Promise<AgentBackupManifestV2> {
  assertAgentBackupManifestV2WireBytes(
    new TextEncoder().encode(json).byteLength,
  );
  return parseAgentBackupManifestV2(JSON.parse(json));
}

interface AgentBackupManifestV2WireReader {
  read():
    | { done: boolean; value?: Uint8Array }
    | Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(reason?: unknown): void | Promise<void>;
  releaseLock?(): void;
}

export type AgentBackupManifestV2WireSource =
  | Iterable<Uint8Array>
  | AsyncIterable<Uint8Array>
  | { getReader(): AgentBackupManifestV2WireReader };

function getManifestWireIterator(
  source: AgentBackupManifestV2WireSource,
): Iterator<Uint8Array> | AsyncIterator<Uint8Array> {
  if (
    typeof source === "object" &&
    source !== null &&
    "getReader" in source &&
    typeof source.getReader === "function"
  ) {
    const reader = source.getReader();
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        reader.releaseLock?.();
      }
    };
    return {
      async next(): Promise<IteratorResult<Uint8Array>> {
        const step = await reader.read();
        if (step.done) {
          release();
          return { done: true, value: undefined };
        }
        return { done: false, value: step.value as Uint8Array };
      },
      async return(): Promise<IteratorResult<Uint8Array>> {
        try {
          await reader.cancel?.("backup manifest ingestion stopped");
        } finally {
          release();
        }
        return { done: true, value: undefined };
      },
    };
  }
  return getByteIterator(
    source as Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  );
}

/**
 * Consume an HTTP/body byte stream under the wire cap before UTF-8 decoding or
 * JSON allocation. The iterator/reader is cancelled on overflow or parse error.
 */
export async function parseAgentBackupManifestV2JsonStream(
  source: AgentBackupManifestV2WireSource,
  declaredContentLength?: number,
): Promise<AgentBackupManifestV2> {
  const budget = createAgentBackupManifestV2WireIngressBudget(
    declaredContentLength,
  );
  const iterator = getManifestWireIterator(source);
  const fragments: Uint8Array[] = [];
  let completed = false;
  try {
    while (true) {
      const step = await iterator.next();
      if (!step || typeof step !== "object") {
        throw new TypeError("Backup manifest source returned an invalid step");
      }
      if (step.done) {
        completed = true;
        break;
      }
      if (!(step.value instanceof Uint8Array)) {
        throw new TypeError(
          "Backup manifest source must yield Uint8Array bytes",
        );
      }
      if (step.value.byteLength === 0) {
        throw new Error("Backup manifest source yielded an empty fragment");
      }
      budget.acceptFragment(step.value.byteLength);
      fragments.push(Uint8Array.from(step.value));
    }
    const byteLength = budget.finish();
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const fragment of fragments) {
      bytes.set(fragment, offset);
      offset += fragment.byteLength;
    }
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return await parseAgentBackupManifestV2(JSON.parse(json));
  } finally {
    if (!completed && typeof iterator.return === "function") {
      try {
        await iterator.return();
      } catch {
        // error-policy:J6 the primary wire validation failure is authoritative;
        // the transport already lost ownership when cancellation also failed.
      }
    }
  }
}

export interface AgentBackupManifestV2ComponentCapability {
  fullFormats: readonly string[];
  /** Empty means this restore lane does not implement delta decoding. */
  deltaFormats: readonly string[];
}

export interface AgentBackupManifestV2RestoreCapabilities {
  components: Readonly<
    Record<string, AgentBackupManifestV2ComponentCapability>
  >;
  /** Validators/decoders for every accepted watermark namespace. */
  watermarks: Readonly<Record<string, AgentBackupManifestV2WatermarkValidator>>;
  /** Non-empty subset required on every manifest in a restore chain. */
  requiredWatermarkNamespaces: readonly string[];
  /** Local root keys are permitted only in disposable development lanes. */
  environment: "development" | "staging" | "production";
  kmsProviders: readonly AgentBackupManifestV2KmsProvider[];
}

export interface AgentBackupManifestV2WatermarkContext {
  manifest: AgentBackupManifestV2;
  /** Value on the preceding manifest, or undefined at the full base. */
  previousValue: string | undefined;
  /** Trusted control-plane ledger floor for this exact manifest. */
  minimumValue: string | undefined;
}

export type AgentBackupManifestV2WatermarkValidator = (
  value: string,
  context: AgentBackupManifestV2WatermarkContext,
) => boolean | Promise<boolean>;

export interface AgentBackupManifestV2CatalogRecord {
  manifest: unknown;
  /** Trusted catalog digest, never copied from the untrusted manifest. */
  expectedManifestSha256: string;
  expectedSource: AgentBackupManifestV2Source;
  expectedRuntime: AgentBackupManifestV2Runtime;
  /** Trusted ledger floors interpreted by registered watermark validators. */
  minimumWatermarks: readonly AgentBackupManifestV2Watermark[];
}

export interface AgentBackupManifestV2OperationControl {
  /** Cooperative cancellation propagated to every external callback. */
  signal?: AbortSignal;
  /** Absolute Unix epoch milliseconds; operations fail closed after it. */
  deadlineEpochMs: number;
}

export type AgentBackupManifestV2CatalogResolver = (
  operationId: string,
  control: Readonly<AgentBackupManifestV2OperationControl>,
) =>
  | AgentBackupManifestV2CatalogRecord
  | null
  | Promise<AgentBackupManifestV2CatalogRecord | null>;

export interface AgentBackupManifestV2RestoreLease {
  /** Durable restore lease row identity. */
  leaseId: string;
  /** Monotone/unique CAS fence issued when the lease is acquired or renewed. */
  fencingToken: string;
  /** Per-agent catalog revision observed while authorizing this restore. */
  catalogEpoch: string;
  /** Database-clock expiry, never a worker-local estimate. */
  expiresAt: string;
}

export interface AgentBackupManifestV2CommitAuthority {
  readonly restoreLease: AgentBackupManifestV2RestoreLease;
  /** Fresh authoritative database time used to reject an expired lease. */
  readonly trustedNow: string;
}

export interface AgentBackupManifestV2CommitAuthorityRequest {
  readonly restoreAttemptId: string;
  readonly organizationId: string;
  readonly agentId: string;
  readonly activationGeneration: string;
  readonly lifecycleRevision: string;
  readonly operationId: string;
  readonly expectedManifestSha256: string;
  /** Full base→target catalog vector that the resolver must re-read atomically. */
  readonly expectedChain: readonly {
    readonly operationId: string;
    readonly expectedManifestSha256: string;
  }[];
  readonly expectedRestoreLease: AgentBackupManifestV2RestoreLease;
}

export type AgentBackupManifestV2CommitAuthorityResolver = (
  request: AgentBackupManifestV2CommitAuthorityRequest,
  control: Readonly<AgentBackupManifestV2OperationControl>,
) =>
  | AgentBackupManifestV2CommitAuthority
  | null
  | Promise<AgentBackupManifestV2CommitAuthority | null>;

export interface AgentBackupManifestV2RestoreAuthority {
  organizationId: string;
  agentId: string;
  activationGeneration: string;
  lifecycleRevision: string;
  operationId: string;
  expectedManifestSha256: string;
  expectedSource: AgentBackupManifestV2Source;
  expectedRuntime: AgentBackupManifestV2Runtime;
  minimumWatermarks: readonly AgentBackupManifestV2Watermark[];
  clock: {
    trustedNow: string;
    maxFutureSkewMs: number;
  };
  restoreLease: AgentBackupManifestV2RestoreLease;
  control: AgentBackupManifestV2OperationControl;
  resolveCatalogManifest: AgentBackupManifestV2CatalogResolver;
  /** Re-reads lease and catalog fencing authority immediately before commit. */
  resolveCommitAuthority: AgentBackupManifestV2CommitAuthorityResolver;
  capabilities: AgentBackupManifestV2RestoreCapabilities;
}

export interface VerifiedAgentBackupManifestV2ChainEntry {
  readonly manifest: AgentBackupManifestV2;
  readonly expectedManifestSha256: string;
  readonly expectedSource: AgentBackupManifestV2Source;
  readonly expectedRuntime: AgentBackupManifestV2Runtime;
  readonly minimumWatermarks: readonly AgentBackupManifestV2Watermark[];
}

export interface VerifiedAgentBackupManifestV2Restore {
  /** The requested manifest; identical to the last manifest in `chain`. */
  readonly manifest: AgentBackupManifestV2;
  /** Authenticated, immutable full-base→target chain safe from re-resolution. */
  readonly chain: readonly VerifiedAgentBackupManifestV2ChainEntry[];
  /** Immutable lease/catalog fence that must still match at atomic commit. */
  readonly restoreLease: AgentBackupManifestV2RestoreLease;
}

const RestoreLeaseSchema = z.strictObject({
  leaseId: UuidSchema,
  fencingToken: UuidSchema,
  catalogEpoch: CanonicalUint64StringSchema,
  expiresAt: CanonicalTimestampSchema,
});

const CommitAuthoritySchema = z.strictObject({
  restoreLease: RestoreLeaseSchema,
  trustedNow: CanonicalTimestampSchema,
});

const RestoreAuthorityScalarsSchema = z.strictObject({
  organizationId: UuidSchema,
  agentId: UuidSchema,
  activationGeneration: UuidSchema,
  lifecycleRevision: CanonicalUint64StringSchema,
  operationId: UuidSchema,
  expectedManifestSha256: Sha256Schema,
  expectedSource: SourceSchema,
  expectedRuntime: RuntimeSchema,
  minimumWatermarks: z
    .array(WatermarkSchema)
    .min(1)
    .max(AGENT_BACKUP_MANIFEST_V2_LIMITS.maxWatermarks),
  clock: z.strictObject({
    trustedNow: CanonicalTimestampSchema,
    maxFutureSkewMs: SafeNonNegativeIntegerSchema.max(5 * 60 * 1000),
  }),
  restoreLease: RestoreLeaseSchema,
  control: z.strictObject({
    deadlineEpochMs: SafePositiveIntegerSchema,
  }),
});

const CatalogRecordSchema = z.strictObject({
  manifest: z.unknown(),
  expectedManifestSha256: Sha256Schema,
  expectedSource: SourceSchema,
  expectedRuntime: RuntimeSchema,
  minimumWatermarks: z
    .array(WatermarkSchema)
    .min(1)
    .max(AGENT_BACKUP_MANIFEST_V2_LIMITS.maxWatermarks),
});

function operationControlError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function assertOperationActive(
  control: Readonly<AgentBackupManifestV2OperationControl>,
): void {
  if (control.signal?.aborted) {
    throw operationControlError("Backup operation was cancelled");
  }
  if (Date.now() >= control.deadlineEpochMs) {
    throw operationControlError("Backup operation deadline exceeded");
  }
}

async function awaitWithOperationControl<T>(
  value: T | PromiseLike<T>,
  control: Readonly<AgentBackupManifestV2OperationControl>,
  onLateFulfilled?: (value: T) => void,
): Promise<T> {
  let interruptedOperation = false;
  const observedValue = Promise.resolve(value).then((resolved) => {
    if (interruptedOperation) onLateFulfilled?.(resolved);
    return resolved;
  });
  try {
    assertOperationActive(control);
  } catch (cause) {
    interruptedOperation = true;
    // error-policy:J5 cancellation is already returned to the caller; this
    // observer still handles a provider promise that rejects after the check.
    void observedValue.catch((_lateFailure: unknown) => undefined);
    throw cause;
  }
  const remainingMs = control.deadlineEpochMs - Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => {
        interruptedOperation = true;
        reject(operationControlError("Backup operation deadline exceeded"));
      },
      Math.min(remainingMs, 2_147_483_647),
    );
    if (control.signal) {
      abortListener = () => {
        interruptedOperation = true;
        reject(operationControlError("Backup operation was cancelled"));
      };
      control.signal.addEventListener("abort", abortListener, { once: true });
    }
  });
  try {
    // error-policy:J3 interruption is raced with the external operation and the
    // finally block only releases timer/listener resources before propagation.
    return await Promise.race([observedValue, interrupted]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (control.signal && abortListener) {
      control.signal.removeEventListener("abort", abortListener);
    }
  }
}

function isOperationControlError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

async function callWithOperationControl<T>(
  callback: () => T | PromiseLike<T>,
  control: Readonly<AgentBackupManifestV2OperationControl>,
  onLateFulfilled?: (value: T) => void,
): Promise<T> {
  assertOperationActive(control);
  return awaitWithOperationControl(callback(), control, onLateFulfilled);
}

async function callProviderWithOperationControl<T>(
  label: string,
  callback: () => T | PromiseLike<T>,
  control: Readonly<AgentBackupManifestV2OperationControl>,
  onLateFulfilled?: (value: T) => void,
): Promise<T> {
  try {
    return await callWithOperationControl(callback, control, onLateFulfilled);
  } catch (cause) {
    if (isOperationControlError(cause)) throw cause;
    // Provider errors are deliberately not attached as `cause`: callbacks can
    // contain object keys, credentials, signed URLs, or plaintext fragments.
    throw new Error(`${label} failed`);
  }
}

function assertCanonicalUniqueList(
  values: readonly string[],
  label: string,
  schema: z.ZodType<string>,
  allowEmpty = false,
): void {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    throw new TypeError(`${label} must be a non-empty canonical allowlist`);
  }
  for (const value of values) schema.parse(value);
  if (!isStrictlySorted(values)) {
    throw new TypeError(`${label} must be unique and sorted`);
  }
}

function validateRestoreCapabilities(
  capabilities: AgentBackupManifestV2RestoreCapabilities,
): void {
  if (
    !isJsonRecord(capabilities) ||
    !isJsonRecord(capabilities.components) ||
    !isJsonRecord(capabilities.watermarks)
  ) {
    throw new TypeError("Restore capabilities must define component formats");
  }
  const componentNames = Object.keys(capabilities.components);
  assertCanonicalUniqueList(
    componentNames,
    "Capability component names",
    ComponentNameSchema,
  );
  for (const name of componentNames) {
    const capability = capabilities.components[name];
    if (!isJsonRecord(capability)) {
      throw new TypeError(`Capability for ${name} must be an object`);
    }
    assertCanonicalUniqueList(
      capability.fullFormats,
      `Full formats for ${name}`,
      VersionSchema,
    );
    assertCanonicalUniqueList(
      capability.deltaFormats,
      `Delta formats for ${name}`,
      VersionSchema,
      true,
    );
  }
  const watermarkNamespaces = Object.keys(capabilities.watermarks);
  assertCanonicalUniqueList(
    watermarkNamespaces,
    "Supported watermark namespaces",
    WatermarkNamespaceSchema,
  );
  for (const namespace of watermarkNamespaces) {
    if (typeof capabilities.watermarks[namespace] !== "function") {
      throw new TypeError(
        `Watermark namespace ${namespace} requires a validator/decoder`,
      );
    }
  }
  assertCanonicalUniqueList(
    capabilities.requiredWatermarkNamespaces,
    "Required watermark namespaces",
    WatermarkNamespaceSchema,
  );
  const supportedWatermarks = new Set(watermarkNamespaces);
  for (const required of capabilities.requiredWatermarkNamespaces) {
    if (!supportedWatermarks.has(required)) {
      throw new TypeError(
        `Required watermark namespace ${required} is not supported`,
      );
    }
  }
  if (
    !Array.isArray(capabilities.kmsProviders) ||
    capabilities.kmsProviders.length === 0
  ) {
    throw new TypeError("KMS providers must be a non-empty allowlist");
  }
  const providers = capabilities.kmsProviders.map((provider) =>
    DurableKmsProviderSchema.parse(provider),
  );
  if (!isStrictlySorted(providers)) {
    throw new TypeError("KMS providers must be unique and sorted");
  }
  const environment = z
    .enum(["development", "staging", "production"])
    .parse(capabilities.environment);
  if (environment !== "development" && providers.includes("local")) {
    throw new TypeError(
      "Local KMS requires a disposable development capability policy",
    );
  }
}

function snapshotRestoreCapabilities(
  capabilities: AgentBackupManifestV2RestoreCapabilities,
): AgentBackupManifestV2RestoreCapabilities {
  validateRestoreCapabilities(capabilities);
  const components = Object.fromEntries(
    Object.keys(capabilities.components).map((name) => {
      const capability = capabilities.components[name];
      return [
        name,
        Object.freeze({
          fullFormats: Object.freeze([...capability.fullFormats]),
          deltaFormats: Object.freeze([...capability.deltaFormats]),
        }),
      ];
    }),
  );
  const watermarks = Object.fromEntries(
    Object.keys(capabilities.watermarks).map((namespace) => [
      namespace,
      capabilities.watermarks[namespace],
    ]),
  );
  return Object.freeze({
    components: Object.freeze(components),
    watermarks: Object.freeze(watermarks),
    requiredWatermarkNamespaces: Object.freeze([
      ...capabilities.requiredWatermarkNamespaces,
    ]),
    environment: capabilities.environment,
    kmsProviders: Object.freeze([...capabilities.kmsProviders]),
  });
}

function assertManifestCapabilities(
  manifest: AgentBackupManifestV2,
  capabilities: AgentBackupManifestV2RestoreCapabilities,
): void {
  if (
    manifest.source.kind === "cloud" &&
    manifest.encryption.kms.provider === "local"
  ) {
    throw new Error("Cloud restores require a remote durable KMS provider");
  }
  if (!capabilities.kmsProviders.includes(manifest.encryption.kms.provider)) {
    throw new Error(
      `Restore does not allow KMS provider ${manifest.encryption.kms.provider}`,
    );
  }
  for (const component of manifest.components) {
    const capability = capabilities.components[component.name];
    if (!capability) {
      throw new Error(
        `Restore has no registered capability for component ${component.name}`,
      );
    }
    const formats =
      component.state.kind === "full"
        ? capability.fullFormats
        : capability.deltaFormats;
    if (!formats.includes(component.format)) {
      throw new Error(
        `Restore does not support ${component.state.kind} format ${component.format} for ${component.name}`,
      );
    }
  }

  const supportedWatermarks = new Set(Object.keys(capabilities.watermarks));
  const actualWatermarks = new Set(
    manifest.watermarks.map((watermark) => watermark.namespace),
  );
  for (const namespace of actualWatermarks) {
    if (!supportedWatermarks.has(namespace)) {
      throw new Error(
        `Restore does not support watermark namespace ${namespace}`,
      );
    }
  }
  for (const required of capabilities.requiredWatermarkNamespaces) {
    if (!actualWatermarks.has(required)) {
      throw new Error(`Restore requires watermark namespace ${required}`);
    }
  }
}

function assertTrustedManifestIdentity(
  manifest: AgentBackupManifestV2,
  expected: {
    organizationId: string;
    agentId: string;
    activationGeneration: string;
    lifecycleRevision: string;
  },
): void {
  if (manifest.identity.organizationId !== expected.organizationId) {
    throw new Error("Backup belongs to another organization");
  }
  if (manifest.identity.agentId !== expected.agentId) {
    throw new Error("Backup belongs to another agent");
  }
  if (
    manifest.identity.activationGeneration !== expected.activationGeneration
  ) {
    throw new Error("Backup belongs to another activation generation");
  }
  if (manifest.identity.lifecycleRevision !== expected.lifecycleRevision) {
    throw new Error("Backup belongs to another lifecycle revision");
  }
}

function assertOperationDigestAuthority(
  manifest: AgentBackupManifestV2,
  operationId: string,
  expectedManifestSha256: string,
): void {
  if (manifest.operationId !== operationId) {
    throw new Error("Backup operation id does not match trusted authority");
  }
  if (manifest.integrity.manifestSha256 !== expectedManifestSha256) {
    throw new Error("Backup manifest digest does not match trusted authority");
  }
}

function assertManifestLedgerExpectations(
  manifest: AgentBackupManifestV2,
  expected: {
    expectedSource: AgentBackupManifestV2Source;
    expectedRuntime: AgentBackupManifestV2Runtime;
    minimumWatermarks: readonly AgentBackupManifestV2Watermark[];
  },
): void {
  if (
    canonicalJson(manifest.source) !== canonicalJson(expected.expectedSource)
  ) {
    throw new Error(
      "Backup source provenance does not match trusted authority",
    );
  }
  if (
    canonicalJson(manifest.runtime) !== canonicalJson(expected.expectedRuntime)
  ) {
    throw new Error("Backup runtime does not match trusted authority");
  }
  const minimumNamespaces = expected.minimumWatermarks.map(
    (watermark) => watermark.namespace,
  );
  if (!isStrictlySorted(minimumNamespaces)) {
    throw new TypeError("Trusted minimum watermarks must be unique and sorted");
  }
  const manifestNamespaces = new Set(
    manifest.watermarks.map((watermark) => watermark.namespace),
  );
  for (const namespace of minimumNamespaces) {
    if (!manifestNamespaces.has(namespace)) {
      throw new Error("Backup is missing a trusted ledger watermark");
    }
  }
}

function assertManifestClockAuthority(
  manifest: AgentBackupManifestV2,
  clock: { trustedNow: string; maxFutureSkewMs: number },
): void {
  if (
    Date.parse(manifest.createdAt) >
    Date.parse(clock.trustedNow) + clock.maxFutureSkewMs
  ) {
    throw new Error("Backup timestamp exceeds trusted clock skew");
  }
}

function assertRestoreLeaseActive(
  restoreLease: AgentBackupManifestV2RestoreLease,
  trustedNow: string,
): void {
  if (Date.parse(restoreLease.expiresAt) <= Date.parse(trustedNow)) {
    throw new Error("Backup restore lease is expired");
  }
}

function assertSameRestoreLease(
  actual: AgentBackupManifestV2RestoreLease,
  expected: AgentBackupManifestV2RestoreLease,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("Backup restore lease or catalog epoch changed");
  }
}

async function resolveManifestChain(
  current: AgentBackupManifestV2,
  authority: AgentBackupManifestV2RestoreAuthority,
): Promise<VerifiedAgentBackupManifestV2ChainEntry[]> {
  const newestToOldest: VerifiedAgentBackupManifestV2ChainEntry[] = [
    {
      manifest: current,
      expectedManifestSha256: authority.expectedManifestSha256,
      expectedSource: authority.expectedSource,
      expectedRuntime: authority.expectedRuntime,
      minimumWatermarks: authority.minimumWatermarks,
    },
  ];
  const seen = new Set([current.operationId]);
  let child = current;

  while (child.chain.kind === "incremental") {
    assertOperationActive(authority.control);
    const parentOperationId = child.chain.parentOperationId;
    if (seen.has(parentOperationId)) {
      throw new Error("Incremental backup catalog contains a cycle");
    }
    seen.add(parentOperationId);
    const recordInput = await callProviderWithOperationControl(
      "Backup catalog manifest resolution",
      () =>
        authority.resolveCatalogManifest(parentOperationId, authority.control),
      authority.control,
    );
    if (recordInput === null) {
      throw new Error("Incremental parent is missing from the trusted catalog");
    }
    const record = CatalogRecordSchema.parse(recordInput);
    const parent = await parseAgentBackupManifestV2WithControl(
      record.manifest,
      authority.control,
    );
    assertTrustedManifestIdentity(parent, authority);
    assertOperationDigestAuthority(
      parent,
      parentOperationId,
      record.expectedManifestSha256,
    );
    assertManifestLedgerExpectations(parent, record);
    assertManifestClockAuthority(parent, authority.clock);
    assertManifestCapabilities(parent, authority.capabilities);
    if (Date.parse(parent.createdAt) > Date.parse(child.createdAt)) {
      throw new Error(
        "Incremental parent createdAt must not be later than its child",
      );
    }

    if (child.chain.depth === 1) {
      if (
        parentOperationId !== child.chain.baseOperationId ||
        parent.chain.kind !== "full" ||
        parent.operationId !== child.chain.baseOperationId
      ) {
        throw new Error("Depth-1 incremental must resolve to its full base");
      }
    } else if (
      parentOperationId === child.chain.baseOperationId ||
      parent.chain.kind !== "incremental" ||
      parent.chain.depth !== child.chain.depth - 1 ||
      parent.chain.baseOperationId !== child.chain.baseOperationId
    ) {
      throw new Error(
        "Incremental parent must be the preceding depth in the same base chain",
      );
    }
    newestToOldest.push({
      manifest: parent,
      expectedManifestSha256: record.expectedManifestSha256,
      expectedSource: record.expectedSource,
      expectedRuntime: record.expectedRuntime,
      minimumWatermarks: record.minimumWatermarks,
    });
    child = parent;
  }

  const oldestToNewest = newestToOldest.reverse();
  if (
    current.chain.kind === "incremental" &&
    oldestToNewest[0].manifest.operationId !== current.chain.baseOperationId
  ) {
    throw new Error("Incremental chain did not terminate at its declared base");
  }
  return oldestToNewest;
}

function assertRestoreChainBudgets(
  chain: readonly VerifiedAgentBackupManifestV2ChainEntry[],
): void {
  if (
    chain.length === 0 ||
    chain.length > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChainManifests
  ) {
    throw new RangeError("Backup restore chain exceeds cumulative limits");
  }
  let plainBytes = 0;
  let compressedBytes = 0;
  let encryptedBytes = 0;
  let chunkCount = 0;
  let manifestBytes = 0;
  let wrappedDekBytes = 0;
  for (const entry of chain) {
    plainBytes += entry.manifest.totals.plainBytes;
    compressedBytes += entry.manifest.totals.compressedBytes;
    encryptedBytes += entry.manifest.totals.encryptedBytes;
    chunkCount += entry.manifest.totals.chunkCount;
    manifestBytes += new TextEncoder().encode(
      canonicalJson(entry.manifest),
    ).byteLength;
    wrappedDekBytes += entry.manifest.encryption.wrappedDek.bytes;
    if (
      !Number.isSafeInteger(plainBytes) ||
      plainBytes > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChainPlainBytes ||
      !Number.isSafeInteger(compressedBytes) ||
      compressedBytes >
        AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChainCompressedBytes ||
      !Number.isSafeInteger(encryptedBytes) ||
      encryptedBytes > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChainEncryptedBytes ||
      !Number.isSafeInteger(chunkCount) ||
      chunkCount > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChainChunks ||
      !Number.isSafeInteger(manifestBytes) ||
      manifestBytes > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChainManifestBytes ||
      !Number.isSafeInteger(wrappedDekBytes) ||
      wrappedDekBytes > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChainWrappedDekBytes
    ) {
      throw new RangeError("Backup restore chain exceeds cumulative limits");
    }
  }
}

function assertDeltaOverlayChain(
  chain: readonly VerifiedAgentBackupManifestV2ChainEntry[],
): void {
  const logicalDigests = new Map<string, string>();
  let contentAddressing: string | undefined;
  for (const [manifestIndex, entry] of chain.entries()) {
    const { manifest } = entry;
    const currentContentAddressing = canonicalJson(
      manifest.integrity.contentAddressing,
    );
    if (
      contentAddressing !== undefined &&
      currentContentAddressing !== contentAddressing
    ) {
      throw new Error(
        "Content HMAC key rotation requires compaction to a new full backup",
      );
    }
    contentAddressing = currentContentAddressing;
    for (const component of manifest.components) {
      if (component.state.kind === "full") {
        if (manifestIndex !== 0) {
          throw new Error(
            "Incremental chains cannot contain full component payloads",
          );
        }
        logicalDigests.set(
          component.name,
          component.state.resultContentHmacSha256,
        );
        continue;
      }
      const previousDigest = logicalDigests.get(component.name);
      if (previousDigest === undefined) {
        throw new Error(
          `Delta component ${component.name} has no full base component`,
        );
      }
      if (component.state.baseContentHmacSha256 !== previousDigest) {
        throw new Error(
          `Delta component ${component.name} does not overlay its parent state`,
        );
      }
      logicalDigests.set(
        component.name,
        component.state.resultContentHmacSha256,
      );
    }
  }
}

function assertFreshDekGenerations(
  chain: readonly VerifiedAgentBackupManifestV2ChainEntry[],
): void {
  const seen = new Set<string>();
  for (const entry of chain) {
    const generationId = entry.manifest.encryption.dekGenerationId;
    if (seen.has(generationId)) {
      throw new Error("Backup chain reused a per-operation DEK generation");
    }
    seen.add(generationId);
  }
}

async function assertWatermarkChain(
  chain: readonly VerifiedAgentBackupManifestV2ChainEntry[],
  capabilities: AgentBackupManifestV2RestoreCapabilities,
  control: Readonly<AgentBackupManifestV2OperationControl>,
): Promise<void> {
  const previous = new Map<string, string>();
  for (const entry of chain) {
    const minimum = new Map(
      entry.minimumWatermarks.map((watermark) => [
        watermark.namespace,
        watermark.value,
      ]),
    );
    for (const watermark of entry.manifest.watermarks) {
      const validator = capabilities.watermarks[watermark.namespace];
      if (!validator) {
        throw new Error(
          `Restore does not support watermark namespace ${watermark.namespace}`,
        );
      }
      const accepted = await callProviderWithOperationControl(
        "Backup watermark validation",
        () =>
          validator(watermark.value, {
            manifest: entry.manifest,
            previousValue: previous.get(watermark.namespace),
            minimumValue: minimum.get(watermark.namespace),
          }),
        control,
      );
      if (accepted !== true) {
        throw new Error(
          `Restore rejected watermark namespace ${watermark.namespace}`,
        );
      }
      previous.set(watermark.namespace, watermark.value);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

interface TrustedRestoreInternal {
  readonly resolveCommitAuthority: AgentBackupManifestV2CommitAuthorityResolver;
}

const trustedRestoreResults = new WeakMap<
  VerifiedAgentBackupManifestV2Restore,
  TrustedRestoreInternal
>();

async function revalidateFrozenRestoreChain(
  chain: readonly VerifiedAgentBackupManifestV2ChainEntry[],
  authority: AgentBackupManifestV2RestoreAuthority,
): Promise<readonly VerifiedAgentBackupManifestV2ChainEntry[]> {
  const revalidated: VerifiedAgentBackupManifestV2ChainEntry[] = [];
  for (const entry of chain) {
    const manifest = await parseAgentBackupManifestV2WithControl(
      entry.manifest,
      authority.control,
    );
    assertTrustedManifestIdentity(manifest, authority);
    assertOperationDigestAuthority(
      manifest,
      entry.manifest.operationId,
      entry.expectedManifestSha256,
    );
    assertManifestLedgerExpectations(manifest, entry);
    assertManifestClockAuthority(manifest, authority.clock);
    assertManifestCapabilities(manifest, authority.capabilities);
    revalidated.push({
      manifest,
      expectedManifestSha256: entry.expectedManifestSha256,
      expectedSource: entry.expectedSource,
      expectedRuntime: entry.expectedRuntime,
      minimumWatermarks: entry.minimumWatermarks,
    });
  }
  assertDeltaOverlayChain(revalidated);
  assertFreshDekGenerations(revalidated);
  return deepFreeze(revalidated);
}

/**
 * Authenticate metadata against trusted control-plane authority and resolve
 * the complete incremental catalog chain. The caller must still fetch/decrypt
 * chunks, call the streaming payload verifier, and have its registered decoder
 * verify tombstones/upserts and result digests before mutating a sandbox.
 *
 * Incrementals are delta-only. Restore starts at the full base, walks oldest to
 * newest, leaves omitted components unchanged, and applies explicit tombstones
 * before deterministic upserts. Capture compacts to a new full backup no later
 * than depth 20. AAD is operation-bound, so no chunk is reused across operation
 * ids; retries replay the exact persisted nonce/envelope bytes.
 * `activationGeneration` names one sandbox incarnation and
 * `lifecycleRevision` snapshots its monotone control-plane revision. When
 * either changes, capture starts a new full chain instead of linking an
 * incremental to stale lifecycle authority.
 */
export async function verifyAgentBackupManifestV2ForRestore(
  input: unknown,
  authority: AgentBackupManifestV2RestoreAuthority,
): Promise<VerifiedAgentBackupManifestV2Restore> {
  const trusted = RestoreAuthorityScalarsSchema.parse({
    organizationId: authority.organizationId,
    agentId: authority.agentId,
    activationGeneration: authority.activationGeneration,
    lifecycleRevision: authority.lifecycleRevision,
    operationId: authority.operationId,
    expectedManifestSha256: authority.expectedManifestSha256,
    expectedSource: authority.expectedSource,
    expectedRuntime: authority.expectedRuntime,
    minimumWatermarks: authority.minimumWatermarks,
    clock: authority.clock,
    restoreLease: authority.restoreLease,
    control: { deadlineEpochMs: authority.control?.deadlineEpochMs },
  });
  if (typeof authority.resolveCatalogManifest !== "function") {
    throw new TypeError("Restore requires a trusted catalog resolver");
  }
  if (typeof authority.resolveCommitAuthority !== "function") {
    throw new TypeError("Restore requires a commit authority resolver");
  }
  if (!authority.capabilities) {
    throw new TypeError("Restore requires a capability policy");
  }
  const capabilities = snapshotRestoreCapabilities(authority.capabilities);
  const resolver = authority.resolveCatalogManifest;
  const control = Object.freeze({
    deadlineEpochMs: trusted.control.deadlineEpochMs,
    signal: authority.control.signal,
  });
  assertOperationActive(control);
  assertRestoreLeaseActive(trusted.restoreLease, trusted.clock.trustedNow);
  const authoritySnapshot = Object.freeze({
    ...trusted,
    control,
    resolveCatalogManifest: (
      operationId: string,
      callbackControl: Readonly<AgentBackupManifestV2OperationControl>,
    ) => resolver(operationId, callbackControl),
    resolveCommitAuthority: authority.resolveCommitAuthority.bind(authority),
    capabilities,
  });

  const manifest = await parseAgentBackupManifestV2WithControl(input, control);
  assertTrustedManifestIdentity(manifest, trusted);
  assertOperationDigestAuthority(
    manifest,
    trusted.operationId,
    trusted.expectedManifestSha256,
  );
  assertManifestLedgerExpectations(manifest, trusted);
  assertManifestClockAuthority(manifest, trusted.clock);
  assertManifestCapabilities(manifest, capabilities);
  const chain = deepFreeze(
    await resolveManifestChain(manifest, authoritySnapshot),
  );
  assertRestoreChainBudgets(chain);
  assertDeltaOverlayChain(chain);
  assertFreshDekGenerations(chain);
  await assertWatermarkChain(chain, capabilities, control);
  const frozenChain = await revalidateFrozenRestoreChain(
    chain,
    authoritySnapshot,
  );
  const result = Object.freeze({
    manifest: frozenChain[frozenChain.length - 1].manifest,
    chain: frozenChain,
    restoreLease: deepFreeze({ ...trusted.restoreLease }),
  });
  trustedRestoreResults.set(result, {
    resolveCommitAuthority: authority.resolveCommitAuthority.bind(authority),
  });
  return result;
}

export interface AgentBackupSha256Stream {
  update(bytes: Uint8Array): void | Promise<void>;
  digestHex(): string | Promise<string>;
}

export type AgentBackupSha256StreamFactory = () => AgentBackupSha256Stream;

export interface AgentBackupRestoreCallbackContext {
  readonly control: Readonly<AgentBackupManifestV2OperationControl>;
  readonly manifest: AgentBackupManifestV2;
}

export interface AgentBackupWrappedDekRequest
  extends AgentBackupRestoreCallbackContext {
  /** Defensive copy of the external Steward envelope bytes. */
  readonly wrappedDek: Uint8Array;
  /** Canonical provider/org/operation-bound KEK context bytes. */
  readonly context: Uint8Array;
  readonly keyId: string;
  readonly keyVersion: number;
}

export interface AgentBackupEncryptedChunkEnvelope
  extends AgentBackupRestoreCallbackContext {
  readonly dataKey: unknown;
  readonly component: AgentBackupManifestV2Component;
  readonly chunk: AgentBackupManifestV2Chunk;
  readonly algorithm: "AES-256-GCM";
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
  /** Exact UTF-8 bytes returned by `canonicalizeAgentBackupChunkAad`. */
  readonly aad: Uint8Array;
}

export interface AgentBackupDecompressionRequest
  extends AgentBackupRestoreCallbackContext {
  readonly component: AgentBackupManifestV2Component;
  readonly chunk: AgentBackupManifestV2Chunk;
  /** Defensive copy of authenticated compressed plaintext. */
  readonly compressedPlaintext: Uint8Array;
  /** Hard output ceiling the decompressor must enforce while streaming. */
  readonly maxOutputBytes: number;
}

export interface AgentBackupRestoreStageFragment
  extends AgentBackupRestoreCallbackContext {
  readonly component: AgentBackupManifestV2Component;
  readonly chunk: AgentBackupManifestV2Chunk;
  readonly fragmentIndex: number;
  /** A fresh copy owned by the isolated staging transaction. */
  readonly plaintext: Uint8Array;
}

export interface AgentBackupRestoreComponentResultRequest
  extends AgentBackupRestoreCallbackContext {
  readonly component: AgentBackupManifestV2Component;
  readonly payloadContentHmacSha256: string;
  readonly emptyPayload: boolean;
}

export interface AgentBackupRestoreComponentResult {
  accepted: true;
  resultContentHmacSha256: string;
  tombstoneCount: number;
  /** Must be true for a zero-chunk full component. */
  emptyPayloadValidated: boolean;
}

export interface AgentBackupManifestV2RestoreAttempt {
  /** Stable UUID persisted by the caller and reused across process retries. */
  restoreAttemptId: string;
}

export interface AgentBackupRestoreStagingSession {
  readonly restoreAttemptId: string;
  readonly operationId: string;
  readonly expectedManifestSha256: string;
  /** Durable staging row/object identity; safe to persist for crash recovery. */
  readonly stagingHandle: string;
  /** Durable cleanup-outbox identity registered atomically by `begin`. */
  readonly cleanupHandle: string;
  /** Fences concurrent/stale workers operating on the same attempt. */
  readonly executionToken: string;
}

export interface AgentBackupRestoreStagedReceipt {
  readonly restoreAttemptId: string;
  readonly operationId: string;
  readonly expectedManifestSha256: string;
  readonly stagingHandle: string;
  readonly cleanupHandle: string;
  readonly stagedPlainBytes: number;
  readonly fragmentCount: number;
  readonly componentResults: readonly AgentBackupRestoreComponentResult[];
}

export interface AgentBackupRestoreCommitReceipt {
  readonly committed: true;
  readonly restoreAttemptId: string;
  readonly operationId: string;
  readonly expectedManifestSha256: string;
  readonly publicationId: string;
  /** Per-agent publication sequence allocated atomically by commit. */
  readonly restoreGeneration: string;
  readonly committedAt: string;
  readonly restoreLease: AgentBackupManifestV2RestoreLease;
}

export type AgentBackupRestoreCommitOutcome =
  | {
      readonly status: "committed";
      readonly receipt: AgentBackupRestoreCommitReceipt;
    }
  | { readonly status: "not-committed" }
  | { readonly status: "pending" };

export interface AgentBackupRestoreCleanupReceipt {
  readonly restoreAttemptId: string;
  readonly cleanupHandle: string;
  readonly status: "complete" | "pending";
}

export interface AgentBackupRestoreStagingAdapter {
  /**
   * Atomically claims this durable attempt and registers `cleanupHandle`
   * before returning. A duplicate active attempt must fail closed; a stale
   * claimant may be resumed only with a new fenced `executionToken`.
   */
  begin(
    request: AgentBackupManifestV2RestoreAttempt & {
      restore: VerifiedAgentBackupManifestV2Restore;
      control: Readonly<AgentBackupManifestV2OperationControl>;
    },
  ):
    | AgentBackupRestoreStagingSession
    | Promise<AgentBackupRestoreStagingSession>;
  /**
   * Fences on `executionToken` and idempotently upserts the deterministic
   * operation/component/chunk/fragment tuple. An exact retry is acknowledged;
   * different bytes for an existing tuple fail closed.
   */
  stagePlaintextFragment(
    session: AgentBackupRestoreStagingSession,
    fragment: AgentBackupRestoreStageFragment,
  ): true | Promise<true>;
  /** Mandatory format decoder and reconstructed-result validator. */
  finalizeComponent(
    session: AgentBackupRestoreStagingSession,
    request: AgentBackupRestoreComponentResultRequest,
  ):
    | AgentBackupRestoreComponentResult
    | Promise<AgentBackupRestoreComponentResult>;
  /**
   * Durably seals the exact staged receipt before it can be committed. Exact
   * retries return the same receipt; a conflicting receipt fails closed.
   */
  seal(
    session: AgentBackupRestoreStagingSession,
    receipt: AgentBackupRestoreStagedReceipt,
    control: Readonly<AgentBackupManifestV2OperationControl>,
  ): AgentBackupRestoreStagedReceipt | Promise<AgentBackupRestoreStagedReceipt>;
  /**
   * Atomically CASes the still-current lease/catalog fence and publishes the
   * staged state, allocates `restoreGeneration`, and records the receipt in one
   * transaction. Replays for one `restoreAttemptId` return the same receipt.
   */
  commit(
    session: AgentBackupRestoreStagingSession,
    request: {
      restore: VerifiedAgentBackupManifestV2Restore;
      stagedReceipt: AgentBackupRestoreStagedReceipt;
      commitAuthority: AgentBackupManifestV2CommitAuthority;
      control: Readonly<AgentBackupManifestV2OperationControl>;
    },
  ): AgentBackupRestoreCommitReceipt | Promise<AgentBackupRestoreCommitReceipt>;
  /** Queries the durable ledger by `restoreAttemptId` after a lost response. */
  queryCommitOutcome(
    session: AgentBackupRestoreStagingSession,
    control: Readonly<AgentBackupManifestV2OperationControl>,
  ): AgentBackupRestoreCommitOutcome | Promise<AgentBackupRestoreCommitOutcome>;
  /** Rolls back isolated writes; the cleanup outbox remains durable on failure. */
  abort(
    session: AgentBackupRestoreStagingSession,
    reasonCode: "abandoned" | "commit-not-applied" | "staging-failed",
    control: Readonly<AgentBackupManifestV2OperationControl>,
  ):
    | AgentBackupRestoreCleanupReceipt
    | Promise<AgentBackupRestoreCleanupReceipt>;
  /** Reaper entrypoint usable after the worker/process that staged has died. */
  reapCleanup(
    request: Pick<
      AgentBackupRestoreStagingSession,
      "restoreAttemptId" | "cleanupHandle"
    >,
    control: Readonly<AgentBackupManifestV2OperationControl>,
  ):
    | AgentBackupRestoreCleanupReceipt
    | Promise<AgentBackupRestoreCleanupReceipt>;
}

export interface AgentBackupManifestV2RestoreProviders {
  /** Raw SHA-256 for byte-integrity and framed payload verification. */
  sha256Factory: AgentBackupSha256StreamFactory;
  /**
   * Fresh HMAC-SHA-256 stream keyed by the manifest's organization-scoped
   * content key. Key material must remain inside the provider.
   */
  contentHmacFactory(
    context: AgentBackupRestoreCallbackContext,
  ): AgentBackupSha256Stream;
  loadWrappedDek(
    context: AgentBackupRestoreCallbackContext,
  ): Uint8Array | Promise<Uint8Array>;
  /** Durable KMS KEK unwrap; called exactly once per chain operation. */
  unwrapDek(request: AgentBackupWrappedDekRequest): unknown | Promise<unknown>;
  releaseDek(
    dataKey: unknown,
    context: AgentBackupRestoreCallbackContext,
  ): true | Promise<true>;
  loadEncryptedChunk(
    context: AgentBackupRestoreCallbackContext & {
      component: AgentBackupManifestV2Component;
      chunk: AgentBackupManifestV2Chunk;
    },
  ): Uint8Array | Promise<Uint8Array>;
  /** Local AES-GCM data-plane decrypt using the already-unwrapped DEK. */
  decryptChunk(
    envelope: AgentBackupEncryptedChunkEnvelope,
  ): Uint8Array | Promise<Uint8Array>;
  decompressChunk(
    request: AgentBackupDecompressionRequest,
  ):
    | Iterable<Uint8Array>
    | AsyncIterable<Uint8Array>
    | Promise<Iterable<Uint8Array> | AsyncIterable<Uint8Array>>;
  staging: AgentBackupRestoreStagingAdapter;
}

export interface StagedAgentBackupManifestV2Restore {
  readonly restore: VerifiedAgentBackupManifestV2Restore;
  readonly session: AgentBackupRestoreStagingSession;
  readonly stagedReceipt: AgentBackupRestoreStagedReceipt;
  readonly componentResults: readonly AgentBackupRestoreComponentResult[];
  readonly stagedPlainBytes: number;
  readonly fragmentCount: number;
}

export interface CommittedAgentBackupManifestV2Restore {
  readonly committed: true;
  readonly restore: VerifiedAgentBackupManifestV2Restore;
  readonly receipt: AgentBackupRestoreCommitReceipt;
}

const RestoreComponentResultSchema = z.strictObject({
  accepted: z.literal(true),
  resultContentHmacSha256: Sha256Schema,
  tombstoneCount: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxDeltaTombstones,
  ),
  emptyPayloadValidated: z.boolean(),
});

const RestoreAttemptSchema = z.strictObject({
  restoreAttemptId: UuidSchema,
});

const RestoreStagingSessionSchema = z.strictObject({
  restoreAttemptId: UuidSchema,
  operationId: UuidSchema,
  expectedManifestSha256: Sha256Schema,
  stagingHandle: UuidSchema,
  cleanupHandle: UuidSchema,
  executionToken: UuidSchema,
});

const RestoreStagedReceiptSchema = z.strictObject({
  restoreAttemptId: UuidSchema,
  operationId: UuidSchema,
  expectedManifestSha256: Sha256Schema,
  stagingHandle: UuidSchema,
  cleanupHandle: UuidSchema,
  stagedPlainBytes: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChainPlainBytes,
  ),
  fragmentCount: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChainFragments,
  ),
  componentResults: z
    .array(RestoreComponentResultSchema)
    .max(
      AGENT_BACKUP_MANIFEST_V2_LIMITS.maxComponents *
        AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChainManifests,
    ),
});

const RestoreCommitReceiptSchema = z.strictObject({
  committed: z.literal(true),
  restoreAttemptId: UuidSchema,
  operationId: UuidSchema,
  expectedManifestSha256: Sha256Schema,
  publicationId: UuidSchema,
  restoreGeneration: CanonicalPositiveUint64StringSchema,
  committedAt: CanonicalTimestampSchema,
  restoreLease: RestoreLeaseSchema,
});

const RestoreCommitOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("committed"),
    receipt: RestoreCommitReceiptSchema,
  }),
  z.strictObject({ status: z.literal("not-committed") }),
  z.strictObject({ status: z.literal("pending") }),
]);

const RestoreCleanupReceiptSchema = z.strictObject({
  restoreAttemptId: UuidSchema,
  cleanupHandle: UuidSchema,
  status: z.enum(["complete", "pending"]),
});

interface StagedRestoreInternal {
  session: AgentBackupRestoreStagingSession;
  stagedReceipt?: AgentBackupRestoreStagedReceipt;
  staging: AgentBackupRestoreStagingAdapter;
  control: Readonly<AgentBackupManifestV2OperationControl>;
  resolveCommitAuthority: AgentBackupManifestV2CommitAuthorityResolver;
  state:
    | "staged"
    | "committing"
    | "commit-ambiguous"
    | "commit-not-applied"
    | "aborting"
    | "cleanup-pending";
}

const stagedRestoreInternals = new WeakMap<
  StagedAgentBackupManifestV2Restore,
  StagedRestoreInternal
>();

function uint64BigEndian(value: number): Uint8Array {
  SafeNonNegativeIntegerSchema.parse(value);
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

async function finishDigest(
  digest: AgentBackupSha256Stream,
  label: string,
  control?: Readonly<AgentBackupManifestV2OperationControl>,
): Promise<string> {
  let value: string;
  try {
    value = control
      ? await callWithOperationControl(() => digest.digestHex(), control)
      : await digest.digestHex();
  } catch (cause) {
    if (isOperationControlError(cause)) throw cause;
    throw new Error(`${label} failed`);
  }
  const result = Sha256Schema.safeParse(value);
  if (!result.success) {
    throw new TypeError(
      `${label} returned an invalid lowercase SHA-256 digest`,
    );
  }
  return result.data;
}

function createDigest(
  factory: AgentBackupSha256StreamFactory,
): AgentBackupSha256Stream {
  const digest = factory();
  if (
    !digest ||
    typeof digest.update !== "function" ||
    typeof digest.digestHex !== "function"
  ) {
    throw new TypeError("SHA-256 stream factory returned an invalid digest");
  }
  return digest;
}

function createProviderDigest(
  factory: AgentBackupSha256StreamFactory,
  label: string,
): AgentBackupSha256Stream {
  try {
    return createDigest(factory);
  } catch {
    throw new Error(`${label} failed`);
  }
}

async function updateDigest(
  digest: AgentBackupSha256Stream,
  bytes: Uint8Array,
  control: Readonly<AgentBackupManifestV2OperationControl>,
): Promise<void> {
  try {
    await callWithOperationControl(() => digest.update(bytes), control);
  } catch (cause) {
    if (isOperationControlError(cause)) throw cause;
    throw new Error("Backup digest update failed");
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function getByteIterator(
  stream: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): Iterator<Uint8Array> | AsyncIterator<Uint8Array> {
  const asyncFactory = (stream as AsyncIterable<Uint8Array>)[
    Symbol.asyncIterator
  ];
  if (typeof asyncFactory === "function") return asyncFactory.call(stream);
  const syncFactory = (stream as Iterable<Uint8Array>)[Symbol.iterator];
  if (typeof syncFactory === "function") return syncFactory.call(stream);
  throw new TypeError("Decompressor must return a byte stream");
}

async function closeByteIterator(
  iterator: Iterator<Uint8Array> | AsyncIterator<Uint8Array>,
): Promise<void> {
  if (typeof iterator.return !== "function") return;
  const cleanupControl = Object.freeze({
    deadlineEpochMs: Date.now() + 5_000,
  });
  await callProviderWithOperationControl(
    "Backup decompressor cancellation",
    () => iterator.return?.(),
    cleanupControl,
  );
}

function snapshotRestoreProviders(
  providers: AgentBackupManifestV2RestoreProviders,
): AgentBackupManifestV2RestoreProviders {
  const requiredFunctions = [
    providers?.sha256Factory,
    providers?.contentHmacFactory,
    providers?.loadWrappedDek,
    providers?.unwrapDek,
    providers?.releaseDek,
    providers?.loadEncryptedChunk,
    providers?.decryptChunk,
    providers?.decompressChunk,
    providers?.staging?.begin,
    providers?.staging?.stagePlaintextFragment,
    providers?.staging?.finalizeComponent,
    providers?.staging?.seal,
    providers?.staging?.commit,
    providers?.staging?.queryCommitOutcome,
    providers?.staging?.abort,
    providers?.staging?.reapCleanup,
  ];
  if (requiredFunctions.some((callback) => typeof callback !== "function")) {
    throw new TypeError("Restore providers are incomplete");
  }
  const staging = providers.staging;
  const begin = staging.begin.bind(staging);
  const stagePlaintextFragment = staging.stagePlaintextFragment.bind(staging);
  const finalizeComponent = staging.finalizeComponent.bind(staging);
  const seal = staging.seal.bind(staging);
  const commit = staging.commit.bind(staging);
  const queryCommitOutcome = staging.queryCommitOutcome.bind(staging);
  const abort = staging.abort.bind(staging);
  const reapCleanup = staging.reapCleanup.bind(staging);
  const stagingSnapshot: AgentBackupRestoreStagingAdapter = {
    begin: (request) => begin(request),
    stagePlaintextFragment: (session, fragment) =>
      stagePlaintextFragment(session, fragment),
    finalizeComponent: (session, request) =>
      finalizeComponent(session, request),
    seal: (session, receipt, control) => seal(session, receipt, control),
    commit: (session, request) => commit(session, request),
    queryCommitOutcome: (session, control) =>
      queryCommitOutcome(session, control),
    abort: (session, reasonCode, control) =>
      abort(session, reasonCode, control),
    reapCleanup: (request, control) => reapCleanup(request, control),
  };
  const sha256Factory = providers.sha256Factory.bind(providers);
  const contentHmacFactory = providers.contentHmacFactory.bind(providers);
  const loadWrappedDek = providers.loadWrappedDek.bind(providers);
  const unwrapDek = providers.unwrapDek.bind(providers);
  const releaseDek = providers.releaseDek.bind(providers);
  const loadEncryptedChunk = providers.loadEncryptedChunk.bind(providers);
  const decryptChunk = providers.decryptChunk.bind(providers);
  const decompressChunk = providers.decompressChunk.bind(providers);
  const snapshot: AgentBackupManifestV2RestoreProviders = {
    sha256Factory: () => sha256Factory(),
    contentHmacFactory: (context) => contentHmacFactory(context),
    loadWrappedDek: (context) => loadWrappedDek(context),
    unwrapDek: (request) => unwrapDek(request),
    releaseDek: (dataKey, context) => releaseDek(dataKey, context),
    loadEncryptedChunk: (context) => loadEncryptedChunk(context),
    decryptChunk: (envelope) => decryptChunk(envelope),
    decompressChunk: (request) => decompressChunk(request),
    staging: Object.freeze(stagingSnapshot),
  };
  return Object.freeze(snapshot);
}

function snapshotOperationControl(
  control: AgentBackupManifestV2OperationControl,
): Readonly<AgentBackupManifestV2OperationControl> {
  const parsed = z
    .strictObject({ deadlineEpochMs: SafePositiveIntegerSchema })
    .parse({ deadlineEpochMs: control?.deadlineEpochMs });
  const snapshot = Object.freeze({
    deadlineEpochMs: parsed.deadlineEpochMs,
    signal: control.signal,
  });
  assertOperationActive(snapshot);
  return snapshot;
}

async function abortStaging(
  internal: StagedRestoreInternal,
  reasonCode: "abandoned" | "commit-not-applied" | "staging-failed",
): Promise<AgentBackupRestoreCleanupReceipt> {
  const cleanupControl = Object.freeze({
    deadlineEpochMs: Date.now() + 5_000,
  });
  const receipt = RestoreCleanupReceiptSchema.parse(
    await callProviderWithOperationControl(
      "Backup staging rollback",
      () =>
        internal.staging.abort(internal.session, reasonCode, cleanupControl),
      cleanupControl,
    ),
  );
  if (
    receipt.restoreAttemptId !== internal.session.restoreAttemptId ||
    receipt.cleanupHandle !== internal.session.cleanupHandle
  ) {
    throw new Error("Backup staging rollback returned a mismatched receipt");
  }
  return deepFreeze(receipt);
}

function cleanupPendingError(
  session: AgentBackupRestoreStagingSession,
): Error &
  Pick<AgentBackupRestoreStagingSession, "restoreAttemptId" | "cleanupHandle"> {
  return Object.assign(
    new Error("Backup staging cleanup is pending durable reaper processing"),
    {
      restoreAttemptId: session.restoreAttemptId,
      cleanupHandle: session.cleanupHandle,
    },
  );
}

async function requireCompleteCleanup(
  internal: StagedRestoreInternal,
  reasonCode: "abandoned" | "commit-not-applied" | "staging-failed",
): Promise<AgentBackupRestoreCleanupReceipt> {
  const receipt = await abortStaging(internal, reasonCode);
  if (receipt.status !== "complete") {
    internal.state = "cleanup-pending";
    throw cleanupPendingError(internal.session);
  }
  return receipt;
}

async function sealStaging(
  internal: StagedRestoreInternal,
  receiptInput: AgentBackupRestoreStagedReceipt,
): Promise<AgentBackupRestoreStagedReceipt> {
  const receipt = RestoreStagedReceiptSchema.parse(
    await callProviderWithOperationControl(
      "Backup staging receipt persistence",
      () =>
        internal.staging.seal(internal.session, receiptInput, internal.control),
      internal.control,
    ),
  );
  if (canonicalJson(receipt) !== canonicalJson(receiptInput)) {
    throw new Error("Backup staging returned a mismatched durable receipt");
  }
  return deepFreeze(receipt);
}

async function queryCommitOutcome(
  internal: StagedRestoreInternal,
  control: Readonly<AgentBackupManifestV2OperationControl>,
): Promise<AgentBackupRestoreCommitOutcome> {
  return deepFreeze(
    RestoreCommitOutcomeSchema.parse(
      await callProviderWithOperationControl(
        "Backup commit outcome query",
        () => internal.staging.queryCommitOutcome(internal.session, control),
        control,
      ),
    ),
  );
}

function assertCommitReceipt(
  internal: StagedRestoreInternal,
  receiptInput: AgentBackupRestoreCommitReceipt,
  authority: AgentBackupManifestV2CommitAuthority,
): AgentBackupRestoreCommitReceipt {
  const receipt = RestoreCommitReceiptSchema.parse(receiptInput);
  if (
    receipt.restoreAttemptId !== internal.session.restoreAttemptId ||
    receipt.operationId !== internal.session.operationId ||
    receipt.expectedManifestSha256 !==
      internal.session.expectedManifestSha256 ||
    canonicalJson(receipt.restoreLease) !==
      canonicalJson(authority.restoreLease)
  ) {
    throw new Error("Backup commit returned a mismatched durable receipt");
  }
  assertRestoreLeaseActive(receipt.restoreLease, receipt.committedAt);
  return deepFreeze(receipt);
}

async function resolveCurrentCommitAuthority(
  staged: StagedAgentBackupManifestV2Restore,
  internal: StagedRestoreInternal,
): Promise<AgentBackupManifestV2CommitAuthority> {
  const currentInput = await callProviderWithOperationControl(
    "Backup commit authority revalidation",
    () =>
      internal.resolveCommitAuthority(
        {
          restoreAttemptId: internal.session.restoreAttemptId,
          organizationId: staged.restore.manifest.identity.organizationId,
          agentId: staged.restore.manifest.identity.agentId,
          activationGeneration:
            staged.restore.manifest.identity.activationGeneration,
          lifecycleRevision: staged.restore.manifest.identity.lifecycleRevision,
          operationId: staged.restore.manifest.operationId,
          expectedManifestSha256:
            staged.restore.manifest.integrity.manifestSha256,
          expectedChain: staged.restore.chain.map((entry) => ({
            operationId: entry.manifest.operationId,
            expectedManifestSha256: entry.expectedManifestSha256,
          })),
          expectedRestoreLease: staged.restore.restoreLease,
        },
        internal.control,
      ),
    internal.control,
  );
  if (currentInput === null) {
    throw new Error("Backup commit authority is no longer valid");
  }
  const current = CommitAuthoritySchema.parse(currentInput);
  assertRestoreLeaseActive(current.restoreLease, current.trustedNow);
  assertSameRestoreLease(current.restoreLease, staged.restore.restoreLease);
  return deepFreeze(current);
}

async function prepareManifestPayload(
  manifest: AgentBackupManifestV2,
  providers: AgentBackupManifestV2RestoreProviders,
  session: AgentBackupRestoreStagingSession,
  control: Readonly<AgentBackupManifestV2OperationControl>,
  counters: { stagedPlainBytes: number; fragmentCount: number },
  componentResults: AgentBackupRestoreComponentResult[],
): Promise<void> {
  const callbackContext = Object.freeze({ control, manifest });
  const wrappedInput = await callProviderWithOperationControl(
    "Wrapped DEK load",
    () => providers.loadWrappedDek(callbackContext),
    control,
  );
  if (!(wrappedInput instanceof Uint8Array)) {
    throw new TypeError("Wrapped DEK source must return Uint8Array bytes");
  }
  const wrappedDek = Uint8Array.from(wrappedInput);
  if (
    wrappedDek.byteLength !== manifest.encryption.wrappedDek.bytes ||
    wrappedDek.byteLength > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxWrappedDekBytes
  ) {
    throw new Error("Wrapped DEK envelope length mismatch");
  }
  const wrappedDekDigest = createProviderDigest(
    providers.sha256Factory,
    "Wrapped DEK digest factory",
  );
  await updateDigest(wrappedDekDigest, wrappedDek, control);
  if (
    (await finishDigest(wrappedDekDigest, "Wrapped DEK digest", control)) !==
    manifest.encryption.wrappedDek.sha256
  ) {
    throw new Error("Wrapped DEK envelope digest mismatch");
  }
  const context = new TextEncoder().encode(
    canonicalizeAgentBackupDekContext(dekContextInput(manifest)),
  );
  const dataKey = await callProviderWithOperationControl(
    "Wrapped DEK unwrap",
    () =>
      providers.unwrapDek({
        ...callbackContext,
        wrappedDek: Uint8Array.from(wrappedDek),
        context,
        keyId: manifest.encryption.kms.keyId,
        keyVersion: manifest.encryption.kms.keyVersion,
      }),
    control,
    (lateDataKey) => {
      if (lateDataKey === null || lateDataKey === undefined) return;
      const releaseControl = Object.freeze({
        deadlineEpochMs: Date.now() + 5_000,
      });
      // error-policy:J5 the restore already reports its cancellation/deadline;
      // this observer still releases a KMS handle returned after that outcome.
      void callProviderWithOperationControl(
        "Late operation data key release",
        () =>
          providers.releaseDek(
            lateDataKey,
            Object.freeze({ control: releaseControl, manifest }),
          ),
        releaseControl,
      )
        .then((released) => {
          if (released !== true) {
            throw new Error(
              "Late operation data key release was not acknowledged",
            );
          }
        })
        .catch((_lateReleaseFailure: unknown) => undefined);
    },
  );
  if (dataKey === null || dataKey === undefined) {
    throw new Error("KMS did not return an operation data key");
  }

  let processingFailed = false;
  let processingFailure: unknown;
  try {
    const payloadDigest = createProviderDigest(
      () => providers.contentHmacFactory(callbackContext),
      "Framed payload content HMAC factory",
    );
    const encoder = new TextEncoder();
    await updateDigest(
      payloadDigest,
      encoder.encode(AGENT_BACKUP_PAYLOAD_DIGEST_DERIVATION),
      control,
    );
    await updateDigest(
      payloadDigest,
      uint64BigEndian(manifest.components.length),
      control,
    );
    const operationNonces = new Set<string>();

    for (const component of manifest.components) {
      assertOperationActive(control);
      const componentName = encoder.encode(component.name);
      await updateDigest(
        payloadDigest,
        uint64BigEndian(componentName.byteLength),
        control,
      );
      await updateDigest(payloadDigest, componentName, control);
      await updateDigest(
        payloadDigest,
        uint64BigEndian(component.totals.plainBytes),
        control,
      );
      const componentDigest = createProviderDigest(
        () => providers.contentHmacFactory(callbackContext),
        "Component content HMAC factory",
      );
      let componentBytes = 0;

      for (const chunk of component.chunks) {
        const encryptedInput = await callProviderWithOperationControl(
          "Encrypted backup chunk load",
          () =>
            providers.loadEncryptedChunk({
              ...callbackContext,
              component,
              chunk,
            }),
          control,
        );
        if (!(encryptedInput instanceof Uint8Array)) {
          throw new TypeError(
            "Encrypted chunk source must return Uint8Array bytes",
          );
        }
        const encrypted = Uint8Array.from(encryptedInput);
        if (encrypted.byteLength !== chunk.encryptedBytes) {
          throw new Error("Encrypted chunk length mismatch");
        }
        const encryptedDigest = createProviderDigest(
          providers.sha256Factory,
          "Encrypted chunk digest factory",
        );
        await updateDigest(encryptedDigest, encrypted, control);
        if (
          (await finishDigest(
            encryptedDigest,
            "Encrypted chunk digest",
            control,
          )) !== chunk.sha256
        ) {
          throw new Error("Encrypted chunk digest mismatch");
        }
        const nonceEnd = AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes;
        const tagStart =
          encrypted.byteLength - AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes;
        const nonce = encrypted.subarray(0, nonceEnd);
        const nonceKey = bytesToHex(nonce);
        if (operationNonces.has(nonceKey)) {
          throw new Error("AES-GCM nonce reuse detected within one operation");
        }
        operationNonces.add(nonceKey);
        const compressedInput = await callProviderWithOperationControl(
          "Encrypted backup chunk decryption",
          () =>
            providers.decryptChunk({
              ...callbackContext,
              dataKey,
              component,
              chunk,
              algorithm: manifest.encryption.algorithm,
              nonce,
              ciphertext: encrypted.subarray(nonceEnd, tagStart),
              tag: encrypted.subarray(tagStart),
              aad: encoder.encode(
                canonicalizeAgentBackupChunkAad(
                  chunkAadInput(manifest, component, chunk),
                ),
              ),
            }),
          control,
        );
        if (!(compressedInput instanceof Uint8Array)) {
          throw new TypeError("Chunk decryptor must return Uint8Array bytes");
        }
        const compressedPlaintext = Uint8Array.from(compressedInput);
        if (compressedPlaintext.byteLength !== chunk.compressedBytes) {
          throw new Error("Authenticated compressed chunk length mismatch");
        }
        const stream = await callProviderWithOperationControl(
          "Backup chunk decompression",
          () =>
            providers.decompressChunk({
              ...callbackContext,
              component,
              chunk,
              compressedPlaintext: Uint8Array.from(compressedPlaintext),
              maxOutputBytes: chunk.plainBytes,
            }),
          control,
        );
        if (
          !stream ||
          (!(Symbol.iterator in Object(stream)) &&
            !(Symbol.asyncIterator in Object(stream)))
        ) {
          throw new TypeError("Decompressor must return a byte stream");
        }

        const iterator = getByteIterator(stream);
        assertOperationActive(control);
        const contentHmac = createProviderDigest(
          () => providers.contentHmacFactory(callbackContext),
          "Chunk content HMAC factory",
        );
        let chunkBytes = 0;
        let fragmentIndex = 0;
        try {
          while (true) {
            const step = await callProviderWithOperationControl(
              "Backup decompressor iteration",
              () => iterator.next(),
              control,
            );
            if (!step || typeof step !== "object") {
              throw new TypeError(
                "Decompressor returned an invalid stream step",
              );
            }
            if (step.done) break;
            const fragmentInput = step.value;
            assertOperationActive(control);
            if (!(fragmentInput instanceof Uint8Array)) {
              throw new TypeError(
                "Decompressor must yield Uint8Array fragments",
              );
            }
            if (fragmentInput.byteLength === 0) {
              throw new Error("Decompressor yielded a zero-length fragment");
            }
            fragmentIndex += 1;
            counters.fragmentCount += 1;
            if (
              fragmentIndex >
                AGENT_BACKUP_MANIFEST_V2_LIMITS.maxPlaintextFragmentsPerChunk ||
              counters.fragmentCount >
                AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChainFragments
            ) {
              throw new RangeError(
                "Backup restore exceeds plaintext fragment limits",
              );
            }
            if (chunkBytes > chunk.plainBytes - fragmentInput.byteLength) {
              throw new RangeError("Decompressed chunk exceeds its output cap");
            }
            const plaintext = Uint8Array.from(fragmentInput);
            chunkBytes += plaintext.byteLength;
            componentBytes += plaintext.byteLength;
            counters.stagedPlainBytes += plaintext.byteLength;
            if (
              counters.stagedPlainBytes >
              AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChainPlainBytes
            ) {
              throw new RangeError(
                "Backup staging exceeds its plaintext byte cap",
              );
            }
            await updateDigest(contentHmac, plaintext, control);
            await updateDigest(componentDigest, plaintext, control);
            await updateDigest(payloadDigest, plaintext, control);
            const staged = await callProviderWithOperationControl(
              "Backup plaintext fragment staging",
              () =>
                providers.staging.stagePlaintextFragment(session, {
                  ...callbackContext,
                  component,
                  chunk,
                  fragmentIndex: fragmentIndex - 1,
                  plaintext: Uint8Array.from(plaintext),
                }),
              control,
            );
            if (staged !== true) {
              throw new Error("Backup staging did not acknowledge a fragment");
            }
          }
        } catch (cause) {
          try {
            await closeByteIterator(iterator);
          } catch (closeFailure) {
            throw new AggregateError(
              [cause, closeFailure],
              "Backup decompression and cancellation both failed",
            );
          }
          throw cause;
        }
        if (chunkBytes !== chunk.plainBytes) {
          throw new Error("Decompressed chunk length mismatch");
        }
        if (
          (await finishDigest(contentHmac, "Content HMAC", control)) !==
          chunk.contentHmacSha256
        ) {
          throw new Error("Tenant content HMAC mismatch");
        }
      }

      if (componentBytes !== component.totals.plainBytes) {
        throw new Error("Plaintext component length mismatch");
      }
      const componentContentHmacSha256 = await finishDigest(
        componentDigest,
        "Component content HMAC",
        control,
      );
      if (componentContentHmacSha256 !== component.payloadContentHmacSha256) {
        throw new Error("Component content HMAC mismatch");
      }
      const result = RestoreComponentResultSchema.parse(
        await callProviderWithOperationControl(
          "Backup component finalization",
          () =>
            providers.staging.finalizeComponent(session, {
              ...callbackContext,
              component,
              payloadContentHmacSha256: componentContentHmacSha256,
              emptyPayload: component.chunks.length === 0,
            }),
          control,
        ),
      );
      if (
        component.chunks.length === 0 &&
        result.emptyPayloadValidated !== true
      ) {
        throw new Error("Empty full component was not explicitly validated");
      }
      if (
        result.resultContentHmacSha256 !==
        component.state.resultContentHmacSha256
      ) {
        throw new Error("Decoded component result digest mismatch");
      }
      const expectedTombstones =
        component.state.kind === "delta" ? component.state.tombstoneCount : 0;
      if (result.tombstoneCount !== expectedTombstones) {
        throw new Error("Decoded component tombstone count mismatch");
      }
      componentResults.push(deepFreeze({ ...result }));
    }

    if (
      (await finishDigest(
        payloadDigest,
        "Framed payload content HMAC",
        control,
      )) !== manifest.integrity.framedContentHmacSha256
    ) {
      throw new Error("Framed plaintext payload digest mismatch");
    }
  } catch (cause) {
    // error-policy:J3 retain the processing failure until the DEK handle has
    // also been released; neither error is silently discarded.
    processingFailed = true;
    processingFailure = cause;
  }

  let releaseFailure: unknown;
  try {
    // Releasing an opaque DEK handle is cleanup, so caller cancellation must
    // not prevent it. It still has its own short, fail-closed deadline.
    const releaseControl = Object.freeze({
      deadlineEpochMs: Date.now() + 5_000,
    });
    const released = await callProviderWithOperationControl(
      "Operation data key release",
      () =>
        providers.releaseDek(
          dataKey,
          Object.freeze({ control: releaseControl, manifest }),
        ),
      releaseControl,
    );
    if (released !== true) {
      throw new Error("Operation data key release was not acknowledged");
    }
  } catch (cause) {
    // error-policy:J3 DEK release is a mandatory security boundary and is
    // combined with, rather than masking, an earlier processing failure.
    releaseFailure = cause;
  }
  if (processingFailed && releaseFailure !== undefined) {
    throw new AggregateError(
      [processingFailure, releaseFailure],
      "Backup processing and data-key release both failed",
    );
  }
  if (processingFailed) {
    throw processingFailure;
  }
  if (releaseFailure !== undefined) {
    throw releaseFailure;
  }
}

/**
 * Authenticate and stage the entire full→target chain without touching live
 * sandbox state. A tenant-keyed payload HMAC covers this sequence:
 *
 * UTF8(`elizaos.agent-backup.payload.v1`) || uint64be(componentCount) ||
 * for each manifest-sorted component: uint64be(UTF8(name).length) ||
 * UTF8(name) || uint64be(componentPlainBytes) || raw chunks in index order.
 *
 * All lengths are unsigned 64-bit big-endian. The pipeline verifies wrapped
 * DEKs, encrypted envelopes, unique nonces, AEAD, decompression ceilings,
 * keyed content digests, mandatory format-decoder results and empty components.
 * It returns an opaque staged result; only `commitAgentBackupManifestV2Restore`
 * can make it live after all manifests have passed. Any failure aborts staging.
 */
export async function verifyAgentBackupManifestV2Payload(
  verified: VerifiedAgentBackupManifestV2Restore,
  providerInput: AgentBackupManifestV2RestoreProviders,
  controlInput: AgentBackupManifestV2OperationControl,
  attemptInput: AgentBackupManifestV2RestoreAttempt,
): Promise<StagedAgentBackupManifestV2Restore> {
  const trusted = trustedRestoreResults.get(verified);
  if (!trusted) {
    throw new TypeError("Payload staging requires a trusted restore result");
  }
  assertRestoreChainBudgets(verified.chain);
  const providers = snapshotRestoreProviders(providerInput);
  const control = snapshotOperationControl(controlInput);
  const attempt = RestoreAttemptSchema.parse(attemptInput);
  const session = RestoreStagingSessionSchema.parse(
    await callProviderWithOperationControl(
      "Backup staging attempt acquisition",
      () =>
        providers.staging.begin({
          restoreAttemptId: attempt.restoreAttemptId,
          restore: verified,
          control,
        }),
      control,
    ),
  );
  const internal: StagedRestoreInternal = {
    session: deepFreeze(session),
    staging: providers.staging,
    control,
    resolveCommitAuthority: trusted.resolveCommitAuthority,
    state: "staged",
  };
  const componentResults: AgentBackupRestoreComponentResult[] = [];
  const counters = { stagedPlainBytes: 0, fragmentCount: 0 };
  try {
    if (
      session.restoreAttemptId !== attempt.restoreAttemptId ||
      session.operationId !== verified.manifest.operationId ||
      session.expectedManifestSha256 !==
        verified.manifest.integrity.manifestSha256
    ) {
      throw new Error("Backup staging returned a mismatched durable session");
    }
    for (const entry of verified.chain) {
      await prepareManifestPayload(
        entry.manifest,
        providers,
        session,
        control,
        counters,
        componentResults,
      );
    }
    assertDeltaOverlayChain(verified.chain);
    const stagedReceipt = await sealStaging(internal, {
      restoreAttemptId: session.restoreAttemptId,
      operationId: session.operationId,
      expectedManifestSha256: session.expectedManifestSha256,
      stagingHandle: session.stagingHandle,
      cleanupHandle: session.cleanupHandle,
      stagedPlainBytes: counters.stagedPlainBytes,
      fragmentCount: counters.fragmentCount,
      componentResults,
    });
    internal.stagedReceipt = stagedReceipt;
    const result = deepFreeze({
      restore: verified,
      session,
      stagedReceipt,
      componentResults,
      stagedPlainBytes: counters.stagedPlainBytes,
      fragmentCount: counters.fragmentCount,
    });
    stagedRestoreInternals.set(result, internal);
    return result;
  } catch (cause) {
    // error-policy:J3 the durable cleanup registration was created atomically
    // by begin; immediate rollback is attempted and the reaper handle survives.
    const error =
      cause instanceof Error ? cause : new Error("Backup staging failed");
    try {
      await requireCompleteCleanup(internal, "staging-failed");
    } catch {
      throw cleanupPendingError(session);
    }
    throw error;
  }
}

async function reconcileCommitOutcome(
  staged: StagedAgentBackupManifestV2Restore,
  internal: StagedRestoreInternal,
  control: Readonly<AgentBackupManifestV2OperationControl>,
): Promise<AgentBackupRestoreCommitOutcome> {
  const outcome = await queryCommitOutcome(internal, control);
  if (outcome.status === "committed") {
    const authority = Object.freeze({
      restoreLease: staged.restore.restoreLease,
      trustedNow: outcome.receipt.committedAt,
    });
    const receipt = assertCommitReceipt(internal, outcome.receipt, authority);
    stagedRestoreInternals.delete(staged);
    return deepFreeze({ status: "committed", receipt });
  }
  internal.state =
    outcome.status === "not-committed"
      ? "commit-not-applied"
      : "commit-ambiguous";
  return outcome;
}

/** Query the durable outcome after a lost/ambiguous commit response. */
export async function reconcileAgentBackupManifestV2RestoreCommit(
  staged: StagedAgentBackupManifestV2Restore,
  controlInput: AgentBackupManifestV2OperationControl,
): Promise<AgentBackupRestoreCommitOutcome> {
  const internal = stagedRestoreInternals.get(staged);
  if (
    !internal ||
    (internal.state !== "committing" &&
      internal.state !== "commit-ambiguous" &&
      internal.state !== "commit-not-applied")
  ) {
    throw new TypeError("Restore has no reconcilable commit attempt");
  }
  return reconcileCommitOutcome(
    staged,
    internal,
    snapshotOperationControl(controlInput),
  );
}

/** Atomically publish a fully validated staged restore idempotently. */
export async function commitAgentBackupManifestV2Restore(
  staged: StagedAgentBackupManifestV2Restore,
): Promise<CommittedAgentBackupManifestV2Restore> {
  const internal = stagedRestoreInternals.get(staged);
  if (
    !internal ||
    (internal.state !== "staged" &&
      internal.state !== "commit-ambiguous" &&
      internal.state !== "commit-not-applied")
  ) {
    throw new TypeError("Restore is not a live validated staging result");
  }
  if (internal.state === "commit-ambiguous") {
    const reconciliationControl = Object.freeze({
      deadlineEpochMs: Date.now() + 5_000,
    });
    const outcome = await reconcileCommitOutcome(
      staged,
      internal,
      reconciliationControl,
    );
    if (outcome.status === "committed") {
      return Object.freeze({
        committed: true,
        restore: staged.restore,
        receipt: outcome.receipt,
      });
    }
    if (outcome.status === "pending") {
      throw new Error("Backup commit outcome remains pending reconciliation");
    }
  }

  const commitAuthority = await resolveCurrentCommitAuthority(staged, internal);
  if (!internal.stagedReceipt) {
    throw new Error("Backup staged receipt is unavailable");
  }
  assertOperationActive(internal.control);
  internal.state = "committing";
  try {
    // The callback is deliberately invoked only after the deadline assertion.
    // Once invoked, any throw/timeout is ambiguous until the durable ledger is
    // queried; abort is never guessed from transport state.
    const commitPromise = internal.staging.commit(internal.session, {
      restore: staged.restore,
      stagedReceipt: internal.stagedReceipt,
      commitAuthority,
      control: internal.control,
    });
    const receipt = assertCommitReceipt(
      internal,
      await awaitWithOperationControl(commitPromise, internal.control),
      commitAuthority,
    );
    stagedRestoreInternals.delete(staged);
    return Object.freeze({
      committed: true,
      restore: staged.restore,
      receipt,
    });
  } catch {
    internal.state = "commit-ambiguous";
    const reconciliationControl = Object.freeze({
      deadlineEpochMs: Date.now() + 5_000,
    });
    let outcome: AgentBackupRestoreCommitOutcome;
    try {
      outcome = await reconcileCommitOutcome(
        staged,
        internal,
        reconciliationControl,
      );
    } catch {
      throw new Error("Backup commit outcome requires durable reconciliation");
    }
    if (outcome.status === "committed") {
      return Object.freeze({
        committed: true,
        restore: staged.restore,
        receipt: outcome.receipt,
      });
    }
    if (outcome.status === "pending") {
      throw new Error("Backup commit outcome remains pending reconciliation");
    }
    throw new Error("Backup commit was durably recorded as not applied");
  }
}

/** Explicitly abandon a validated, definitely-uncommitted staging result. */
export async function abortAgentBackupManifestV2Restore(
  staged: StagedAgentBackupManifestV2Restore,
): Promise<AgentBackupRestoreCleanupReceipt> {
  const internal = stagedRestoreInternals.get(staged);
  if (!internal) {
    throw new TypeError("Restore is not a live validated staging result");
  }
  if (
    internal.state === "commit-ambiguous" ||
    internal.state === "committing"
  ) {
    const outcome = await reconcileCommitOutcome(
      staged,
      internal,
      Object.freeze({ deadlineEpochMs: Date.now() + 5_000 }),
    );
    if (outcome.status === "committed") {
      throw new Error("Committed restore staging cannot be aborted");
    }
    if (outcome.status === "pending") {
      throw new Error("Ambiguous restore commit cannot be aborted");
    }
  }
  if (
    internal.state !== "staged" &&
    internal.state !== "commit-not-applied" &&
    internal.state !== "cleanup-pending"
  ) {
    throw new TypeError("Restore is not abortable");
  }
  const previousState = internal.state;
  internal.state = "aborting";
  try {
    const receipt = await requireCompleteCleanup(
      internal,
      previousState === "commit-not-applied"
        ? "commit-not-applied"
        : "abandoned",
    );
    stagedRestoreInternals.delete(staged);
    return receipt;
  } catch (cause) {
    internal.state = "cleanup-pending";
    throw cause;
  }
}

/** Run one durable cleanup outbox item without requiring an in-memory result. */
export async function reapAgentBackupManifestV2StagingCleanup(
  staging: Pick<AgentBackupRestoreStagingAdapter, "reapCleanup">,
  requestInput: Pick<
    AgentBackupRestoreStagingSession,
    "restoreAttemptId" | "cleanupHandle"
  >,
  controlInput: AgentBackupManifestV2OperationControl,
): Promise<AgentBackupRestoreCleanupReceipt> {
  if (typeof staging?.reapCleanup !== "function") {
    throw new TypeError("Backup staging cleanup reaper is unavailable");
  }
  const request = z
    .strictObject({ restoreAttemptId: UuidSchema, cleanupHandle: UuidSchema })
    .parse(requestInput);
  const control = snapshotOperationControl(controlInput);
  const receipt = RestoreCleanupReceiptSchema.parse(
    await callProviderWithOperationControl(
      "Backup staging cleanup reaper",
      () => staging.reapCleanup(request, control),
      control,
    ),
  );
  if (
    receipt.restoreAttemptId !== request.restoreAttemptId ||
    receipt.cleanupHandle !== request.cleanupHandle
  ) {
    throw new Error(
      "Backup staging cleanup reaper returned a mismatched receipt",
    );
  }
  return deepFreeze(receipt);
}

/** Query a durable attempt after the staging worker/process has disappeared. */
export async function queryAgentBackupManifestV2RestoreCommitOutcome(
  staging: Pick<AgentBackupRestoreStagingAdapter, "queryCommitOutcome">,
  sessionInput: AgentBackupRestoreStagingSession,
  controlInput: AgentBackupManifestV2OperationControl,
): Promise<AgentBackupRestoreCommitOutcome> {
  if (typeof staging?.queryCommitOutcome !== "function") {
    throw new TypeError("Backup commit outcome provider is unavailable");
  }
  const session = RestoreStagingSessionSchema.parse(sessionInput);
  const control = snapshotOperationControl(controlInput);
  const outcome = RestoreCommitOutcomeSchema.parse(
    await callProviderWithOperationControl(
      "Backup commit outcome query",
      () => staging.queryCommitOutcome(session, control),
      control,
    ),
  );
  if (
    outcome.status === "committed" &&
    (outcome.receipt.restoreAttemptId !== session.restoreAttemptId ||
      outcome.receipt.operationId !== session.operationId ||
      outcome.receipt.expectedManifestSha256 !== session.expectedManifestSha256)
  ) {
    throw new Error("Backup commit outcome returned a mismatched receipt");
  }
  if (outcome.status === "committed") {
    assertRestoreLeaseActive(
      outcome.receipt.restoreLease,
      outcome.receipt.committedAt,
    );
  }
  return deepFreeze(outcome);
}

/** Equal operation ids must replay the exact persisted envelopes and nonces. */
export async function assertAgentBackupManifestV2Replay(
  existingInput: unknown,
  replayInput: unknown,
): Promise<AgentBackupManifestV2> {
  const [existing, replay] = await Promise.all([
    parseAgentBackupManifestV2(existingInput),
    parseAgentBackupManifestV2(replayInput),
  ]);
  if (existing.operationId !== replay.operationId) {
    throw new Error("Replay operation ids differ");
  }
  if (existing.integrity.manifestSha256 !== replay.integrity.manifestSha256) {
    throw new Error(
      "The same operation id carries a different canonical backup payload",
    );
  }
  return existing;
}

const LegacyRequiredComponentSchema = z.record(
  z.string().min(1).max(128),
  z.json(),
);

const LegacyComponentHashesSchema = z
  .record(z.string(), Sha256Schema)
  .superRefine((hashes, context) => {
    for (const required of REQUIRED_FULL_COMPONENTS) {
      const legacyName = required === "state-files" ? "stateFiles" : required;
      if (!(legacyName in hashes)) {
        addIssue(
          context,
          [legacyName],
          `Legacy component hash ${legacyName} is required`,
        );
      }
    }
  });

/** Narrow compatibility shape returned only by the explicit v1 parser. */
export const LegacyAgentBackupManifestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.literal(AGENT_BACKUP_MANIFEST_FORMAT),
  createdAt: CanonicalTimestampSchema,
  agentId: UuidSchema,
  components: z.strictObject({
    database: LegacyRequiredComponentSchema,
    media: LegacyRequiredComponentSchema,
    vault: LegacyRequiredComponentSchema,
    character: LegacyRequiredComponentSchema,
    stateFiles: LegacyRequiredComponentSchema,
  }),
  integrity: z.strictObject({ componentHashes: LegacyComponentHashesSchema }),
});

export type LegacyAgentBackupManifestV1 = z.infer<
  typeof LegacyAgentBackupManifestV1Schema
>;

export interface NonRestorableLegacyAgentBackupManifestV1 {
  /** No restore API accepts this compatibility-only wrapper. */
  readonly restorable: false;
  readonly manifest: LegacyAgentBackupManifestV1;
}

/** Parse legacy metadata into an explicitly non-restorable wrapper. */
export function parseLegacyAgentBackupManifestV1(
  input: unknown,
): NonRestorableLegacyAgentBackupManifestV1 {
  const manifest = LegacyAgentBackupManifestV1Schema.parse(input);
  return deepFreeze({ restorable: false, manifest });
}

/** External legacy JSON must use the same pre-parse wire ceiling as v2. */
export function parseLegacyAgentBackupManifestV1Json(
  json: string,
): NonRestorableLegacyAgentBackupManifestV1 {
  assertAgentBackupManifestV2WireBytes(new TextEncoder().encode(json).length);
  return parseLegacyAgentBackupManifestV1(JSON.parse(json));
}
