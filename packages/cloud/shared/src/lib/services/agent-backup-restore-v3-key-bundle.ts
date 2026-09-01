/**
 * Validates and unwraps the exact manifest-v3 operation key bundle for one
 * structured callback lifetime. The trusted callback owns copied key views
 * until its promise is genuinely quiescent; only then may provider release and
 * local zeroization begin. Cancellation closes admission immediately but does
 * not fabricate quiescence for JavaScript work that is already running.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import {
  computeKmsAeadOperationKeyBundleLocalReceiptDigest,
  KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  KMS_AEAD_OPERATION_KEY_BUNDLE_V1,
  type KmsAeadOperationKeyBundleHandle,
  type KmsAeadOperationKeyBundleWrapped,
  type UnwrapKmsAeadOperationKeyBundleInput,
} from "@elizaos/core/security/kms";
import {
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  type AgentBackupManifestV3,
  canonicalizeAgentBackupOperationKeyBundleContext,
} from "@elizaos/shared";
import { logger } from "../utils/logger";
import type { AgentBackupRestoreV3Control } from "./agent-backup-restore-v3-control";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface AgentBackupRestoreV3OperationKeyBundleAuthority {
  readonly generationId: string;
  readonly format: typeof KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format;
  readonly ref: string;
  readonly keyId: string;
  readonly keyVersion: number;
  readonly canonicalContext: string;
  readonly ciphertextBase64: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly localReceiptDigest: string;
}

export interface AgentBackupRestoreV3KeyBundleProvider {
  unwrap(
    input: Readonly<UnwrapKmsAeadOperationKeyBundleInput>,
  ): KmsAeadOperationKeyBundleHandle | PromiseLike<KmsAeadOperationKeyBundleHandle>;
  release(handle: KmsAeadOperationKeyBundleHandle): true | PromiseLike<true>;
}

export interface AgentBackupRestoreV3OperationKeys {
  readonly generationId: string;
  readonly dek: Uint8Array;
  readonly contentHmacKey: Uint8Array;
}

/** Cooperative fence exposed to the structured key-use callback. */
export interface AgentBackupRestoreV3OperationKeyUseControl {
  readonly signal: AbortSignal;
  readonly deadlineEpochMs: number;
  assertActive(label?: string): void;
  settle<T>(label: string, operation: () => T | PromiseLike<T>): Promise<T>;
}

export interface WithAgentBackupRestoreV3OperationKeysInput {
  readonly authority: Readonly<AgentBackupRestoreV3OperationKeyBundleAuthority>;
  readonly manifest: Readonly<AgentBackupManifestV3>;
  readonly provider: AgentBackupRestoreV3KeyBundleProvider;
  readonly control: AgentBackupRestoreV3Control;
}

export class AgentBackupRestoreV3KeyBundleError extends ElizaError {
  override readonly name = "AgentBackupRestoreV3KeyBundleError";

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, { code, cause: options?.cause, severity: "fatal" });
  }
}

function keyBundleError(code: string, message: string, cause?: unknown): never {
  throw new AgentBackupRestoreV3KeyBundleError(code, message, { cause });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeFailure(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  return new AgentBackupRestoreV3KeyBundleError(
    "AGENT_BACKUP_RESTORE_V3_KEY_BUNDLE_FAILED",
    "Restore-v3 key-bundle operation failed with a non-error cause",
    { cause },
  );
}

function snapshotAuthority(
  value: Readonly<AgentBackupRestoreV3OperationKeyBundleAuthority>,
): Readonly<AgentBackupRestoreV3OperationKeyBundleAuthority> {
  if (!value || typeof value !== "object") {
    keyBundleError(
      "AGENT_BACKUP_RESTORE_V3_KEY_AUTHORITY_MISMATCH",
      "Restore-v3 operation key-bundle authority is absent",
    );
  }
  return Object.freeze({
    generationId: value.generationId,
    format: value.format,
    ref: value.ref,
    keyId: value.keyId,
    keyVersion: value.keyVersion,
    canonicalContext: value.canonicalContext,
    ciphertextBase64: value.ciphertextBase64,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
    localReceiptDigest: value.localReceiptDigest,
  });
}

function manifestKeyAuthority(manifest: Readonly<AgentBackupManifestV3>): {
  readonly operationId: string;
  readonly generationId: string;
  readonly canonicalContext: string;
  readonly format: string;
  readonly plaintextBytes: number;
  readonly dekOffsetBytes: number;
  readonly dekBytes: number;
  readonly contentHmacOffsetBytes: number;
  readonly contentHmacBytes: number;
  readonly ref: string;
  readonly keyId: string;
  readonly keyVersion: number;
  readonly wrappedBytes: number;
  readonly wrappedSha256: string;
  readonly contextDerivation: string;
  readonly localReceiptDerivation: string;
  readonly localReceiptDigest: string;
} {
  try {
    const identity = manifest.identity;
    const source = manifest.source;
    const encryption = manifest.encryption;
    const bundle = encryption.operationKeyBundle;
    const wrapped = bundle.wrapped;
    const operationId = manifest.operationId;
    const generationId = bundle.generationId;
    const keyId = encryption.kms.keyId;
    const keyVersion = encryption.kms.keyVersion;
    return Object.freeze({
      operationId,
      generationId,
      canonicalContext: canonicalizeAgentBackupOperationKeyBundleContext({
        organizationId: identity.organizationId,
        agentId: identity.agentId,
        activationGeneration: identity.activationGeneration,
        lifecycleRevision: identity.lifecycleRevision,
        operationId,
        keyBundleGenerationId: generationId,
        sourceKind: source.kind,
        sourceProvider: source.provider,
        kmsProvider: encryption.kms.provider,
        keyId,
        keyVersion,
      }),
      format: bundle.format,
      plaintextBytes: bundle.plaintextBytes,
      dekOffsetBytes: bundle.dek.offsetBytes,
      dekBytes: bundle.dek.bytes,
      contentHmacOffsetBytes: bundle.contentHmac.offsetBytes,
      contentHmacBytes: bundle.contentHmac.bytes,
      ref: wrapped.ref,
      keyId,
      keyVersion,
      wrappedBytes: wrapped.bytes,
      wrappedSha256: wrapped.sha256,
      contextDerivation: wrapped.contextDerivation,
      localReceiptDerivation: wrapped.localReceiptDerivation,
      localReceiptDigest: wrapped.localReceiptDigest,
    });
  } catch (cause) {
    // error-policy:J3 the manifest is an untrusted persisted boundary; malformed
    // authority is rejected explicitly and never becomes a usable key context.
    keyBundleError(
      "AGENT_BACKUP_RESTORE_V3_KEY_AUTHORITY_MISMATCH",
      "Restore-v3 manifest has invalid operation key-bundle authority",
      cause,
    );
  }
}

function decodeCanonicalEnvelope(value: string): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    keyBundleError(
      "AGENT_BACKUP_RESTORE_V3_KEY_ENVELOPE_INVALID",
      "Restore-v3 wrapped operation key bundle is not canonical base64",
    );
  }
  const decoded = Buffer.from(value, "base64");
  try {
    if (
      decoded.byteLength !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes ||
      decoded.toString("base64") !== value
    ) {
      keyBundleError(
        "AGENT_BACKUP_RESTORE_V3_KEY_ENVELOPE_INVALID",
        "Restore-v3 wrapped operation key bundle has an invalid encoded length",
      );
    }
    return Uint8Array.from(decoded);
  } finally {
    decoded.fill(0);
  }
}

function buildExactUnwrapAuthority(
  authorityValue: Readonly<AgentBackupRestoreV3OperationKeyBundleAuthority>,
  manifest: Readonly<AgentBackupManifestV3>,
): {
  readonly generationId: string;
  readonly wrapped: KmsAeadOperationKeyBundleWrapped;
  readonly context: Uint8Array;
} {
  const authority = snapshotAuthority(authorityValue);
  const expected = manifestKeyAuthority(manifest);
  if (
    !UUID_PATTERN.test(authority.generationId) ||
    authority.generationId !== expected.generationId ||
    authority.format !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format ||
    authority.format !== expected.format ||
    expected.plaintextBytes !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes ||
    expected.dekOffsetBytes !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.dek.offsetBytes ||
    expected.dekBytes !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.dek.bytes ||
    expected.contentHmacOffsetBytes !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.contentHmac.offsetBytes ||
    expected.contentHmacBytes !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.contentHmac.bytes ||
    expected.ref !== `backup-key-bundle:${expected.operationId}` ||
    authority.ref !== expected.ref ||
    authority.keyId !== expected.keyId ||
    authority.keyVersion !== expected.keyVersion ||
    authority.canonicalContext !== expected.canonicalContext ||
    authority.sizeBytes !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes ||
    authority.sizeBytes !== expected.wrappedBytes ||
    !SHA256_PATTERN.test(authority.sha256) ||
    authority.sha256 !== expected.wrappedSha256 ||
    !SHA256_PATTERN.test(authority.localReceiptDigest) ||
    authority.localReceiptDigest !== expected.localReceiptDigest ||
    expected.contextDerivation !== AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION ||
    expected.localReceiptDerivation !==
      AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION ||
    expected.localReceiptDerivation !== KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION
  ) {
    keyBundleError(
      "AGENT_BACKUP_RESTORE_V3_KEY_AUTHORITY_MISMATCH",
      "Restore-v3 operation key-bundle authority differs from manifest-v3",
    );
  }

  const wrappedKeyBundle = decodeCanonicalEnvelope(authority.ciphertextBase64);
  const context = new TextEncoder().encode(expected.canonicalContext);
  try {
    if (
      sha256Hex(wrappedKeyBundle) !== authority.sha256 ||
      computeKmsAeadOperationKeyBundleLocalReceiptDigest({
        keyId: authority.keyId,
        keyVersion: authority.keyVersion,
        canonicalContext: context,
        wrappedKeyBundle,
      }) !== authority.localReceiptDigest
    ) {
      keyBundleError(
        "AGENT_BACKUP_RESTORE_V3_KEY_ENVELOPE_INVALID",
        "Restore-v3 operation key-bundle envelope failed its exact digest or context receipt",
      );
    }
    return {
      generationId: authority.generationId,
      wrapped: {
        format: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format,
        keyId: authority.keyId,
        keyVersion: authority.keyVersion,
        plaintextBytes: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
        nonceBytes: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.nonceBytes,
        authTagBytes: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.authTagBytes,
        bytes: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes,
        sha256: authority.sha256,
        localReceiptDerivation: KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
        localReceiptDigest: authority.localReceiptDigest,
        wrappedKeyBundle,
      },
      context,
    };
  } catch (cause) {
    // error-policy:J6 exact envelope/context copies are teardown-only after
    // validation fails; the original typed failure remains authoritative.
    wrappedKeyBundle.fill(0);
    context.fill(0);
    throw cause;
  }
}

function observableKeyViews(handle: unknown): Uint8Array[] {
  const views: Uint8Array[] = [];
  if (!handle || typeof handle !== "object") return views;
  try {
    const dek = (handle as { dek?: unknown }).dek;
    if (dek instanceof Uint8Array) views.push(dek);
  } catch (_cause) {
    // error-policy:J6 a hostile/released getter must not prevent observation of
    // the other view or provider release during mandatory teardown.
    logger.warn("[AgentBackupRestoreV3KeyBundle] Failed to observe DEK for teardown", {
      phase: "release-zeroization",
      view: "dek",
    });
    // The other view and provider release remain independently observable.
  }
  try {
    const contentHmacKey = (handle as { contentHmacKey?: unknown }).contentHmacKey;
    if (contentHmacKey instanceof Uint8Array && !views.includes(contentHmacKey)) {
      views.push(contentHmacKey);
    }
  } catch (_cause) {
    // error-policy:J6 see the independent DEK observation above.
    logger.warn("[AgentBackupRestoreV3KeyBundle] Failed to observe HMAC key for teardown", {
      phase: "release-zeroization",
      view: "content-hmac",
    });
    // Provider release and every other observable view still run.
  }
  return views;
}

function validateKeyViews(
  handle: KmsAeadOperationKeyBundleHandle,
  retainedViews: Uint8Array[],
): {
  readonly dek: Uint8Array;
  readonly contentHmacKey: Uint8Array;
} {
  const dek = handle.dek;
  if (dek instanceof Uint8Array) retainedViews.push(dek);
  const contentHmacKey = handle.contentHmacKey;
  if (contentHmacKey instanceof Uint8Array && !retainedViews.includes(contentHmacKey)) {
    retainedViews.push(contentHmacKey);
  }
  const overlaps =
    dek instanceof Uint8Array &&
    contentHmacKey instanceof Uint8Array &&
    dek.buffer === contentHmacKey.buffer &&
    dek.byteOffset < contentHmacKey.byteOffset + contentHmacKey.byteLength &&
    contentHmacKey.byteOffset < dek.byteOffset + dek.byteLength;
  if (
    handle.format !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format ||
    handle.released ||
    !(dek instanceof Uint8Array) ||
    dek.byteLength !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.dek.bytes ||
    !(contentHmacKey instanceof Uint8Array) ||
    contentHmacKey.byteLength !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.contentHmac.bytes ||
    overlaps
  ) {
    keyBundleError(
      "AGENT_BACKUP_RESTORE_V3_KEY_BUNDLE_INVALID",
      "KMS returned an invalid restore-v3 operation key-bundle handle",
    );
  }
  const callbackDek = Uint8Array.from(dek);
  retainedViews.push(callbackDek);
  const callbackContentHmacKey = Uint8Array.from(contentHmacKey);
  retainedViews.push(callbackContentHmacKey);
  return { dek: callbackDek, contentHmacKey: callbackContentHmacKey };
}

/**
 * Invoke provider release once, immediately erase every observable view, then
 * await and verify the release acknowledgement. This remains safe when a
 * provider returns a promise that later fails or never settles.
 */
async function releaseAndZeroize(
  provider: AgentBackupRestoreV3KeyBundleProvider,
  handle: KmsAeadOperationKeyBundleHandle,
  retainedViews: readonly Uint8Array[] = [],
): Promise<void> {
  const views = [...new Set([...retainedViews, ...observableKeyViews(handle)])];
  let pending: Promise<true> | undefined;
  let releaseFailed = false;
  let releaseFailure: unknown;
  try {
    pending = Promise.resolve(provider.release(handle));
  } catch (cause) {
    // error-policy:J2 synchronous provider release failure is retained and
    // rethrown after every locally observable view has been wiped.
    releaseFailed = true;
    releaseFailure = cause;
  }
  const wipeFailures: unknown[] = [];
  for (const view of views) {
    try {
      Uint8Array.prototype.fill.call(view, 0);
    } catch (cause) {
      // error-policy:J2 every wipe is attempted and all failures are retained
      // for the terminal release/zeroization aggregate.
      wipeFailures.push(cause);
    }
  }
  if (pending) {
    try {
      const acknowledged = await pending;
      if (acknowledged !== true || handle.released !== true) {
        keyBundleError(
          "AGENT_BACKUP_RESTORE_V3_KEY_RELEASE_UNCONFIRMED",
          "KMS operation key-bundle release was not acknowledged",
        );
      }
    } catch (cause) {
      // error-policy:J2 asynchronous acknowledgement failure is retained with
      // any local wipe failures instead of being mistaken for release success.
      releaseFailed = true;
      releaseFailure = cause;
    }
  }
  const failures = [
    ...(releaseFailed ? [normalizeFailure(releaseFailure)] : []),
    ...wipeFailures.map(normalizeFailure),
  ];
  if (failures.length > 1) {
    throw new AggregateError(failures, "KMS release and local operation-key zeroization failed");
  }
  if (failures[0]) throw failures[0];
}

function releaseLateHandle(
  provider: AgentBackupRestoreV3KeyBundleProvider,
  handle: KmsAeadOperationKeyBundleHandle,
): Promise<void> {
  // `control.wait` wraps this callback in a fresh bounded cleanup control and
  // reports any detached release failure after cancellation is authoritative.
  return releaseAndZeroize(provider, handle);
}

function operationKeyUseControl(
  control: AgentBackupRestoreV3Control,
): Readonly<AgentBackupRestoreV3OperationKeyUseControl> {
  return Object.freeze({
    signal: control.signal,
    deadlineEpochMs: control.deadlineEpochMs,
    assertActive: (label?: string) => control.assertActive(label),
    settle: <T>(label: string, operation: () => T | PromiseLike<T>) =>
      control.settle(label, operation),
  });
}

/**
 * Use one exact operation key bundle without exposing its provider handle.
 * The trusted callback must not copy, return, retain, or detach the key bytes;
 * its promise and `useControl.settle()` joins must cover every key-dependent
 * operation and effect. Cancellation is cooperative for that callback, and
 * release failure is terminal.
 */
export async function withAgentBackupRestoreV3OperationKeys(
  input: Readonly<WithAgentBackupRestoreV3OperationKeysInput>,
  use: (
    keys: Readonly<AgentBackupRestoreV3OperationKeys>,
    control: Readonly<AgentBackupRestoreV3OperationKeyUseControl>,
  ) => void | Promise<void>,
): Promise<void> {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.provider?.unwrap !== "function" ||
    typeof input.provider?.release !== "function" ||
    typeof input.control?.wait !== "function" ||
    typeof input.control?.settle !== "function" ||
    typeof input.control?.cleanup !== "function" ||
    typeof use !== "function"
  ) {
    keyBundleError(
      "AGENT_BACKUP_RESTORE_V3_KEY_COLLABORATOR_INVALID",
      "Restore-v3 operation key-bundle collaborators are incomplete",
    );
  }

  input.control.assertActive("KMS operation key-bundle unwrap");
  const exact = buildExactUnwrapAuthority(input.authority, input.manifest);
  let handle: KmsAeadOperationKeyBundleHandle | undefined;
  try {
    handle = await input.control.wait(
      "KMS operation key-bundle unwrap",
      () =>
        input.provider.unwrap({
          wrapped: exact.wrapped,
          canonicalContext: exact.context,
        }),
      (lateHandle) => releaseLateHandle(input.provider, lateHandle),
    );
  } finally {
    exact.wrapped.wrappedKeyBundle.fill(0);
    exact.context.fill(0);
  }

  let processingFailed = false;
  let processingFailure: unknown;
  const retainedViews: Uint8Array[] = [];
  try {
    const views = validateKeyViews(handle, retainedViews);
    const keys = Object.freeze({
      generationId: exact.generationId,
      dek: views.dek,
      contentHmacKey: views.contentHmacKey,
    });
    const useControl = operationKeyUseControl(input.control);
    // `settle` never treats cancellation as proof that JavaScript stopped. The
    // callback remains inside this trusted computing base and must become
    // genuinely quiescent before any supplied view is erased. It must not copy
    // key bytes into a closure or detach key-dependent work; arbitrary callback
    // code cannot be forced to honor those lifetime rules by this API alone.
    await input.control.settle("Restore-v3 operation key use", () => use(keys, useControl));
  } catch (cause) {
    // error-policy:J2 processing failure remains authoritative until mandatory
    // release completes; a release failure is aggregated below.
    processingFailed = true;
    processingFailure = cause;
  }

  let releaseFailed = false;
  let releaseFailure: unknown;
  try {
    await input.control.cleanup("KMS operation key-bundle release", () =>
      releaseAndZeroize(input.provider, handle, retainedViews),
    );
  } catch (cause) {
    // error-policy:J2 release is mandatory and its failure is rethrown alone or
    // aggregated with the key-use failure below.
    releaseFailed = true;
    releaseFailure = cause;
  }

  if (!processingFailed) {
    try {
      input.control.assertActive("Restore-v3 operation key use completion");
    } catch (cause) {
      // error-policy:J2 cancellation/deadline after a successful callback is
      // retained as the terminal processing failure after safe release.
      processingFailed = true;
      processingFailure = cause;
    }
  }

  if (processingFailed && releaseFailed) {
    throw new AggregateError(
      [normalizeFailure(processingFailure), normalizeFailure(releaseFailure)],
      "Restore-v3 key use and mandatory key-bundle release both failed",
    );
  }
  if (releaseFailed) throw releaseFailure;
  if (processingFailed) throw normalizeFailure(processingFailure);
}
