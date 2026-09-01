/**
 * Exercises the restore-v3 key lifetime boundary with deterministic adversarial
 * handles plus a real LocalKmsAdapter acquire/restart/unwrap round trip. No
 * module mock, network service, or live credential participates in the proof.
 */

import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  KMS_AEAD_OPERATION_KEY_BUNDLE_V1,
  type KmsAeadOperationKeyBundleHandle,
  KmsAeadOperationKeyBundleProvider,
  LocalKmsAdapter,
} from "@elizaos/core/security/kms";
import {
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
  type AgentBackupManifestV3,
} from "@elizaos/shared";
import {
  type AgentBackupRestoreV3DetachedFailureEvent,
  createAgentBackupRestoreV3Control as createRawAgentBackupRestoreV3Control,
} from "./agent-backup-restore-v3-control";
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
const FIXED_CANONICAL_CONTEXT =
  '{"activationGeneration":"33333333-3333-4333-8333-333333333333","agentId":"22222222-2222-4222-8222-222222222222","derivation":"elizaos.agent-backup.operation-key-bundle-context.v1","keyBundleGenerationId":"55555555-5555-4555-8555-555555555555","keyId":"org:11111111-1111-4111-8111-111111111111/dek/v1","keyVersion":1,"kmsProvider":"steward","lifecycleRevision":"42","operationId":"44444444-4444-4444-8444-444444444444","organizationId":"11111111-1111-4111-8111-111111111111","sourceKind":"robot","sourceProvider":"hetzner"}';
const LOCAL_CANONICAL_CONTEXT = FIXED_CANONICAL_CONTEXT.replace(
  '"kmsProvider":"steward"',
  '"kmsProvider":"local"',
);
const FIXED_CONTEXT_SHA256 = "6322461a81fa20edbb1ce1c115b860d68f13f0f528d6db9671bb146ad77b55dc";
const FIXED_ENVELOPE_BASE64 =
  "Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc=";
const FIXED_ENVELOPE_SHA256 = "c700652576629ae789b737fb7c466bbb7d768eba87df4f61b60b0fbdcae49036";
const FIXED_LOCAL_RECEIPT = "e88f162ad7abee9846d72074e6b10cce67757b67c455aa2b93376624309b92de";

type RestoreControlInput = Omit<
  Parameters<typeof createRawAgentBackupRestoreV3Control>[0],
  "reportDetachedFailure"
> & {
  readonly reportDetachedFailure?: (
    event: Readonly<AgentBackupRestoreV3DetachedFailureEvent>,
  ) => void | PromiseLike<void>;
};

function createAgentBackupRestoreV3Control(input: RestoreControlInput) {
  const { reportDetachedFailure = () => undefined, ...controlInput } = input;
  return createRawAgentBackupRestoreV3Control({
    ...controlInput,
    reportDetachedFailure,
  });
}

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

function rejectionOf(operation: PromiseLike<unknown>): Promise<unknown> {
  return Promise.resolve(operation).then(
    () => {
      throw new Error("Expected operation to fail");
    },
    (cause) => cause,
  );
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

interface FixtureInput {
  readonly kmsProvider?: "local" | "steward";
  readonly ciphertextBase64?: string;
  readonly sha256?: string;
  readonly sizeBytes?: number;
  readonly localReceiptDigest?: string;
}

function fixture(input: Readonly<FixtureInput> = {}): {
  readonly authority: AgentBackupRestoreV3OperationKeyBundleAuthority;
  readonly manifest: AgentBackupManifestV3;
} {
  const kmsProvider = input.kmsProvider ?? "steward";
  const canonicalContext =
    kmsProvider === "local" ? LOCAL_CANONICAL_CONTEXT : FIXED_CANONICAL_CONTEXT;
  const ciphertextBase64 = input.ciphertextBase64 ?? FIXED_ENVELOPE_BASE64;
  const sha256 = input.sha256 ?? FIXED_ENVELOPE_SHA256;
  const sizeBytes = input.sizeBytes ?? KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes;
  const localReceiptDigest = input.localReceiptDigest ?? FIXED_LOCAL_RECEIPT;
  const authority: AgentBackupRestoreV3OperationKeyBundleAuthority = {
    generationId: KEY_BUNDLE_GENERATION_ID,
    format: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format,
    ref: `backup-key-bundle:${OPERATION_ID}`,
    keyId: KEY_ID,
    keyVersion: 1,
    canonicalContext,
    ciphertextBase64,
    sha256,
    sizeBytes,
    localReceiptDigest,
  };
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
      kms: { provider: kmsProvider, keyId: KEY_ID, keyVersion: 1 },
      operationKeyBundle: {
        format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.format,
        generationId: KEY_BUNDLE_GENERATION_ID,
        plaintextBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
        dek: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.dek,
        contentHmac: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac,
        wrapped: {
          ref: `backup-key-bundle:${OPERATION_ID}`,
          bytes: sizeBytes,
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
  test("pins an independent exact context, envelope, and local receipt fixture", () => {
    const source = fixture();
    const envelope = Uint8Array.from(Buffer.from(source.authority.ciphertextBase64, "base64"));
    try {
      expect(source.authority.canonicalContext).toBe(FIXED_CANONICAL_CONTEXT);
      expect(
        new Bun.CryptoHasher("sha256")
          .update(new TextEncoder().encode(source.authority.canonicalContext))
          .digest("hex"),
      ).toBe(FIXED_CONTEXT_SHA256);
      expect(new Bun.CryptoHasher("sha256").update(envelope).digest("hex")).toBe(
        FIXED_ENVELOPE_SHA256,
      );
      expect(source.authority.localReceiptDigest).toBe(FIXED_LOCAL_RECEIPT);
    } finally {
      envelope.fill(0);
    }
  });

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
    let callbackDek: Uint8Array | undefined;
    let callbackContentHmacKey: Uint8Array | undefined;
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
      const result: void = await withAgentBackupRestoreV3OperationKeys(
        { ...source, provider, control },
        async (operationKeys, useControl) => {
          events.push("use:start");
          expect(operationKeys.generationId).toBe(KEY_BUNDLE_GENERATION_ID);
          callbackDek = operationKeys.dek;
          callbackContentHmacKey = operationKeys.contentHmacKey;
          expect(operationKeys.dek).not.toBe(keys.dek);
          expect(operationKeys.contentHmacKey).not.toBe(keys.contentHmacKey);
          expect(operationKeys.dek).toEqual(keys.dek);
          expect(operationKeys.contentHmacKey).toEqual(keys.contentHmacKey);
          expect(useControl.signal).toBe(control.signal);
          await Promise.resolve();
          expect(allZero(operationKeys.dek)).toBe(false);
          events.push("use:end");
        },
      );

      expect(result).toBeUndefined();
      expect(events).toEqual(["unwrap", "use:start", "use:end", "release"]);
      expect(keys.handle.released).toBe(true);
      expect(allZero(keys.dek)).toBe(true);
      expect(allZero(keys.contentHmacKey)).toBe(true);
      expect(callbackDek && allZero(callbackDek)).toBe(true);
      expect(callbackContentHmacKey && allZero(callbackContentHmacKey)).toBe(true);
      expect(providerEnvelope && allZero(providerEnvelope)).toBe(true);
    } finally {
      control.close();
    }
  });

  test("reopens a real Local KMS envelope after restart and erases every owned view", async () => {
    const captureRootKey = new Uint8Array(32).fill(0xa5);
    const restoreRootKey = Uint8Array.from(captureRootKey);
    const canonicalContext = new TextEncoder().encode(LOCAL_CANONICAL_CONTEXT);
    const captureProvider = new KmsAeadOperationKeyBundleProvider(
      new LocalKmsAdapter({ rootKey: captureRootKey }),
    );
    const acquired = await captureProvider.acquire({
      keyId: KEY_ID,
      keyVersion: 1,
      canonicalContext,
    });
    const expectedDek = Uint8Array.from(acquired.handle.dek);
    const expectedContentHmacKey = Uint8Array.from(acquired.handle.contentHmacKey);
    const acquiredDekView = acquired.handle.dek;
    const acquiredContentHmacView = acquired.handle.contentHmacKey;
    expect(captureProvider.release(acquired.handle)).toBe(true);
    expect(acquired.handle.released).toBe(true);
    expect(allZero(acquiredDekView)).toBe(true);
    expect(allZero(acquiredContentHmacView)).toBe(true);

    const source = fixture({
      kmsProvider: "local",
      ciphertextBase64: Buffer.from(acquired.wrapped.wrappedKeyBundle).toString("base64"),
      sha256: acquired.wrapped.sha256,
      sizeBytes: acquired.wrapped.bytes,
      localReceiptDigest: acquired.wrapped.localReceiptDigest,
    });
    const coreRestoreProvider = new KmsAeadOperationKeyBundleProvider(
      new LocalKmsAdapter({ rootKey: restoreRootKey }),
    );
    let restoredHandle: KmsAeadOperationKeyBundleHandle | undefined;
    let restoredDekView: Uint8Array | undefined;
    let restoredContentHmacView: Uint8Array | undefined;
    let callbackDekView: Uint8Array | undefined;
    let callbackContentHmacView: Uint8Array | undefined;
    let releaseCount = 0;
    const provider: AgentBackupRestoreV3KeyBundleProvider = {
      async unwrap(input) {
        const handle = await coreRestoreProvider.unwrap(input);
        restoredHandle = handle;
        restoredDekView = handle.dek;
        restoredContentHmacView = handle.contentHmacKey;
        return handle;
      },
      release(handle) {
        releaseCount += 1;
        return coreRestoreProvider.release(handle);
      },
    };
    const control = createAgentBackupRestoreV3Control({
      signal: new AbortController().signal,
      deadlineEpochMs: Date.now() + 2_000,
    });

    try {
      const result: void = await withAgentBackupRestoreV3OperationKeys(
        { ...source, provider, control },
        (operationKeys) => {
          callbackDekView = operationKeys.dek;
          callbackContentHmacView = operationKeys.contentHmacKey;
          expect(operationKeys.dek).toEqual(expectedDek);
          expect(operationKeys.contentHmacKey).toEqual(expectedContentHmacKey);
          expect(operationKeys.dek).not.toBe(restoredDekView);
          expect(operationKeys.contentHmacKey).not.toBe(restoredContentHmacView);
        },
      );

      expect(result).toBeUndefined();
      expect(releaseCount).toBe(1);
      expect(restoredHandle?.released).toBe(true);
      expect(restoredDekView && allZero(restoredDekView)).toBe(true);
      expect(restoredContentHmacView && allZero(restoredContentHmacView)).toBe(true);
      expect(callbackDekView && allZero(callbackDekView)).toBe(true);
      expect(callbackContentHmacView && allZero(callbackContentHmacView)).toBe(true);
      if (!restoredHandle) throw new Error("Expected the real restore handle");
      expect(() => restoredHandle.dek).toThrow("already been released");
    } finally {
      control.close();
      expectedDek.fill(0);
      expectedContentHmacKey.fill(0);
      canonicalContext.fill(0);
      captureRootKey.fill(0);
      restoreRootKey.fill(0);
      acquired.wrapped.wrappedKeyBundle.fill(0);
    }
  });

  test("rejects every exact authority join and non-canonical envelope before unwrap", async () => {
    const source = fixture();
    const mutations: readonly {
      readonly label: string;
      readonly authority: AgentBackupRestoreV3OperationKeyBundleAuthority;
      readonly code: string;
    }[] = [
      {
        label: "generation",
        authority: { ...source.authority, generationId: "66666666-6666-4666-8666-666666666666" },
        code: "AGENT_BACKUP_RESTORE_V3_KEY_AUTHORITY_MISMATCH",
      },
      {
        label: "reference",
        authority: { ...source.authority, ref: `${source.authority.ref}:other` },
        code: "AGENT_BACKUP_RESTORE_V3_KEY_AUTHORITY_MISMATCH",
      },
      {
        label: "key id",
        authority: { ...source.authority, keyId: `${source.authority.keyId}:other` },
        code: "AGENT_BACKUP_RESTORE_V3_KEY_AUTHORITY_MISMATCH",
      },
      {
        label: "key version",
        authority: { ...source.authority, keyVersion: 2 },
        code: "AGENT_BACKUP_RESTORE_V3_KEY_AUTHORITY_MISMATCH",
      },
      {
        label: "context",
        authority: {
          ...source.authority,
          canonicalContext: `${source.authority.canonicalContext} `,
        },
        code: "AGENT_BACKUP_RESTORE_V3_KEY_AUTHORITY_MISMATCH",
      },
      {
        label: "size",
        authority: { ...source.authority, sizeBytes: source.authority.sizeBytes - 1 },
        code: "AGENT_BACKUP_RESTORE_V3_KEY_AUTHORITY_MISMATCH",
      },
      {
        label: "sha256",
        authority: { ...source.authority, sha256: "0".repeat(64) },
        code: "AGENT_BACKUP_RESTORE_V3_KEY_AUTHORITY_MISMATCH",
      },
      {
        label: "local receipt",
        authority: { ...source.authority, localReceiptDigest: "0".repeat(64) },
        code: "AGENT_BACKUP_RESTORE_V3_KEY_AUTHORITY_MISMATCH",
      },
      {
        label: "non-canonical base64",
        authority: {
          ...source.authority,
          ciphertextBase64: source.authority.ciphertextBase64.replace(/=$/, ""),
        },
        code: "AGENT_BACKUP_RESTORE_V3_KEY_ENVELOPE_INVALID",
      },
    ];

    for (const mutation of mutations) {
      const control = createAgentBackupRestoreV3Control({
        signal: new AbortController().signal,
        deadlineEpochMs: Date.now() + 1_000,
      });
      let unwrapCount = 0;
      const provider: AgentBackupRestoreV3KeyBundleProvider = {
        unwrap() {
          unwrapCount += 1;
          return keyHandle().handle;
        },
        release: () => true,
      };
      try {
        await expect(
          withAgentBackupRestoreV3OperationKeys(
            { ...source, authority: mutation.authority, provider, control },
            () => undefined,
          ),
        ).rejects.toMatchObject({ code: mutation.code });
        expect({ label: mutation.label, unwrapCount }).toEqual({
          label: mutation.label,
          unwrapCount: 0,
        });
      } finally {
        control.close();
      }
    }
  });

  test("rejects an altered canonical 92-byte envelope before unwrap", async () => {
    const source = fixture();
    const alteredEnvelopeBase64 = `M${source.authority.ciphertextBase64.slice(1)}`;
    const decoded = Buffer.from(alteredEnvelopeBase64, "base64");
    const control = createAgentBackupRestoreV3Control({
      signal: new AbortController().signal,
      deadlineEpochMs: Date.now() + 1_000,
    });
    let unwrapCount = 0;
    const provider: AgentBackupRestoreV3KeyBundleProvider = {
      unwrap() {
        unwrapCount += 1;
        return keyHandle().handle;
      },
      release: () => true,
    };

    try {
      expect(decoded).toHaveLength(KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes);
      expect(decoded.toString("base64")).toBe(alteredEnvelopeBase64);
      await expect(
        withAgentBackupRestoreV3OperationKeys(
          {
            ...source,
            authority: {
              ...source.authority,
              ciphertextBase64: alteredEnvelopeBase64,
            },
            provider,
            control,
          },
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_RESTORE_V3_KEY_ENVELOPE_INVALID" });
      expect(unwrapCount).toBe(0);
    } finally {
      decoded.fill(0);
      control.close();
    }
  });

  test("recomputes and rejects a jointly forged authority and manifest receipt", async () => {
    const source = fixture();
    const forgedReceipt = "0".repeat(64);
    const authority = {
      ...source.authority,
      localReceiptDigest: forgedReceipt,
    };
    const manifest = {
      ...source.manifest,
      encryption: {
        ...source.manifest.encryption,
        operationKeyBundle: {
          ...source.manifest.encryption.operationKeyBundle,
          wrapped: {
            ...source.manifest.encryption.operationKeyBundle.wrapped,
            localReceiptDigest: forgedReceipt,
          },
        },
      },
    } as AgentBackupManifestV3;
    const control = createAgentBackupRestoreV3Control({
      signal: new AbortController().signal,
      deadlineEpochMs: Date.now() + 1_000,
    });
    let unwrapCount = 0;
    const provider: AgentBackupRestoreV3KeyBundleProvider = {
      unwrap() {
        unwrapCount += 1;
        return keyHandle().handle;
      },
      release: () => true,
    };

    try {
      await expect(
        withAgentBackupRestoreV3OperationKeys(
          { authority, manifest, provider, control },
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_RESTORE_V3_KEY_ENVELOPE_INVALID" });
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
        withAgentBackupRestoreV3OperationKeys({ ...source, provider, control }, () => undefined),
      ).rejects.toThrow("synthetic KMS release failure");
      expect(allZero(keys.dek)).toBe(true);
      expect(allZero(keys.contentHmacKey)).toBe(true);
    } finally {
      control.close();
    }
  });

  test("rejects a false release acknowledgement after zeroizing callback and provider views", async () => {
    const source = fixture();
    const keys = keyHandle();
    let callbackDek: Uint8Array | undefined;
    let callbackContentHmacKey: Uint8Array | undefined;
    const control = createAgentBackupRestoreV3Control({
      signal: new AbortController().signal,
      deadlineEpochMs: Date.now() + 1_000,
    });
    const provider: AgentBackupRestoreV3KeyBundleProvider = {
      unwrap: () => keys.handle,
      release() {
        keys.markReleased();
        return false as true;
      },
    };

    try {
      await expect(
        withAgentBackupRestoreV3OperationKeys({ ...source, provider, control }, (operationKeys) => {
          callbackDek = operationKeys.dek;
          callbackContentHmacKey = operationKeys.contentHmacKey;
        }),
      ).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_KEY_RELEASE_UNCONFIRMED",
      });
      expect(allZero(keys.dek)).toBe(true);
      expect(allZero(keys.contentHmacKey)).toBe(true);
      expect(callbackDek && allZero(callbackDek)).toBe(true);
      expect(callbackContentHmacKey && allZero(callbackContentHmacKey)).toBe(true);
    } finally {
      control.close();
    }
  });

  test("rejects released and overlapping handles before key use while still wiping them", async () => {
    const source = fixture();
    const released = keyHandle();
    released.markReleased();
    const overlappingPlaintext = new Uint8Array(48).fill(0x63);
    let overlappingReleased = false;
    const overlappingHandle: KmsAeadOperationKeyBundleHandle = {
      format: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format,
      dek: overlappingPlaintext.subarray(0, 32),
      contentHmacKey: overlappingPlaintext.subarray(16, 48),
      get released() {
        return overlappingReleased;
      },
    };
    const cases = [
      {
        label: "released",
        handle: released.handle,
        release: () => {
          released.markReleased();
          return true as const;
        },
        views: [released.dek, released.contentHmacKey],
      },
      {
        label: "overlapping",
        handle: overlappingHandle,
        release: () => {
          overlappingReleased = true;
          return true as const;
        },
        views: [overlappingHandle.dek, overlappingHandle.contentHmacKey],
      },
    ] as const;

    for (const invalid of cases) {
      const control = createAgentBackupRestoreV3Control({
        signal: new AbortController().signal,
        deadlineEpochMs: Date.now() + 1_000,
      });
      let useCount = 0;
      const provider: AgentBackupRestoreV3KeyBundleProvider = {
        unwrap: () => invalid.handle,
        release: invalid.release,
      };
      try {
        await expect(
          withAgentBackupRestoreV3OperationKeys({ ...source, provider, control }, () => {
            useCount += 1;
          }),
        ).rejects.toMatchObject({ code: "AGENT_BACKUP_RESTORE_V3_KEY_BUNDLE_INVALID" });
        expect({ label: invalid.label, useCount }).toEqual({
          label: invalid.label,
          useCount: 0,
        });
        expect(invalid.views.every(allZero)).toBe(true);
      } finally {
        control.close();
      }
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
      const failure = await rejectionOf(
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
      const failure = await rejectionOf(pending);
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

  test("reports a failed release of a handle returned after cancellation without key data", async () => {
    const source = fixture();
    const keys = keyHandle();
    const lateHandle = deferred<KmsAeadOperationKeyBundleHandle>();
    const unwrapStarted = deferred<void>();
    const reported = deferred<Readonly<AgentBackupRestoreV3DetachedFailureEvent>>();
    const caller = new AbortController();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
      cleanupDeadlineMs: 100,
      reportDetachedFailure: (event) => reported.resolve(event),
    });
    const provider: AgentBackupRestoreV3KeyBundleProvider = {
      unwrap() {
        unwrapStarted.resolve();
        return lateHandle.promise;
      },
      release() {
        throw new Error("synthetic late KMS release failure");
      },
    };

    try {
      const pending = withAgentBackupRestoreV3OperationKeys(
        { ...source, provider, control },
        () => undefined,
      );
      await unwrapStarted.promise;
      caller.abort(new Error("restore cancelled before unwrap response"));
      await expect(pending).rejects.toMatchObject({ code: "AGENT_BACKUP_RESTORE_V3_ABORTED" });

      lateHandle.resolve(keys.handle);
      const event = await reported.promise;
      expect(event).toEqual({
        label: "KMS operation key-bundle unwrap",
        phase: "late-value-cleanup",
        error: {
          name: "AgentBackupRestoreV3ControlError",
          code: "AGENT_BACKUP_RESTORE_V3_LATE_VALUE_CLEANUP_FAILED",
          message: "Restore-v3 late-value cleanup failed",
          severity: "fatal",
        },
      });
      expect(JSON.stringify(event)).not.toMatch(/dek|handle|ciphertext|Nzc3Nzc3/i);
      expect(allZero(keys.dek)).toBe(true);
      expect(allZero(keys.contentHmacKey)).toBe(true);
    } finally {
      control.close();
    }
  });

  test("does not defer callback admission past an interleaved cancellation", async () => {
    const source = fixture();
    const keys = keyHandle();
    const caller = new AbortController();
    const baseControl = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
    });
    const cancellation = new Error("cancel immediately after key-use admission");
    const control = Object.freeze({
      ...baseControl,
      async settle<T>(label: string, operation: () => T | PromiseLike<T>): Promise<T> {
        baseControl.assertActive(label);
        const pending = operation();
        // If `operation` adds its own Promise microtask, its callback begins
        // only after this cancellation even though settle already admitted it.
        caller.abort(cancellation);
        const value = await pending;
        baseControl.assertActive(label);
        return value;
      },
    });
    let callbackCount = 0;
    let callbackStartedAfterAbort: boolean | undefined;
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
      await expect(
        withAgentBackupRestoreV3OperationKeys({ ...source, provider, control }, () => {
          callbackCount += 1;
          callbackStartedAfterAbort = caller.signal.aborted;
        }),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_RESTORE_V3_ABORTED" });
      expect({ callbackCount, callbackStartedAfterAbort, releaseCount }).toEqual({
        callbackCount: 1,
        callbackStartedAfterAbort: false,
        releaseCount: 1,
      });
      expect(allZero(keys.dek)).toBe(true);
      expect(allZero(keys.contentHmacKey)).toBe(true);
    } finally {
      baseControl.close();
    }
  });

  test("cancellation waits for genuine key-use quiescence before release", async () => {
    const source = fixture();
    const keys = keyHandle();
    const useStarted = deferred<void>();
    const effectStarted = deferred<void>();
    const finishUse = deferred<void>();
    const caller = new AbortController();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
      cleanupDeadlineMs: 100,
    });
    let releaseCount = 0;
    let wrapperSettled = false;
    let callbackDek: Uint8Array | undefined;
    let callbackContentHmacKey: Uint8Array | undefined;
    const events: string[] = [];
    const provider: AgentBackupRestoreV3KeyBundleProvider = {
      unwrap: () => keys.handle,
      release() {
        events.push("release");
        releaseCount += 1;
        keys.markReleased();
        return true;
      },
    };

    try {
      const pending = withAgentBackupRestoreV3OperationKeys(
        { ...source, provider, control },
        async (operationKeys, useControl) => {
          events.push("use:start");
          callbackDek = operationKeys.dek;
          callbackContentHmacKey = operationKeys.contentHmacKey;
          useStarted.resolve();
          await useControl.settle("Synthetic key-dependent effect", async () => {
            effectStarted.resolve();
            await finishUse.promise;
            expect(useControl.signal.aborted).toBe(true);
            expect(allZero(operationKeys.dek)).toBe(false);
            expect(allZero(operationKeys.contentHmacKey)).toBe(false);
            events.push("use:end");
          });
        },
      );
      void pending.then(
        () => {
          wrapperSettled = true;
        },
        () => {
          wrapperSettled = true;
        },
      );
      await useStarted.promise;
      await effectStarted.promise;
      caller.abort(new Error("cancel stuck key use"));
      await Promise.resolve();
      expect(wrapperSettled).toBe(false);
      expect(releaseCount).toBe(0);
      expect(keys.handle.released).toBe(false);
      expect(allZero(keys.dek)).toBe(false);
      expect(allZero(keys.contentHmacKey)).toBe(false);
      expect(callbackDek && allZero(callbackDek)).toBe(false);
      expect(callbackContentHmacKey && allZero(callbackContentHmacKey)).toBe(false);

      finishUse.resolve();
      await expect(pending).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_ABORTED",
      });
      expect(releaseCount).toBe(1);
      expect(keys.handle.released).toBe(true);
      expect(allZero(keys.dek)).toBe(true);
      expect(allZero(keys.contentHmacKey)).toBe(true);
      expect(callbackDek && allZero(callbackDek)).toBe(true);
      expect(callbackContentHmacKey && allZero(callbackContentHmacKey)).toBe(true);
      expect(events).toEqual(["use:start", "use:end", "release"]);
    } finally {
      control.close();
    }
  });

  test("an elapsed deadline also joins key use before release", async () => {
    const source = fixture();
    const keys = keyHandle();
    const useStarted = deferred<void>();
    const finishUse = deferred<void>();
    let nowEpochMs = 1_000;
    let releaseCount = 0;
    const control = createAgentBackupRestoreV3Control({
      signal: new AbortController().signal,
      deadlineEpochMs: 2_000,
      now: () => nowEpochMs,
    });
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
        async () => {
          useStarted.resolve();
          await finishUse.promise;
        },
      );
      await useStarted.promise;
      nowEpochMs = 2_000;
      await Promise.resolve();
      expect(releaseCount).toBe(0);
      expect(allZero(keys.dek)).toBe(false);

      finishUse.resolve();
      await expect(pending).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_DEADLINE_EXCEEDED",
      });
      expect(releaseCount).toBe(1);
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
          failureKind === "use" ? Promise.reject(undefined) : undefined,
        ).then(
          () => undefined,
          (cause) => {
            rejected = true;
            expect(cause).toMatchObject({
              code: "AGENT_BACKUP_RESTORE_V3_KEY_BUNDLE_FAILED",
            });
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
      const failure = await rejectionOf(
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
      const failure = await rejectionOf(
        withAgentBackupRestoreV3OperationKeys({ ...source, provider, control }, () => undefined),
      );
      expect(failure).toBeInstanceOf(AggregateError);
      expect(released).toBe(true);
      expect(allZero(contentHmacKey)).toBe(true);
    } finally {
      control.close();
    }
  });
});
