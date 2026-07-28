/**
 * Exercises encrypted v2 backup chunks against a binary in-memory R2 bucket
 * and the real test KMS, including cleanup and adversarial restore failures.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getKmsClient, resetKmsClientForTests, setKmsClient } from "../../db/crypto/kms-client";
import { deleteObjectsExact } from "../storage/object-store";
import { type RuntimeR2Bucket, setRuntimeR2Bucket } from "../storage/r2-runtime-binding";
import {
  OBJECT_STORAGE_TRANSPORT_TIMEOUTS,
  resetObjectStorageClientForTests,
} from "../storage/s3-compatible-client";
import {
  type AgentBackupChunkDescriptor,
  type AgentBackupChunkIdentity,
  AgentBackupWriteEpochUnquiescedError,
  readEncryptedAgentBackupChunks,
  stageEncryptedAgentBackupChunks,
} from "./agent-backup-chunks";

const identity: AgentBackupChunkIdentity = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  sandboxRecordId: "00000000-0000-4000-8000-000000000002",
  backupId: "00000000-0000-4000-8000-000000000003",
  backupSchemaVersion: 2,
};
const OBJECT_SET_ID = "00000000-0000-4000-8000-000000000010";
const RETRY_OBJECT_SET_ID = "00000000-0000-4000-8000-000000000011";

function writeFence(objectSetId = OBJECT_SET_ID): {
  objectSetId: string;
  signal: AbortSignal;
} {
  return { objectSetId, signal: new AbortController().signal };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function memoryBucket(
  objects: Map<string, Uint8Array>,
  options?: { failPutAt?: number; failDelete?: boolean; throwAfterPutAt?: number },
): RuntimeR2Bucket {
  let puts = 0;
  return {
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return {
        size: value.byteLength,
        async text() {
          return new TextDecoder().decode(value);
        },
        async arrayBuffer() {
          return value.slice().buffer;
        },
      };
    },
    async put(key, value) {
      puts += 1;
      if (puts === options?.failPutAt) throw new Error("injected put failure");
      if (typeof value === "string") {
        objects.set(key, bytes(value));
      } else if (value instanceof Uint8Array) {
        objects.set(key, value.slice());
      } else if (value instanceof ArrayBuffer) {
        objects.set(key, new Uint8Array(value.slice(0)));
      } else if (ArrayBuffer.isView(value)) {
        objects.set(
          key,
          new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)),
        );
      } else {
        throw new Error("unsupported in-memory object value");
      }
      if (puts === options?.throwAfterPutAt) throw new Error("injected ambiguous put failure");
    },
    async delete(key) {
      if (options?.failDelete) throw new Error("injected delete failure");
      for (const candidate of Array.isArray(key) ? key : [key]) objects.delete(candidate);
    },
  };
}

async function* source(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield bytes(value);
}

async function collect(
  descriptor: AgentBackupChunkDescriptor,
  restoreIdentity = identity,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of readEncryptedAgentBackupChunks({
    identity: restoreIdentity,
    descriptor,
  })) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

let previousKmsBackend: string | undefined;

beforeEach(() => {
  previousKmsBackend = process.env.ELIZA_KMS_BACKEND;
  process.env.ELIZA_KMS_BACKEND = "memory";
  resetKmsClientForTests();
});

afterEach(() => {
  setRuntimeR2Bucket(null);
  resetKmsClientForTests();
  if (previousKmsBackend === undefined) {
    delete process.env.ELIZA_KMS_BACKEND;
  } else {
    process.env.ELIZA_KMS_BACKEND = previousKmsBackend;
  }
});

describe("encrypted agent backup chunks", () => {
  test("bulk-deletes exact keys through native R2 and bounds a hung delete by the caller signal", async () => {
    const deleted: string[][] = [];
    let beginHungDelete: (() => void) | undefined;
    const hungDeleteStarted = new Promise<void>((resolve) => {
      beginHungDelete = resolve;
    });
    let hang = false;
    setRuntimeR2Bucket({
      async get() {
        return null;
      },
      async put() {
        return {};
      },
      async delete(keys) {
        const page = Array.isArray(keys) ? keys : [keys];
        deleted.push(page);
        if (hang) {
          beginHungDelete?.();
          return await new Promise<never>(() => undefined);
        }
        return {};
      },
    });

    await deleteObjectsExact(["one", "two"]);
    expect(deleted).toEqual([["one", "two"]]);

    hang = true;
    const controller = new AbortController();
    const pending = deleteObjectsExact(["three"], controller.signal);
    await hungDeleteStarted;
    controller.abort(new Error("reconcile deadline elapsed"));
    await expect(pending).rejects.toThrow("reconcile deadline elapsed");
    expect(deleted).toEqual([["one", "two"], ["three"]]);
  });

  test("stages arbitrary producer views as fixed encrypted chunks and restores exact bytes", async () => {
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));

    const descriptor = await stageEncryptedAgentBackupChunks({
      identity,
      ...writeFence(),
      source: source("abc", "defghijk", "lm"),
      chunkBytes: 4,
      maxTotalBytes: 32,
      createdAt: new Date("2026-07-26T12:00:00.000Z"),
    });

    expect(descriptor.commitState).toBe("complete");
    expect(descriptor.objectSetId).toBe(OBJECT_SET_ID);
    expect(descriptor.chunks.map((chunk) => chunk.plaintextBytes)).toEqual([4, 4, 4, 1]);
    expect(objects.size).toBe(4);
    expect(new TextDecoder().decode(await collect(descriptor))).toBe("abcdefghijklm");
  });

  test("rejects missing, reordered, and ciphertext-tampered chunks", async () => {
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));
    const descriptor = await stageEncryptedAgentBackupChunks({
      identity,
      ...writeFence(),
      source: source("abcdefgh"),
      chunkBytes: 4,
      maxTotalBytes: 16,
    });

    const firstKey = descriptor.chunks[0]?.objectKey;
    if (!firstKey) throw new Error("expected first chunk");
    const original = objects.get(firstKey);
    if (!original) throw new Error("expected first object");
    const tampered = original.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    objects.set(firstKey, tampered);
    await expect(collect(descriptor)).rejects.toThrow("ciphertext integrity");

    objects.set(firstKey, original);
    const reordered: AgentBackupChunkDescriptor = {
      ...descriptor,
      chunks: [descriptor.chunks[1]!, descriptor.chunks[0]!],
    };
    await expect(collect(reordered)).rejects.toThrow("invalid at index 0");

    objects.delete(descriptor.chunks[1]!.objectKey);
    await expect(collect(descriptor)).rejects.toThrow("is missing");
  });

  test("binds ciphertext to the exact tenant, sandbox, backup, schema, index, and size", async () => {
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));
    const descriptor = await stageEncryptedAgentBackupChunks({
      identity,
      ...writeFence(),
      source: source("tenant-bound"),
      chunkBytes: 16,
      maxTotalBytes: 32,
    });
    const otherIdentity = {
      ...identity,
      backupId: "00000000-0000-4000-8000-000000000004",
    };
    const relabeled = { ...descriptor, backupId: otherIdentity.backupId };

    await expect(collect(relabeled, otherIdentity)).rejects.toThrow();

    const otherSandbox = {
      ...identity,
      sandboxRecordId: "00000000-0000-4000-8000-000000000005",
    };
    await expect(
      collect({ ...descriptor, sandboxRecordId: otherSandbox.sandboxRecordId }, otherSandbox),
    ).rejects.toThrow();

    const wrongSchema = structuredClone(descriptor) as AgentBackupChunkDescriptor & {
      backupSchemaVersion: number;
    };
    wrongSchema.backupSchemaVersion = 3;
    await expect(collect(wrongSchema)).rejects.toThrow("does not match");

    const wrongSize = structuredClone(descriptor);
    wrongSize.totalPlaintextBytes += 1;
    await expect(collect(wrongSize)).rejects.toThrow("invalid at index 0");
  });

  test("aborts an object-store read that never settles", async () => {
    const objects = new Map<string, Uint8Array>();
    const bucket = memoryBucket(objects);
    setRuntimeR2Bucket(bucket);
    const descriptor = await stageEncryptedAgentBackupChunks({
      identity,
      ...writeFence(),
      source: source("never-settling-object-read"),
      chunkBytes: 32,
      maxTotalBytes: 64,
    });
    setRuntimeR2Bucket({
      ...bucket,
      get: () => new Promise(() => undefined),
    });
    const controller = new AbortController();
    const iterator = readEncryptedAgentBackupChunks({
      descriptor,
      identity,
      signal: controller.signal,
    });
    const pending = iterator.next();
    controller.abort(new Error("object read watchdog fired"));

    await expect(pending).rejects.toThrow("object read watchdog fired");
  });

  test("aborts a KMS decrypt that never settles", async () => {
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));
    const descriptor = await stageEncryptedAgentBackupChunks({
      identity,
      ...writeFence(),
      source: source("never-settling-kms-read"),
      chunkBytes: 32,
      maxTotalBytes: 64,
    });
    const kms = getKmsClient();
    setKmsClient(
      new Proxy(kms, {
        get(target, property) {
          if (property === "decrypt") {
            return () => new Promise<Uint8Array>(() => undefined);
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
    const controller = new AbortController();
    const iterator = readEncryptedAgentBackupChunks({
      descriptor,
      identity,
      signal: controller.signal,
    });
    const pending = iterator.next();
    controller.abort(new Error("KMS watchdog fired"));

    await expect(pending).rejects.toThrow("KMS watchdog fired");
  });

  test("aborts a source iterator that never settles and requests producer teardown", async () => {
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));
    let sourceReturned = false;
    let markNextStarted: (() => void) | undefined;
    const nextStarted = new Promise<void>((resolve) => {
      markNextStarted = resolve;
    });
    const stalledSource: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            markNextStarted?.();
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
          async return() {
            sourceReturned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const controller = new AbortController();
    const staged = stageEncryptedAgentBackupChunks({
      identity,
      objectSetId: OBJECT_SET_ID,
      signal: controller.signal,
      source: stalledSource,
      chunkBytes: 4,
      maxTotalBytes: 16,
    });
    await nextStarted;
    controller.abort(new Error("source watchdog fired"));

    await expect(staged).rejects.toThrow("source watchdog fired");
    await Promise.resolve();
    expect(sourceReturned).toBe(true);
    expect(objects.size).toBe(0);
  });

  test("aborts KMS encryption that never settles before dispatching an object write", async () => {
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));
    const kms = getKmsClient();
    let markEncryptStarted: (() => void) | undefined;
    const encryptStarted = new Promise<void>((resolve) => {
      markEncryptStarted = resolve;
    });
    setKmsClient(
      new Proxy(kms, {
        get(target, property) {
          if (property === "encrypt") {
            return () => {
              markEncryptStarted?.();
              return new Promise(() => undefined);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
    const controller = new AbortController();
    const staged = stageEncryptedAgentBackupChunks({
      identity,
      objectSetId: OBJECT_SET_ID,
      signal: controller.signal,
      source: source("abcd"),
      chunkBytes: 4,
      maxTotalBytes: 16,
    });
    await encryptStarted;
    controller.abort(new Error("KMS write watchdog fired"));

    await expect(staged).rejects.toThrow("KMS write watchdog fired");
    expect(objects.size).toBe(0);
  });

  test("observes a late rejection when operation creation synchronously aborts the watchdog", async () => {
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));
    const kms = getKmsClient();
    const controller = new AbortController();
    let thenObserved = false;
    setKmsClient(
      new Proxy(kms, {
        get(target, property) {
          if (property === "getOrCreateKey") {
            return () => {
              controller.abort(new Error("watchdog aborted during operation creation"));
              return {
                // biome-ignore lint/suspicious/noThenProperty: reproduces abort-before-assimilation.
                then(_resolve: (value: unknown) => void, reject: (error: unknown) => void): void {
                  thenObserved = true;
                  queueMicrotask(() => reject(new Error("late operation rejection")));
                },
              };
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );

    await expect(
      stageEncryptedAgentBackupChunks({
        identity,
        objectSetId: OBJECT_SET_ID,
        signal: controller.signal,
        source: source("abcd"),
        chunkBytes: 4,
        maxTotalBytes: 16,
      }),
    ).rejects.toThrow("watchdog aborted during operation creation");
    await Promise.resolve();
    expect(thenObserved).toBe(true);
    expect(objects.size).toBe(0);
  });

  test("retains an unquiesced epoch classification for every ambiguous PUT failure", async () => {
    const failedPutObjects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(failedPutObjects, { failPutAt: 2 }));
    const failedPut = await stageEncryptedAgentBackupChunks({
      identity,
      ...writeFence(),
      source: source("abcdefgh"),
      chunkBytes: 4,
      maxTotalBytes: 16,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failedPut).toBeInstanceOf(AgentBackupWriteEpochUnquiescedError);
    expect(failedPut).toMatchObject({
      objectSetId: OBJECT_SET_ID,
      cleanupFailures: [],
    });
    expect(failedPutObjects.size).toBe(0);

    const ambiguousPutObjects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(ambiguousPutObjects, { throwAfterPutAt: 2 }));
    const ambiguousPut = await stageEncryptedAgentBackupChunks({
      identity,
      ...writeFence(),
      source: source("abcdefgh"),
      chunkBytes: 4,
      maxTotalBytes: 16,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(ambiguousPut).toBeInstanceOf(AgentBackupWriteEpochUnquiescedError);
    expect(ambiguousPut).toMatchObject({
      objectSetId: OBJECT_SET_ID,
      cleanupFailures: [],
    });
    expect(ambiguousPutObjects.size).toBe(0);
  });

  test("returns on watchdog abort while retaining a late native R2 PUT for reconciliation", async () => {
    const objects = new Map<string, Uint8Array>();
    let releasePut: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const putStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markSettled: (() => void) | undefined;
    const putSettled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    setRuntimeR2Bucket({
      ...memoryBucket(objects),
      async put(key, value) {
        markStarted?.();
        await new Promise<void>((resolve) => {
          releasePut = resolve;
        });
        if (!(value instanceof Uint8Array)) throw new Error("expected binary object");
        objects.set(key, value.slice());
        markSettled?.();
      },
    });
    const controller = new AbortController();
    const staged = stageEncryptedAgentBackupChunks({
      identity,
      objectSetId: OBJECT_SET_ID,
      signal: controller.signal,
      source: source("abcd"),
      chunkBytes: 4,
      maxTotalBytes: 16,
    });
    await putStarted;
    controller.abort(new Error("capture watchdog fired"));

    const failure = await staged.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AgentBackupWriteEpochUnquiescedError);
    expect(failure).toMatchObject({
      objectSetId: OBJECT_SET_ID,
      cleanupFailures: [],
    });
    expect(objects.size).toBe(0);

    releasePut?.();
    await putSettled;
    expect(objects.size).toBe(1);
  });

  test("removes staged objects when a determinate byte budget fails", async () => {
    const overBudgetObjects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(overBudgetObjects));
    await expect(
      stageEncryptedAgentBackupChunks({
        identity,
        ...writeFence(),
        source: source("abcdefgh"),
        chunkBytes: 4,
        maxTotalBytes: 6,
      }),
    ).rejects.toThrow("plaintext budget");
    expect(overBudgetObjects.size).toBe(0);
  });

  test("durably plans each unique object key before PUT and cleans up on plan failure", async () => {
    const objects = new Map<string, Uint8Array>();
    const events: string[] = [];
    const bucket = memoryBucket(objects);
    const originalPut = bucket.put.bind(bucket);
    bucket.put = async (key, value, options) => {
      events.push(`put:${key}`);
      return await originalPut(key, value, options);
    };
    setRuntimeR2Bucket(bucket);

    await expect(
      stageEncryptedAgentBackupChunks({
        identity,
        ...writeFence(),
        source: source("abcdefgh"),
        chunkBytes: 4,
        maxTotalBytes: 16,
        async onObjectPlanned({ index, objectKey }) {
          events.push(`plan:${objectKey}`);
          if (index === 1) throw new Error("injected durable-plan failure");
        },
      }),
    ).rejects.toThrow("injected durable-plan failure");

    expect(events).toHaveLength(3);
    expect(events[0]?.replace("plan:", "")).toBe(events[1]?.replace("put:", ""));
    expect(events[2]).toStartWith("plan:");
    expect(objects.size).toBe(0);
  });

  test("surfaces partial-object cleanup failure instead of masking residue", async () => {
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects, { failPutAt: 2, failDelete: true }));
    const error = await stageEncryptedAgentBackupChunks({
      identity,
      ...writeFence(),
      source: source("abcdefgh"),
      chunkBytes: 4,
      maxTotalBytes: 16,
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(AgentBackupWriteEpochUnquiescedError);
    const cleanupFailures = (error as AgentBackupWriteEpochUnquiescedError).cleanupFailures;
    expect(Array.isArray(cleanupFailures)).toBe(true);
    expect(cleanupFailures).toHaveLength(1);
    expect(objects.size).toBe(1);
  });

  test("detects aggregate truncation even when individual chunks are intact", async () => {
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));
    const descriptor = await stageEncryptedAgentBackupChunks({
      identity,
      ...writeFence(),
      source: source("abcdef"),
      chunkBytes: 3,
      maxTotalBytes: 16,
    });
    const truncated = { ...descriptor, chunks: descriptor.chunks.slice(0, 1) };
    await expect(collect(truncated)).rejects.toThrow("canonical fixed-size chunk count");
  });

  test("keeps retries isolated and rejects object-key or KMS-key substitution", async () => {
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));
    const createdAt = new Date("2026-07-26T12:00:00.000Z");
    const first = await stageEncryptedAgentBackupChunks({
      identity,
      ...writeFence(OBJECT_SET_ID),
      source: source("first"),
      chunkBytes: 8,
      maxTotalBytes: 16,
      createdAt,
    });
    const second = await stageEncryptedAgentBackupChunks({
      identity,
      ...writeFence(RETRY_OBJECT_SET_ID),
      source: source("second"),
      chunkBytes: 8,
      maxTotalBytes: 16,
      createdAt,
    });

    expect(first.objectSetId).not.toBe(second.objectSetId);
    expect(objects.size).toBe(2);
    expect(new TextDecoder().decode(await collect(first))).toBe("first");
    expect(new TextDecoder().decode(await collect(second))).toBe("second");

    const swappedKey = structuredClone(first);
    swappedKey.chunks[0]!.objectKey = second.chunks[0]!.objectKey;
    await expect(collect(swappedKey)).rejects.toThrow("invalid at index 0");

    const swappedKmsKey = structuredClone(first);
    swappedKmsKey.chunks[0]!.kmsKeyId = "org:00000000-0000-4000-8000-000000000099/dek/v1";
    await expect(collect(swappedKmsKey)).rejects.toThrow("invalid at index 0");
  });

  test("accepts an empty stream without objects and rejects oversized stored bytes before reading", async () => {
    const objects = new Map<string, Uint8Array>();
    let arrayBufferReads = 0;
    const bucket = memoryBucket(objects);
    const originalGet = bucket.get.bind(bucket);
    bucket.get = async (key) => {
      const object = await originalGet(key);
      if (!object) return null;
      return {
        ...object,
        async arrayBuffer() {
          arrayBufferReads += 1;
          return await object.arrayBuffer!();
        },
      };
    };
    setRuntimeR2Bucket(bucket);
    const empty = await stageEncryptedAgentBackupChunks({
      identity,
      ...writeFence(),
      source: source(),
      chunkBytes: 4,
      maxTotalBytes: 16,
    });
    expect(empty).toMatchObject({
      totalPlaintextBytes: 0,
      totalPlaintextSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      chunks: [],
    });
    expect((await collect(empty)).byteLength).toBe(0);

    const descriptor = await stageEncryptedAgentBackupChunks({
      identity,
      ...writeFence(),
      source: source("abcd"),
      chunkBytes: 4,
      maxTotalBytes: 16,
    });
    objects.set(descriptor.chunks[0]!.objectKey, new Uint8Array(32));
    await expect(collect(descriptor)).rejects.toThrow("4-byte read budget");
    expect(arrayBufferReads).toBe(0);
  });

  test("rejects oversized producer views and a 5633rd fixed chunk without residue", async () => {
    const objects = new Map<string, Uint8Array>();
    const cleanupPages: number[] = [];
    const bucket = memoryBucket(objects);
    const originalDelete = bucket.delete.bind(bucket);
    bucket.delete = async (keys) => {
      cleanupPages.push(Array.isArray(keys) ? keys.length : 1);
      return await originalDelete(keys);
    };
    setRuntimeR2Bucket(bucket);
    async function* oversizedView() {
      yield new Uint8Array(16 * 1024 * 1024 + 1);
    }
    await expect(
      stageEncryptedAgentBackupChunks({
        identity,
        ...writeFence(),
        source: oversizedView(),
        chunkBytes: 4,
        maxTotalBytes: 32,
      }),
    ).rejects.toThrow("view larger than");
    expect(objects.size).toBe(0);

    async function* tooManyChunks() {
      for (let index = 0; index < 5_633; index += 1) yield new Uint8Array([index % 256]);
    }
    await expect(
      stageEncryptedAgentBackupChunks({
        identity,
        ...writeFence(),
        source: tooManyChunks(),
        chunkBytes: 1,
        maxTotalBytes: 5_633,
      }),
    ).rejects.toThrow("5632-chunk limit");
    expect(objects.size).toBe(0);
    expect(cleanupPages).toEqual([1_000, 1_000, 1_000, 1_000, 1_000, 632]);
  });

  test("fails a real S3 multi-delete when the provider reports a per-key error", async () => {
    setRuntimeR2Bucket(null);
    let requestBody = "";
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "POST" && url.searchParams.has("delete")) {
          requestBody = await request.text();
          return new Response(
            '<?xml version="1.0" encoding="UTF-8"?>' +
              '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
              "<Error><Key>one</Key><Code>AccessDenied</Code><Message>denied</Message></Error>" +
              "</DeleteResult>",
            { status: 200, headers: { "content-type": "application/xml" } },
          );
        }
        return new Response("unsupported", { status: 405 });
      },
    });
    const env = {
      STORAGE_PROVIDER: process.env.STORAGE_PROVIDER,
      STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT,
      STORAGE_REGION: process.env.STORAGE_REGION,
      STORAGE_ACCESS_KEY_ID: process.env.STORAGE_ACCESS_KEY_ID,
      STORAGE_SECRET_ACCESS_KEY: process.env.STORAGE_SECRET_ACCESS_KEY,
      STORAGE_FORCE_PATH_STYLE: process.env.STORAGE_FORCE_PATH_STYLE,
      STORAGE_HEAVY_PAYLOADS_BUCKET: process.env.STORAGE_HEAVY_PAYLOADS_BUCKET,
    };
    try {
      Object.assign(process.env, {
        STORAGE_PROVIDER: "s3",
        STORAGE_ENDPOINT: `http://127.0.0.1:${server.port}`,
        STORAGE_REGION: "local",
        STORAGE_ACCESS_KEY_ID: "delete-test",
        STORAGE_SECRET_ACCESS_KEY: "delete-test",
        STORAGE_FORCE_PATH_STYLE: "1",
        STORAGE_HEAVY_PAYLOADS_BUCKET: "delete-test-bucket",
      });
      resetObjectStorageClientForTests();
      await expect(deleteObjectsExact(["one", "two"])).rejects.toThrow(
        "returned 1 per-key failures",
      );
      expect(requestBody).toContain("<Key>one</Key>");
      expect(requestBody).toContain("<Key>two</Key>");
    } finally {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetObjectStorageClientForTests();
      server.stop(true);
    }
  });

  test("moves exact ciphertext bytes through the real S3 client", async () => {
    setRuntimeR2Bucket(null);
    const objects = new Map<string, Uint8Array>();
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
        if (request.method === "PUT") {
          objects.set(key, new Uint8Array(await request.arrayBuffer()));
          return new Response(null, { status: 200 });
        }
        if (request.method === "GET") {
          const body = objects.get(key);
          if (!body) {
            return new Response(
              `<Error><Code>NoSuchKey</Code><Message>missing</Message><Key>${key}</Key></Error>`,
              { status: 404, headers: { "content-type": "application/xml" } },
            );
          }
          return new Response(body, {
            status: 200,
            headers: {
              "content-length": String(body.byteLength),
              "content-type": "application/octet-stream",
            },
          });
        }
        if (request.method === "DELETE") {
          objects.delete(key);
          return new Response(null, { status: 204 });
        }
        return new Response("unsupported", { status: 405 });
      },
    });
    const env = {
      STORAGE_PROVIDER: process.env.STORAGE_PROVIDER,
      STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT,
      STORAGE_REGION: process.env.STORAGE_REGION,
      STORAGE_ACCESS_KEY_ID: process.env.STORAGE_ACCESS_KEY_ID,
      STORAGE_SECRET_ACCESS_KEY: process.env.STORAGE_SECRET_ACCESS_KEY,
      STORAGE_FORCE_PATH_STYLE: process.env.STORAGE_FORCE_PATH_STYLE,
      STORAGE_HEAVY_PAYLOADS_BUCKET: process.env.STORAGE_HEAVY_PAYLOADS_BUCKET,
    };
    try {
      Object.assign(process.env, {
        STORAGE_PROVIDER: "s3",
        STORAGE_ENDPOINT: `http://127.0.0.1:${server.port}`,
        STORAGE_REGION: "local",
        STORAGE_ACCESS_KEY_ID: "chunk-test",
        STORAGE_SECRET_ACCESS_KEY: "chunk-test",
        STORAGE_FORCE_PATH_STYLE: "1",
        STORAGE_HEAVY_PAYLOADS_BUCKET: "chunk-test-bucket",
      });
      resetObjectStorageClientForTests();
      const descriptor = await stageEncryptedAgentBackupChunks({
        identity,
        ...writeFence(),
        source: source("\u0000\u0001binary\u00ff"),
        chunkBytes: 5,
        maxTotalBytes: 32,
      });
      expect(new TextDecoder().decode(await collect(descriptor))).toBe("\u0000\u0001binary\u00ff");
      expect(objects.size).toBe(descriptor.chunks.length);
    } finally {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetObjectStorageClientForTests();
      server.stop(true);
    }
  });

  test("aborts a hung real S3 PUT and retains its exact write epoch for reconciliation", async () => {
    setRuntimeR2Bucket(null);
    let markPutStarted: (() => void) | undefined;
    const putStarted = new Promise<void>((resolve) => {
      markPutStarted = resolve;
    });
    const deletedKeys: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
        if (request.method === "PUT") {
          markPutStarted?.();
          return await new Promise<Response>(() => undefined);
        }
        if (request.method === "DELETE") {
          deletedKeys.push(key);
          return new Response(null, { status: 204 });
        }
        return new Response("unsupported", { status: 405 });
      },
    });
    const env = {
      STORAGE_PROVIDER: process.env.STORAGE_PROVIDER,
      STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT,
      STORAGE_REGION: process.env.STORAGE_REGION,
      STORAGE_ACCESS_KEY_ID: process.env.STORAGE_ACCESS_KEY_ID,
      STORAGE_SECRET_ACCESS_KEY: process.env.STORAGE_SECRET_ACCESS_KEY,
      STORAGE_FORCE_PATH_STYLE: process.env.STORAGE_FORCE_PATH_STYLE,
      STORAGE_HEAVY_PAYLOADS_BUCKET: process.env.STORAGE_HEAVY_PAYLOADS_BUCKET,
    };
    try {
      Object.assign(process.env, {
        STORAGE_PROVIDER: "s3",
        STORAGE_ENDPOINT: `http://127.0.0.1:${server.port}`,
        STORAGE_REGION: "local",
        STORAGE_ACCESS_KEY_ID: "chunk-abort-test",
        STORAGE_SECRET_ACCESS_KEY: "chunk-abort-test",
        STORAGE_FORCE_PATH_STYLE: "1",
        STORAGE_HEAVY_PAYLOADS_BUCKET: "chunk-abort-test-bucket",
      });
      resetObjectStorageClientForTests();
      const controller = new AbortController();
      const staged = stageEncryptedAgentBackupChunks({
        identity,
        objectSetId: OBJECT_SET_ID,
        signal: controller.signal,
        source: source("hung-s3-put"),
        chunkBytes: 32,
        maxTotalBytes: 64,
      });
      await putStarted;
      const abortedAt = performance.now();
      controller.abort(new Error("capture watchdog fired"));
      const error = await staged.then(
        () => undefined,
        (failure: unknown) => failure,
      );

      expect(performance.now() - abortedAt).toBeLessThan(2_000);
      expect(error).toBeInstanceOf(AgentBackupWriteEpochUnquiescedError);
      expect(error).toMatchObject({
        objectSetId: OBJECT_SET_ID,
        cleanupFailures: [],
      });
      expect(deletedKeys).toHaveLength(0);
      expect(OBJECT_STORAGE_TRANSPORT_TIMEOUTS).toEqual({
        connectionTimeout: 10_000,
        requestTimeout: 120_000,
        socketTimeout: 30_000,
        throwOnRequestTimeout: true,
      });
    } finally {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetObjectStorageClientForTests();
      server.stop(true);
    }
  });
});
