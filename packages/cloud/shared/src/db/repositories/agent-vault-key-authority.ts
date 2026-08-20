/** Primary-DB authority for immutable, KMS-wrapped agent vault-key generations. */

import { Buffer } from "node:buffer";
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { type KmsClient, orgKey } from "@elizaos/core/security/kms";
import { and, eq, isNull, sql } from "drizzle-orm";
import { isValidUUID } from "../../lib/utils/validation";
import { getKmsClient } from "../crypto/kms-client";
import { dbWrite } from "../helpers";
import {
  agentBackupCatalogAuthorities,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "../schemas/agent-backup-catalog";
import { agentSandboxBackups, agentSandboxes } from "../schemas/agent-sandboxes";
import {
  AGENT_VAULT_KEY_AUTHORITY_FORMAT,
  AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
  AGENT_VAULT_KEY_KMS_CONTEXT_DERIVATION,
  type AgentVaultKeyBackupBinding,
  type AgentVaultKeyGeneration,
  agentVaultKeyAuthorities,
  agentVaultKeyBackupBindings,
  agentVaultKeyGenerations,
} from "../schemas/agent-vault-key-authority";
import { dockerNodes, PLACEABLE_NODE_STATE } from "../schemas/docker-nodes";
import {
  AgentBackupCatalogConflictError,
  lockAgentBackupCatalogAuthority,
  stampAgentBackupCatalogRevision,
} from "./agent-backup-catalog";
import {
  type AgentBackupRestoreSourceV3Input,
  loadAgentBackupRestoreSourceV3,
} from "./agent-backup-restore";
import { hasAgentBackupRestoreAuthority } from "./agent-backup-restore-authority";
import { proveUnambiguousAgentNodeIncarnationForLockedNode } from "./agent-backup-restore-history";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const RAW_KEY_BYTES = 32;
const PASSPHRASE_BYTES = RAW_KEY_BYTES * 2;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const DEFAULT_RESTORE_VAULT_HANDOFF_TIMEOUT_MS = 30_000;
const MAX_RESTORE_VAULT_HANDOFF_TIMEOUT_MS = 60_000;
const RESTORE_VAULT_HANDOFF_AUTHORITY_MARGIN_MS = 1_000;

export class AgentVaultKeyAuthorityError extends Error {
  override readonly name = "AgentVaultKeyAuthorityError";

  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function authorityError(code: string, message: string, cause?: unknown): never {
  throw new AgentVaultKeyAuthorityError(code, message, { cause });
}

function requireCanonicalUuid(value: string, field: string): string {
  if (!isValidUUID(value) || value !== value.toLowerCase()) {
    authorityError("AGENT_VAULT_KEY_INPUT_INVALID", `${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function requireDigest(value: string, field: string): string {
  if (!SHA256_PATTERN.test(value)) {
    authorityError("AGENT_VAULT_KEY_INPUT_INVALID", `${field} must be a lowercase sha256 digest`);
  }
  return value;
}

function requireCanonicalUint64(value: string, field: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    authorityError("AGENT_VAULT_KEY_INPUT_INVALID", `${field} must be a canonical uint64`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) {
    authorityError("AGENT_VAULT_KEY_INPUT_INVALID", `${field} must fit uint64`);
  }
  return parsed;
}

function requireCanonicalText(value: string, field: string, maxBytes: number): string {
  if (
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    authorityError(
      "AGENT_VAULT_KEY_INPUT_INVALID",
      `${field} must be canonical, non-empty, and at most ${maxBytes} bytes`,
    );
  }
  return value;
}

function requireProviderKeyVersion(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    authorityError(
      "AGENT_VAULT_KEY_KMS_PROVIDER_INVALID",
      `${field} must be a positive safe integer`,
    );
  }
  return value;
}

function keyVersionForProvider(value: bigint): number {
  if (value < 1n || value > MAX_SAFE_INTEGER_BIGINT) {
    authorityError(
      "AGENT_VAULT_KEY_AUTHORITY_CORRUPT",
      "Vault-key KMS version is outside the provider safe-integer range",
    );
  }
  return Number(value);
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeDigestMatch(actual: string, expected: string): boolean {
  if (!SHA256_PATTERN.test(actual) || !SHA256_PATTERN.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function canonicalKmsContext(input: {
  organizationId: string;
  agentId: string;
  generationId: string;
  sourceActivationGeneration: string;
}): string {
  return JSON.stringify({
    derivation: AGENT_VAULT_KEY_KMS_CONTEXT_DERIVATION,
    organizationId: input.organizationId,
    agentId: input.agentId,
    generationId: input.generationId,
    sourceActivationGeneration: input.sourceActivationGeneration,
  });
}

function envelopeBytes(input: {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
}): Uint8Array {
  if (
    input.nonce.byteLength !== 12 ||
    input.ciphertext.byteLength !== RAW_KEY_BYTES ||
    input.authTag.byteLength !== 16
  ) {
    authorityError(
      "AGENT_VAULT_KEY_KMS_PROVIDER_INVALID",
      "KMS returned an invalid vault-key AEAD envelope",
    );
  }
  const envelope = new Uint8Array(
    input.nonce.byteLength + input.ciphertext.byteLength + input.authTag.byteLength,
  );
  envelope.set(input.nonce, 0);
  envelope.set(input.ciphertext, input.nonce.byteLength);
  envelope.set(input.authTag, input.nonce.byteLength + input.ciphertext.byteLength);
  return envelope;
}

function authorityReceiptDigest(input: {
  organizationId: string;
  agentId: string;
  generationId: string;
  sourceActivationGeneration: string;
  supersedesGenerationId: string | null;
  kmsKeyId: string;
  kmsKeyVersion: number;
  kmsContext: string;
  wrappedEnvelopeSha256: string;
}): string {
  return sha256Hex(
    JSON.stringify({
      derivation: AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
      format: AGENT_VAULT_KEY_AUTHORITY_FORMAT,
      organizationId: input.organizationId,
      agentId: input.agentId,
      generationId: input.generationId,
      sourceActivationGeneration: input.sourceActivationGeneration,
      supersedesGenerationId: input.supersedesGenerationId,
      kmsKeyId: input.kmsKeyId,
      kmsKeyVersion: input.kmsKeyVersion,
      kmsContextSha256: sha256Hex(input.kmsContext),
      wrappedEnvelopeSha256: input.wrappedEnvelopeSha256,
    }),
  );
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
}

function decodeCanonicalBase64(value: string, expectedBytes: number, field: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    authorityError("AGENT_VAULT_KEY_ENVELOPE_INVALID", `${field} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  try {
    if (decoded.byteLength !== expectedBytes || decoded.toString("base64") !== value) {
      authorityError("AGENT_VAULT_KEY_ENVELOPE_INVALID", `${field} has an invalid encoded length`);
    }
    return Uint8Array.from(decoded);
  } finally {
    decoded.fill(0);
  }
}

function rawKeyToPassphrase(rawKey: Uint8Array): Uint8Array {
  if (rawKey.byteLength !== RAW_KEY_BYTES) {
    authorityError(
      "AGENT_VAULT_KEY_KMS_PROVIDER_INVALID",
      "Decrypted vault key must contain exactly 32 bytes",
    );
  }
  const alphabet = "0123456789abcdef";
  const passphrase = new Uint8Array(PASSPHRASE_BYTES);
  for (let index = 0; index < rawKey.byteLength; index += 1) {
    const byte = rawKey[index] as number;
    passphrase[index * 2] = alphabet.charCodeAt(byte >>> 4);
    passphrase[index * 2 + 1] = alphabet.charCodeAt(byte & 0x0f);
  }
  return passphrase;
}

function byteRangesOverlap(left: Uint8Array, right: Uint8Array): boolean {
  if (left.buffer !== right.buffer) return false;
  const leftEnd = left.byteOffset + left.byteLength;
  const rightEnd = right.byteOffset + right.byteLength;
  return left.byteOffset < rightEnd && right.byteOffset < leftEnd;
}

export class AgentVaultKeySecretHandle {
  private rawKey: Uint8Array | null;

  constructor(rawKey: Uint8Array) {
    if (rawKey.byteLength !== RAW_KEY_BYTES) {
      authorityError(
        "AGENT_VAULT_KEY_KMS_PROVIDER_INVALID",
        "Vault-key handle requires exactly 32 secret bytes",
      );
    }
    this.rawKey = rawKey;
  }

  get released(): boolean {
    return this.rawKey === null;
  }

  async withPassphrase<T>(
    use: (passphrase: Uint8Array) => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.rawKey) {
      authorityError("AGENT_VAULT_KEY_HANDLE_RELEASED", "Vault-key handle was already released");
    }
    const passphrase = rawKeyToPassphrase(this.rawKey);
    const zeroize = () => passphrase.fill(0);
    signal?.addEventListener("abort", zeroize, { once: true });
    try {
      signal?.throwIfAborted();
      return await use(passphrase);
    } finally {
      signal?.removeEventListener("abort", zeroize);
      zeroize();
    }
  }

  release(): void {
    this.rawKey?.fill(0);
    this.rawKey = null;
  }
}

function validateGenerationIntegrity(generation: Readonly<AgentVaultKeyGeneration>): {
  kmsKeyVersion: number;
} {
  const expectedContext = canonicalKmsContext({
    organizationId: generation.organization_id,
    agentId: generation.agent_id,
    generationId: generation.generation_id,
    sourceActivationGeneration: generation.source_activation_generation,
  });
  const expectedKmsKeyId = requireCanonicalText(
    orgKey(generation.organization_id, "dek"),
    "kms_key_id",
    512,
  );
  const kmsKeyVersion = keyVersionForProvider(generation.kms_key_version);
  if (
    generation.format !== AGENT_VAULT_KEY_AUTHORITY_FORMAT ||
    generation.kms_context_derivation !== AGENT_VAULT_KEY_KMS_CONTEXT_DERIVATION ||
    generation.kms_context !== expectedContext ||
    generation.kms_key_id !== expectedKmsKeyId
  ) {
    authorityError(
      "AGENT_VAULT_KEY_AUTHORITY_CORRUPT",
      "Vault-key generation differs from its canonical tenant/KMS authority",
    );
  }
  let ciphertext: Uint8Array | null = null;
  let nonce: Uint8Array | null = null;
  let authTag: Uint8Array | null = null;
  let envelope: Uint8Array | null = null;
  try {
    ciphertext = decodeCanonicalBase64(
      generation.wrapped_ciphertext_base64,
      RAW_KEY_BYTES,
      "wrapped_ciphertext_base64",
    );
    nonce = decodeCanonicalBase64(generation.wrapped_nonce_base64, 12, "wrapped_nonce_base64");
    authTag = decodeCanonicalBase64(
      generation.wrapped_auth_tag_base64,
      16,
      "wrapped_auth_tag_base64",
    );
    envelope = envelopeBytes({ nonce, ciphertext, authTag });
    const envelopeDigest = sha256Hex(envelope);
    const receiptDigest = authorityReceiptDigest({
      organizationId: generation.organization_id,
      agentId: generation.agent_id,
      generationId: generation.generation_id,
      sourceActivationGeneration: generation.source_activation_generation,
      supersedesGenerationId: generation.supersedes_generation_id,
      kmsKeyId: generation.kms_key_id,
      kmsKeyVersion,
      kmsContext: generation.kms_context,
      wrappedEnvelopeSha256: envelopeDigest,
    });
    if (
      !constantTimeDigestMatch(envelopeDigest, generation.wrapped_envelope_sha256) ||
      generation.authority_receipt_derivation !== AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION ||
      !constantTimeDigestMatch(receiptDigest, generation.authority_receipt_digest)
    ) {
      authorityError(
        "AGENT_VAULT_KEY_AUTHORITY_CORRUPT",
        "Vault-key envelope or authority receipt digest does not match",
      );
    }
    return { kmsKeyVersion };
  } finally {
    ciphertext?.fill(0);
    nonce?.fill(0);
    authTag?.fill(0);
    envelope?.fill(0);
  }
}

async function decryptGeneration(
  generation: Readonly<AgentVaultKeyGeneration>,
  kms: KmsClient,
): Promise<Uint8Array> {
  const { kmsKeyVersion } = validateGenerationIntegrity(generation);
  let ciphertext: Uint8Array | null = null;
  let nonce: Uint8Array | null = null;
  let authTag: Uint8Array | null = null;
  try {
    ciphertext = decodeCanonicalBase64(
      generation.wrapped_ciphertext_base64,
      RAW_KEY_BYTES,
      "wrapped_ciphertext_base64",
    );
    nonce = decodeCanonicalBase64(generation.wrapped_nonce_base64, 12, "wrapped_nonce_base64");
    authTag = decodeCanonicalBase64(
      generation.wrapped_auth_tag_base64,
      16,
      "wrapped_auth_tag_base64",
    );
    const decrypted = await kms.decrypt(
      generation.kms_key_id,
      ciphertext,
      nonce,
      authTag,
      new TextEncoder().encode(generation.kms_context),
      kmsKeyVersion,
    );
    try {
      if (decrypted.byteLength !== RAW_KEY_BYTES) {
        authorityError(
          "AGENT_VAULT_KEY_KMS_PROVIDER_INVALID",
          "KMS returned an invalid vault-key plaintext length",
        );
      }
      return Uint8Array.from(decrypted);
    } finally {
      decrypted.fill(0);
    }
  } catch (error) {
    if (error instanceof AgentVaultKeyAuthorityError) throw error;
    throw new AgentVaultKeyAuthorityError(
      "AGENT_VAULT_KEY_UNWRAP_FAILED",
      "KMS could not unwrap vault-key authority",
      { cause: error },
    );
  } finally {
    ciphertext?.fill(0);
    nonce?.fill(0);
    authTag?.fill(0);
  }
}

export interface CreateOrRotateAgentVaultKeyGenerationInput {
  organizationId: string;
  agentId: string;
  generationId: string;
  sourceActivationGeneration: string;
  /** Null creates the first authority; a UUID is the exact rotation CAS. */
  expectedCurrentGenerationId: string | null;
}

export interface CreateOrRotateAgentVaultKeyGenerationOptions {
  kmsClient?: KmsClient;
  randomBytes?: (size: number) => Uint8Array;
}

export interface AgentVaultKeyGenerationAcquisition {
  replayed: boolean;
  authority: Readonly<{
    format: typeof AGENT_VAULT_KEY_AUTHORITY_FORMAT;
    generationId: string;
    receiptDerivation: typeof AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION;
    receiptDigest: string;
  }>;
  generation: Readonly<AgentVaultKeyGeneration>;
  secret: AgentVaultKeySecretHandle;
}

/**
 * Create or rotate under exact activation and current-generation fences.
 * This API stays definition-only until a coordinator can move KMS latency
 * outside the authority-lock window without weakening replay or zeroization.
 */
export async function createOrRotateAgentVaultKeyGeneration(
  input: Readonly<CreateOrRotateAgentVaultKeyGenerationInput>,
  options: Readonly<CreateOrRotateAgentVaultKeyGenerationOptions> = {},
): Promise<AgentVaultKeyGenerationAcquisition> {
  requireCanonicalUuid(input.organizationId, "organizationId");
  requireCanonicalUuid(input.agentId, "agentId");
  requireCanonicalUuid(input.generationId, "generationId");
  requireCanonicalUuid(input.sourceActivationGeneration, "sourceActivationGeneration");
  if (input.expectedCurrentGenerationId !== null) {
    requireCanonicalUuid(input.expectedCurrentGenerationId, "expectedCurrentGenerationId");
  }
  const kms = options.kmsClient ?? getKmsClient();
  const entropy = options.randomBytes ?? ((size: number) => nodeRandomBytes(size));
  let transientRawKey: Uint8Array | null = null;

  try {
    const committed = await dbWrite.transaction(async (tx) => {
      const [sandbox] = await tx
        .select({ id: agentSandboxes.id })
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, input.agentId),
            eq(agentSandboxes.organization_id, input.organizationId),
            eq(agentSandboxes.activation_generation, input.sourceActivationGeneration),
            eq(agentSandboxes.activation_phase, "active"),
            isNull(agentSandboxes.deleted_at),
          ),
        )
        .for("update")
        .limit(1);
      if (!sandbox) {
        authorityError(
          "AGENT_VAULT_KEY_SOURCE_FENCE_LOST",
          "Agent activation no longer matches the vault-key source generation",
        );
      }
      await tx
        .insert(agentBackupCatalogAuthorities)
        .values({ organization_id: input.organizationId, agent_id: input.agentId })
        .onConflictDoNothing();
      await lockAgentBackupCatalogAuthority(tx, input.organizationId, input.agentId);

      const [current] = await tx
        .select()
        .from(agentVaultKeyAuthorities)
        .where(
          and(
            eq(agentVaultKeyAuthorities.organization_id, input.organizationId),
            eq(agentVaultKeyAuthorities.agent_id, input.agentId),
          ),
        )
        .for("update")
        .limit(1);
      const [existing] = await tx
        .select()
        .from(agentVaultKeyGenerations)
        .where(
          and(
            eq(agentVaultKeyGenerations.organization_id, input.organizationId),
            eq(agentVaultKeyGenerations.agent_id, input.agentId),
            eq(agentVaultKeyGenerations.generation_id, input.generationId),
          ),
        )
        .for("no key update")
        .limit(1);
      if (existing) {
        if (
          existing.source_activation_generation !== input.sourceActivationGeneration ||
          existing.supersedes_generation_id !== input.expectedCurrentGenerationId ||
          current?.current_generation_id !== input.generationId
        ) {
          authorityError(
            "AGENT_VAULT_KEY_REPLAY_MISMATCH",
            "Vault-key replay differs from committed source/rotation authority",
          );
        }
        transientRawKey = await decryptGeneration(existing, kms);
        return { generation: existing, replayed: true };
      }
      if ((current?.current_generation_id ?? null) !== input.expectedCurrentGenerationId) {
        authorityError(
          "AGENT_VAULT_KEY_ROTATION_CAS_LOST",
          "Vault-key current generation changed before rotation",
        );
      }

      const generated = entropy(RAW_KEY_BYTES);
      if (!(generated instanceof Uint8Array) || generated.byteLength !== RAW_KEY_BYTES) {
        authorityError(
          "AGENT_VAULT_KEY_ENTROPY_INVALID",
          "Vault-key entropy provider must return exactly 32 bytes",
        );
      }
      transientRawKey = Uint8Array.from(generated);
      generated.fill(0);
      const kmsContext = canonicalKmsContext(input);
      const kmsKeyId = requireCanonicalText(orgKey(input.organizationId, "dek"), "kmsKeyId", 512);
      await kms.getOrCreateKey(kmsKeyId);
      const encrypted = await kms.encrypt(
        kmsKeyId,
        transientRawKey,
        new TextEncoder().encode(kmsContext),
      );
      const kmsKeyVersion = requireProviderKeyVersion(encrypted.keyVersion, "keyVersion");
      if (encrypted.keyId !== kmsKeyId) {
        authorityError(
          "AGENT_VAULT_KEY_KMS_PROVIDER_INVALID",
          "KMS returned a foreign vault-key authority",
        );
      }
      const wrappedEnvelope = envelopeBytes(encrypted);
      try {
        const verified = await kms.decrypt(
          encrypted.keyId,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          new TextEncoder().encode(kmsContext),
          kmsKeyVersion,
        );
        try {
          if (
            verified.byteLength !== transientRawKey.byteLength ||
            !timingSafeEqual(
              Buffer.from(verified.buffer, verified.byteOffset, verified.byteLength),
              Buffer.from(
                transientRawKey.buffer,
                transientRawKey.byteOffset,
                transientRawKey.byteLength,
              ),
            )
          ) {
            authorityError(
              "AGENT_VAULT_KEY_KMS_PROVIDER_INVALID",
              "KMS vault-key envelope did not immediately round-trip",
            );
          }
        } finally {
          if (!byteRangesOverlap(verified, transientRawKey)) verified.fill(0);
        }

        const wrappedEnvelopeSha256 = sha256Hex(wrappedEnvelope);
        const receiptDigest = authorityReceiptDigest({
          organizationId: input.organizationId,
          agentId: input.agentId,
          generationId: input.generationId,
          sourceActivationGeneration: input.sourceActivationGeneration,
          supersedesGenerationId: input.expectedCurrentGenerationId,
          kmsKeyId: encrypted.keyId,
          kmsKeyVersion,
          kmsContext,
          wrappedEnvelopeSha256,
        });
        const [generation] = await tx
          .insert(agentVaultKeyGenerations)
          .values({
            organization_id: input.organizationId,
            agent_id: input.agentId,
            generation_id: input.generationId,
            source_activation_generation: input.sourceActivationGeneration,
            supersedes_generation_id: input.expectedCurrentGenerationId,
            format: AGENT_VAULT_KEY_AUTHORITY_FORMAT,
            kms_key_id: encrypted.keyId,
            kms_key_version: BigInt(kmsKeyVersion),
            kms_context: kmsContext,
            kms_context_derivation: AGENT_VAULT_KEY_KMS_CONTEXT_DERIVATION,
            wrapped_ciphertext_base64: encodeBase64(encrypted.ciphertext),
            wrapped_nonce_base64: encodeBase64(encrypted.nonce),
            wrapped_auth_tag_base64: encodeBase64(encrypted.authTag),
            wrapped_envelope_sha256: wrappedEnvelopeSha256,
            authority_receipt_derivation: AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
            authority_receipt_digest: receiptDigest,
          })
          .returning();
        if (!generation) {
          authorityError("AGENT_VAULT_KEY_INSERT_LOST", "Vault-key insert returned no authority");
        }
        if (current) {
          const [rotated] = await tx
            .update(agentVaultKeyAuthorities)
            .set({
              current_generation_id: input.generationId,
              revision: sql`${agentVaultKeyAuthorities.revision} + 1`,
              updated_at: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(agentVaultKeyAuthorities.organization_id, input.organizationId),
                eq(agentVaultKeyAuthorities.agent_id, input.agentId),
                eq(
                  agentVaultKeyAuthorities.current_generation_id,
                  input.expectedCurrentGenerationId as string,
                ),
              ),
            )
            .returning({ generationId: agentVaultKeyAuthorities.current_generation_id });
          if (!rotated) {
            authorityError(
              "AGENT_VAULT_KEY_ROTATION_CAS_LOST",
              "Vault-key current-generation rotation CAS was lost",
            );
          }
        } else {
          await tx.insert(agentVaultKeyAuthorities).values({
            organization_id: input.organizationId,
            agent_id: input.agentId,
            current_generation_id: input.generationId,
          });
        }
        return { generation, replayed: false };
      } finally {
        wrappedEnvelope.fill(0);
      }
    });

    if (!transientRawKey) {
      authorityError(
        "AGENT_VAULT_KEY_HANDLE_MISSING",
        "Committed vault-key generation returned no transient key handle",
      );
    }
    const secret = new AgentVaultKeySecretHandle(transientRawKey);
    transientRawKey = null;
    return {
      replayed: committed.replayed,
      authority: Object.freeze({
        format: AGENT_VAULT_KEY_AUTHORITY_FORMAT,
        generationId: committed.generation.generation_id,
        receiptDerivation: AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
        receiptDigest: committed.generation.authority_receipt_digest,
      }),
      generation: Object.freeze({ ...committed.generation }),
      secret,
    };
  } catch (error) {
    const keyToZero = transientRawKey as Uint8Array | null;
    keyToZero?.fill(0);
    if (error instanceof AgentVaultKeyAuthorityError) throw error;
    authorityError(
      "AGENT_VAULT_KEY_CREATE_FAILED",
      "Could not create or rotate vault-key authority",
      error,
    );
  }
}

/** Read the current manifest pointer without exposing or unwrapping its key. */
export async function loadCurrentAgentVaultKeyAuthority(input: {
  organizationId: string;
  agentId: string;
}): Promise<AgentVaultKeyGenerationAcquisition["authority"]> {
  requireCanonicalUuid(input.organizationId, "organizationId");
  requireCanonicalUuid(input.agentId, "agentId");
  const [row] = await dbWrite
    .select()
    .from(agentVaultKeyAuthorities)
    .innerJoin(
      agentVaultKeyGenerations,
      and(
        eq(agentVaultKeyGenerations.organization_id, agentVaultKeyAuthorities.organization_id),
        eq(agentVaultKeyGenerations.agent_id, agentVaultKeyAuthorities.agent_id),
        eq(agentVaultKeyGenerations.generation_id, agentVaultKeyAuthorities.current_generation_id),
      ),
    )
    .where(
      and(
        eq(agentVaultKeyAuthorities.organization_id, input.organizationId),
        eq(agentVaultKeyAuthorities.agent_id, input.agentId),
      ),
    )
    .limit(1);
  const generation = row?.agent_vault_key_generations;
  if (!generation) {
    authorityError(
      "AGENT_VAULT_KEY_AUTHORITY_MISSING",
      "Current vault-key generation is absent or has an unknown format",
    );
  }
  validateGenerationIntegrity(generation);
  return Object.freeze({
    format: AGENT_VAULT_KEY_AUTHORITY_FORMAT,
    generationId: generation.generation_id,
    receiptDerivation: AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
    receiptDigest: generation.authority_receipt_digest,
  });
}

export interface BindAgentBackupVaultKeyGenerationInput {
  organizationId: string;
  agentId: string;
  backupId: string;
  operationId: string;
  sourceActivationGeneration: string;
  sourceLifecycleRevision: string;
  manifestSha256: string;
  vaultKeyGenerationId: string;
  vaultKeyAuthorityReceiptDigest: string;
}

/** Bind one captured manifest-v3 to the exact immutable generation it names. */
export async function bindAgentBackupVaultKeyGeneration(
  input: Readonly<BindAgentBackupVaultKeyGenerationInput>,
): Promise<Readonly<AgentVaultKeyBackupBinding>> {
  requireCanonicalUuid(input.organizationId, "organizationId");
  requireCanonicalUuid(input.agentId, "agentId");
  requireCanonicalUuid(input.backupId, "backupId");
  requireCanonicalUuid(input.operationId, "operationId");
  requireCanonicalUuid(input.sourceActivationGeneration, "sourceActivationGeneration");
  const sourceLifecycleRevision = requireCanonicalUint64(
    input.sourceLifecycleRevision,
    "sourceLifecycleRevision",
  );
  requireDigest(input.manifestSha256, "manifestSha256");
  requireCanonicalUuid(input.vaultKeyGenerationId, "vaultKeyGenerationId");
  requireDigest(input.vaultKeyAuthorityReceiptDigest, "vaultKeyAuthorityReceiptDigest");

  return dbWrite.transaction(async (tx) => {
    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, input.backupId),
          eq(agentSandboxBackups.catalog_organization_id, input.organizationId),
          eq(agentSandboxBackups.catalog_agent_id, input.agentId),
          eq(agentSandboxBackups.backup_operation_id, input.operationId),
          eq(agentSandboxBackups.lifecycle_generation, input.sourceActivationGeneration),
          eq(agentSandboxBackups.lifecycle_revision, sourceLifecycleRevision),
          eq(agentSandboxBackups.manifest_digest, input.manifestSha256),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !backup?.catalog_state ||
      backup.manifest_version !== 3 ||
      backup.vault_key_generation_id !== input.vaultKeyGenerationId ||
      backup.vault_key_authority_receipt_digest !== input.vaultKeyAuthorityReceiptDigest
    ) {
      throw new AgentBackupCatalogConflictError(
        "Manifest-v3 backup differs from the requested vault-key binding",
      );
    }
    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      input.organizationId,
      input.agentId,
    );
    const [generation] = await tx
      .select()
      .from(agentVaultKeyGenerations)
      .where(
        and(
          eq(agentVaultKeyGenerations.organization_id, input.organizationId),
          eq(agentVaultKeyGenerations.agent_id, input.agentId),
          eq(agentVaultKeyGenerations.generation_id, input.vaultKeyGenerationId),
          eq(
            agentVaultKeyGenerations.authority_receipt_digest,
            input.vaultKeyAuthorityReceiptDigest,
          ),
        ),
      )
      .for("no key update")
      .limit(1);
    if (!generation) {
      throw new AgentBackupCatalogConflictError(
        "Manifest-v3 vault-key generation is absent or differs from primary authority",
      );
    }
    validateGenerationIntegrity(generation);
    const values = {
      organization_id: input.organizationId,
      agent_id: input.agentId,
      backup_id: input.backupId,
      operation_id: input.operationId,
      source_activation_generation: input.sourceActivationGeneration,
      source_lifecycle_revision: sourceLifecycleRevision,
      manifest_sha256: input.manifestSha256,
      vault_key_generation_id: input.vaultKeyGenerationId,
      vault_key_authority_receipt_digest: input.vaultKeyAuthorityReceiptDigest,
    } as const;
    const [inserted] = await tx
      .insert(agentVaultKeyBackupBindings)
      .values(values)
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      await stampAgentBackupCatalogRevision(tx, {
        backupId: input.backupId,
        organizationId: input.organizationId,
        agentId: input.agentId,
        expectedRevision: authority.catalog_revision,
      });
      return Object.freeze({ ...inserted });
    }
    const [existing] = await tx
      .select()
      .from(agentVaultKeyBackupBindings)
      .where(
        and(
          eq(agentVaultKeyBackupBindings.organization_id, input.organizationId),
          eq(agentVaultKeyBackupBindings.backup_id, input.backupId),
        ),
      )
      .limit(1);
    if (
      !existing ||
      existing.agent_id !== values.agent_id ||
      existing.operation_id !== values.operation_id ||
      existing.source_activation_generation !== values.source_activation_generation ||
      existing.source_lifecycle_revision !== values.source_lifecycle_revision ||
      existing.manifest_sha256 !== values.manifest_sha256 ||
      existing.vault_key_generation_id !== values.vault_key_generation_id ||
      existing.vault_key_authority_receipt_digest !== values.vault_key_authority_receipt_digest
    ) {
      throw new AgentBackupCatalogConflictError("Vault-key backup binding replay mismatch");
    }
    return Object.freeze({ ...existing });
  });
}

export interface AgentBackupRestoreVaultPassphraseInput extends AgentBackupRestoreSourceV3Input {
  /** Durable restore coordinator row; distinct from the source backup operation. */
  restoreOperationId: string;
  restoreClaimGeneration: string;
  targetNodeRecordId: string;
  targetNodeIncarnation: string;
  vaultKeyGenerationId: string;
  vaultKeyAuthorityReceiptDigest: string;
}

export interface AgentBackupRestoreVaultPassphraseOptions {
  kmsClient?: KmsClient;
  /** Hard deadline for the one remote vault handoff; defaults to 30 seconds. */
  handoffTimeoutMs?: number;
}

function requireRestoreVaultHandoffTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_RESTORE_VAULT_HANDOFF_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_RESTORE_VAULT_HANDOFF_TIMEOUT_MS
  ) {
    authorityError(
      "AGENT_VAULT_KEY_INPUT_INVALID",
      `handoffTimeoutMs must be an integer between 1 and ${MAX_RESTORE_VAULT_HANDOFF_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

interface AgentBackupRestoreVaultTargetHandoff<T> {
  run: (signal: AbortSignal) => Promise<T> | T;
}

async function runBoundedAgentBackupRestoreVaultTargetHandoff<T>(
  handoff: Readonly<AgentBackupRestoreVaultTargetHandoff<T>>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new AgentVaultKeyAuthorityError(
    "AGENT_VAULT_KEY_HANDOFF_TIMEOUT",
    `Restore vault handoff exceeded ${timeoutMs}ms`,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => handoff.run(controller.signal)),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadAgentBackupRestoreVaultGeneration(
  input: Readonly<AgentBackupRestoreVaultPassphraseInput>,
): Promise<
  Readonly<{
    generation: Readonly<AgentVaultKeyGeneration>;
    manifestImageDigest: string;
  }>
> {
  requireCanonicalUuid(input.vaultKeyGenerationId, "vaultKeyGenerationId");
  requireDigest(input.vaultKeyAuthorityReceiptDigest, "vaultKeyAuthorityReceiptDigest");
  const source = await loadAgentBackupRestoreSourceV3(input);
  if (
    source.vaultKeyAuthority.generationId !== input.vaultKeyGenerationId ||
    source.vaultKeyAuthority.authorityReceiptDigest !== input.vaultKeyAuthorityReceiptDigest
  ) {
    throw new AgentBackupCatalogConflictError(
      "Restore vault-key authority differs from its exact manifest-v3 source",
    );
  }

  const [generation] = await dbWrite
    .select()
    .from(agentVaultKeyGenerations)
    .where(
      and(
        eq(agentVaultKeyGenerations.organization_id, input.organizationId),
        eq(agentVaultKeyGenerations.agent_id, input.agentId),
        eq(agentVaultKeyGenerations.generation_id, input.vaultKeyGenerationId),
        eq(agentVaultKeyGenerations.authority_receipt_digest, input.vaultKeyAuthorityReceiptDigest),
      ),
    )
    .limit(1);
  if (!generation) {
    throw new AgentBackupCatalogConflictError(
      "Restore source is missing its exact retained vault-key generation",
    );
  }
  validateGenerationIntegrity(generation);
  return Object.freeze({
    generation: Object.freeze({ ...generation }),
    manifestImageDigest: source.manifest.runtime.imageDigest,
  });
}

/**
 * Prove that this callback still belongs to one live, claimed, target-pinned
 * restore. Locks follow backup -> operation -> lease -> node -> catalogue.
 *
 * The optional handoff runs only after the final proof and while every authority
 * lock is still held. It is reserved for one bounded, timeout-protected remote
 * vault operation and must never issue or re-enter primary-DB work.
 */
async function proveAgentBackupRestoreVaultTargetAuthority(
  input: Readonly<AgentBackupRestoreVaultPassphraseInput>,
  manifestImageDigest: string,
  handoffTimeoutMs: number,
): Promise<void>;
async function proveAgentBackupRestoreVaultTargetAuthority<T>(
  input: Readonly<AgentBackupRestoreVaultPassphraseInput>,
  manifestImageDigest: string,
  handoffTimeoutMs: number,
  handoff: Readonly<AgentBackupRestoreVaultTargetHandoff<T>>,
): Promise<T>;
async function proveAgentBackupRestoreVaultTargetAuthority(
  input: Readonly<AgentBackupRestoreVaultPassphraseInput>,
  manifestImageDigest: string,
  handoffTimeoutMs: number,
  handoff?: Readonly<AgentBackupRestoreVaultTargetHandoff<unknown>>,
): Promise<unknown> {
  const restoreOperationId = requireCanonicalUuid(input.restoreOperationId, "restoreOperationId");
  const restoreClaimGeneration = requireCanonicalUuid(
    input.restoreClaimGeneration,
    "restoreClaimGeneration",
  );
  const targetNodeRecordId = requireCanonicalUuid(input.targetNodeRecordId, "targetNodeRecordId");
  const targetNodeIncarnation = requireCanonicalUuid(
    input.targetNodeIncarnation,
    "targetNodeIncarnation",
  );
  const sourceLifecycleRevision = requireCanonicalUint64(
    input.sourceLifecycleRevision,
    "sourceLifecycleRevision",
  );
  const catalogEpoch = requireCanonicalUint64(input.catalogEpoch, "catalogEpoch");

  return await dbWrite.transaction(async (tx) => {
    const [backup] = await tx
      .select({
        catalogState: agentSandboxBackups.catalog_state,
        manifestVersion: agentSandboxBackups.manifest_version,
      })
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, input.backupId),
          eq(agentSandboxBackups.catalog_organization_id, input.organizationId),
          eq(agentSandboxBackups.catalog_agent_id, input.agentId),
          eq(agentSandboxBackups.backup_operation_id, input.operationId),
          eq(agentSandboxBackups.lifecycle_generation, input.sourceActivationGeneration),
          eq(agentSandboxBackups.lifecycle_revision, sourceLifecycleRevision),
          eq(agentSandboxBackups.manifest_digest, input.expectedManifestSha256),
          eq(agentSandboxBackups.image_digest, manifestImageDigest),
          eq(agentSandboxBackups.vault_key_generation_id, input.vaultKeyGenerationId),
          eq(
            agentSandboxBackups.vault_key_authority_receipt_digest,
            input.vaultKeyAuthorityReceiptDigest,
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !backup ||
      !hasAgentBackupRestoreAuthority(backup.catalogState) ||
      backup.manifestVersion !== 3
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore vault backup authority is absent, non-restorable, or no longer exact",
      );
    }

    const [operation] = await tx
      .select()
      .from(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.id, restoreOperationId))
      .for("update")
      .limit(1);
    if (!operation) {
      throw new AgentBackupCatalogConflictError("Restore vault operation is missing");
    }
    if (
      operation.organization_id !== input.organizationId ||
      operation.agent_id !== input.agentId ||
      operation.backup_id !== input.backupId ||
      operation.restore_attempt_id !== input.restoreAttemptId ||
      operation.lease_id !== input.leaseId ||
      operation.lease_generation !== input.fencingToken ||
      operation.lease_owner_id !== input.ownerId ||
      operation.catalog_epoch !== catalogEpoch ||
      operation.copy_role !== input.copyRole ||
      operation.expected_operation_id !== input.operationId ||
      operation.expected_activation_generation !== input.sourceActivationGeneration ||
      operation.expected_lifecycle_revision !== sourceLifecycleRevision ||
      operation.expected_manifest_sha256 !== input.expectedManifestSha256
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore vault operation differs from its exact source and lease authority",
      );
    }
    if (
      operation.phase !== "reserved" &&
      !(operation.phase === "failed_retryable" && operation.resume_phase === "reserved")
    ) {
      throw new AgentBackupCatalogConflictError(
        `Restore vault operation is not resumable from reserved (phase ${operation.phase})`,
      );
    }
    if (
      operation.expected_node_record_id !== targetNodeRecordId ||
      operation.expected_node_incarnation !== targetNodeIncarnation ||
      operation.expected_image_digest !== manifestImageDigest
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore vault operation lacks its exact complete target authority",
      );
    }

    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, input.leaseId),
          eq(agentBackupRestoreLeases.organization_id, input.organizationId),
          eq(agentBackupRestoreLeases.agent_id, input.agentId),
          eq(agentBackupRestoreLeases.backup_id, input.backupId),
          eq(agentBackupRestoreLeases.operation_id, input.operationId),
          eq(agentBackupRestoreLeases.activation_generation, input.sourceActivationGeneration),
          eq(agentBackupRestoreLeases.lifecycle_revision, sourceLifecycleRevision),
          eq(agentBackupRestoreLeases.expected_manifest_sha256, input.expectedManifestSha256),
          eq(agentBackupRestoreLeases.copy_role, input.copyRole),
          eq(agentBackupRestoreLeases.restore_attempt_id, input.restoreAttemptId),
          eq(agentBackupRestoreLeases.owner_id, input.ownerId),
          eq(agentBackupRestoreLeases.generation, input.fencingToken),
          eq(agentBackupRestoreLeases.catalog_epoch, catalogEpoch),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) {
      throw new AgentBackupCatalogConflictError("Restore vault lease fence was lost");
    }

    const [node] = await tx
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, targetNodeRecordId))
      .for("update")
      .limit(1);
    if (!node || node.node_incarnation !== targetNodeIncarnation) {
      throw new AgentBackupCatalogConflictError(
        "Restore vault target node record or incarnation was lost",
      );
    }
    await proveUnambiguousAgentNodeIncarnationForLockedNode(tx, node, targetNodeIncarnation);

    const catalogAuthority = await lockAgentBackupCatalogAuthority(
      tx,
      input.organizationId,
      input.agentId,
    );
    if (catalogAuthority.catalog_revision !== catalogEpoch) {
      throw new AgentBackupCatalogConflictError(
        "Restore vault target was invalidated by a catalogue revision",
      );
    }

    // Read the primary clock only after all authority locks: a wait on the node
    // or catalogue must not let an expired claim or lease authorize material.
    const databaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at <= databaseNow) {
      throw new AgentBackupCatalogConflictError("Restore vault lease is expired or released");
    }
    if (
      operation.claim_owner !== input.ownerId ||
      operation.claim_generation !== restoreClaimGeneration ||
      operation.claim_expires_at === null ||
      operation.claim_expires_at <= databaseNow
    ) {
      throw new AgentBackupCatalogConflictError("Restore vault operation claim is not live");
    }
    if (
      !node.enabled ||
      node.status !== "healthy" ||
      node.placement_state !== PLACEABLE_NODE_STATE ||
      node.metadata.capacityProvisional === true
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore vault target is not an enabled, healthy, open existing node",
      );
    }

    const requiredUntil =
      databaseNow.getTime() + handoffTimeoutMs + RESTORE_VAULT_HANDOFF_AUTHORITY_MARGIN_MS;
    if (
      lease.expires_at.getTime() < requiredUntil ||
      operation.claim_expires_at.getTime() < requiredUntil
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore vault lease and claim do not cover the bounded remote handoff plus authority margin",
      );
    }

    if (handoff) {
      const result = await runBoundedAgentBackupRestoreVaultTargetHandoff(
        handoff,
        handoffTimeoutMs,
      );
      const afterHandoffDatabaseNow = await readPostLockDatabaseNow(tx);
      if (
        lease.expires_at <= afterHandoffDatabaseNow ||
        operation.claim_expires_at <= afterHandoffDatabaseNow
      ) {
        throw new AgentBackupCatalogConflictError(
          "Restore vault lease or claim expired during the remote handoff",
        );
      }
      return result;
    }
  });
}

/**
 * Expose only a callback-scoped byte passphrase after two identical restore
 * authority proofs around the lock-free KMS unwrap. `use` is one idempotent,
 * fully-awaited remote vault operation. It must honor the AbortSignal, enforce
 * the pinned host key and Linux boot UUID again on the remote transport, and
 * never issue or re-enter primary-DB code because the second proof keeps every
 * authority lock through the handoff. A remote effect may already exist when a
 * timeout, post-handoff expiry, or transaction commit fails, so replay must be
 * safe and exact.
 */
export async function withAgentBackupRestoreVaultPassphrase<T>(
  input: Readonly<AgentBackupRestoreVaultPassphraseInput>,
  use: (passphrase: Uint8Array, signal: AbortSignal) => Promise<T> | T,
  options: Readonly<AgentBackupRestoreVaultPassphraseOptions> = {},
): Promise<T> {
  const handoffTimeoutMs = requireRestoreVaultHandoffTimeoutMs(options.handoffTimeoutMs);
  const beforeKms = await loadAgentBackupRestoreVaultGeneration(input);
  await proveAgentBackupRestoreVaultTargetAuthority(
    input,
    beforeKms.manifestImageDigest,
    handoffTimeoutMs,
  );
  const rawKey = await decryptGeneration(beforeKms.generation, options.kmsClient ?? getKmsClient());
  const secret = new AgentVaultKeySecretHandle(rawKey);
  try {
    const afterKms = await loadAgentBackupRestoreVaultGeneration(input);
    return await proveAgentBackupRestoreVaultTargetAuthority(
      input,
      afterKms.manifestImageDigest,
      handoffTimeoutMs,
      {
        run: (signal) => secret.withPassphrase((passphrase) => use(passphrase, signal), signal),
      },
    );
  } finally {
    secret.release();
  }
}
