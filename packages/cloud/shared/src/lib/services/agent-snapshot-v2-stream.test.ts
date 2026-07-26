/**
 * Exercises the Cloud snapshot v2 stream boundary with generated canonical
 * wire data, including a payload larger than 256 MiB and adversarial frames.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  AGENT_SNAPSHOT_V2_CHUNK_BYTES,
  AGENT_SNAPSHOT_V2_CONTENT_TYPE,
  AGENT_SNAPSHOT_V2_FORMAT,
  AGENT_SNAPSHOT_V2_MAX_LINE_BYTES,
  AGENT_SNAPSHOT_V2_MAX_PATH_BYTES,
  AGENT_SNAPSHOT_V2_MAX_TOTAL_BYTES,
  AGENT_SNAPSHOT_V2_REPACK_VIEW_BYTES,
  AGENT_SNAPSHOT_V2_TRANSFER,
  type AgentSnapshotV2ChunkFrame,
  type AgentSnapshotV2DatabaseDescriptor,
  type AgentSnapshotV2Descriptor,
  type AgentSnapshotV2FileDescriptor,
  type AgentSnapshotV2FileSetDescriptor,
  type AgentSnapshotV2Frame,
  AgentSnapshotV2StreamValidator,
  type AgentSnapshotV2Trailer,
  agentSnapshotV2Sha256,
  agentSnapshotV2Sha256Json,
  agentSnapshotV2StableJson,
  observeAgentSnapshotV2Stream,
  validateAgentSnapshotV2Stream,
} from "./agent-snapshot-v2-stream";

const EMPTY_SHA256 = agentSnapshotV2Sha256(Buffer.alloc(0));
const CREATED_AT = "2026-07-26T12:00:00.000Z";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";

function encodeFrame(frame: unknown): Buffer {
  return Buffer.from(`${agentSnapshotV2StableJson(frame)}\n`);
}

function fileSet(
  files: readonly AgentSnapshotV2FileDescriptor[],
  component: AgentSnapshotV2FileDescriptor["component"],
): AgentSnapshotV2FileSetDescriptor {
  const selected = files.filter((file) => file.component === component);
  return {
    fileIndices: selected.map((file) => file.index),
    kind: "file-set",
    sha256: agentSnapshotV2Sha256Json(
      selected.map(({ path, sha256, size }) => ({ path, sha256, size })),
    ),
  };
}

function externalPostgresDatabase(): AgentSnapshotV2DatabaseDescriptor {
  const identitySha256 = "ab".repeat(32);
  const sha256 = agentSnapshotV2Sha256Json({
    algorithm: "sha256",
    identitySha256,
    identityVersion: 1,
    kind: "external-postgres-reference",
  });
  return {
    externalPostgres: {
      algorithm: "sha256",
      identitySha256,
      identityVersion: 1,
      kind: "external-postgres-reference",
      sha256,
    },
    kind: "external-postgres-reference",
    sha256,
  };
}

function descriptorFor(
  files: AgentSnapshotV2FileDescriptor[] = [],
  database: AgentSnapshotV2DatabaseDescriptor = externalPostgresDatabase(),
): AgentSnapshotV2Descriptor {
  const characterFile = files.find((file) => file.component === "character-config") ?? null;
  return {
    agentId: AGENT_ID,
    chunkSize: AGENT_SNAPSHOT_V2_CHUNK_BYTES,
    components: {
      character: {
        configFileIndex: characterFile?.index ?? null,
        kind: "character-config",
        sha256: agentSnapshotV2Sha256Json({
          configFile: characterFile
            ? {
                path: characterFile.path,
                sha256: characterFile.sha256,
                size: characterFile.size,
              }
            : null,
        }),
      },
      database,
      media: fileSet(files, "media"),
      stateFiles: fileSet(files, "state"),
      vault: fileSet(files, "vault"),
    },
    createdAt: CREATED_AT,
    files,
    format: AGENT_SNAPSHOT_V2_FORMAT,
    schemaVersion: 2,
    transfer: AGENT_SNAPSHOT_V2_TRANSFER,
    type: "descriptor",
  };
}

function fileDescriptor(
  index: number,
  path: string,
  content: Uint8Array,
  component: AgentSnapshotV2FileDescriptor["component"] = "state",
): AgentSnapshotV2FileDescriptor {
  return {
    component,
    index,
    mode: 0o600,
    mtimeMs: 1_774_185_600_000,
    path,
    sha256: agentSnapshotV2Sha256(content),
    size: content.byteLength,
  };
}

function chunkFrames(
  file: AgentSnapshotV2FileDescriptor,
  content: Uint8Array,
): AgentSnapshotV2ChunkFrame[] {
  const frames: AgentSnapshotV2ChunkFrame[] = [];
  for (
    let offset = 0, chunkIndex = 0;
    offset < content.byteLength;
    offset += AGENT_SNAPSHOT_V2_CHUNK_BYTES, chunkIndex += 1
  ) {
    const bytes = content.subarray(
      offset,
      Math.min(content.byteLength, offset + AGENT_SNAPSHOT_V2_CHUNK_BYTES),
    );
    frames.push({
      bytesBase64: Buffer.from(bytes).toString("base64"),
      chunkIndex,
      fileIndex: file.index,
      offset,
      sha256: agentSnapshotV2Sha256(bytes),
      size: bytes.byteLength,
      type: "chunk",
    });
  }
  return frames;
}

function completeFrames(
  descriptor: AgentSnapshotV2Descriptor,
  contents: readonly Uint8Array[],
): AgentSnapshotV2Frame[] {
  const chunks = descriptor.files.flatMap((file) => {
    const content = contents[file.index];
    if (!content) {
      throw new Error(`missing test content for file ${file.index}`);
    }
    return chunkFrames(file, content);
  });
  const aggregate = createHash("sha256");
  for (const content of contents) {
    aggregate.update(content);
  }
  const trailer: AgentSnapshotV2Trailer = {
    aggregateSha256: aggregate.digest("hex"),
    chunkCount: chunks.length,
    descriptorSha256: agentSnapshotV2Sha256(agentSnapshotV2StableJson(descriptor)),
    fileCount: descriptor.files.length,
    totalBytes: contents.reduce((total, content) => total + content.byteLength, 0),
    type: "trailer",
  };
  return [descriptor, ...chunks, trailer];
}

async function* encodedFrames(frames: readonly unknown[]): AsyncGenerator<Uint8Array> {
  for (const frame of frames) {
    yield encodeFrame(frame);
  }
}

async function validateFrames(
  frames: readonly unknown[],
  contentType = AGENT_SNAPSHOT_V2_CONTENT_TYPE,
) {
  return await validateAgentSnapshotV2Stream({
    options: { contentType, expectedAgentId: AGENT_ID },
    source: encodedFrames(frames),
  });
}

async function expectInvalid(frames: readonly unknown[], message: string): Promise<void> {
  await expect(validateFrames(frames)).rejects.toThrow(message);
}

describe("agent snapshot v2 Cloud stream validator", () => {
  test("accepts the exact content type and an identity-only external Postgres snapshot", async () => {
    const descriptor = descriptorFor();
    const frames = completeFrames(descriptor, []);
    const summary = await validateFrames(frames);

    expect(summary.descriptor.components.database.kind).toBe("external-postgres-reference");
    expect(summary.descriptor.files).toHaveLength(0);
    expect(summary.trailer).toMatchObject({
      aggregateSha256: EMPTY_SHA256,
      chunkCount: 0,
      fileCount: 0,
      totalBytes: 0,
    });
    expect(summary.peakBufferedLineBytes).toBeLessThan(AGENT_SNAPSHOT_V2_MAX_LINE_BYTES);

    await expect(
      validateFrames(frames, `${AGENT_SNAPSHOT_V2_CONTENT_TYPE}; charset=utf-8`),
    ).rejects.toThrow("content type is unsupported");
  });

  test("accepts canonical multi-component ordering and zero-byte files", async () => {
    const contents = [Buffer.alloc(0), Buffer.from("vault"), Buffer.alloc(0), Buffer.from("state")];
    const descriptor = descriptorFor([
      fileDescriptor(0, "empty-media", contents[0]!, "media"),
      fileDescriptor(1, "vault.json", contents[1]!, "vault"),
      fileDescriptor(2, "character.json", contents[2]!, "character-config"),
      fileDescriptor(3, "state.json", contents[3]!, "state"),
    ]);

    const summary = await validateFrames(completeFrames(descriptor, contents));

    expect(summary.trailer.fileCount).toBe(4);
    expect(summary.trailer.chunkCount).toBe(2);
    expect(summary.trailer.totalBytes).toBe(10);
  });

  test("validates and forwards more than 256 MiB without retaining the payload", async () => {
    const fullChunk = Buffer.alloc(AGENT_SNAPSHOT_V2_CHUNK_BYTES, 0xa5);
    const tail = Buffer.from([0xa5]);
    const fullChunkCount = (256 * 1024 * 1024) / AGENT_SNAPSHOT_V2_CHUNK_BYTES;
    const totalBytes = fullChunkCount * AGENT_SNAPSHOT_V2_CHUNK_BYTES + tail.byteLength;
    const fileHash = createHash("sha256");
    for (let index = 0; index < fullChunkCount; index += 1) {
      fileHash.update(fullChunk);
    }
    fileHash.update(tail);
    const file: AgentSnapshotV2FileDescriptor = {
      component: "state",
      index: 0,
      mode: 0o600,
      mtimeMs: 1_774_185_600_000,
      path: "large/generated.bin",
      sha256: fileHash.digest("hex"),
      size: totalBytes,
    };
    const descriptor = descriptorFor([file]);
    const chunkSha256 = agentSnapshotV2Sha256(fullChunk);
    const tailSha256 = agentSnapshotV2Sha256(tail);
    const trailer: AgentSnapshotV2Trailer = {
      aggregateSha256: file.sha256,
      chunkCount: fullChunkCount + 1,
      descriptorSha256: agentSnapshotV2Sha256(agentSnapshotV2StableJson(descriptor)),
      fileCount: 1,
      totalBytes,
      type: "trailer",
    };
    const inputWireHash = createHash("sha256");

    async function* generatedSource(): AsyncGenerator<Uint8Array> {
      let batch: Buffer[] = [];
      let batchBytes = 0;
      const flush = (): Buffer | null => {
        if (batchBytes === 0) {
          return null;
        }
        const output = Buffer.concat(batch, batchBytes);
        batch = [];
        batchBytes = 0;
        inputWireHash.update(output);
        return output;
      };
      const append = (line: Buffer): Buffer | null => {
        batch.push(line);
        batchBytes += line.byteLength;
        if (batchBytes >= 6 * 1024 * 1024) {
          return flush();
        }
        return null;
      };

      const descriptorBatch = append(encodeFrame(descriptor));
      if (descriptorBatch) {
        yield descriptorBatch;
      }
      for (let chunkIndex = 0; chunkIndex < fullChunkCount; chunkIndex += 1) {
        const line = encodeFrame({
          bytesBase64: fullChunk.toString("base64"),
          chunkIndex,
          fileIndex: 0,
          offset: chunkIndex * AGENT_SNAPSHOT_V2_CHUNK_BYTES,
          sha256: chunkSha256,
          size: AGENT_SNAPSHOT_V2_CHUNK_BYTES,
          type: "chunk",
        } satisfies AgentSnapshotV2ChunkFrame);
        const output = append(line);
        if (output) {
          yield output;
        }
      }
      const tailBatch = append(
        encodeFrame({
          bytesBase64: tail.toString("base64"),
          chunkIndex: fullChunkCount,
          fileIndex: 0,
          offset: fullChunkCount * AGENT_SNAPSHOT_V2_CHUNK_BYTES,
          sha256: tailSha256,
          size: tail.byteLength,
          type: "chunk",
        } satisfies AgentSnapshotV2ChunkFrame),
      );
      if (tailBatch) {
        yield tailBatch;
      }
      const trailerBatch = append(encodeFrame(trailer));
      if (trailerBatch) {
        yield trailerBatch;
      }
      const finalBatch = flush();
      if (finalBatch) {
        yield finalBatch;
      }
    }

    const validator = new AgentSnapshotV2StreamValidator({
      contentType: AGENT_SNAPSHOT_V2_CONTENT_TYPE,
      expectedAgentId: AGENT_ID,
    });
    const forwardedHash = createHash("sha256");
    let forwardedWireBytes = 0;
    let maximumForwardedView = 0;
    for await (const view of observeAgentSnapshotV2Stream({
      source: generatedSource(),
      validator,
    })) {
      forwardedHash.update(view);
      forwardedWireBytes += view.byteLength;
      maximumForwardedView = Math.max(maximumForwardedView, view.byteLength);
    }
    const summary = validator.summary;
    if (!summary) {
      throw new Error("generated snapshot did not finish validation");
    }

    expect(summary.trailer.totalBytes).toBeGreaterThan(256 * 1024 * 1024);
    expect(summary.trailer.totalBytes).toBe(totalBytes);
    expect(summary.peakBufferedLineBytes).toBeLessThan(512 * 1024);
    expect(validator.bufferedLineBytes).toBe(0);
    expect(maximumForwardedView).toBeLessThanOrEqual(AGENT_SNAPSHOT_V2_REPACK_VIEW_BYTES);
    expect(forwardedWireBytes).toBe(summary.wireBytes);
    expect(forwardedHash.digest("hex")).toBe(inputWireHash.digest("hex"));
  }, 120_000);

  test("rejects descriptor version, component order, indices, paths, and duplicates", async () => {
    const first = fileDescriptor(0, "b.txt", Buffer.from("b"));
    const second = fileDescriptor(1, "a.txt", Buffer.from("a"));
    const reordered = descriptorFor([first, second]);
    await expectInvalid([reordered], "canonical order");

    const duplicatePath = descriptorFor([
      fileDescriptor(0, "same.txt", Buffer.from("a")),
      fileDescriptor(1, "same.txt", Buffer.from("b")),
    ]);
    await expectInvalid([duplicatePath], "canonical order");

    const duplicateIndexFiles = [
      fileDescriptor(0, "a.txt", Buffer.from("a")),
      { ...fileDescriptor(1, "b.txt", Buffer.from("b")), index: 0 },
    ];
    await expectInvalid(
      [descriptorFor(duplicateIndexFiles)],
      "indices are duplicated or reordered",
    );

    for (const malformedPath of [
      "../escape",
      "/absolute",
      "a\\b",
      "a/../b",
      "x".repeat(AGENT_SNAPSHOT_V2_MAX_PATH_BYTES + 1),
    ]) {
      const invalid = descriptorFor([fileDescriptor(0, malformedPath, Buffer.from("x"))]);
      await expectInvalid([invalid], "path");
    }

    const descriptor = descriptorFor();
    await expectInvalid([{ ...descriptor, schemaVersion: 3 }], "version is unsupported");
    await expectInvalid([{ ...descriptor, transfer: "whole-buffer-v1" }], "version is unsupported");
    await expectInvalid(
      [{ ...descriptor, chunkSize: AGENT_SNAPSHOT_V2_CHUNK_BYTES / 2 }],
      "version is unsupported",
    );
    await expectInvalid(
      [{ ...descriptor, format: "elizaos.agent-snapshot" }],
      "version is unsupported",
    );
  });

  test("rejects external Postgres database bytes and inconsistent identity hashes", async () => {
    const databaseFile = fileDescriptor(
      0,
      "database.bin",
      Buffer.from("secret database bytes"),
      "database",
    );
    const hydrated = descriptorFor([databaseFile]);
    await expectInvalid([hydrated], "contains database bytes");

    const descriptor = descriptorFor();
    const database = descriptor.components.database;
    if (database.kind !== "external-postgres-reference") {
      throw new Error("expected external Postgres descriptor");
    }
    const invalidIdentity = descriptorFor([], {
      ...database,
      externalPostgres: {
        ...database.externalPostgres,
        identitySha256: "cd".repeat(32),
      },
    });
    await expectInvalid([invalidIdentity], "identity hash is inconsistent");
  });

  test("rejects corrupt, duplicated, reordered, non-canonical, and invalid-tail chunks", async () => {
    const content = Buffer.alloc(AGENT_SNAPSHOT_V2_CHUNK_BYTES + 7, 0x5c);
    const file = fileDescriptor(0, "two-chunks.bin", content);
    const descriptor = descriptorFor([file]);
    const frames = completeFrames(descriptor, [content]);
    const firstChunk = frames[1];
    const tailChunk = frames[2];
    const trailer = frames[3];
    if (firstChunk?.type !== "chunk" || tailChunk?.type !== "chunk") {
      throw new Error("expected two generated chunk frames");
    }

    await expectInvalid(
      [descriptor, firstChunk, firstChunk, tailChunk, trailer],
      "duplicated, reordered, or non-canonical",
    );
    await expectInvalid(
      [descriptor, firstChunk, { ...tailChunk, offset: tailChunk.offset - 1 }, trailer],
      "duplicated, reordered, or non-canonical",
    );
    await expectInvalid(
      [descriptor, { ...firstChunk, sha256: "00".repeat(32) }, tailChunk, trailer],
      "hash mismatch",
    );
    await expectInvalid(
      [
        descriptor,
        firstChunk,
        { ...tailChunk, bytesBase64: `${tailChunk.bytesBase64}=`, size: tailChunk.size },
        trailer,
      ],
      "canonical base64",
    );

    const extraTailByte = Buffer.alloc(tailChunk.size + 1, 0x5c);
    await expectInvalid(
      [
        descriptor,
        firstChunk,
        {
          ...tailChunk,
          bytesBase64: extraTailByte.toString("base64"),
          sha256: agentSnapshotV2Sha256(extraTailByte),
          size: extraTailByte.byteLength,
        },
        trailer,
      ],
      "duplicated, reordered, or non-canonical",
    );

    const wrongFileHash = descriptorFor([{ ...file, sha256: "11".repeat(32) }]);
    const wrongHashFrames = completeFrames(wrongFileHash, [content]);
    await expectInvalid(wrongHashFrames, "file two-chunks.bin hash is inconsistent");
  });

  test("rejects every inconsistent trailer field, truncation, and post-trailer residue", async () => {
    const content = Buffer.from("trailer integrity");
    const descriptor = descriptorFor([fileDescriptor(0, "state.json", content)]);
    const frames = completeFrames(descriptor, [content]);
    const trailer = frames.at(-1);
    if (trailer?.type !== "trailer") {
      throw new Error("expected generated trailer");
    }
    const prefix = frames.slice(0, -1);
    const corruptTrailers: AgentSnapshotV2Trailer[] = [
      { ...trailer, aggregateSha256: "00".repeat(32) },
      { ...trailer, descriptorSha256: "00".repeat(32) },
      { ...trailer, chunkCount: trailer.chunkCount + 1 },
      { ...trailer, fileCount: trailer.fileCount + 1 },
      { ...trailer, totalBytes: trailer.totalBytes + 1 },
    ];
    for (const corrupt of corruptTrailers) {
      await expectInvalid([...prefix, corrupt], "trailer is inconsistent");
    }

    await expectInvalid(prefix, "truncated");
    await expectInvalid([...frames, trailer], "frames after its trailer");

    const unterminated = encodeFrame(trailer).subarray(0, -1);
    const validator = new AgentSnapshotV2StreamValidator({
      contentType: AGENT_SNAPSHOT_V2_CONTENT_TYPE,
    });
    for (const frame of prefix) {
      validator.push(encodeFrame(frame));
    }
    validator.push(unterminated);
    expect(() => validator.finish()).toThrow("truncated");
  });

  test("rejects non-canonical JSON and lines beyond the 16 MiB bound", async () => {
    const descriptor = descriptorFor();
    const validator = new AgentSnapshotV2StreamValidator({
      contentType: AGENT_SNAPSHOT_V2_CONTENT_TYPE,
    });
    const nonCanonical = { type: descriptor.type, ...descriptor };
    expect(() => validator.push(Buffer.from(`${JSON.stringify(nonCanonical)}\n`))).toThrow(
      "canonical JSON",
    );

    const oversized = new AgentSnapshotV2StreamValidator({
      contentType: AGENT_SNAPSHOT_V2_CONTENT_TYPE,
    });
    expect(() => oversized.push(Buffer.alloc(AGENT_SNAPSHOT_V2_MAX_LINE_BYTES + 1, 0x20))).toThrow(
      "line exceeds its byte budget",
    );
  });

  test("enforces the 16 GiB descriptor byte budget before accepting frames", async () => {
    const first: AgentSnapshotV2FileDescriptor = {
      component: "state",
      index: 0,
      mode: 0o600,
      mtimeMs: 0,
      path: "a",
      sha256: EMPTY_SHA256,
      size: AGENT_SNAPSHOT_V2_MAX_TOTAL_BYTES,
    };
    const second: AgentSnapshotV2FileDescriptor = {
      ...first,
      index: 1,
      path: "b",
      size: 1,
    };
    await expectInvalid([descriptorFor([first, second])], "byte total exceeds its budget");

    const tooManyFiles = {
      ...descriptorFor(),
      files: new Array(100_001).fill(null),
    };
    await expectInvalid([tooManyFiles], "file count exceeds its budget");
  });
});
