import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createCipheriv, createHash, createHmac } from "node:crypto";
import {
  AGENT_BACKUP_CHUNK_ENVELOPE_V1,
  AGENT_BACKUP_RECORD_STREAM_V1_FORMAT,
  type AgentBackupManifestV3,
  type AgentBackupRestoreV3SourceAuthorityObject,
  canonicalizeAgentBackupChunkAad,
  canonicalizeAgentBackupRestoreV3ExactReadReceiptProof,
} from "@elizaos/shared";
import { type ExactObjectRead, ObjectLocatorReceipt } from "../storage/object-store";
import { createAgentBackupRestoreV3Control } from "./agent-backup-restore-v3-control";
import {
  AgentBackupRestoreV3ExactObjectError,
  type AgentBackupRestoreV3ExactObjectErrorCode,
  type StreamAgentBackupRestoreV3ExactObjectInput,
  type StreamAgentBackupRestoreV3ExactObjectResult,
  streamAgentBackupRestoreV3ExactObject,
} from "./agent-backup-restore-v3-exact-object";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000002";
const BACKUP_ID = "30000000-0000-4000-8000-000000000003";
const OPERATION_ID = "40000000-0000-4000-8000-000000000004";
const ACTIVATION_ID = "50000000-0000-4000-8000-000000000005";
const OBJECT_ID = "60000000-0000-4000-8000-000000000006";
const SOURCE_AUTHORITY_SHA256 = "a".repeat(64);
const ENDPOINT_ALIAS = "restore-primary";
const BUCKET = "exact-backups";
const REGION = "auto";
const KEY_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const BACKEND_FINGERPRINT = `sha256:${"c".repeat(64)}`;
const PROVIDER_VERSION = "provider-version-7";
const DEK = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const CONTENT_HMAC_KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const NONCE = Uint8Array.from({ length: 12 }, (_, index) => 17 + index);

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(value: string): `sha256:${string}` {
  return `sha256:${sha256Hex(value)}`;
}

function checksumBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface FixtureOptions {
  readonly plaintextBytes?: number;
  readonly plaintextTransform?: (plaintext: Uint8Array) => Uint8Array;
  readonly declaredContentHmacSha256?: string;
  readonly expectedCiphertextSha256?: string;
  readonly bodyTransform?: (body: Uint8Array) => Uint8Array;
  readonly declaredSizeDelta?: number;
  readonly completionLocator?: ObjectLocatorReceipt;
  readonly completion?: Deferred<
    ExactObjectRead["completion"] extends Promise<infer T> ? T : never
  >;
  readonly fragmentSizes?: readonly number[];
  readonly includeEmptyFragment?: boolean;
  readonly cancelHangs?: boolean;
  readonly cancelRejects?: boolean;
  readonly cleanupDeadlineMs?: number;
}

function fixture(options: FixtureOptions = {}) {
  const canonicalPlaintext = Uint8Array.from(
    { length: options.plaintextBytes ?? 513 },
    (_, index) => (index * 29 + 7) & 0xff,
  );
  const plaintext = options.plaintextTransform?.(canonicalPlaintext.slice()) ?? canonicalPlaintext;
  const actualContentHmacSha256 = createHmac("sha256", CONTENT_HMAC_KEY)
    .update(plaintext)
    .digest("hex");
  const declaredContentHmacSha256 = options.declaredContentHmacSha256 ?? actualContentHmacSha256;
  const aadInput = {
    identity: {
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      activationGeneration: ACTIVATION_ID,
      lifecycleRevision: "19",
    },
    operationId: OPERATION_ID,
    component: {
      name: "character",
      format: AGENT_BACKUP_RECORD_STREAM_V1_FORMAT,
      compression: "none" as const,
    },
    chunk: {
      index: 0,
      offsetBytes: 0,
      plainBytes: plaintext.byteLength,
      compressedBytes: plaintext.byteLength,
      contentHmacSha256: declaredContentHmacSha256,
    },
  };
  const aad = new TextEncoder().encode(canonicalizeAgentBackupChunkAad(aadInput));
  const cipher = createCipheriv("aes-256-gcm", DEK, NONCE, {
    authTagLength: AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes,
  });
  cipher.setAAD(aad);
  const ciphertext = cipher.update(plaintext);
  const final = cipher.final();
  const tag = cipher.getAuthTag();
  const canonicalBody = joinBytes([NONCE, ciphertext, final, tag]);
  const body = options.bodyTransform?.(canonicalBody.slice()) ?? canonicalBody.slice();
  const actualCiphertextSha256 = sha256Hex(canonicalBody);
  const expectedCiphertextSha256 = options.expectedCiphertextSha256 ?? actualCiphertextSha256;
  const chunk = {
    index: 0,
    offsetBytes: 0,
    plainBytes: plaintext.byteLength,
    compressedBytes: plaintext.byteLength,
    encryptedBytes: canonicalBody.byteLength,
    contentHmacSha256: declaredContentHmacSha256,
    aadSha256: sha256Hex(aad),
    sha256: expectedCiphertextSha256,
  };
  const manifest = {
    schemaVersion: 3,
    operationId: OPERATION_ID,
    identity: aadInput.identity,
    components: [
      {
        name: "character",
        format: AGENT_BACKUP_RECORD_STREAM_V1_FORMAT,
        compression: "none",
        chunks: [chunk],
      },
    ],
  } as unknown as AgentBackupManifestV3;
  const sourceObject: AgentBackupRestoreV3SourceAuthorityObject = {
    objectId: OBJECT_ID,
    componentIndex: 0,
    componentName: "character",
    chunkIndex: 0,
    copyRole: "primary",
    contentHmacSha256: declaredContentHmacSha256,
    catalog: {
      transport: "worker-r2",
      provider: "cloudflare-r2",
      endpointIdentityFingerprint: BACKEND_FINGERPRINT,
      endpointAliasFingerprint: fingerprint(ENDPOINT_ALIAS),
      bucketFingerprint: fingerprint(BUCKET),
      regionFingerprint: fingerprint(REGION),
      keyFingerprint: KEY_FINGERPRINT,
      providerVersionId: PROVIDER_VERSION,
      providerEtag: null,
      providerChecksum: null,
      uploadReceiptDigest: "d".repeat(64),
      ciphertextSha256: expectedCiphertextSha256,
      sizeBytes: canonicalBody.byteLength,
    },
  };
  const locator =
    options.completionLocator ??
    new ObjectLocatorReceipt({
      transport: "worker-r2-binding",
      provider: "r2",
      endpointAlias: ENDPOINT_ALIAS,
      backendIdentityFingerprint: BACKEND_FINGERPRINT,
      bucket: BUCKET,
      region: REGION,
      keyFingerprint: KEY_FINGERPRINT,
      version: PROVIDER_VERSION,
      versionSource: "provider",
    });
  const completionReceipt = {
    locator,
    metadata: {
      sizeBytes: canonicalBody.byteLength,
      checksum: {
        algorithm: "sha256" as const,
        encoding: "base64" as const,
        value: checksumBase64(expectedCiphertextSha256),
      },
    },
    verifiedComplete: true as const,
  };
  const completion = options.completion;
  const fragments: Uint8Array[] = [];
  const fragmentSizes = options.fragmentSizes ?? [1, 4, 7, 13, 31, 64];
  for (let offset = 0, index = 0; offset < body.byteLength; index += 1) {
    const size = fragmentSizes[index % fragmentSizes.length] ?? 1;
    fragments.push(body.slice(offset, Math.min(body.byteLength, offset + size)));
    offset += size;
  }
  if (options.includeEmptyFragment) {
    fragments.splice(Math.min(1, fragments.length), 0, new Uint8Array(0));
  }
  let pullCount = 0;
  let cancelCount = 0;
  let fragmentIndex = 0;
  const read: ExactObjectRead = {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        const fragment = fragments[fragmentIndex++];
        if (fragment) {
          controller.enqueue(fragment.slice());
          return;
        }
        controller.close();
      },
      async cancel() {
        cancelCount += 1;
        if (options.cancelRejects) throw new Error("simulated cancel rejection");
        if (options.cancelHangs) await new Promise<never>(() => undefined);
      },
    }),
    declaredMetadata: {
      sizeBytes: canonicalBody.byteLength + (options.declaredSizeDelta ?? 0),
      checksum: {
        algorithm: "sha256",
        encoding: "base64",
        value: checksumBase64(expectedCiphertextSha256),
      },
    },
    completion: completion?.promise ?? Promise.resolve(completionReceipt),
  };
  const abortController = new AbortController();
  const control = createAgentBackupRestoreV3Control({
    signal: abortController.signal,
    deadlineEpochMs: Date.now() + 60_000,
    cleanupDeadlineMs: options.cleanupDeadlineMs,
  });
  let openCount = 0;
  const input: StreamAgentBackupRestoreV3ExactObjectInput = {
    manifest,
    backupId: BACKUP_ID,
    sourceAuthoritySha256: SOURCE_AUTHORITY_SHA256,
    sourceObject,
    openExactObject(object, providerControl) {
      openCount += 1;
      expect(object).toEqual(sourceObject);
      expect(providerControl.signal).toBe(control.signal);
      expect(providerControl.deadlineEpochMs).toBe(control.deadlineEpochMs);
      return read;
    },
    dek: DEK,
    contentHmacKey: CONTENT_HMAC_KEY,
    operationNonceOwners: new Map<string, string>(),
    control,
  };
  return {
    input,
    plaintext,
    manifest,
    sourceObject,
    read,
    completionReceipt,
    completion,
    abortController,
    control,
    openCount: () => openCount,
    pullCount: () => pullCount,
    cancelCount: () => cancelCount,
    fragmentCount: fragments.length,
  };
}

async function drain(
  input: StreamAgentBackupRestoreV3ExactObjectInput,
): Promise<{ plaintext: Uint8Array; result: StreamAgentBackupRestoreV3ExactObjectResult }> {
  const iterator = streamAgentBackupRestoreV3ExactObject(input);
  const fragments: Uint8Array[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return { plaintext: joinBytes(fragments), result: next.value };
    fragments.push(next.value.slice());
  }
}

async function expectCode(
  operation: Promise<unknown>,
  code: AgentBackupRestoreV3ExactObjectErrorCode,
): Promise<void> {
  try {
    await operation;
    throw new Error("Expected exact-object operation to reject");
  } catch (cause) {
    expect(cause).toBeInstanceOf(AgentBackupRestoreV3ExactObjectError);
    expect((cause as AgentBackupRestoreV3ExactObjectError).code).toBe(code);
  }
}

describe("streamAgentBackupRestoreV3ExactObject", () => {
  test("streams fragmented real AES-256-GCM and returns a locator-free canonical proof", async () => {
    const exact = fixture();
    try {
      const restored = await drain(exact.input);
      expect(restored.plaintext).toEqual(exact.plaintext);
      expect(restored.result.receipt).toMatchObject({
        objectId: OBJECT_ID,
        componentName: "character",
        copyRole: "primary",
        ciphertextSha256: exact.sourceObject.catalog.ciphertextSha256,
        sizeBytes: exact.sourceObject.catalog.sizeBytes,
      });
      const canonical = canonicalizeAgentBackupRestoreV3ExactReadReceiptProof(
        restored.result.proof,
      );
      expect(canonical).not.toContain(ENDPOINT_ALIAS);
      expect(canonical).not.toContain(BUCKET);
      expect(canonical).not.toContain(REGION);
      expect(canonical).toContain(fingerprint(BUCKET));
      expect(exact.openCount()).toBe(1);
      expect(exact.cancelCount()).toBe(0);
    } finally {
      exact.control.close();
    }
  });

  test("accepts empty and provider-sized ingress while bounding crypto output", async () => {
    const exact = fixture({
      plaintextBytes: 512 * 1024,
      fragmentSizes: [1024 * 1024],
      includeEmptyFragment: true,
    });
    try {
      const iterator = streamAgentBackupRestoreV3ExactObject(exact.input);
      const plaintext: Uint8Array[] = [];
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        expect(next.value.byteLength).toBeLessThanOrEqual(256 * 1024);
        plaintext.push(next.value.slice());
      }
      expect(joinBytes(plaintext)).toEqual(exact.plaintext);
    } finally {
      exact.control.close();
    }
  });

  test("rejects AAD drift before provider I/O", async () => {
    const exact = fixture();
    try {
      const component = exact.manifest.components[0];
      const chunk = component?.chunks[0];
      if (!component || !chunk) throw new Error("Fixture chunk absent");
      const input = {
        ...exact.input,
        manifest: {
          ...exact.manifest,
          components: [{ ...component, chunks: [{ ...chunk, aadSha256: "f".repeat(64) }] }],
        },
      } as StreamAgentBackupRestoreV3ExactObjectInput;
      await expectCode(drain(input), "AGENT_BACKUP_RESTORE_V3_AAD_MISMATCH");
      expect(exact.openCount()).toBe(0);
    } finally {
      exact.control.close();
    }
  });

  test("rejects authentication-tag, ciphertext-hash, HMAC, and declared-size drift", async () => {
    const tagDrift = fixture({
      bodyTransform(body) {
        body[body.byteLength - 1] ^= 0xff;
        return body;
      },
    });
    const hashDrift = fixture({ expectedCiphertextSha256: "e".repeat(64) });
    const hmacDrift = fixture({ declaredContentHmacSha256: "f".repeat(64) });
    const sizeDrift = fixture({ declaredSizeDelta: 1 });
    try {
      await expectCode(drain(tagDrift.input), "AGENT_BACKUP_RESTORE_V3_AEAD_AUTHENTICATION_FAILED");
      await expectCode(drain(hashDrift.input), "AGENT_BACKUP_RESTORE_V3_CHUNK_PROOF_MISMATCH");
      await expectCode(drain(hmacDrift.input), "AGENT_BACKUP_RESTORE_V3_CHUNK_PROOF_MISMATCH");
      await expectCode(drain(sizeDrift.input), "AGENT_BACKUP_RESTORE_V3_EXACT_READ_INVALID");
    } finally {
      tagDrift.control.close();
      hashDrift.control.close();
      hmacDrift.control.close();
      sizeDrift.control.close();
    }
  });

  test("rejects exact provider completion identity drift", async () => {
    const driftedLocator = new ObjectLocatorReceipt({
      transport: "worker-r2-binding",
      provider: "r2",
      endpointAlias: ENDPOINT_ALIAS,
      backendIdentityFingerprint: BACKEND_FINGERPRINT,
      bucket: `${BUCKET}-replaced`,
      region: REGION,
      keyFingerprint: KEY_FINGERPRINT,
      version: PROVIDER_VERSION,
      versionSource: "provider",
    });
    const exact = fixture({ completionLocator: driftedLocator });
    try {
      await expectCode(drain(exact.input), "AGENT_BACKUP_RESTORE_V3_CHUNK_PROOF_MISMATCH");
    } finally {
      exact.control.close();
    }
  });

  test("rejects truncated and overflowing provider bodies", async () => {
    const truncated = fixture({
      bodyTransform: (body) => body.slice(0, body.byteLength - 1),
    });
    const overflowing = fixture({
      bodyTransform(body) {
        const output = new Uint8Array(body.byteLength + 1);
        output.set(body);
        output[output.byteLength - 1] = 0xff;
        return output;
      },
    });
    try {
      await expectCode(drain(truncated.input), "AGENT_BACKUP_RESTORE_V3_CIPHERTEXT_TRUNCATED");
      await expectCode(drain(overflowing.input), "AGENT_BACKUP_RESTORE_V3_CIPHERTEXT_OVERFLOW");
    } finally {
      truncated.control.close();
      overflowing.control.close();
    }
  });

  test("applies consumer backpressure and bounds hanging cancellation on early return", async () => {
    const exact = fixture({
      fragmentSizes: [12, 17, 17, 17],
      cancelHangs: true,
    });
    try {
      const iterator = streamAgentBackupRestoreV3ExactObject(exact.input);
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(exact.pullCount()).toBeLessThan(exact.fragmentCount);
      const startedAt = Date.now();
      const ended = await iterator.return(undefined as never);
      expect(ended.done).toBe(true);
      expect(ended.value).toBeUndefined();
      expect(exact.cancelCount()).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      exact.control.close();
    }
  });

  test("does not return a receipt before provider completion settles", async () => {
    const completion =
      deferred<ExactObjectRead["completion"] extends Promise<infer T> ? T : never>();
    const exact = fixture({ completion });
    try {
      const iterator = streamAgentBackupRestoreV3ExactObject(exact.input);
      const plaintext: Uint8Array[] = [];
      let pendingFinal:
        | Promise<IteratorResult<Uint8Array, StreamAgentBackupRestoreV3ExactObjectResult>>
        | undefined;
      while (true) {
        const nextPromise = iterator.next();
        const state = await Promise.race([
          nextPromise.then((next) => ({ kind: "next" as const, next })),
          new Promise<{ kind: "pending" }>((resolve) =>
            setTimeout(() => resolve({ kind: "pending" }), 5),
          ),
        ]);
        if (state.kind === "pending") {
          pendingFinal = nextPromise;
          break;
        }
        if (state.next.done) throw new Error("Receipt preceded provider completion");
        plaintext.push(state.next.value.slice());
      }
      expect(joinBytes(plaintext)).toEqual(exact.plaintext);
      expect(pendingFinal).toBeDefined();
      completion.resolve(exact.completionReceipt);
      const final = await pendingFinal;
      expect(final?.done).toBe(true);
      expect(final?.value.receipt.objectId).toBe(OBJECT_ID);
    } finally {
      exact.control.close();
    }
  });

  test("observes and bounds late-open cancellation that hangs or rejects", async () => {
    async function runLateOpen(cancelMode: "hang" | "reject"): Promise<void> {
      const exact = fixture({
        cancelHangs: cancelMode === "hang",
        cancelRejects: cancelMode === "reject",
        cleanupDeadlineMs: 20,
      });
      const lateOpen = deferred<ExactObjectRead>();
      const openStarted = deferred<void>();
      const input: StreamAgentBackupRestoreV3ExactObjectInput = {
        ...exact.input,
        openExactObject: () => {
          openStarted.resolve();
          return lateOpen.promise;
        },
      };
      try {
        const next = streamAgentBackupRestoreV3ExactObject(input).next();
        await openStarted.promise;
        exact.abortController.abort(new Error("stop late open"));
        await expect(next).rejects.toMatchObject({
          code: "AGENT_BACKUP_RESTORE_V3_ABORTED",
        });
        lateOpen.resolve(exact.read);
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(exact.cancelCount()).toBe(1);
      } finally {
        exact.control.close();
      }
    }

    await runLateOpen("hang");
    await runLateOpen("reject");
  });

  test("accepts a byte-identical retry owned by the same operation slot", async () => {
    const first = fixture();
    const retry = fixture();
    const sharedOwners = first.input.operationNonceOwners;
    const retryInput = { ...retry.input, operationNonceOwners: sharedOwners };
    try {
      await drain(first.input);
      const restored = await drain(retryInput);
      expect(restored.plaintext).toEqual(retry.plaintext);
      expect(sharedOwners.size).toBe(1);
    } finally {
      first.control.close();
      retry.control.close();
    }
  });

  test("rejects a same-slot nonce collision with different ciphertext", async () => {
    const first = fixture();
    const collision = fixture({
      plaintextTransform(plaintext) {
        plaintext[0] = (plaintext[0] ?? 0) ^ 0xff;
        return plaintext;
      },
    });
    const collisionInput = {
      ...collision.input,
      operationNonceOwners: first.input.operationNonceOwners,
    };
    try {
      await drain(first.input);
      await expectCode(drain(collisionInput), "AGENT_BACKUP_RESTORE_V3_NONCE_REUSE");
    } finally {
      first.control.close();
      collision.control.close();
    }
  });

  test("deep-freezes source authority before provider open", async () => {
    const exact = fixture();
    let mutationRejected = false;
    const input: StreamAgentBackupRestoreV3ExactObjectInput = {
      ...exact.input,
      openExactObject(sourceObject) {
        try {
          (sourceObject.catalog as { sizeBytes: number }).sizeBytes += 1;
        } catch (_cause: unknown) {
          mutationRejected = true;
        }
        expect(Object.isFrozen(sourceObject)).toBe(true);
        expect(Object.isFrozen(sourceObject.catalog)).toBe(true);
        return exact.read;
      },
    };
    try {
      const restored = await drain(input);
      expect(restored.plaintext).toEqual(exact.plaintext);
      expect(mutationRejected).toBe(true);
    } finally {
      exact.control.close();
    }
  });

  test("rejects nonce reuse owned by a different operation slot", async () => {
    const exact = fixture();
    exact.input.operationNonceOwners.set(
      bytesToHexForTest(NONCE),
      '{"operationId":"different-slot"}',
    );
    try {
      await expectCode(drain(exact.input), "AGENT_BACKUP_RESTORE_V3_NONCE_REUSE");
    } finally {
      exact.control.close();
    }
  });
});

function bytesToHexForTest(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
