/** Primary-DB authority for immutable, KMS-wrapped agent vault-key generations. */

import { Buffer } from "node:buffer";
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { type KmsClient, orgKey } from "@elizaos/core/security/kms";
import { and, eq, isNull, sql } from "drizzle-orm";
import { isValidUUID } from "../../lib/utils/validation";
import { getKmsClient } from "../crypto/kms-client";
import { dbWrite } from "../helpers";
import { agentBackupCatalogAuthorities } from "../schemas/agent-backup-catalog";
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
import {
  AgentBackupCatalogConflictError,
  lockAgentBackupCatalogAuthority,
  stampAgentBackupCatalogRevision,
} from "./agent-backup-catalog";

const RAW_KEY_BYTES = 32;
const PASSPHRASE_BYTES = RAW_KEY_BYTES * 2;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

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

  async withPassphrase<T>(use: (passphrase: Uint8Array) => Promise<T> | T): Promise<T> {
    if (!this.rawKey) {
      authorityError("AGENT_VAULT_KEY_HANDLE_RELEASED", "Vault-key handle was already released");
    }
    const passphrase = rawKeyToPassphrase(this.rawKey);
    try {
      return await use(passphrase);
    } finally {
      passphrase.fill(0);
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
