/**
 * Exercises encrypted v2 backup chunks against a binary in-memory R2 bucket
 * and the real test KMS, including cleanup and adversarial restore failures.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetKmsClientForTests } from "../../db/crypto/kms-client";
import { type RuntimeR2Bucket, setRuntimeR2Bucket } from "../storage/r2-runtime-binding";
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
  options?: { failPutAt?: number; failDelete?: boolean },
): RuntimeR2Bucket {
  let puts = 0;
  return {
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return {
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
    await expect(collect(truncated)).rejects.toThrow("aggregate integrity");
  });
});
