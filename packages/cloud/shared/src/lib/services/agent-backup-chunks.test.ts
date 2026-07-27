/**
 * Exercises encrypted v2 backup chunks against a binary in-memory R2 bucket
 * and the real test KMS, including cleanup and adversarial restore failures.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getKmsClient, resetKmsClientForTests, setKmsClient } from "../../db/crypto/kms-client";
import { type RuntimeR2Bucket, setRuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { resetObjectStorageClientForTests } from "../storage/s3-compatible-client";
import {
  type AgentBackupChunkDescriptor,
  type AgentBackupChunkIdentity,
  readEncryptedAgentBackupChunks,
  stageEncryptedAgentBackupChunks,
} from "./agent-backup-chunks";

const identity: AgentBackupChunkIdentity = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  sandboxRecordId: "00000000-0000-4000-8000-000000000002",
  backupId: "00000000-0000-4000-8000-000000000003",
  backupSchemaVersion: 2,
};

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
      objects.delete(key);
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
  test("stages arbitrary producer views as fixed encrypted chunks and restores exact bytes", async () => {
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));

    const descriptor = await stageEncryptedAgentBackupChunks({
      identity,
      source: source("abc", "defghijk", "lm"),
      chunkBytes: 4,
      maxTotalBytes: 32,
      createdAt: new Date("2026-07-26T12:00:00.000Z"),
    });

    expect(descriptor.commitState).toBe("complete");
    expect(descriptor.objectSetId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(descriptor.chunks.map((chunk) => chunk.plaintextBytes)).toEqual([4, 4, 4, 1]);
    expect(objects.size).toBe(4);
    expect(new TextDecoder().decode(await collect(descriptor))).toBe("abcdefghijklm");
  });

  test("rejects missing, reordered, and ciphertext-tampered chunks", async () => {
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));
    const descriptor = await stageEncryptedAgentBackupChunks({
      identity,
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

  test("removes staged objects when a later upload or byte budget fails", async () => {
    const failedPutObjects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(failedPutObjects, { failPutAt: 2 }));
    await expect(
      stageEncryptedAgentBackupChunks({
        identity,
        source: source("abcdefgh"),
        chunkBytes: 4,
        maxTotalBytes: 16,
      }),
    ).rejects.toThrow("injected put failure");
    expect(failedPutObjects.size).toBe(0);

    const ambiguousPutObjects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(ambiguousPutObjects, { throwAfterPutAt: 2 }));
    await expect(
      stageEncryptedAgentBackupChunks({
        identity,
        source: source("abcdefgh"),
        chunkBytes: 4,
        maxTotalBytes: 16,
      }),
    ).rejects.toThrow("injected ambiguous put failure");
    expect(ambiguousPutObjects.size).toBe(0);

    const overBudgetObjects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(overBudgetObjects));
    await expect(
      stageEncryptedAgentBackupChunks({
        identity,
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
    await expect(
      stageEncryptedAgentBackupChunks({
        identity,
        source: source("abcdefgh"),
        chunkBytes: 4,
        maxTotalBytes: 16,
      }),
    ).rejects.toThrow("partial objects could not be removed");
    expect(objects.size).toBe(1);
  });

  test("detects aggregate truncation even when individual chunks are intact", async () => {
    const objects = new Map<string, Uint8Array>();
    setRuntimeR2Bucket(memoryBucket(objects));
    const descriptor = await stageEncryptedAgentBackupChunks({
      identity,
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
      source: source("first"),
      chunkBytes: 8,
      maxTotalBytes: 16,
      createdAt,
    });
    const second = await stageEncryptedAgentBackupChunks({
      identity,
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
    setRuntimeR2Bucket(memoryBucket(objects));
    async function* oversizedView() {
      yield new Uint8Array(16 * 1024 * 1024 + 1);
    }
    await expect(
      stageEncryptedAgentBackupChunks({
        identity,
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
        source: tooManyChunks(),
        chunkBytes: 1,
        maxTotalBytes: 5_633,
      }),
    ).rejects.toThrow("5632-chunk limit");
    expect(objects.size).toBe(0);
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
});
