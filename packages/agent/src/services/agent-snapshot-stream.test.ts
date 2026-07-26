/**
 * Exercises the canonical snapshot stream against real temporary files:
 * multi-component round trips, fail-closed staging, adversarial frame/path
 * inputs, external-Postgres identity-only capture, and a >256 MiB source.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, test } from "vitest";
import {
  AGENT_BACKUP_V1_MAX_SOURCE_BYTES,
  createAgentSnapshot,
  parseAgentSnapshotRequest,
} from "./agent-backup.ts";
import {
  createAgentSnapshotStream,
  restoreAgentSnapshotStream,
} from "./agent-snapshot-stream.ts";
import {
  AGENT_SNAPSHOT_STREAM_CHUNK_BYTES,
  type AgentSnapshotStreamDescriptor,
  encodeSnapshotStreamFrame,
  parseCanonicalSnapshotStreamFrame,
  stableJson,
} from "./agent-snapshot-stream-protocol.ts";

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  ELIZA_CONFIG_PATH: process.env.ELIZA_CONFIG_PATH,
  ELIZA_NAMESPACE: process.env.ELIZA_NAMESPACE,
  ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
  PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR,
  POSTGRES_URL: process.env.POSTGRES_URL,
};
const roots = new Set<string>();
const AGENT_ID = "90000000-0000-4000-8000-000000000001";
const POSTGRES_URL =
  "postgres://capture:secret@db.example.com:5432/eliza?schema=tenant";

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function temporaryRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), label));
  roots.add(root);
  return root;
}

function runtimeStub(
  postgresUrl = POSTGRES_URL,
  onRawConnection?: () => void,
): AgentRuntime {
  return {
    adapter: {
      close: async () => undefined,
      getRawConnection: () => {
        onRawConnection?.();
        throw new Error("External Postgres snapshot must not inspect SQL");
      },
    },
    agentId: AGENT_ID,
    character: { name: "Stream Test Agent" },
    getSetting: (key: string) => (key === "POSTGRES_URL" ? postgresUrl : null),
  } as unknown as AgentRuntime;
}

async function writeFixture(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "media"), { recursive: true });
  await fs.mkdir(path.join(root, ".vault-pglite"), { recursive: true });
  await fs.mkdir(path.join(root, "audit"), { recursive: true });
  await fs.mkdir(path.join(root, "skills"), { recursive: true });
  await fs.writeFile(path.join(root, "eliza.json"), '{"name":"captured"}\n');
  await fs.writeFile(
    path.join(root, "media", `${"a".repeat(64)}.bin`),
    "media-payload",
  );
  await fs.writeFile(path.join(root, "vault.json"), "vault-payload", {
    mode: 0o600,
  });
  await fs.writeFile(
    path.join(root, ".vault-pglite", "data.bin"),
    "vault-db-payload",
  );
  await fs.writeFile(
    path.join(root, "audit", "vault.jsonl"),
    '{"event":"captured"}\n',
  );
  await fs.writeFile(
    path.join(root, "skills", "active.json"),
    '{"active":true}\n',
  );
}

async function collectStream(runtime: AgentRuntime): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  for await (const frame of createAgentSnapshotStream(runtime)) {
    frames.push(frame);
  }
  return frames;
}

function decodeFrame(frame: Buffer): Record<string, unknown> {
  return parseCanonicalSnapshotStreamFrame(frame.subarray(0, -1)) as Record<
    string,
    unknown
  >;
}

async function* asInput(
  frames: readonly (Buffer | string)[],
): AsyncGenerator<Buffer | string> {
  for (const frame of frames) yield frame;
}

afterEach(async () => {
  restoreEnv();
  await Promise.all(
    [...roots].map((root) => fs.rm(root, { force: true, recursive: true })),
  );
  roots.clear();
});

describe.sequential("agent snapshot chunked-v1 stream", () => {
  test("accepts chunked-v1 only for schema-v2 pre-upgrade capture", () => {
    expect(
      parseAgentSnapshotRequest({
        purpose: "pre-upgrade",
        schemaVersion: 2,
        transfer: "chunked-v1",
      }),
    ).toEqual({
      purpose: "pre-upgrade",
      schemaVersion: 2,
      transfer: "chunked-v1",
    });
    expect(() =>
      parseAgentSnapshotRequest({
        purpose: "manual",
        schemaVersion: 1,
        transfer: "chunked-v1",
      }),
    ).toThrow(/requires a pre-upgrade snapshot/);
    expect(() =>
      parseAgentSnapshotRequest({
        purpose: "pre-upgrade",
        schemaVersion: 2,
        transfer: "chunked-v2" as never,
      }),
    ).toThrow(/Unsupported snapshot transfer/);
  });

  test("round-trips files after the complete stream verifies", async () => {
    const source = await temporaryRoot("eliza-stream-source-");
    const target = await temporaryRoot("eliza-stream-target-");
    await writeFixture(source);
    await fs.mkdir(path.join(target, "skills"), { recursive: true });
    await fs.writeFile(path.join(target, "skills", "stale.json"), "stale");
    await fs.writeFile(path.join(target, "sentinel.txt"), "target-before");

    process.env.ELIZA_STATE_DIR = source;
    delete process.env.PGLITE_DATA_DIR;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    const sourceRuntime = runtimeStub();
    const iterator = createAgentSnapshotStream(sourceRuntime);
    const first = await iterator.next();
    if (first.done) throw new Error("Snapshot stream emitted no descriptor");

    process.env.ELIZA_STATE_DIR = target;
    const targetRuntime = runtimeStub(
      "postgres://restore:rotated@DB.EXAMPLE.COM/eliza?search_path=tenant",
    );
    async function* transfer(): AsyncGenerator<Buffer> {
      yield first.value;
      yield* iterator;
    }
    await expect(
      restoreAgentSnapshotStream(targetRuntime, transfer()),
    ).resolves.toMatchObject({
      aggregateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      fileCount: expect.any(Number),
      requiresRestart: true,
      schemaVersion: 2,
      success: true,
      totalBytes: expect.any(Number),
      transfer: "chunked-v1",
    });

    await expect(
      fs.readFile(path.join(target, "skills", "active.json"), "utf8"),
    ).resolves.toBe('{"active":true}\n');
    await expect(
      fs.readFile(path.join(target, "media", `${"a".repeat(64)}.bin`), "utf8"),
    ).resolves.toBe("media-payload");
    await expect(
      fs.readFile(path.join(target, ".vault-pglite", "data.bin"), "utf8"),
    ).resolves.toBe("vault-db-payload");
    await expect(
      fs.readFile(path.join(target, "eliza.json"), "utf8"),
    ).resolves.toBe('{"name":"captured"}\n');
    await expect(
      fs.stat(path.join(target, "skills", "stale.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(target, "sentinel.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("external Postgres capture contains identity only and reads zero SQL bytes", async () => {
    const source = await temporaryRoot("eliza-stream-postgres-");
    await writeFixture(source);
    process.env.ELIZA_STATE_DIR = source;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    let rawConnectionCalls = 0;
    const frames = await collectStream(
      runtimeStub(POSTGRES_URL, () => {
        rawConnectionCalls += 1;
      }),
    );
    const descriptor = decodeFrame(frames[0] as Buffer);
    expect(rawConnectionCalls).toBe(0);
    expect(descriptor).toMatchObject({
      components: {
        database: { kind: "external-postgres-reference" },
      },
    });
    const serialized = frames.map((frame) => frame.toString()).join("");
    expect(serialized).not.toContain("capture");
    expect(serialized).not.toContain("secret");
    expect(
      (descriptor as unknown as AgentSnapshotStreamDescriptor).files.some(
        (file) => file.component === "database",
      ),
    ).toBe(false);
  });

  test("rejects corrupt, truncated, reordered, and non-canonical streams before apply", async () => {
    const source = await temporaryRoot("eliza-stream-adversarial-source-");
    const target = await temporaryRoot("eliza-stream-adversarial-target-");
    await writeFixture(source);
    await fs.writeFile(
      path.join(source, "skills", "large.bin"),
      Buffer.alloc(AGENT_SNAPSHOT_STREAM_CHUNK_BYTES + 17, 0x5a),
    );
    process.env.ELIZA_STATE_DIR = source;
    const frames = await collectStream(runtimeStub());
    const chunkIndices = frames
      .map((frame, index) => ({ frame: decodeFrame(frame), index }))
      .filter(({ frame }) => frame.type === "chunk")
      .map(({ index }) => index);
    expect(chunkIndices.length).toBeGreaterThan(1);

    process.env.ELIZA_STATE_DIR = target;
    await fs.writeFile(path.join(target, "sentinel.txt"), "unchanged");
    const corrupt = frames.map((frame) => Buffer.from(frame));
    const corruptIndex = chunkIndices[0] as number;
    const corruptFrame = decodeFrame(corrupt[corruptIndex] as Buffer);
    const corruptBytes = Buffer.from(
      corruptFrame.bytesBase64 as string,
      "base64",
    );
    corruptBytes[0] = (corruptBytes[0] ?? 0) ^ 0xff;
    corruptFrame.bytesBase64 = corruptBytes.toString("base64");
    corrupt[corruptIndex] = Buffer.from(`${stableJson(corruptFrame)}\n`);

    await expect(
      restoreAgentSnapshotStream(runtimeStub(), asInput(corrupt)),
    ).rejects.toThrow(/hash mismatch/);
    await expect(
      restoreAgentSnapshotStream(runtimeStub(), asInput(frames.slice(0, -1))),
    ).rejects.toThrow(/truncated/);

    const reordered = frames.map((frame) => Buffer.from(frame));
    const firstChunk = chunkIndices[0] as number;
    const secondChunk = chunkIndices[1] as number;
    const firstChunkFrame = reordered[firstChunk];
    const secondChunkFrame = reordered[secondChunk];
    if (!firstChunkFrame || !secondChunkFrame) {
      throw new Error("Chunk frame index is missing");
    }
    reordered[firstChunk] = secondChunkFrame;
    reordered[secondChunk] = firstChunkFrame;
    await expect(
      restoreAgentSnapshotStream(runtimeStub(), asInput(reordered)),
    ).rejects.toThrow(/duplicated or reordered/);

    const nonCanonical = frames.map((frame) => Buffer.from(frame));
    nonCanonical[0] = Buffer.from(` ${frames[0]?.toString()}`);
    await expect(
      restoreAgentSnapshotStream(runtimeStub(), asInput(nonCanonical)),
    ).rejects.toThrow(/not canonical JSON/);
    await expect(
      fs.readFile(path.join(target, "sentinel.txt"), "utf8"),
    ).resolves.toBe("unchanged");
    await expect(fs.readdir(target)).resolves.toEqual(["sentinel.txt"]);
  });

  test("rejects traversal, component-policy, and parent-file path conflicts", async () => {
    const source = await temporaryRoot("eliza-stream-paths-");
    await writeFixture(source);
    process.env.ELIZA_STATE_DIR = source;
    const frames = await collectStream(runtimeStub());
    const descriptor = decodeFrame(frames[0] as Buffer);
    const files = descriptor.files as Array<Record<string, unknown>>;
    const stateFile = files.find((file) => file.component === "state");
    if (!stateFile) throw new Error("Fixture has no state file");

    for (const invalidPath of [
      "../escape",
      "/absolute",
      "nested\\windows",
      "nested\ncontrol",
    ]) {
      const invalid = structuredClone(descriptor);
      const invalidFile = (invalid.files as Array<Record<string, unknown>>)[
        stateFile.index as number
      ];
      if (!invalidFile) throw new Error("State file index is missing");
      invalidFile.path = invalidPath;
      expect(() =>
        parseCanonicalSnapshotStreamFrame(Buffer.from(stableJson(invalid))),
      ).not.toThrow();
      const body = [
        encodeSnapshotStreamFrame(
          invalid as unknown as AgentSnapshotStreamDescriptor,
        ),
        ...frames.slice(1),
      ];
      await expect(
        restoreAgentSnapshotStream(runtimeStub(), asInput(body)),
      ).rejects.toThrow(/path/);
    }

    const wrongComponent = structuredClone(descriptor);
    const wrongComponentFile = (
      wrongComponent.files as Array<Record<string, unknown>>
    )[stateFile.index as number];
    if (!wrongComponentFile) throw new Error("State file index is missing");
    wrongComponentFile.path = "vault.json";
    const target = await temporaryRoot("eliza-stream-path-target-");
    process.env.ELIZA_STATE_DIR = target;
    await expect(
      restoreAgentSnapshotStream(
        runtimeStub(),
        asInput([
          Buffer.from(`${stableJson(wrongComponent)}\n`),
          ...frames.slice(1),
        ]),
      ),
    ).rejects.toThrow(/hash is inconsistent|unsupported/);
    await expect(fs.readdir(target)).resolves.toEqual([]);
  });

  test("rejects source and destination symlink traversal", async () => {
    const source = await temporaryRoot("eliza-stream-symlink-source-");
    const outside = await temporaryRoot("eliza-stream-symlink-outside-");
    await fs.mkdir(path.join(source, "skills"), { recursive: true });
    await fs.writeFile(path.join(source, "eliza.json"), "{}\n");
    await fs.writeFile(path.join(outside, "outside.json"), "outside");
    await fs.symlink(
      path.join(outside, "outside.json"),
      path.join(source, "skills", "linked.json"),
    );
    process.env.ELIZA_STATE_DIR = source;
    await expect(collectStream(runtimeStub())).rejects.toThrow(/symbolic link/);

    await fs.rm(path.join(source, "skills", "linked.json"));
    await fs.writeFile(path.join(source, "skills", "active.json"), "captured");
    const frames = await collectStream(runtimeStub());
    const target = await temporaryRoot("eliza-stream-symlink-target-");
    await fs.symlink(outside, path.join(target, "skills"));
    process.env.ELIZA_STATE_DIR = target;
    await expect(
      restoreAgentSnapshotStream(runtimeStub(), asInput(frames)),
    ).rejects.toThrow(/symbolic link|non-directory/);
    await expect(
      fs.readFile(path.join(outside, "outside.json"), "utf8"),
    ).resolves.toBe("outside");
    await expect(fs.readdir(outside)).resolves.toEqual(["outside.json"]);
  });

  test("streams a source larger than 256 MiB without a payload-sized frame", async () => {
    const source = await temporaryRoot("eliza-stream-large-");
    const target = await temporaryRoot("eliza-stream-large-target-");
    await fs.mkdir(path.join(source, "skills"), { recursive: true });
    await fs.writeFile(path.join(source, "eliza.json"), "{}\n");
    const size = 256 * 1024 * 1024 + AGENT_SNAPSHOT_STREAM_CHUNK_BYTES;
    await fs.writeFile(path.join(source, "skills", "large.bin"), "");
    await fs.truncate(path.join(source, "skills", "large.bin"), size);
    process.env.ELIZA_STATE_DIR = source;

    let maximumFrameBytes = 0;
    let chunkCount = 0;
    const iterator = createAgentSnapshotStream(runtimeStub());
    const first = await iterator.next();
    if (first.done) throw new Error("Snapshot stream emitted no descriptor");
    process.env.ELIZA_STATE_DIR = target;
    async function* measuredTransfer(): AsyncGenerator<Buffer> {
      yield first.value;
      for await (const frame of iterator) {
        maximumFrameBytes = Math.max(maximumFrameBytes, frame.length);
        const parsed = decodeFrame(frame);
        if (parsed.type === "chunk") chunkCount += 1;
        yield frame;
      }
    }
    const result = await restoreAgentSnapshotStream(
      runtimeStub(),
      measuredTransfer(),
    );
    expect(result.totalBytes).toBeGreaterThan(256 * 1024 * 1024);
    expect(chunkCount).toBeGreaterThan(1024);
    expect(maximumFrameBytes).toBeLessThan(
      AGENT_SNAPSHOT_STREAM_CHUNK_BYTES * 2,
    );
    await expect(
      fs.stat(path.join(target, "skills", "large.bin")),
    ).resolves.toMatchObject({ size });
  }, 120_000);

  test("restores a chunked stream fragmented into one-byte transport views", async () => {
    const source = await temporaryRoot("eliza-stream-fragmented-");
    const target = await temporaryRoot("eliza-stream-fragmented-target-");
    await writeFixture(source);
    await fs.writeFile(
      path.join(source, "skills", "full-chunk.bin"),
      Buffer.alloc(AGENT_SNAPSHOT_STREAM_CHUNK_BYTES, 0x5a),
    );
    process.env.ELIZA_STATE_DIR = source;
    const frames = await collectStream(runtimeStub());
    process.env.ELIZA_STATE_DIR = target;

    async function* fragmentedTransfer(): AsyncGenerator<Buffer> {
      for (const frame of frames) {
        for (let offset = 0; offset < frame.length; offset += 1) {
          yield frame.subarray(offset, offset + 1);
        }
      }
    }

    await expect(
      restoreAgentSnapshotStream(runtimeStub(), fragmentedTransfer()),
    ).resolves.toMatchObject({
      requiresRestart: true,
      success: true,
      transfer: "chunked-v1",
    });
    await expect(
      fs.readFile(path.join(target, "skills", "full-chunk.bin")),
    ).resolves.toEqual(Buffer.alloc(AGENT_SNAPSHOT_STREAM_CHUNK_BYTES, 0x5a));
  }, 30_000);

  test("rejects a v1 source once aggregate files exceed 128 MiB", async () => {
    const source = await temporaryRoot("eliza-snapshot-v1-cap-");
    const pgliteDir = path.join(source, "pglite");
    await fs.mkdir(path.join(source, "media"), { recursive: true });
    await fs.mkdir(pgliteDir, { recursive: true });
    await fs.writeFile(path.join(pgliteDir, "data.bin"), "database");
    const oversized = path.join(source, "media", "oversized.bin");
    await fs.writeFile(oversized, "");
    await fs.truncate(oversized, AGENT_BACKUP_V1_MAX_SOURCE_BYTES + 1);
    process.env.ELIZA_STATE_DIR = source;
    process.env.PGLITE_DATA_DIR = pgliteDir;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;

    await expect(
      createAgentSnapshot(
        {
          adapter: { close: async () => undefined },
          agentId: AGENT_ID,
          character: { name: "V1 Cap Agent" },
          getSetting: () => null,
        } as unknown as AgentRuntime,
        {} as never,
        {
          purpose: "manual",
          schemaVersion: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "AGENT_SNAPSHOT_SOURCE_TOO_LARGE" });
  });
});
