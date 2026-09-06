import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createAgentBackupObjectStore } from "./agent-backup-object-store";
import {
  createExactRuntimeR2Backend,
  DEFAULT_IMMUTABLE_UPLOAD_DURATION_MS,
  type ExactObjectStorageBackend,
  MAX_IMMUTABLE_UPLOAD_DURATION_MS,
  ObjectStorageLifecycleError,
} from "./object-store";
import {
  createMultipartObjectUpload,
  DEFAULT_MULTIPART_REQUEST_DURATION_MS,
  MAX_MULTIPART_OBJECT_BYTES,
  MAX_MULTIPART_REQUEST_DURATION_MS,
  MULTIPART_OBJECT_PART_BYTES,
  type MultipartObjectMutationControl,
  type MultipartObjectRequestControl,
  type MultipartObjectUploadHandle,
  rehydrateMultipartObjectUploadHandle,
  resumeMultipartObjectUpload,
  type SerializedMultipartObjectUploadHandle,
} from "./object-store-multipart";
import type {
  RuntimeR2Bucket,
  RuntimeR2MultipartOptions,
  RuntimeR2MultipartUpload,
  RuntimeR2ObjectMetadata,
} from "./r2-runtime-binding";
import {
  createS3CompatibleClient,
  isSingleAttemptObjectStorageClient,
} from "./s3-compatible-client";

const BACKEND_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const KEY = "agent-sandbox-backups/org-a/generation-a/object-a";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function sha256(...parts: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function base64Sha256(part: Uint8Array): string {
  return createHash("sha256").update(part).digest("base64");
}

function bytePart(size: number, value: number): Uint8Array {
  const part = new Uint8Array(size);
  part.fill(value);
  return part;
}

function providerError(code: string, status: number): Error {
  return Object.assign(new Error(code), {
    name: code,
    $metadata: { httpStatusCode: status },
  });
}

function requestControl(
  input: {
    signal?: AbortSignal;
    deadline?: Date;
    late?: Promise<void>[];
    registrationError?: unknown;
    beforeProviderMutation?: () => Promise<void>;
  } = {},
): MultipartObjectMutationControl {
  return {
    signal: input.signal,
    deadline: input.deadline ?? new Date(Date.now() + 60_000),
    beforeProviderMutation: input.beforeProviderMutation ?? (async () => undefined),
    registerLateSettlement(settlement) {
      if (input.registrationError !== undefined) throw input.registrationError;
      input.late?.push(settlement);
    },
  };
}

interface FakeUploadState {
  readonly key: string;
  readonly uploadId: string;
  readonly options: RuntimeR2MultipartOptions;
  readonly parts: Map<number, Uint8Array>;
  aborted: boolean;
}

interface FakeStoredObject {
  readonly parts: readonly Uint8Array[];
  readonly options: RuntimeR2MultipartOptions;
  readonly etag: string;
  readonly version: string;
}

class FakeRuntimeMultipartBucket implements RuntimeR2Bucket {
  readonly uploads = new Map<string, FakeUploadState>();
  readonly objects = new Map<string, FakeStoredObject>();
  readonly createGates: Deferred<void>[] = [];
  readonly completeGates: Deferred<void>[] = [];
  readonly abortGates: Deferred<void>[] = [];
  readonly uploadGates = new Map<number, Deferred<void>>();
  readonly partResponseLoss = new Set<number>();
  readonly providerBodies = new Map<number, Uint8Array>();
  readonly callOrder: string[] = [];
  createCalls = 0;
  completeCalls = 0;
  abortCalls = 0;
  getReads = 0;
  loseCreateResponse = false;
  loseCompleteResponse = false;
  completeFailuresBeforePersist = 0;
  completeRejectsUndefined = false;
  driftCompletedBody = false;
  driftGetEtag = false;
  forgeCompletedMetadata = false;
  readonly abortFailures: unknown[] = [];
  readonly headFailures: unknown[] = [];
  workersNoSuchUploadErrors = false;
  nextUploadId: string | undefined;

  async head(key: string): Promise<RuntimeR2ObjectMetadata | null> {
    this.callOrder.push("head");
    if (this.headFailures.length > 0) throw this.headFailures.shift();
    const object = this.objects.get(key);
    if (!object) return null;
    const size = object.parts.reduce((total, part) => total + part.byteLength, 0);
    return {
      size,
      etag: object.etag,
      version: object.version,
      customMetadata: this.forgeCompletedMetadata
        ? { "eliza-content-sha256": Buffer.alloc(32, 0xff).toString("base64") }
        : object.options.customMetadata,
    };
  }

  async get(key: string) {
    this.callOrder.push("get");
    const object = this.objects.get(key);
    if (!object) return null;
    const parts = object.parts;
    let index = 0;
    const bucket = this;
    return {
      size: parts.reduce((total, part) => total + part.byteLength, 0),
      etag: this.driftGetEtag ? `${object.etag}-drift` : object.etag,
      version: object.version,
      customMetadata: object.options.customMetadata,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          const part = parts[index++];
          if (!part) {
            controller.close();
            return;
          }
          bucket.getReads += 1;
          controller.enqueue(part);
        },
      }),
      text: async () => "",
    };
  }

  async put(): Promise<unknown> {
    throw new Error("single PUT is outside this fake");
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async createMultipartUpload(
    key: string,
    options: RuntimeR2MultipartOptions = {},
  ): Promise<RuntimeR2MultipartUpload> {
    this.createCalls += 1;
    this.callOrder.push("create");
    const uploadId = this.nextUploadId ?? `upload-${this.createCalls}`;
    this.nextUploadId = undefined;
    const state: FakeUploadState = {
      key,
      uploadId,
      options,
      parts: new Map(),
      aborted: false,
    };
    this.uploads.set(uploadId, state);
    const gate = this.createGates.shift();
    if (gate) await gate.promise;
    if (this.loseCreateResponse) throw providerError("InternalError", 500);
    return this.handle(state);
  }

  resumeMultipartUpload(key: string, uploadId: string): RuntimeR2MultipartUpload {
    const state = this.uploads.get(uploadId) ?? {
      key,
      uploadId,
      options: {},
      parts: new Map<number, Uint8Array>(),
      aborted: true,
    };
    return this.handle(state);
  }

  private handle(state: FakeUploadState): RuntimeR2MultipartUpload {
    return {
      key: state.key,
      uploadId: state.uploadId,
      uploadPart: async (partNumber, body) => {
        if (state.aborted || !this.uploads.has(state.uploadId)) throw this.noSuchUploadError();
        if (!(body instanceof Uint8Array)) throw new Error("expected byte part");
        this.callOrder.push(`part-${partNumber}`);
        this.providerBodies.set(partNumber, body);
        const gate = this.uploadGates.get(partNumber);
        if (gate) await gate.promise;
        const stored = Uint8Array.from(body);
        state.parts.set(partNumber, stored);
        const etag = `etag-${base64Sha256(stored)}`;
        if (this.partResponseLoss.delete(partNumber)) {
          throw providerError("InternalError", 500);
        }
        return { partNumber, etag };
      },
      complete: async (parts) => {
        if (state.aborted || !this.uploads.has(state.uploadId)) throw this.noSuchUploadError();
        this.completeCalls += 1;
        this.callOrder.push("complete");
        const gate = this.completeGates.shift();
        if (gate) await gate.promise;
        if (this.completeFailuresBeforePersist > 0) {
          this.completeFailuresBeforePersist -= 1;
          if (this.completeRejectsUndefined) await Promise.reject(undefined);
          throw providerError("InternalError", 500);
        }
        const storedParts = parts.map(({ partNumber, etag }) => {
          const stored = state.parts.get(partNumber);
          if (!stored || etag !== `etag-${base64Sha256(stored)}`) {
            throw providerError("InvalidPart", 400);
          }
          return stored;
        });
        if (this.driftCompletedBody && storedParts.length > 0) {
          const drifted = Uint8Array.from(storedParts[storedParts.length - 1]!);
          drifted[drifted.length - 1] ^= 0xff;
          storedParts[storedParts.length - 1] = drifted;
        }
        const object = {
          parts: Object.freeze(storedParts),
          options: state.options,
          etag: `object-etag-${this.completeCalls}`,
          version: `object-version-${this.completeCalls}`,
        };
        this.objects.set(state.key, object);
        this.uploads.delete(state.uploadId);
        if (this.loseCompleteResponse) throw providerError("InternalError", 500);
        return {
          size: storedParts.reduce((total, part) => total + part.byteLength, 0),
          etag: object.etag,
          version: object.version,
          customMetadata: state.options.customMetadata,
        };
      },
      abort: async () => {
        this.abortCalls += 1;
        this.callOrder.push("abort");
        if (state.aborted || !this.uploads.has(state.uploadId)) throw this.noSuchUploadError();
        const gate = this.abortGates.shift();
        if (gate) await gate.promise;
        if (this.abortFailures.length > 0) throw this.abortFailures.shift();
        state.aborted = true;
        this.uploads.delete(state.uploadId);
      },
    };
  }

  private noSuchUploadError(): Error {
    return this.workersNoSuchUploadErrors
      ? new Error("put: The specified multipart upload does not exist. (10024)")
      : providerError("NoSuchUpload", 404);
  }
}

function runtimeBackend(bucket: RuntimeR2Bucket): ExactObjectStorageBackend {
  return createExactRuntimeR2Backend({
    locator: {
      transport: "worker-r2-binding",
      provider: "r2",
      endpointAlias: "r2-primary-eu",
      backendIdentityFingerprint: BACKEND_FINGERPRINT,
      bucket: "private-backup-bucket",
      region: "auto",
    },
    bucket,
  });
}

interface FakeS3Upload {
  readonly key: string;
  readonly metadata: Record<string, string>;
  readonly parts: Map<number, { body: Uint8Array; etag: string; checksum: string }>;
}

class FakeS3MultipartClient {
  readonly uploads = new Map<string, FakeS3Upload>();
  readonly objects = new Map<
    string,
    {
      parts: readonly Uint8Array[];
      metadata: Record<string, string>;
      etag: string;
      version?: string;
    }
  >();
  readonly signals: AbortSignal[] = [];
  readonly commands: string[] = [];
  readonly abortInputs: Array<{ bucket: string; key: string; uploadId: string }> = [];
  readonly createGates: Deferred<void>[] = [];
  readonly listPartsGates: Deferred<void>[] = [];
  createEchoBucket: string | undefined;
  createEchoKey: string | undefined;
  readonly createFailures: unknown[] = [];
  readonly getFailures: unknown[] = [];
  abortKeepsUploadAttempts = 0;
  omitObjectVersion = false;
  nextUploadId = 1;
  nextUploadIdOverride: string | undefined;

  async send(
    command: { constructor: { name: string }; input: unknown },
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown> {
    if (options?.abortSignal) this.signals.push(options.abortSignal);
    const name = command.constructor.name;
    this.commands.push(name);
    const input = command.input as Record<string, unknown>;
    const key = String(input.Key ?? "");
    const uploadId = String(input.UploadId ?? "");

    if (name === "CreateMultipartUploadCommand") {
      if (this.createFailures.length > 0) throw this.createFailures.shift();
      const nextUploadId = this.nextUploadIdOverride ?? `s3-upload-${this.nextUploadId++}`;
      this.nextUploadIdOverride = undefined;
      this.uploads.set(nextUploadId, {
        key,
        metadata: { ...((input.Metadata as Record<string, string> | undefined) ?? {}) },
        parts: new Map(),
      });
      const gate = this.createGates.shift();
      if (gate) await gate.promise;
      return {
        Key: this.createEchoKey ?? key,
        Bucket: this.createEchoBucket ?? input.Bucket,
        UploadId: nextUploadId,
      };
    }
    if (name === "UploadPartCommand") {
      const upload = this.uploads.get(uploadId);
      if (!upload) throw providerError("NoSuchUpload", 404);
      const partNumber = Number(input.PartNumber);
      const body = input.Body;
      if (!(body instanceof Uint8Array)) throw new Error("expected S3 byte part");
      const stored = Uint8Array.from(body);
      const checksum = String(input.ChecksumSHA256 ?? "");
      const etag = `"s3-etag-${base64Sha256(stored)}"`;
      upload.parts.set(partNumber, { body: stored, etag, checksum });
      return { ETag: etag, ChecksumSHA256: checksum };
    }
    if (name === "ListPartsCommand") {
      const gate = this.listPartsGates.shift();
      if (gate) await gate.promise;
      const upload = this.uploads.get(uploadId);
      if (!upload) throw providerError("NoSuchUpload", 404);
      return {
        Key: key,
        Bucket: input.Bucket,
        UploadId: uploadId,
        IsTruncated: false,
        Parts: [...upload.parts.entries()].map(([partNumber, part]) => ({
          PartNumber: partNumber,
          ETag: part.etag,
          Size: part.body.byteLength,
          ChecksumSHA256: part.checksum,
        })),
      };
    }
    if (name === "CompleteMultipartUploadCommand") {
      const upload = this.uploads.get(uploadId);
      if (!upload) throw providerError("NoSuchUpload", 404);
      const requested = ((input.MultipartUpload as { Parts?: unknown[] } | undefined)?.Parts ??
        []) as Array<{ PartNumber?: number; ETag?: string }>;
      const parts = requested.map((requestedPart) => {
        const stored = upload.parts.get(requestedPart.PartNumber ?? -1);
        if (!stored || stored.etag !== requestedPart.ETag) {
          throw providerError("InvalidPart", 400);
        }
        return stored.body;
      });
      this.objects.set(key, {
        parts: Object.freeze(parts),
        metadata: upload.metadata,
        etag: `s3-object-etag-${uploadId}`,
        version: this.omitObjectVersion ? undefined : `s3-version-${uploadId}`,
      });
      this.uploads.delete(uploadId);
      return { Key: key, Bucket: input.Bucket };
    }
    if (name === "AbortMultipartUploadCommand") {
      this.abortInputs.push({
        bucket: String(input.Bucket ?? ""),
        key,
        uploadId,
      });
      if (!this.uploads.has(uploadId)) throw providerError("NoSuchUpload", 404);
      if (this.abortKeepsUploadAttempts > 0) {
        this.abortKeepsUploadAttempts -= 1;
        return {};
      }
      this.uploads.delete(uploadId);
      return {};
    }
    if (name === "HeadObjectCommand") {
      const object = this.objects.get(key);
      if (!object) throw providerError("NoSuchKey", 404);
      return {
        ContentLength: object.parts.reduce((total, part) => total + part.byteLength, 0),
        ETag: `"${object.etag}"`,
        VersionId: object.version,
        Metadata: object.metadata,
      };
    }
    if (name === "GetObjectCommand") {
      if (this.getFailures.length > 0) throw this.getFailures.shift();
      const object = this.objects.get(key);
      if (!object) throw providerError("NoSuchKey", 404);
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const part = object.parts[index++];
          if (!part) {
            controller.close();
            return;
          }
          controller.enqueue(part);
        },
      });
      return {
        ContentLength: object.parts.reduce((total, part) => total + part.byteLength, 0),
        ETag: `"${object.etag}"`,
        VersionId: object.version,
        Metadata: object.metadata,
        Body: stream,
      };
    }
    throw new Error(`unexpected ${name}`);
  }
}

function s3Backend(
  client: FakeS3MultipartClient,
  input: { singleAttempt?: boolean } = {},
): ExactObjectStorageBackend {
  const transport = createS3CompatibleClient({
    endpoint: "http://127.0.0.1:9",
    region: "fsn1",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    maxAttempts: input.singleAttempt === false ? 3 : 1,
  });
  transport.send = client.send.bind(client) as typeof transport.send;
  return {
    locator: {
      transport: "s3-compatible",
      provider: "s3",
      endpointAlias: "hetzner-fsn1",
      backendIdentityFingerprint: BACKEND_FINGERPRINT,
      bucket: "private-backup-bucket",
      region: "fsn1",
    },
    s3Client: transport,
  } as unknown as ExactObjectStorageBackend;
}

async function createRuntimeSession(input: {
  bucket: FakeRuntimeMultipartBucket;
  parts: readonly Uint8Array[];
  key?: string;
  control?: MultipartObjectRequestControl;
}) {
  return createMultipartObjectUpload({
    backend: runtimeBackend(input.bucket),
    key: input.key ?? KEY,
    expectedSize: input.parts.reduce((total, part) => total + part.byteLength, 0),
    expectedSha256: sha256(...input.parts),
    control: input.control ?? requestControl(),
  });
}

async function uploadAll(
  session: Awaited<ReturnType<typeof createRuntimeSession>>,
  parts: readonly Uint8Array[],
): Promise<void> {
  for (let index = 0; index < parts.length; index += 1) {
    await session.uploadPart({
      partNumber: index + 1,
      body: parts[index]!,
      control: requestControl(),
    });
  }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    if (!(error instanceof ObjectStorageLifecycleError)) throw error;
    expect(error.code).toBe(code);
  }
}

describe("exact multipart object upload", () => {
  test("pins every store multipart wrapper to its captured backend authority", async () => {
    const ownerBucket = new FakeRuntimeMultipartBucket();
    const foreignBucket = new FakeRuntimeMultipartBucket();
    const store = await createAgentBackupObjectStore({
      provider: "cloudflare-r2",
      transport: "worker-r2",
      endpointAlias: "r2-owner-eu",
      accountIdentity: "cloudflare-owner-account",
      bindingIdentity: "BACKUP_OWNER",
      bucket: "sandbox-backup-owner",
      region: "auto",
      bucketBinding: ownerBucket,
    });
    const foreignBackend = runtimeBackend(foreignBucket);
    const part = bytePart(23, 0x0f);
    const createInput = {
      backend: foreignBackend,
      key: KEY,
      expectedSize: part.byteLength,
      expectedSha256: sha256(part),
      control: requestControl(),
    };
    const session = await store.createMultipart(createInput);
    expect(ownerBucket.createCalls).toBe(1);
    expect(foreignBucket.createCalls).toBe(0);

    const rehydrateInput = {
      backend: foreignBackend,
      key: session.handle.key,
      uploadId: session.handle.uploadId,
      expectedSize: session.handle.expectedSize,
      expectedSha256: session.handle.expectedSha256,
      contentType: session.handle.contentType,
      receipt: session.handle.toJSON(),
    };
    const rehydrated = await store.rehydrateMultipartHandle(rehydrateInput);
    expect(rehydrated.handleFingerprint).toBe(session.handle.handleFingerprint);

    const resumeInput = {
      backend: foreignBackend,
      handle: rehydrated,
      acknowledgedParts: [],
      control: requestControl(),
    };
    const resumed = await store.resumeMultipart(resumeInput);
    await resumed.abort(requestControl());
    expect(ownerBucket.abortCalls).toBe(1);
    expect(foreignBucket.abortCalls).toBe(0);
  });

  test("snapshots mutable runtime and S3 backends for the whole session", async () => {
    const runtimeOwner = new FakeRuntimeMultipartBucket();
    const runtimeForeign = new FakeRuntimeMultipartBucket();
    const mutableRuntimeBackend = runtimeBackend(runtimeOwner);
    const runtimePart = bytePart(17, 0x10);
    const runtimeCreation = createMultipartObjectUpload({
      backend: mutableRuntimeBackend,
      key: `${KEY}-runtime-snapshot`,
      expectedSize: runtimePart.byteLength,
      expectedSha256: sha256(runtimePart),
      control: requestControl(),
    });
    Object.assign(mutableRuntimeBackend, { runtimeBucket: runtimeForeign });
    const runtimeSession = await runtimeCreation;
    await uploadAll(runtimeSession, [runtimePart]);
    await runtimeSession.complete(requestControl());
    expect(runtimeOwner.objects.has(`${KEY}-runtime-snapshot`)).toBe(true);
    expect(runtimeForeign.objects.size).toBe(0);

    const s3Owner = new FakeS3MultipartClient();
    const s3Foreign = new FakeS3MultipartClient();
    const mutableS3Backend = s3Backend(s3Owner);
    const s3Part = bytePart(19, 0x11);
    const s3Session = await createMultipartObjectUpload({
      backend: mutableS3Backend,
      key: `${KEY}-s3-snapshot`,
      expectedSize: s3Part.byteLength,
      expectedSha256: sha256(s3Part),
      control: requestControl(),
    });
    Object.assign(mutableS3Backend, { s3Client: s3Foreign });
    await s3Session.uploadPart({ partNumber: 1, body: s3Part, control: requestControl() });
    await s3Session.complete(requestControl());
    expect(s3Owner.objects.has(`${KEY}-s3-snapshot`)).toBe(true);
    expect(s3Foreign.commands).toEqual([]);
  });

  test("reads provider bindings and locator fields only once at the backend boundary", async () => {
    const owner = new FakeRuntimeMultipartBucket();
    const foreign = new FakeRuntimeMultipartBucket();
    const exactLocator = runtimeBackend(owner).locator;
    const locatorReads = new Map<string, number>();
    const locator: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(exactLocator)) {
      Object.defineProperty(locator, field, {
        enumerable: true,
        get() {
          locatorReads.set(field, (locatorReads.get(field) ?? 0) + 1);
          return value;
        },
      });
    }
    let bindingReads = 0;
    const backend = {
      locator,
      get runtimeBucket() {
        bindingReads += 1;
        return bindingReads === 1 ? owner : foreign;
      },
    } as unknown as ExactObjectStorageBackend;
    const part = bytePart(21, 0x14);
    const session = await createMultipartObjectUpload({
      backend,
      key: `${KEY}-getter-backend`,
      expectedSize: part.byteLength,
      expectedSha256: sha256(part),
      control: requestControl(),
    });
    expect(bindingReads).toBe(1);
    expect([...locatorReads.values()].every((reads) => reads === 1)).toBe(true);
    expect(owner.createCalls).toBe(1);
    expect(foreign.createCalls).toBe(0);
    await session.abort(requestControl());
  });

  test("snapshots the resume handle before asynchronous authority validation", async () => {
    const ownerBucket = new FakeRuntimeMultipartBucket();
    const foreignBucket = new FakeRuntimeMultipartBucket();
    const part = bytePart(13, 0x12);
    const owner = await createRuntimeSession({
      bucket: ownerBucket,
      parts: [part],
      key: `${KEY}-resume-owner`,
    });
    const foreignFirst = await createRuntimeSession({
      bucket: foreignBucket,
      parts: [part],
      key: `${KEY}-resume-foreign-first`,
    });
    const foreignSecond = await createRuntimeSession({
      bucket: foreignBucket,
      parts: [part],
      key: `${KEY}-resume-foreign-second`,
    });
    const mutableHandle = {
      ...owner.handle,
      endpointAlias: owner.handle.endpointAlias,
      bucket: owner.handle.bucket,
      region: owner.handle.region,
      key: owner.handle.key,
      uploadId: owner.handle.uploadId,
    } as MultipartObjectUploadHandle;
    const mutableInput = {
      backend: runtimeBackend(ownerBucket),
      handle: mutableHandle,
      acknowledgedParts: [],
      control: requestControl(),
    };
    const resumedPromise = resumeMultipartObjectUpload(mutableInput);
    mutableInput.handle = foreignSecond.handle;
    Object.assign(mutableHandle, {
      key: foreignFirst.handle.key,
      uploadId: foreignFirst.handle.uploadId,
      handleFingerprint: foreignFirst.handle.handleFingerprint,
    });
    const resumed = await resumedPromise;
    expect(resumed.handle.handleFingerprint).toBe(owner.handle.handleFingerprint);

    await resumed.abort(requestControl());
    await foreignFirst.abort(requestControl());
    await foreignSecond.abort(requestControl());
  });

  test("snapshots mutable durable receipts before asynchronous validation", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const part = bytePart(13, 0x13);
    const original = await createRuntimeSession({ bucket, parts: [part] });
    const partReceipt = await original.uploadPart({
      partNumber: 1,
      body: part,
      control: requestControl(),
    });
    const mutablePartReceipt = { ...partReceipt };
    const resume = resumeMultipartObjectUpload({
      backend: runtimeBackend(bucket),
      handle: original.handle,
      acknowledgedParts: [mutablePartReceipt],
      control: requestControl(),
    });
    mutablePartReceipt.etag = "mutated-after-call";
    const resumed = await resume;
    expect(resumed.acknowledgedParts()).toEqual([partReceipt]);

    const mutableHandleReceipt = { ...original.handle.toJSON() };
    const rehydration = rehydrateMultipartObjectUploadHandle({
      backend: runtimeBackend(bucket),
      key: original.handle.key,
      uploadId: original.handle.uploadId,
      expectedSize: original.handle.expectedSize,
      expectedSha256: original.handle.expectedSha256,
      contentType: original.handle.contentType,
      receipt: mutableHandleReceipt,
    });
    mutableHandleReceipt.handleFingerprint = `sha256:${"f".repeat(64)}`;
    await expect(rehydration).resolves.toMatchObject({
      handleFingerprint: original.handle.handleFingerprint,
    });
    await resumed.abort(requestControl());
  });

  test("uploads three fixed parts without whole-object concatenation and keeps JSON private", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const parts = [
      bytePart(MULTIPART_OBJECT_PART_BYTES, 0x11),
      bytePart(MULTIPART_OBJECT_PART_BYTES, 0x22),
      bytePart(17, 0x33),
    ];
    const session = await createRuntimeSession({ bucket, parts });
    await uploadAll(session, parts);
    const receipt = await session.complete(requestControl());

    expect(session.acknowledgedParts().map((part) => part.partNumber)).toEqual([1, 2, 3]);
    expect(receipt).toMatchObject({
      metadata: { sizeBytes: MULTIPART_OBJECT_PART_BYTES * 2 + 17 },
      verifiedPresent: true,
    });
    expect(bucket.objects.get(KEY)?.parts).toHaveLength(3);
    expect(bucket.getReads).toBe(3);

    const serialized = JSON.stringify({
      handle: session.handle,
      parts: session.acknowledgedParts(),
    });
    for (const privateValue of [
      KEY,
      session.handle.uploadId,
      "private-backup-bucket",
      "r2-primary-eu",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    for (const privateField of ["key", "uploadId", "bucket", "endpointAlias"]) {
      expect(Object.keys(session.handle)).not.toContain(privateField);
    }
    const safeReceipt = JSON.parse(serialized).handle as SerializedMultipartObjectUploadHandle;
    const rehydrated = await rehydrateMultipartObjectUploadHandle({
      backend: runtimeBackend(bucket),
      key: KEY,
      uploadId: session.handle.uploadId,
      expectedSize: session.handle.expectedSize,
      expectedSha256: session.handle.expectedSha256,
      contentType: session.handle.contentType,
      receipt: safeReceipt,
    });
    expect(rehydrated.handleFingerprint).toBe(session.handle.handleFingerprint);
  }, 30_000);

  test("accepts one uniquely small trailing part", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const parts = [bytePart(31, 0x44)];
    const session = await createRuntimeSession({ bucket, parts });
    await uploadAll(session, parts);
    await expect(session.complete(requestControl())).resolves.toMatchObject({
      metadata: { sizeBytes: 31 },
    });
    expect(bucket.objects.get(KEY)?.parts).toHaveLength(1);
  });

  test("rejects invalid plans, slots, sizes, and forged handles before provider effects", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    await expectCode(
      createMultipartObjectUpload({
        backend: runtimeBackend(bucket),
        key: KEY,
        expectedSize: MAX_MULTIPART_OBJECT_BYTES + 1,
        expectedSha256: "0".repeat(64),
        control: requestControl(),
      }),
      "OBJECT_STORAGE_MULTIPART_INVALID",
    );
    expect(bucket.createCalls).toBe(0);
    await expectCode(
      createMultipartObjectUpload({
        backend: runtimeBackend(bucket),
        key: KEY,
        expectedSize: 1,
        expectedSha256: "0".repeat(64),
        control: {} as MultipartObjectMutationControl,
      }),
      "OBJECT_STORAGE_MULTIPART_INVALID",
    );
    expect(bucket.createCalls).toBe(0);

    const part = bytePart(23, 0x55);
    const session = await createRuntimeSession({ bucket, parts: [part] });
    await expectCode(
      session.uploadPart({ partNumber: 2, body: part, control: requestControl() }),
      "OBJECT_STORAGE_MULTIPART_INVALID",
    );
    await expectCode(
      session.uploadPart({ partNumber: 1, body: part.subarray(1), control: requestControl() }),
      "OBJECT_STORAGE_MULTIPART_INVALID",
    );

    const forged = {
      ...session.handle,
      endpointAlias: session.handle.endpointAlias,
      bucket: session.handle.bucket,
      region: session.handle.region,
      key: session.handle.key,
      uploadId: session.handle.uploadId,
      handleFingerprint: `sha256:${"f".repeat(64)}`,
    } as MultipartObjectUploadHandle;
    await expectCode(
      resumeMultipartObjectUpload({
        backend: runtimeBackend(bucket),
        handle: forged,
        control: requestControl(),
      }),
      "OBJECT_STORAGE_MULTIPART_HANDLE_MISMATCH",
    );
  });

  test("requires and snapshots fenced authority before multipart creation", async () => {
    const missingHookBucket = new FakeRuntimeMultipartBucket();
    const readOnlyControl: MultipartObjectRequestControl = {
      deadline: new Date(Date.now() + 60_000),
      registerLateSettlement() {},
    };
    await expectCode(
      createMultipartObjectUpload({
        backend: runtimeBackend(missingHookBucket),
        key: KEY,
        expectedSize: 1,
        expectedSha256: sha256(new Uint8Array([1])),
        control: readOnlyControl as MultipartObjectMutationControl,
      }),
      "OBJECT_STORAGE_MULTIPART_INVALID",
    );
    expect(missingHookBucket.createCalls).toBe(0);

    const rejectedBucket = new FakeRuntimeMultipartBucket();
    const leaseLost = new Error("catalogue lease generation expired");
    await expect(
      createMultipartObjectUpload({
        backend: runtimeBackend(rejectedBucket),
        key: KEY,
        expectedSize: 1,
        expectedSha256: sha256(new Uint8Array([2])),
        control: requestControl({
          beforeProviderMutation: async () => {
            throw leaseLost;
          },
        }),
      }),
    ).rejects.toBe(leaseLost);
    expect(rejectedBucket.createCalls).toBe(0);

    const snapshottedBucket = new FakeRuntimeMultipartBucket();
    let originalChecks = 0;
    let replacementChecks = 0;
    const control = requestControl({
      beforeProviderMutation: async () => {
        originalChecks += 1;
      },
    });
    const creation = createRuntimeSession({
      bucket: snapshottedBucket,
      parts: [new Uint8Array([3])],
      control,
    });
    Object.assign(control, {
      beforeProviderMutation: async () => {
        replacementChecks += 1;
      },
    });
    const session = await creation;
    expect(originalChecks).toBe(1);
    expect(replacementChecks).toBe(0);
    expect(snapshottedBucket.callOrder[0]).toBe("create");
    await session.abort(requestControl());
  });

  test("snapshots mutable plan scalars before validating the provider plan", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const exactSha256 = sha256(new Uint8Array([4]));
    let sizeReads = 0;
    let shaReads = 0;
    const session = await createMultipartObjectUpload({
      backend: runtimeBackend(bucket),
      key: KEY,
      get expectedSize() {
        sizeReads += 1;
        return sizeReads < 5 ? 1 : 2 ** 40;
      },
      get expectedSha256() {
        shaReads += 1;
        return shaReads === 1 ? exactSha256 : "not-a-canonical-digest";
      },
      control: requestControl(),
    });
    expect(sizeReads).toBe(1);
    expect(shaReads).toBe(1);
    expect(session.handle).toMatchObject({
      expectedSize: 1,
      expectedSha256: exactSha256,
      partCount: 1,
    });
    await session.abort(requestControl());
  });

  test("runs fenced authority immediately before each successful provider mutation", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const part = bytePart(27, 0x54);
    const session = await createRuntimeSession({
      bucket,
      parts: [part],
      control: requestControl({
        beforeProviderMutation: async () => {
          bucket.callOrder.push("authorize-create");
        },
      }),
    });
    await session.uploadPart({
      partNumber: 1,
      body: part,
      control: requestControl({
        beforeProviderMutation: async () => {
          bucket.callOrder.push("authorize-part");
        },
      }),
    });
    await session.complete(
      requestControl({
        beforeProviderMutation: async () => {
          bucket.callOrder.push("authorize-complete");
        },
      }),
    );
    expect(bucket.callOrder).toEqual([
      "authorize-create",
      "create",
      "authorize-part",
      "part-1",
      "authorize-complete",
      "complete",
      "head",
      "get",
    ]);

    const abortBucket = new FakeRuntimeMultipartBucket();
    const abortSession = await createRuntimeSession({ bucket: abortBucket, parts: [part] });
    await abortSession.abort(
      requestControl({
        beforeProviderMutation: async () => {
          abortBucket.callOrder.push("authorize-abort");
        },
      }),
    );
    expect(abortBucket.callOrder.slice(-2)).toEqual(["authorize-abort", "abort"]);
  });

  test("returns the public unsupported code before provider effects", async () => {
    const bucket: RuntimeR2Bucket = {
      async head() {
        return null;
      },
      async get() {
        return null;
      },
      async put() {
        return null;
      },
      async delete() {},
    };
    await expectCode(
      createMultipartObjectUpload({
        backend: runtimeBackend(bucket),
        key: KEY,
        expectedSize: 1,
        expectedSha256: sha256(new Uint8Array([1])),
        control: requestControl(),
      }),
      "OBJECT_STORAGE_MULTIPART_UNSUPPORTED",
    );
  });

  test("distinguishes authoritative S3 create rejection from unsupported multipart", async () => {
    const rejected = new FakeS3MultipartClient();
    rejected.createFailures.push(providerError("AccessDenied", 403));
    await expectCode(
      createMultipartObjectUpload({
        backend: s3Backend(rejected),
        key: KEY,
        expectedSize: 1,
        expectedSha256: sha256(new Uint8Array([2])),
        control: requestControl(),
      }),
      "OBJECT_STORAGE_MULTIPART_CREATE_FAILED",
    );
    expect(rejected.commands).toEqual(["CreateMultipartUploadCommand"]);
    expect(rejected.uploads.size).toBe(0);

    const unsupported = new FakeS3MultipartClient();
    unsupported.createFailures.push(providerError("NotImplemented", 501));
    await expectCode(
      createMultipartObjectUpload({
        backend: s3Backend(unsupported),
        key: KEY,
        expectedSize: 1,
        expectedSha256: sha256(new Uint8Array([3])),
        control: requestControl(),
      }),
      "OBJECT_STORAGE_MULTIPART_UNSUPPORTED",
    );
    expect(unsupported.commands).toEqual(["CreateMultipartUploadCommand"]);
    expect(unsupported.uploads.size).toBe(0);

    const timedOut = new FakeS3MultipartClient();
    timedOut.createFailures.push(providerError("RequestTimeout", 400));
    await expectCode(
      createMultipartObjectUpload({
        backend: s3Backend(timedOut),
        key: KEY,
        expectedSize: 1,
        expectedSha256: sha256(new Uint8Array([4])),
        control: requestControl(),
      }),
      "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE",
    );
    expect(timedOut.commands).toEqual(["CreateMultipartUploadCommand"]);

    for (const field of ["code", "Code"] as const) {
      const compatibleTimeout = new FakeS3MultipartClient();
      compatibleTimeout.createFailures.push(
        Object.assign(new Error("request timed out"), {
          [field]: "RequestTimeout",
          $metadata: { httpStatusCode: 400 },
        }),
      );
      await expectCode(
        createMultipartObjectUpload({
          backend: s3Backend(compatibleTimeout),
          key: `${KEY}-${field}`,
          expectedSize: 1,
          expectedSha256: sha256(new Uint8Array([5])),
          control: requestControl(),
        }),
        "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE",
      );
      expect(compatibleTimeout.commands).toEqual(["CreateMultipartUploadCommand"]);
    }
  });

  test("rejects hidden S3 create retries before any provider effect", async () => {
    const client = new FakeS3MultipartClient();
    const part = bytePart(5, 0x4f);
    await expectCode(
      createMultipartObjectUpload({
        backend: s3Backend(client, { singleAttempt: false }),
        key: KEY,
        expectedSize: part.byteLength,
        expectedSha256: sha256(part),
        control: requestControl(),
      }),
      "OBJECT_STORAGE_MULTIPART_INVALID",
    );
    expect(client.commands).toEqual([]);
    expect(client.uploads.size).toBe(0);
  });

  test("rejects hidden S3 mutation retries when resuming a durable handle", async () => {
    const client = new FakeS3MultipartClient();
    const part = bytePart(9, 0x4e);
    const session = await createMultipartObjectUpload({
      backend: s3Backend(client),
      key: KEY,
      expectedSize: part.byteLength,
      expectedSha256: sha256(part),
      control: requestControl(),
    });
    const commandsBeforeResume = client.commands.length;
    await expectCode(
      resumeMultipartObjectUpload({
        backend: s3Backend(client, { singleAttempt: false }),
        handle: session.handle,
        control: requestControl(),
      }),
      "OBJECT_STORAGE_MULTIPART_INVALID",
    );
    expect(client.commands).toHaveLength(commandsBeforeResume);
    await session.abort(requestControl());
  });

  test("snapshots the S3 retry budget before marking a client single-attempt", async () => {
    let maxAttemptReads = 0;
    const client = createS3CompatibleClient({
      endpoint: "http://127.0.0.1:9",
      region: "fsn1",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      get maxAttempts() {
        maxAttemptReads += 1;
        return maxAttemptReads === 1 ? 3 : 1;
      },
    });
    try {
      expect(maxAttemptReads).toBe(1);
      expect(isSingleAttemptObjectStorageClient(client)).toBe(false);
      expect(await client.config.maxAttempts()).toBe(3);
    } finally {
      client.destroy();
    }
  });

  test("accepts exactly 1024 UTF-8 key bytes and rejects the next code point", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const part = bytePart(7, 0x5a);
    const exactKey = "😀".repeat(256);
    const session = await createRuntimeSession({ bucket, parts: [part], key: exactKey });
    await session.abort(requestControl());
    expect(bucket.createCalls).toBe(1);

    await expectCode(
      createRuntimeSession({
        bucket,
        parts: [part],
        key: "😀".repeat(257),
      }),
      "OBJECT_STORAGE_MULTIPART_INVALID",
    );
    expect(bucket.createCalls).toBe(1);
  });

  test("uses the single-PUT default deadline and rejects deadlines beyond its cap", async () => {
    expect(DEFAULT_MULTIPART_REQUEST_DURATION_MS).toBe(DEFAULT_IMMUTABLE_UPLOAD_DURATION_MS);
    expect(MAX_MULTIPART_REQUEST_DURATION_MS).toBe(MAX_IMMUTABLE_UPLOAD_DURATION_MS);

    const withoutDeadline: MultipartObjectMutationControl = {
      beforeProviderMutation: async () => undefined,
      registerLateSettlement() {},
    };
    const part = bytePart(11, 0x5b);
    const bucket = new FakeRuntimeMultipartBucket();
    const session = await createRuntimeSession({ bucket, parts: [part], control: withoutDeadline });
    await session.abort(withoutDeadline);
    expect(bucket.createCalls).toBe(1);

    const rejected = new FakeRuntimeMultipartBucket();
    await expectCode(
      createRuntimeSession({
        bucket: rejected,
        parts: [part],
        control: requestControl({
          deadline: new Date(Date.now() + MAX_MULTIPART_REQUEST_DURATION_MS + 60_000),
        }),
      }),
      "OBJECT_STORAGE_MULTIPART_INVALID",
    );
    expect(rejected.createCalls).toBe(0);
  });

  test("aborts an S3 upload against the requested locator when create echoes drift", async () => {
    const client = new FakeS3MultipartClient();
    client.createEchoKey = `${KEY}-foreign`;
    client.createEchoBucket = "foreign-bucket";
    const late: Promise<void>[] = [];
    const part = bytePart(13, 0x5c);
    let failure: unknown;
    try {
      await createMultipartObjectUpload({
        backend: s3Backend(client),
        key: KEY,
        expectedSize: part.byteLength,
        expectedSha256: sha256(part),
        control: requestControl({ late }),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ObjectStorageLifecycleError);
    expect((failure as ObjectStorageLifecycleError).code).toBe(
      "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE",
    );
    await Promise.all(late);
    expect(client.abortInputs).toEqual([
      {
        bucket: "private-backup-bucket",
        key: KEY,
        uploadId: "s3-upload-1",
      },
    ]);
    expect(client.uploads.size).toBe(0);
    expect(String(failure)).not.toContain(KEY);
    expect(String(failure)).not.toContain("s3-upload-1");
    expect(String(failure)).not.toContain("private-backup-bucket");
  });

  test("keeps create indeterminate when post-effect cleanup registration throws", async () => {
    const client = new FakeS3MultipartClient();
    client.createEchoKey = `${KEY}-foreign`;
    const part = bytePart(17, 0x5d);
    await expectCode(
      createMultipartObjectUpload({
        backend: s3Backend(client),
        key: KEY,
        expectedSize: part.byteLength,
        expectedSha256: sha256(part),
        control: requestControl({ registrationError: new Error("registration unavailable") }),
      }),
      "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE",
    );
    await Bun.sleep(1);
    expect(client.abortInputs).toHaveLength(1);
    expect(client.uploads.size).toBe(0);
  });

  test("never retries an indeterminate create and aborts a late resolved handle", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const gate = deferred<void>();
    bucket.createGates.push(gate);
    const late: Promise<void>[] = [];
    const part = bytePart(19, 0x66);
    const creation = createRuntimeSession({
      bucket,
      parts: [part],
      control: requestControl({ deadline: new Date(Date.now() + 10), late }),
    });
    await expectCode(creation, "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE");
    expect(bucket.createCalls).toBe(1);
    gate.resolve();
    await Promise.all(late);
    expect(bucket.abortCalls).toBe(1);
    expect(bucket.createCalls).toBe(1);

    const lost = new FakeRuntimeMultipartBucket();
    lost.loseCreateResponse = true;
    await expectCode(
      createRuntimeSession({ bucket: lost, parts: [part] }),
      "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE",
    );
    expect(lost.createCalls).toBe(1);
  });

  test("aborts late-created runtime and S3 uploads even when their ids are not persistable", async () => {
    const invalidUploadId = "x".repeat(4_097);

    const runtimeBucket = new FakeRuntimeMultipartBucket();
    runtimeBucket.nextUploadId = invalidUploadId;
    const runtimeGate = deferred<void>();
    runtimeBucket.createGates.push(runtimeGate);
    const runtimeLate: Promise<void>[] = [];
    const runtimeCreation = createRuntimeSession({
      bucket: runtimeBucket,
      parts: [bytePart(17, 0x63)],
      control: requestControl({ deadline: new Date(Date.now() + 10), late: runtimeLate }),
    });
    await expectCode(runtimeCreation, "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE");
    runtimeGate.resolve();
    await Promise.all(runtimeLate);
    expect(runtimeBucket.abortCalls).toBe(1);
    expect(runtimeBucket.uploads.size).toBe(0);

    const s3Client = new FakeS3MultipartClient();
    s3Client.nextUploadIdOverride = invalidUploadId;
    const s3Gate = deferred<void>();
    s3Client.createGates.push(s3Gate);
    const s3Late: Promise<void>[] = [];
    const s3Creation = createMultipartObjectUpload({
      backend: s3Backend(s3Client),
      key: KEY,
      expectedSize: 1,
      expectedSha256: sha256(new Uint8Array([1])),
      control: requestControl({ deadline: new Date(Date.now() + 10), late: s3Late }),
    });
    await expectCode(s3Creation, "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE");
    s3Gate.resolve();
    await Promise.all(s3Late);
    expect(s3Client.abortInputs).toHaveLength(1);
    expect(s3Client.abortInputs[0]?.uploadId).toBe(invalidUploadId);
    expect(s3Client.uploads.size).toBe(0);
  });

  test("registers cleanup when S3 immediately returns an invalid upload id", async () => {
    const client = new FakeS3MultipartClient();
    const invalidUploadId = "y".repeat(4_097);
    client.nextUploadIdOverride = invalidUploadId;
    const late: Promise<void>[] = [];
    await expectCode(
      createMultipartObjectUpload({
        backend: s3Backend(client),
        key: KEY,
        expectedSize: 1,
        expectedSha256: sha256(new Uint8Array([2])),
        control: requestControl({ late }),
      }),
      "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE",
    );
    await Promise.all(late);
    expect(client.abortInputs).toHaveLength(1);
    expect(client.abortInputs[0]?.uploadId).toBe(invalidUploadId);
    expect(client.uploads.size).toBe(0);
  });

  test("owns a provider result that settles between cancellation and the race observer", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const gate = deferred<void>();
    bucket.createGates.push(gate);
    const originalLate: Promise<void>[] = [];
    const stolenLate: Promise<void>[] = [];
    const controller = new AbortController();
    const control = requestControl({ signal: controller.signal, late: originalLate });
    const part = bytePart(19, 0x68);
    const creation = createRuntimeSession({ bucket, parts: [part], control });
    while (bucket.createCalls === 0) await Promise.resolve();

    Object.assign(control, {
      registerLateSettlement(settlement: Promise<void>) {
        stolenLate.push(settlement);
      },
    });
    controller.abort();
    gate.resolve();

    await expectCode(creation, "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE");
    expect(originalLate).toHaveLength(1);
    expect(stolenLate).toHaveLength(0);
    await Promise.all(originalLate);
    expect(bucket.abortCalls).toBe(1);
    expect(bucket.uploads.size).toBe(0);
  });

  test("keeps a failed late-created upload cleanup observable to the durable caller", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const gate = deferred<void>();
    bucket.createGates.push(gate);
    bucket.abortFailures.push(providerError("InternalError", 500));
    const late: Promise<void>[] = [];
    const part = bytePart(29, 0x67);
    const creation = createRuntimeSession({
      bucket,
      parts: [part],
      control: requestControl({ deadline: new Date(Date.now() + 10), late }),
    });
    await expectCode(creation, "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE");
    expect(late).toHaveLength(1);
    gate.resolve();
    await expect(late[0]).rejects.toMatchObject({ name: "InternalError" });
    expect(bucket.abortCalls).toBe(1);
    expect(bucket.uploads.size).toBe(1);
  });

  test("replays the same response-lost part but rejects a different body", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const part = bytePart(37, 0x77);
    const session = await createRuntimeSession({ bucket, parts: [part] });
    bucket.partResponseLoss.add(1);
    await expectCode(
      session.uploadPart({ partNumber: 1, body: part, control: requestControl() }),
      "OBJECT_STORAGE_MULTIPART_PART_FAILED",
    );
    const receipt = await session.uploadPart({
      partNumber: 1,
      body: part,
      control: requestControl(),
    });
    expect(receipt.providerAcknowledged).toBe(true);

    const different = Uint8Array.from(part);
    different[0] ^= 0xff;
    await expectCode(
      session.uploadPart({ partNumber: 1, body: different, control: requestControl() }),
      "OBJECT_STORAGE_MULTIPART_PART_CONFLICT",
    );
  });

  test("revalidates authority before a part mutation and releases a rejected admission", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const part = bytePart(31, 0x76);
    const session = await createRuntimeSession({ bucket, parts: [part] });
    const leaseLost = new Error("part lease generation expired");
    await expect(
      session.uploadPart({
        partNumber: 1,
        body: part,
        control: requestControl({
          beforeProviderMutation: async () => {
            throw leaseLost;
          },
        }),
      }),
    ).rejects.toBe(leaseLost);
    expect(bucket.providerBodies.size).toBe(0);

    await expect(
      session.uploadPart({ partNumber: 1, body: part, control: requestControl() }),
    ).resolves.toMatchObject({ partNumber: 1, sizeBytes: part.byteLength });
    await session.abort(requestControl());
  });

  test("snapshots the exact part body before validating and copying it", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const exact = bytePart(29, 0x77);
    const oversized = bytePart(1_024, 0x78);
    const session = await createRuntimeSession({ bucket, parts: [exact] });
    let bodyReads = 0;
    const receipt = await session.uploadPart({
      partNumber: 1,
      get body() {
        bodyReads += 1;
        return bodyReads === 1 ? exact : oversized;
      },
      control: requestControl(),
    });
    expect(bodyReads).toBe(1);
    expect(receipt.sizeBytes).toBe(exact.byteLength);
    expect(bucket.providerBodies.get(1)?.byteLength).toBe(exact.byteLength);
    await session.abort(requestControl());
  });

  test("copies an ArrayBuffer with native bounds without calling an overridden slice", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const exact = bytePart(23, 0x7a);
    const body = new ArrayBuffer(exact.byteLength);
    new Uint8Array(body).set(exact);
    let sliceCalls = 0;
    Object.defineProperty(body, "slice", {
      value: () => {
        sliceCalls += 1;
        return new ArrayBuffer(exact.byteLength + 1);
      },
    });
    const session = await createRuntimeSession({ bucket, parts: [exact] });

    const receipt = await session.uploadPart({
      partNumber: 1,
      body,
      control: requestControl(),
    });

    expect(sliceCalls).toBe(0);
    expect(receipt.sizeBytes).toBe(exact.byteLength);
    expect(bucket.providerBodies.get(1)?.byteLength).toBe(exact.byteLength);
    await session.abort(requestControl());
  });

  test("copies a Uint8Array with native bounds without invoking its iterator", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const exact = bytePart(25, 0x7b);
    let iteratorCalls = 0;
    Object.defineProperty(exact, Symbol.iterator, {
      value: function* () {
        iteratorCalls += 1;
        yield* bytePart(1_024, 0x7c);
      },
    });
    const session = await createRuntimeSession({ bucket, parts: [bytePart(25, 0x7b)] });

    const receipt = await session.uploadPart({
      partNumber: 1,
      body: exact,
      control: requestControl(),
    });

    expect(iteratorCalls).toBe(0);
    expect(receipt.sizeBytes).toBe(exact.byteLength);
    expect(bucket.providerBodies.get(1)?.byteLength).toBe(exact.byteLength);
    await session.abort(requestControl());
  });

  test("snapshots a mutable part number before asynchronous dispatch", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const parts = [bytePart(MULTIPART_OBJECT_PART_BYTES, 0x78), bytePart(1, 0x79)];
    const session = await createRuntimeSession({ bucket, parts });
    const mutableInput = {
      partNumber: 1,
      body: parts[0]!,
      control: requestControl(),
    };
    const upload = session.uploadPart(mutableInput);
    mutableInput.partNumber = 2;
    await expect(upload).resolves.toMatchObject({
      partNumber: 1,
      sizeBytes: MULTIPART_OBJECT_PART_BYTES,
    });
    const providerParts = bucket.uploads.get(session.handle.uploadId)?.parts;
    expect(providerParts?.has(1)).toBe(true);
    expect(providerParts?.has(2)).toBe(false);
    await session.abort(requestControl());
  });

  test("retains the private provider copy until late settlement then zeroizes it", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const gate = deferred<void>();
    bucket.uploadGates.set(1, gate);
    const late: Promise<void>[] = [];
    const part = bytePart(41, 0x88);
    const session = await createRuntimeSession({ bucket, parts: [part] });
    const upload = session.uploadPart({
      partNumber: 1,
      body: part,
      control: requestControl({ deadline: new Date(Date.now() + 10), late }),
    });
    await expectCode(upload, "OBJECT_STORAGE_MULTIPART_DEADLINE_EXCEEDED");
    const providerBody = bucket.providerBodies.get(1);
    expect(providerBody?.every((byte) => byte === 0x88)).toBe(true);
    expect(part.every((byte) => byte === 0x88)).toBe(true);
    gate.resolve();
    await Promise.all(late);
    expect(providerBody?.every((byte) => byte === 0)).toBe(true);
    expect(session.acknowledgedParts()).toHaveLength(1);
  });

  test("admits only one copied part until provider settlement and zeroization", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const gate = deferred<void>();
    bucket.uploadGates.set(1, gate);
    const late: Promise<void>[] = [];
    const controller = new AbortController();
    const parts = [bytePart(MULTIPART_OBJECT_PART_BYTES, 0x89), bytePart(17, 0x8a)];
    const session = await createRuntimeSession({ bucket, parts });
    const first = session.uploadPart({
      partNumber: 1,
      body: parts[0]!,
      control: requestControl({ signal: controller.signal, late }),
    });
    while (!bucket.providerBodies.has(1)) await Promise.resolve();

    const overflow = Array.from({ length: 128 }, () =>
      session.uploadPart({
        partNumber: 2,
        body: parts[1]!,
        control: requestControl(),
      }),
    );
    await Promise.all(
      overflow.map((attempt) => expectCode(attempt, "OBJECT_STORAGE_MULTIPART_BACKPRESSURE")),
    );
    expect(bucket.providerBodies.size).toBe(1);
    expect(bucket.providerBodies.has(2)).toBe(false);

    controller.abort();
    await expectCode(first, "OBJECT_STORAGE_MULTIPART_ABORTED");
    const providerBody = bucket.providerBodies.get(1);
    expect(providerBody?.every((byte) => byte === 0x89)).toBe(true);
    gate.resolve();
    await Promise.all(late);
    expect(providerBody?.every((byte) => byte === 0)).toBe(true);

    await expect(
      session.uploadPart({
        partNumber: 2,
        body: parts[1]!,
        control: requestControl(),
      }),
    ).resolves.toMatchObject({ partNumber: 2, providerAcknowledged: true });
  }, 30_000);

  test("does not let a canceled queued part release a newer buffer", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const abortGate = deferred<void>();
    const uploadGate = deferred<void>();
    bucket.abortGates.push(abortGate);
    bucket.abortFailures.push(
      providerError("InternalError", 500),
      providerError("InternalError", 500),
    );
    bucket.uploadGates.set(1, uploadGate);
    const parts = [
      bytePart(MULTIPART_OBJECT_PART_BYTES, 0x8b),
      bytePart(MULTIPART_OBJECT_PART_BYTES, 0x8c),
      bytePart(1, 0x8d),
    ];
    const session = await createRuntimeSession({ bucket, parts });
    const abort = session.abort(requestControl());
    while (bucket.abortCalls === 0) await Promise.resolve();

    const canceled = session.uploadPart({
      partNumber: 1,
      body: parts[0]!,
      control: requestControl({ deadline: new Date(Date.now() + 10) }),
    });
    await expectCode(canceled, "OBJECT_STORAGE_MULTIPART_DEADLINE_EXCEEDED");
    const retained = session.uploadPart({
      partNumber: 1,
      body: parts[0]!,
      control: requestControl(),
    });

    abortGate.resolve();
    await expectCode(abort, "OBJECT_STORAGE_MULTIPART_ABORT_UNCONFIRMED");
    while (!bucket.providerBodies.has(1)) await Promise.resolve();
    await expectCode(
      session.uploadPart({
        partNumber: 2,
        body: parts[1]!,
        control: requestControl(),
      }),
      "OBJECT_STORAGE_MULTIPART_BACKPRESSURE",
    );

    uploadGate.resolve();
    await retained;
    await session.abort(requestControl());
  }, 30_000);

  test("propagates caller cancellation while keeping the provider settlement observable", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const gate = deferred<void>();
    bucket.uploadGates.set(1, gate);
    const late: Promise<void>[] = [];
    const controller = new AbortController();
    const part = bytePart(43, 0x99);
    const session = await createRuntimeSession({ bucket, parts: [part] });
    const upload = session.uploadPart({
      partNumber: 1,
      body: part,
      control: requestControl({ signal: controller.signal, late }),
    });
    while (!bucket.providerBodies.has(1)) await Promise.resolve();
    controller.abort();
    await expectCode(upload, "OBJECT_STORAGE_MULTIPART_ABORTED");
    gate.resolve();
    await Promise.all(late);
    expect(session.acknowledgedParts()).toHaveLength(1);
  });

  test("adopts exact bytes after a lost complete response using drained HEAD and GET", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    bucket.loseCompleteResponse = true;
    const parts = [
      bytePart(MULTIPART_OBJECT_PART_BYTES, 0xaa),
      bytePart(MULTIPART_OBJECT_PART_BYTES, 0xbb),
      bytePart(29, 0xcc),
    ];
    const session = await createRuntimeSession({ bucket, parts });
    await uploadAll(session, parts);
    const receipt = await session.complete(requestControl());
    expect(receipt.verifiedPresent).toBe(true);
    expect(bucket.completeCalls).toBe(1);
    expect(bucket.callOrder.slice(-3)).toEqual(["complete", "head", "get"]);
    expect(bucket.getReads).toBe(3);
  }, 30_000);

  test("replays the same acknowledged parts when ambiguous completion left no object", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    bucket.completeFailuresBeforePersist = 1;
    bucket.completeRejectsUndefined = true;
    const part = bytePart(61, 0xcd);
    const session = await createRuntimeSession({ bucket, parts: [part] });
    await uploadAll(session, [part]);
    await expect(session.complete(requestControl())).resolves.toMatchObject({
      verifiedPresent: true,
    });
    expect(bucket.completeCalls).toBe(2);
    expect(bucket.callOrder.slice(-5)).toEqual(["complete", "head", "complete", "head", "get"]);
  });

  test("revalidates authority before a hidden completion replay", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    bucket.completeFailuresBeforePersist = 1;
    const part = bytePart(33, 0xcf);
    const session = await createRuntimeSession({ bucket, parts: [part] });
    await uploadAll(session, [part]);
    const leaseLost = new Error("completion lease generation expired");
    let leaseChecks = 0;
    await expect(
      session.complete(
        requestControl({
          beforeProviderMutation: async () => {
            leaseChecks += 1;
            if (leaseChecks === 2) throw leaseLost;
          },
        }),
      ),
    ).rejects.toBe(leaseLost);
    expect(leaseChecks).toBe(2);
    expect(bucket.completeCalls).toBe(1);
    expect(bucket.objects.has(KEY)).toBe(false);
    expect(bucket.callOrder.slice(-2)).toEqual(["complete", "head"]);
  });

  test("returns completion-unconfirmed after both exact attempts remain absent", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    bucket.completeFailuresBeforePersist = 2;
    const part = bytePart(41, 0xce);
    const session = await createRuntimeSession({ bucket, parts: [part] });
    await uploadAll(session, [part]);
    await expectCode(
      session.complete(requestControl()),
      "OBJECT_STORAGE_MULTIPART_COMPLETE_UNCONFIRMED",
    );
    expect(bucket.completeCalls).toBe(2);
    expect(bucket.callOrder.slice(-4)).toEqual(["complete", "head", "complete", "head"]);
  });

  test("refuses forged metadata and body drift after ambiguous completion", async () => {
    const part = bytePart(47, 0xdd);
    for (const mutation of ["metadata", "body"] as const) {
      const bucket = new FakeRuntimeMultipartBucket();
      bucket.loseCompleteResponse = true;
      bucket.forgeCompletedMetadata = mutation === "metadata";
      bucket.driftCompletedBody = mutation === "body";
      const session = await createRuntimeSession({
        bucket,
        parts: [part],
        key: `${KEY}-${mutation}`,
      });
      await uploadAll(session, [part]);
      await expectCode(
        session.complete(requestControl()),
        "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
      );
      expect(bucket.completeCalls).toBe(1);
    }
  });

  test("keeps an S3 GET transport failure unconfirmed instead of inventing drift", async () => {
    const client = new FakeS3MultipartClient();
    const part = bytePart(49, 0xdf);
    const session = await createMultipartObjectUpload({
      backend: s3Backend(client),
      key: `${KEY}-s3-get-failure`,
      expectedSize: part.byteLength,
      expectedSha256: sha256(part),
      control: requestControl(),
    });
    await session.uploadPart({ partNumber: 1, body: part, control: requestControl() });
    client.getFailures.push(providerError("SlowDown", 503));
    await expectCode(
      session.complete(requestControl()),
      "OBJECT_STORAGE_MULTIPART_COMPLETE_UNCONFIRMED",
    );
    expect(client.objects.has(`${KEY}-s3-get-failure`)).toBe(true);
  });

  test("classifies an S3 conditional GET mismatch as exact generation conflict", async () => {
    const client = new FakeS3MultipartClient();
    client.omitObjectVersion = true;
    const part = bytePart(51, 0xe0);
    const session = await createMultipartObjectUpload({
      backend: s3Backend(client),
      key: `${KEY}-s3-get-precondition`,
      expectedSize: part.byteLength,
      expectedSha256: sha256(part),
      control: requestControl(),
    });
    await session.uploadPart({ partNumber: 1, body: part, control: requestControl() });
    client.getFailures.push(providerError("PreconditionFailed", 412));
    await expectCode(
      session.complete(requestControl()),
      "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
    );
  });

  test("classifies a disappeared exact S3 version as generation conflict", async () => {
    const client = new FakeS3MultipartClient();
    const part = bytePart(53, 0xe1);
    const session = await createMultipartObjectUpload({
      backend: s3Backend(client),
      key: `${KEY}-s3-get-version-missing`,
      expectedSize: part.byteLength,
      expectedSha256: sha256(part),
      control: requestControl(),
    });
    await session.uploadPart({ partNumber: 1, body: part, control: requestControl() });
    client.getFailures.push(providerError("NoSuchVersion", 404));
    await expectCode(
      session.complete(requestControl()),
      "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
    );
  });

  test("keeps the exact R2 conflict when response-body cleanup registration throws", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    bucket.driftGetEtag = true;
    const part = bytePart(31, 0xde);
    const session = await createRuntimeSession({ bucket, parts: [part] });
    await uploadAll(session, [part]);
    await expectCode(
      session.complete(
        requestControl({ registrationError: new Error("registration unavailable") }),
      ),
      "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
    );
  });

  test("serializes abort behind an in-flight part settlement", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const gate = deferred<void>();
    bucket.uploadGates.set(1, gate);
    const late: Promise<void>[] = [];
    const part = bytePart(53, 0xee);
    const session = await createRuntimeSession({ bucket, parts: [part] });
    const upload = session.uploadPart({
      partNumber: 1,
      body: part,
      control: requestControl({ deadline: new Date(Date.now() + 10), late }),
    });
    await expectCode(upload, "OBJECT_STORAGE_MULTIPART_DEADLINE_EXCEEDED");
    const abort = session.abort(requestControl());
    await Promise.resolve();
    expect(bucket.abortCalls).toBe(0);
    gate.resolve();
    await Promise.all(late);
    await abort;
    expect(bucket.callOrder.slice(-2)).toEqual(["part-1", "abort"]);
  });

  test("honors a queued abort deadline while an earlier provider call is unsettled", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const gate = deferred<void>();
    bucket.uploadGates.set(1, gate);
    const late: Promise<void>[] = [];
    const part = bytePart(31, 0xed);
    const session = await createRuntimeSession({ bucket, parts: [part] });
    await expectCode(
      session.uploadPart({
        partNumber: 1,
        body: part,
        control: requestControl({ deadline: new Date(Date.now() + 10), late }),
      }),
      "OBJECT_STORAGE_MULTIPART_DEADLINE_EXCEEDED",
    );

    const queuedAbort = session.abort(requestControl({ deadline: new Date(Date.now() + 10) }));
    const abortOutcome = await Promise.race([
      queuedAbort.then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      Bun.sleep(80).then(() => "pending" as const),
    ]);
    expect(abortOutcome).toBeInstanceOf(ObjectStorageLifecycleError);
    expect((abortOutcome as ObjectStorageLifecycleError).code).toBe(
      "OBJECT_STORAGE_MULTIPART_DEADLINE_EXCEEDED",
    );
    expect(bucket.abortCalls).toBe(0);

    gate.resolve();
    await Promise.all(late);
    await session.abort(requestControl());
    expect(bucket.abortCalls).toBe(1);
  });

  test("wipes and releases an undispatched part when its queued deadline expires", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const part = bytePart(43, 0xee);
    const session = await createRuntimeSession({ bucket, parts: [part] });
    await uploadAll(session, [part]);
    const gate = deferred<void>();
    bucket.completeGates.push(gate);
    const completeLate: Promise<void>[] = [];
    await expectCode(
      session.complete(requestControl({ deadline: new Date(Date.now() + 10), late: completeLate })),
      "OBJECT_STORAGE_MULTIPART_DEADLINE_EXCEEDED",
    );

    await expectCode(
      session.uploadPart({
        partNumber: 1,
        body: part,
        control: requestControl({ deadline: new Date(Date.now() + 10) }),
      }),
      "OBJECT_STORAGE_MULTIPART_DEADLINE_EXCEEDED",
    );
    await expectCode(
      session.uploadPart({
        partNumber: 1,
        body: part,
        control: requestControl({ deadline: new Date(Date.now() + 10) }),
      }),
      "OBJECT_STORAGE_MULTIPART_DEADLINE_EXCEEDED",
    );
    expect(part.every((byte) => byte === 0xee)).toBe(true);

    gate.resolve();
    await Promise.all(completeLate);
  });

  test("returns abort-unconfirmed with both provider failures preserved", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    const first = providerError("InternalError", 500);
    const second = providerError("SlowDown", 503);
    bucket.abortFailures.push(first, second);
    const part = bytePart(37, 0xef);
    const session = await createRuntimeSession({ bucket, parts: [part] });
    let failure: unknown;
    try {
      await session.abort(requestControl());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ObjectStorageLifecycleError);
    expect((failure as ObjectStorageLifecycleError).code).toBe(
      "OBJECT_STORAGE_MULTIPART_ABORT_UNCONFIRMED",
    );
    expect((failure as Error & { cause?: unknown }).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error & { cause: AggregateError }).cause as AggregateError).errors).toEqual(
      [first, second],
    );
    expect(bucket.abortCalls).toBe(2);
    expect(bucket.uploads.size).toBe(1);
  });

  test("revalidates authority before a hidden abort replay", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    bucket.abortFailures.push(providerError("InternalError", 500));
    const part = bytePart(35, 0xf1);
    const session = await createRuntimeSession({ bucket, parts: [part] });
    const leaseLost = new Error("abort lease generation expired");
    let leaseChecks = 0;
    await expect(
      session.abort(
        requestControl({
          beforeProviderMutation: async () => {
            leaseChecks += 1;
            if (leaseChecks === 2) throw leaseLost;
          },
        }),
      ),
    ).rejects.toBe(leaseLost);
    expect(leaseChecks).toBe(2);
    expect(bucket.abortCalls).toBe(1);
    expect(bucket.uploads.has(session.handle.uploadId)).toBe(true);
  });

  test("does not report abort success when a lost completion already committed the object", async () => {
    const bucket = new FakeRuntimeMultipartBucket();
    bucket.loseCompleteResponse = true;
    bucket.headFailures.push(providerError("InternalError", 500));
    const part = bytePart(39, 0xf0);
    const session = await createRuntimeSession({ bucket, parts: [part] });
    await uploadAll(session, [part]);
    await expectCode(
      session.complete(requestControl()),
      "OBJECT_STORAGE_MULTIPART_COMPLETE_UNCONFIRMED",
    );
    expect(bucket.objects.has(KEY)).toBe(true);
    expect(bucket.uploads.size).toBe(0);

    await expectCode(session.abort(requestControl()), "OBJECT_STORAGE_MULTIPART_ABORT_UNCONFIRMED");
    await expect(session.complete(requestControl())).resolves.toMatchObject({
      verifiedPresent: true,
    });
    expect(bucket.objects.has(KEY)).toBe(true);
    expect(bucket.completeCalls).toBe(1);
  });

  test("repeats S3 abort until ListParts proves the upload absent", async () => {
    const client = new FakeS3MultipartClient();
    client.abortKeepsUploadAttempts = 1;
    const part = bytePart(43, 0xf0);
    const session = await createMultipartObjectUpload({
      backend: s3Backend(client),
      key: KEY,
      expectedSize: part.byteLength,
      expectedSha256: sha256(part),
      control: requestControl(),
    });
    await session.abort(requestControl());
    expect(client.commands.slice(-4)).toEqual([
      "AbortMultipartUploadCommand",
      "ListPartsCommand",
      "AbortMultipartUploadCommand",
      "ListPartsCommand",
    ]);
    expect(client.abortInputs).toHaveLength(2);
    expect(client.uploads.size).toBe(0);
  });

  test("recognizes Workers R2 NoSuchUpload code 10024 on every terminal operation", async () => {
    const part = bytePart(47, 0xf1);

    const uploadBucket = new FakeRuntimeMultipartBucket();
    uploadBucket.workersNoSuchUploadErrors = true;
    const uploadOriginal = await createRuntimeSession({ bucket: uploadBucket, parts: [part] });
    uploadBucket.uploads.delete(uploadOriginal.handle.uploadId);
    const uploadResumed = await resumeMultipartObjectUpload({
      backend: runtimeBackend(uploadBucket),
      handle: uploadOriginal.handle,
      acknowledgedParts: [],
      control: requestControl(),
    });
    await expectCode(
      uploadResumed.uploadPart({ partNumber: 1, body: part, control: requestControl() }),
      "OBJECT_STORAGE_MULTIPART_NO_SUCH_UPLOAD",
    );

    const completeBucket = new FakeRuntimeMultipartBucket();
    completeBucket.workersNoSuchUploadErrors = true;
    const completeOriginal = await createRuntimeSession({ bucket: completeBucket, parts: [part] });
    await uploadAll(completeOriginal, [part]);
    completeBucket.uploads.delete(completeOriginal.handle.uploadId);
    const completeResumed = await resumeMultipartObjectUpload({
      backend: runtimeBackend(completeBucket),
      handle: completeOriginal.handle,
      acknowledgedParts: completeOriginal.acknowledgedParts(),
      control: requestControl(),
    });
    await expectCode(
      completeResumed.complete(requestControl()),
      "OBJECT_STORAGE_MULTIPART_NO_SUCH_UPLOAD",
    );

    const abortBucket = new FakeRuntimeMultipartBucket();
    abortBucket.workersNoSuchUploadErrors = true;
    const abortOriginal = await createRuntimeSession({ bucket: abortBucket, parts: [part] });
    abortBucket.uploads.delete(abortOriginal.handle.uploadId);
    const abortResumed = await resumeMultipartObjectUpload({
      backend: runtimeBackend(abortBucket),
      handle: abortOriginal.handle,
      acknowledgedParts: [],
      control: requestControl(),
    });
    await expect(abortResumed.abort(requestControl())).resolves.toBeUndefined();
    expect(abortBucket.abortCalls).toBe(1);
  });

  test("returns a resume deadline while the late S3 inventory remains externally owned", async () => {
    const client = new FakeS3MultipartClient();
    const backend = s3Backend(client);
    const part = bytePart(53, 0xf2);
    const original = await createMultipartObjectUpload({
      backend,
      key: KEY,
      expectedSize: part.byteLength,
      expectedSha256: sha256(part),
      control: requestControl(),
    });
    const gate = deferred<void>();
    client.listPartsGates.push(gate);
    const late: Promise<void>[] = [];
    const resumed = resumeMultipartObjectUpload({
      backend,
      handle: original.handle,
      acknowledgedParts: [],
      control: requestControl({ deadline: new Date(Date.now() + 10), late }),
    });
    const outcome = await Promise.race([
      resumed.then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      Bun.sleep(80).then(() => "pending" as const),
    ]);
    expect(outcome).toBeInstanceOf(ObjectStorageLifecycleError);
    expect((outcome as ObjectStorageLifecycleError).code).toBe(
      "OBJECT_STORAGE_MULTIPART_DEADLINE_EXCEEDED",
    );
    expect(late).toHaveLength(1);
    gate.resolve();
    await Promise.all(late);
  });

  test("reconciles a committed S3 upload after crash and fails closed on drift or absence", async () => {
    const exactClient = new FakeS3MultipartClient();
    const exactBackend = s3Backend(exactClient);
    const exactBodies = [bytePart(MULTIPART_OBJECT_PART_BYTES, 0xf0), bytePart(71, 0xf1)];
    const original = await createMultipartObjectUpload({
      backend: exactBackend,
      key: KEY,
      expectedSize: exactBodies.reduce((total, part) => total + part.byteLength, 0),
      expectedSha256: sha256(...exactBodies),
      control: requestControl(),
    });
    for (let index = 0; index < exactBodies.length; index += 1) {
      await original.uploadPart({
        partNumber: index + 1,
        body: exactBodies[index]!,
        control: requestControl(),
      });
    }
    const exactParts = [...original.acknowledgedParts()].reverse();
    await original.complete(requestControl());
    const completesBeforeResume = exactClient.commands.filter(
      (command) => command === "CompleteMultipartUploadCommand",
    ).length;

    const reconciled = await resumeMultipartObjectUpload({
      backend: exactBackend,
      handle: original.handle,
      acknowledgedParts: exactParts,
      control: requestControl(),
    });
    await expect(reconciled.complete(requestControl())).resolves.toMatchObject({
      verifiedPresent: true,
      metadata: { sizeBytes: MULTIPART_OBJECT_PART_BYTES + 71 },
    });
    expect(
      exactClient.commands.filter((command) => command === "CompleteMultipartUploadCommand"),
    ).toHaveLength(completesBeforeResume);
    expect(exactClient.commands.slice(-3)).toEqual([
      "ListPartsCommand",
      "HeadObjectCommand",
      "GetObjectCommand",
    ]);

    const driftClient = new FakeS3MultipartClient();
    const driftBackend = s3Backend(driftClient);
    const driftKey = `${KEY}-drift-resume`;
    const driftPart = bytePart(73, 0xf2);
    const drifted = await createMultipartObjectUpload({
      backend: driftBackend,
      key: driftKey,
      expectedSize: driftPart.byteLength,
      expectedSha256: sha256(driftPart),
      control: requestControl(),
    });
    await drifted.uploadPart({ partNumber: 1, body: driftPart, control: requestControl() });
    const driftReceipts = drifted.acknowledgedParts();
    await drifted.complete(requestControl());
    const stored = driftClient.objects.get(driftKey)!;
    const changedPart = Uint8Array.from(stored.parts[0]!);
    changedPart[0] ^= 0xff;
    driftClient.objects.set(driftKey, {
      ...stored,
      parts: Object.freeze([changedPart]),
    });
    await expectCode(
      resumeMultipartObjectUpload({
        backend: driftBackend,
        handle: drifted.handle,
        acknowledgedParts: driftReceipts,
        control: requestControl(),
      }),
      "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
    );

    const absentClient = new FakeS3MultipartClient();
    const absentBackend = s3Backend(absentClient);
    const absentKey = `${KEY}-absent-resume`;
    const absentPart = bytePart(79, 0xf3);
    const absent = await createMultipartObjectUpload({
      backend: absentBackend,
      key: absentKey,
      expectedSize: absentPart.byteLength,
      expectedSha256: sha256(absentPart),
      control: requestControl(),
    });
    await absent.uploadPart({ partNumber: 1, body: absentPart, control: requestControl() });
    absentClient.uploads.delete(absent.handle.uploadId);
    await expectCode(
      resumeMultipartObjectUpload({
        backend: absentBackend,
        handle: absent.handle,
        acknowledgedParts: absent.acknowledgedParts(),
        control: requestControl(),
      }),
      "OBJECT_STORAGE_MULTIPART_NO_SUCH_UPLOAD",
    );
  });

  test("runs S3 create, upload, resume, complete, abort, and NoSuchUpload with signals", async () => {
    const client = new FakeS3MultipartClient();
    const backend = s3Backend(client);
    const completedPart = bytePart(59, 0xfa);
    const completed = await createMultipartObjectUpload({
      backend,
      key: KEY,
      expectedSize: completedPart.byteLength,
      expectedSha256: sha256(completedPart),
      control: requestControl(),
    });
    await completed.uploadPart({ partNumber: 1, body: completedPart, control: requestControl() });
    await expect(completed.complete(requestControl())).resolves.toMatchObject({
      verifiedPresent: true,
      metadata: { sizeBytes: 59 },
    });

    const abortKey = `${KEY}-abort`;
    const abortPart = bytePart(67, 0xfb);
    const original = await createMultipartObjectUpload({
      backend,
      key: abortKey,
      expectedSize: abortPart.byteLength,
      expectedSha256: sha256(abortPart),
      control: requestControl(),
    });
    await original.uploadPart({ partNumber: 1, body: abortPart, control: requestControl() });
    const resumed = await resumeMultipartObjectUpload({
      backend,
      handle: original.handle,
      acknowledgedParts: original.acknowledgedParts(),
      control: requestControl(),
    });
    await resumed.abort(requestControl());
    await expectCode(
      resumeMultipartObjectUpload({
        backend,
        handle: original.handle,
        acknowledgedParts: original.acknowledgedParts(),
        control: requestControl(),
      }),
      "OBJECT_STORAGE_MULTIPART_NO_SUCH_UPLOAD",
    );

    for (const command of [
      "CreateMultipartUploadCommand",
      "UploadPartCommand",
      "CompleteMultipartUploadCommand",
      "HeadObjectCommand",
      "GetObjectCommand",
      "ListPartsCommand",
      "AbortMultipartUploadCommand",
    ]) {
      expect(client.commands).toContain(command);
    }
    expect(client.signals).toHaveLength(client.commands.length);
    expect(client.signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });
});
