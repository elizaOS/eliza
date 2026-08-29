import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  computeKmsAeadOperationKeyBundleLocalReceiptDigest,
  KMS_AEAD_OPERATION_KEY_BUNDLE_V1,
  type KmsAeadOperationKeyBundleHandle,
} from "@elizaos/core/security/kms";
import {
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
  type AgentBackupManifestV3,
  canonicalizeAgentBackupOperationKeyBundleContext,
} from "@elizaos/shared";
import { createAgentBackupRestoreV3Control } from "./agent-backup-restore-v3-control";
import {
  type AgentBackupRestoreV3KeyBundleProvider,
  type AgentBackupRestoreV3OperationKeyBundleAuthority,
  withAgentBackupRestoreV3OperationKeys,
} from "./agent-backup-restore-v3-key-bundle";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVATION_GENERATION = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const KEY_BUNDLE_GENERATION_ID = "55555555-5555-4555-8555-555555555555";
const KEY_ID = `org:${ORGANIZATION_ID}/dek/v1`;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function captureFailure(operation: PromiseLike<unknown>): Promise<unknown> {
  try {
    await operation;
    throw new Error("Expected operation to fail");
  } catch (cause) {
    return cause;
  }
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function keyHandle(): {
  readonly handle: KmsAeadOperationKeyBundleHandle;
  readonly dek: Uint8Array;
  readonly contentHmacKey: Uint8Array;
  readonly markReleased: () => void;
} {
  const plaintext = new Uint8Array(KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes);
  plaintext.fill(0x41, 0, 32);
  plaintext.fill(0x42, 32);
  const dek = plaintext.subarray(0, 32);
  const contentHmacKey = plaintext.subarray(32);
  let released = false;
  return {
    handle: {
      format: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format,
      dek,
      contentHmacKey,
      get released() {
        return released;
      },
    },
    dek,
    contentHmacKey,
    markReleased: () => {
      released = true;
    },
  };
}

function fixture(): {
  readonly authority: AgentBackupRestoreV3OperationKeyBundleAuthority;
  readonly manifest: AgentBackupManifestV3;
} {
  const context = canonicalizeAgentBackupOperationKeyBundleContext({
    organizationId: ORGANIZATION_ID,
    agentId: AGENT_ID,
    activationGeneration: ACTIVATION_GENERATION,
    lifecycleRevision: "42",
    operationId: OPERATION_ID,
    keyBundleGenerationId: KEY_BUNDLE_GENERATION_ID,
    sourceKind: "robot",
    sourceProvider: "hetzner",
    kmsProvider: "steward",
    keyId: KEY_ID,
    keyVersion: 1,
  });
  const envelope = new Uint8Array(KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes).fill(0x37);
  const contextBytes = new TextEncoder().encode(context);
  const localReceiptDigest = computeKmsAeadOperationKeyBundleLocalReceiptDigest({
    keyId: KEY_ID,
    keyVersion: 1,
    canonicalContext: contextBytes,
    wrappedKeyBundle: envelope,
  });
  contextBytes.fill(0);
  const sha256 = new Bun.CryptoHasher("sha256").update(envelope).digest("hex");
  const authority: AgentBackupRestoreV3OperationKeyBundleAuthority = {
    generationId: KEY_BUNDLE_GENERATION_ID,
    format: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format,
    ref: `backup-key-bundle:${OPERATION_ID}`,
    keyId: KEY_ID,
    keyVersion: 1,
    canonicalContext: context,
    ciphertextBase64: Buffer.from(envelope).toString("base64"),
    sha256,
    sizeBytes: envelope.byteLength,
    localReceiptDigest,
  };
  envelope.fill(0);
  const manifest = {
    operationId: OPERATION_ID,
    identity: {
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      activationGeneration: ACTIVATION_GENERATION,
      lifecycleRevision: "42",
    },
    source: { kind: "robot", provider: "hetzner" },
    encryption: {
      kms: { provider: "steward", keyId: KEY_ID, keyVersion: 1 },
      operationKeyBundle: {
        format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.format,
        generationId: KEY_BUNDLE_GENERATION_ID,
        plaintextBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
        dek: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.dek,
        contentHmac: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac,
        wrapped: {
          ref: `backup-key-bundle:${OPERATION_ID}`,
          bytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes,
          sha256,
          localReceiptDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
          localReceiptDigest,
          contextDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
        },
      },
    },
  } as unknown as AgentBackupManifestV3;
  return { authority, manifest };
}

describe("withAgentBackupRestoreV3OperationKeys", () => {
  test("finishes use before mandatory release and zeroizes retained key views", async () => {
    const source = fixture();
    const keys = keyHandle();
    const caller = new AbortController();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
    });
    const events: string[] = [];
    let providerEnvelope: Uint8Array | undefined;
    const provider: AgentBackupRestoreV3KeyBundleProvider = {
      unwrap(input) {
        events.push("unwrap");
        providerEnvelope = input.wrapped.wrappedKeyBundle;
        return keys.handle;
      },
      release() {
        events.push("release");
        keys.markReleased();
        return true;
      },
    };

    try {
      const result = await withAgentBackupRestoreV3OperationKeys(
        { ...source, provider, control },
        async (operationKeys) => {
          events.push("use:start");
          expect(operationKeys.generationId).toBe(KEY_BUNDLE_GENERATION_ID);
          expect(operationKeys.dek).toBe(keys.dek);
          expect(operationKeys.contentHmacKey).toBe(keys.contentHmacKey);
          await Promise.resolve();
          expect(allZero(operationKeys.dek)).toBe(false);
          events.push("use:end");
          return "authenticated";
        },
      );

      expect(result).toBe("authenticated");
      expect(events).toEqual(["unwrap", "use:start", "use:end", "release"]);
      expect(keys.handle.released).toBe(true);
      expect(allZero(keys.dek)).toBe(true);
      expect(allZero(keys.contentHmacKey)).toBe(true);
      expect(providerEnvelope && allZero(providerEnvelope)).toBe(true);
    } finally {
      control.close();
    }
  });

  test("rejects context drift before invoking KMS unwrap", async () => {
    const source = fixture();
    const caller = new AbortController();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
    });
    let unwrapCount = 0;
    const provider: AgentBackupRestoreV3KeyBundleProvider = {
      unwrap() {
        unwrapCount += 1;
        return keyHandle().handle;
      },
      release() {
        return true;
      },
    };

    try {
      const failure = await captureFailure(
        withAgentBackupRestoreV3OperationKeys(
          {
            ...source,
            authority: {
              ...source.authority,
              canonicalContext: `${source.authority.canonicalContext} `,
            },
            provider,
            control,
          },
          () => undefined,
        ),
      );
      expect((failure as { code?: string }).code).toBe(
        "AGENT_BACKUP_RESTORE_V3_KEY_AUTHORITY_MISMATCH",
      );
      expect(unwrapCount).toBe(0);
    } finally {
      control.close();
    }
  });

  test("surfaces release failure after locally zeroizing every key view", async () => {
    const source = fixture();
    const keys = keyHandle();
    const caller = new AbortController();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
    });
    const provider: AgentBackupRestoreV3KeyBundleProvider = {
      unwrap: () => keys.handle,
      release() {
        throw new Error("synthetic KMS release failure");
      },
    };

    try {
      await expect(
        withAgentBackupRestoreV3OperationKeys({ ...source, provider, control }, () => "unused"),
      ).rejects.toThrow("synthetic KMS release failure");
      expect(allZero(keys.dek)).toBe(true);
      expect(allZero(keys.contentHmacKey)).toBe(true);
    } finally {
      control.close();
    }
  });

  test("retains both callback and mandatory release failures", async () => {
    const source = fixture();
    const keys = keyHandle();
    const caller = new AbortController();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
    });
    const provider: AgentBackupRestoreV3KeyBundleProvider = {
      unwrap: () => keys.handle,
      release() {
        throw new Error("release failed");
      },
    };

    try {
      const failure = await captureFailure(
        withAgentBackupRestoreV3OperationKeys({ ...source, provider, control }, () => {
          throw new Error("use failed");
        }),
      );
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
        "use failed",
        "release failed",
      ]);
      expect(allZero(keys.dek)).toBe(true);
      expect(allZero(keys.contentHmacKey)).toBe(true);
    } finally {
      control.close();
    }
  });

  test("releases and zeroizes a handle returned after unwrap cancellation", async () => {
    const source = fixture();
    const keys = keyHandle();
    const lateHandle = deferred<KmsAeadOperationKeyBundleHandle>();
    const unwrapStarted = deferred<void>();
    const releaseObserved = deferred<void>();
    const caller = new AbortController();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
      cleanupDeadlineMs: 100,
    });
    let useCount = 0;
    const provider: AgentBackupRestoreV3KeyBundleProvider = {
      unwrap() {
        unwrapStarted.resolve();
        return lateHandle.promise;
      },
      release() {
        keys.markReleased();
        releaseObserved.resolve();
        return true;
      },
    };

    try {
      const pending = withAgentBackupRestoreV3OperationKeys(
        { ...source, provider, control },
        () => {
          useCount += 1;
        },
      );
      await unwrapStarted.promise;
      caller.abort(new Error("restore cancelled"));
      const failure = await captureFailure(pending);
      expect((failure as { code?: string }).code).toBe("AGENT_BACKUP_RESTORE_V3_ABORTED");
      expect(useCount).toBe(0);

      lateHandle.resolve(keys.handle);
      await releaseObserved.promise;
      expect(keys.handle.released).toBe(true);
      expect(allZero(keys.dek)).toBe(true);
      expect(allZero(keys.contentHmacKey)).toBe(true);
    } finally {
      control.close();
    }
  });

  test("cancellation bounds a non-settling use before mandatory release", async () => {
    const source = fixture();
    const keys = keyHandle();
    const useStarted = deferred<void>();
    const caller = new AbortController();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
      cleanupDeadlineMs: 100,
    });
    let releaseCount = 0;
    const provider: AgentBackupRestoreV3KeyBundleProvider = {
      unwrap: () => keys.handle,
      release() {
        releaseCount += 1;
        keys.markReleased();
        return true;
      },
    };

    try {
      const pending = withAgentBackupRestoreV3OperationKeys(
        { ...source, provider, control },
        () => {
          useStarted.resolve();
          return new Promise<never>(() => undefined);
        },
      );
      await useStarted.promise;
      caller.abort(new Error("cancel stuck key use"));
      await expect(pending).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_ABORTED",
      });
      expect(releaseCount).toBe(1);
      expect(keys.handle.released).toBe(true);
      expect(allZero(keys.dek)).toBe(true);
      expect(allZero(keys.contentHmacKey)).toBe(true);
    } finally {
      control.close();
    }
  });

  test("does not confuse undefined use or release rejections with success", async () => {
    const source = fixture();

    for (const failureKind of ["use", "release"] as const) {
      const keys = keyHandle();
      const control = createAgentBackupRestoreV3Control({
        signal: new AbortController().signal,
        deadlineEpochMs: Date.now() + 1_000,
      });
      let rejected = false;
      const provider: AgentBackupRestoreV3KeyBundleProvider = {
        unwrap: () => keys.handle,
        release() {
          keys.markReleased();
          return failureKind === "release" ? Promise.reject(undefined) : true;
        },
      };
      try {
        await withAgentBackupRestoreV3OperationKeys({ ...source, provider, control }, () =>
          failureKind === "use" ? Promise.reject(undefined) : "authenticated",
        ).then(
          () => undefined,
          (cause) => {
            rejected = true;
            if (failureKind === "use") {
              expect(cause).toBeUndefined();
            } else {
              expect(cause).toMatchObject({
                code: "AGENT_BACKUP_RESTORE_V3_KEY_BUNDLE_FAILED",
              });
            }
          },
        );
        expect(rejected).toBe(true);
        expect(allZero(keys.dek)).toBe(true);
        expect(allZero(keys.contentHmacKey)).toBe(true);
      } finally {
        control.close();
      }
    }
  });

  test("retains two undefined failures in an AggregateError", async () => {
    const source = fixture();
    const keys = keyHandle();
    const control = createAgentBackupRestoreV3Control({
      signal: new AbortController().signal,
      deadlineEpochMs: Date.now() + 1_000,
    });
    const provider: AgentBackupRestoreV3KeyBundleProvider = {
      unwrap: () => keys.handle,
      release() {
        keys.markReleased();
        return Promise.reject(undefined);
      },
    };

    try {
      const failure = await captureFailure(
        withAgentBackupRestoreV3OperationKeys({ ...source, provider, control }, () =>
          Promise.reject(undefined),
        ),
      );
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toHaveLength(2);
      expect((failure as AggregateError).errors.every((entry) => entry instanceof Error)).toBe(
        true,
      );
    } finally {
      control.close();
    }
  });

  test("continues zeroizing live views after a detached view throws", async () => {
    const source = fixture();
    const detachedDek = new Uint8Array(32).fill(0x61);
    structuredClone(detachedDek.buffer, { transfer: [detachedDek.buffer] });
    const contentHmacKey = new Uint8Array(32).fill(0x62);
    let released = false;
    const malformedHandle: KmsAeadOperationKeyBundleHandle = {
      format: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format,
      dek: detachedDek,
      contentHmacKey,
      get released() {
        return released;
      },
    };
    const control = createAgentBackupRestoreV3Control({
      signal: new AbortController().signal,
      deadlineEpochMs: Date.now() + 1_000,
    });
    const provider: AgentBackupRestoreV3KeyBundleProvider = {
      unwrap: () => malformedHandle,
      release() {
        released = true;
        return true;
      },
    };

    try {
      const failure = await captureFailure(
        withAgentBackupRestoreV3OperationKeys({ ...source, provider, control }, () => "unused"),
      );
      expect(failure).toBeInstanceOf(AggregateError);
      expect(released).toBe(true);
      expect(allZero(contentHmacKey)).toBe(true);
    } finally {
      control.close();
    }
  });
});
