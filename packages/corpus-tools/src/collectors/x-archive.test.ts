/**
 * Deterministic unit coverage for the X archive collector against the
 * committed synthetic mini-archive fixture. The harness is real (filesystem
 * shards, real fflate ZIP bytes) with no network or mocked collaborators.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { validateCorpusTarget } from "../validator.ts";
import {
  assertXArchiveZipFileSize,
  assertXArchiveZipUncompressedSize,
  collectXArchive,
  MAX_X_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_X_ARCHIVE_ZIP_BYTES,
} from "./x-archive.ts";

const FIXTURE_DIR = path.join(import.meta.dirname, "../../fixtures/x-archive");
const OWNER = "7777";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "x-archive-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function zipFixture(): Promise<string> {
  const dataDir = path.join(FIXTURE_DIR, "data");
  const entries: Record<string, Uint8Array> = {};
  for (const name of await fs.readdir(dataDir)) {
    entries[`data/${name}`] = new Uint8Array(
      await fs.readFile(path.join(dataDir, name)),
    );
  }
  const zipPath = path.join(await makeTempDir(), "archive.zip");
  await fs.writeFile(zipPath, zipSync(entries));
  return zipPath;
}

describe("collectXArchive", () => {
  it("parses tweets, DMs, and likes from an extracted archive with cutoff filtering", async () => {
    const outDir = await makeTempDir();
    const result = await collectXArchive({
      archivePath: FIXTURE_DIR,
      ownerAccountId: OWNER,
      ownerDisplay: "Synthetic Owner",
      outDir,
    });

    expect(result.summary.tweetCount).toBe(4);
    expect(result.summary.dmMessageCount).toBe(3);
    expect(result.summary.dmConversationCount).toBe(2);
    expect(result.summary.likeCount).toBe(2);
    expect(result.summary.skippedBeforeCutoff).toBe(2);
    expect(result.issues).toEqual([]);
    expect(result.manifest.totals.messages).toBe(7);
  });

  it("maps tweet direction, thread roots, and same-shard reply references", async () => {
    const outDir = await makeTempDir();
    await collectXArchive({
      archivePath: FIXTURE_DIR,
      ownerAccountId: OWNER,
      outDir,
    });

    const august = (
      await fs.readFile(path.join(outDir, "x", OWNER, "2024-08.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const root = august.find((m) => m.id === "x:tweet:1001");
    const reply = august.find((m) => m.id === "x:tweet:1002");
    expect(root.direction).toBe("out");
    expect(root.threadId).toBe("x:thread:1001");
    expect(root.replyToId).toBeUndefined();
    expect(reply.threadId).toBe("x:thread:1001");
    expect(reply.replyToId).toBe("x:tweet:1001");

    const september = (
      await fs.readFile(path.join(outDir, "x", OWNER, "2024-09.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    // Cross-shard parent: thread root still resolves, replyToId omitted.
    const laterReply = september.find((m) => m.id === "x:tweet:1003");
    expect(laterReply.threadId).toBe("x:thread:1001");
    expect(laterReply.replyToId).toBeUndefined();
    // Parent outside the archive: thread falls back to the referenced id.
    const orphanReply = september.find((m) => m.id === "x:tweet:1004");
    expect(orphanReply.threadId).toBe("x:thread:999");
    expect(orphanReply.replyToId).toBeUndefined();
  });

  it("derives DM direction from senderId versus the owner id", async () => {
    const outDir = await makeTempDir();
    await collectXArchive({
      archivePath: FIXTURE_DIR,
      ownerAccountId: OWNER,
      outDir,
    });
    const august = (
      await fs.readFile(path.join(outDir, "x", OWNER, "2024-08.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const inbound = august.find((m) => m.id === "x:dm:5001");
    const outbound = august.find((m) => m.id === "x:dm:5002");
    expect(inbound.direction).toBe("in");
    expect(inbound.senderId).toBe("8888");
    expect(inbound.threadId).toBe("x:dm-conversation:7777-8888");
    expect(outbound.direction).toBe("out");
    expect(outbound.senderId).toBe(OWNER);
  });

  it("produces shards and a manifest that pass corpus validation", async () => {
    const outDir = await makeTempDir();
    const result = await collectXArchive({
      archivePath: FIXTURE_DIR,
      ownerAccountId: OWNER,
      outDir,
    });
    expect(result.shardPaths).toHaveLength(2);
    const validation = await validateCorpusTarget(outDir);
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
    const summary = JSON.parse(
      await fs.readFile(path.join(outDir, "x-archive-summary.json"), "utf8"),
    );
    expect(summary.tweetCount).toBe(4);
    expect(summary.dmConversationCount).toBe(2);
  });

  it("reads the same corpus from the official ZIP form", async () => {
    const zipPath = await zipFixture();
    const dirOut = await makeTempDir();
    const zipOut = await makeTempDir();
    const fromDir = await collectXArchive({
      archivePath: FIXTURE_DIR,
      ownerAccountId: OWNER,
      outDir: dirOut,
    });
    const fromZip = await collectXArchive({
      archivePath: zipPath,
      ownerAccountId: OWNER,
      outDir: zipOut,
    });
    expect(fromZip.summary).toEqual(fromDir.summary);
    expect(fromZip.manifest.shards.map((s) => s.sha256)).toEqual(
      fromDir.manifest.shards.map((s) => s.sha256),
    );
  });

  it("is resumable: reruns reuse matching shards and restore missing ones", async () => {
    const outDir = await makeTempDir();
    const first = await collectXArchive({
      archivePath: FIXTURE_DIR,
      ownerAccountId: OWNER,
      outDir,
    });
    expect(first.summary.shardsWritten).toBe(2);
    expect(first.summary.shardsReused).toBe(0);

    const rerun = await collectXArchive({
      archivePath: FIXTURE_DIR,
      ownerAccountId: OWNER,
      outDir,
    });
    expect(rerun.summary.shardsWritten).toBe(0);
    expect(rerun.summary.shardsReused).toBe(2);

    await fs.rm(path.join(outDir, "x", OWNER, "2024-09.jsonl"));
    const repaired = await collectXArchive({
      archivePath: FIXTURE_DIR,
      ownerAccountId: OWNER,
      outDir,
    });
    expect(repaired.summary.shardsWritten).toBe(1);
    expect(repaired.summary.shardsReused).toBe(1);
    const validation = await validateCorpusTarget(outDir);
    expect(validation.ok).toBe(true);
  });

  it("fails closed on a missing tweets file and malformed inputs", async () => {
    const emptyArchive = await makeTempDir();
    await fs.mkdir(path.join(emptyArchive, "data"), { recursive: true });
    const outDir = await makeTempDir();
    await expect(
      collectXArchive({
        archivePath: emptyArchive,
        ownerAccountId: OWNER,
        outDir,
      }),
    ).rejects.toMatchObject({ code: "X_ARCHIVE_MISSING_FILE" });

    const badPrefix = await makeTempDir();
    await fs.mkdir(path.join(badPrefix, "data"), { recursive: true });
    await fs.writeFile(
      path.join(badPrefix, "data", "tweets.js"),
      '[{"tweet":{}}]',
      "utf8",
    );
    await expect(
      collectXArchive({
        archivePath: badPrefix,
        ownerAccountId: OWNER,
        outDir,
      }),
    ).rejects.toMatchObject({ code: "X_ARCHIVE_BAD_PREFIX" });

    const badJson = await makeTempDir();
    await fs.mkdir(path.join(badJson, "data"), { recursive: true });
    await fs.writeFile(
      path.join(badJson, "data", "tweets.js"),
      "window.YTD.tweets.part0 = [{ nope",
      "utf8",
    );
    await expect(
      collectXArchive({ archivePath: badJson, ownerAccountId: OWNER, outDir }),
    ).rejects.toMatchObject({ code: "X_ARCHIVE_BAD_JSON" });
  });

  it("rejects a ZIP whose forged central directory declares a huge entry", async () => {
    const zipPath = path.join(await makeTempDir(), "bomb.zip");
    const forged = forgeUncompressedSizes(
      await zipFixtureBytes(),
      MAX_X_ARCHIVE_UNCOMPRESSED_BYTES + 1,
    );
    await fs.writeFile(zipPath, forged);
    await expect(
      collectXArchive({
        archivePath: zipPath,
        ownerAccountId: OWNER,
        outDir: await makeTempDir(),
      }),
    ).rejects.toMatchObject({ code: "X_ARCHIVE_ZIP_TOO_LARGE" });
  });

  it("rejects when the sum of declared entry sizes exceeds the cap", async () => {
    const zipPath = path.join(await makeTempDir(), "sum-bomb.zip");
    const perEntry = Math.floor(MAX_X_ARCHIVE_UNCOMPRESSED_BYTES / 2) + 1;
    const forged = forgeUncompressedSizes(await zipFixtureBytes(), perEntry);
    await fs.writeFile(zipPath, forged);
    await expect(
      collectXArchive({
        archivePath: zipPath,
        ownerAccountId: OWNER,
        outDir: await makeTempDir(),
      }),
    ).rejects.toMatchObject({ code: "X_ARCHIVE_ZIP_TOO_LARGE" });
  });

  it("does not count media entries that the extractor skips", () => {
    const zip = zipSync({
      "data/tweets.js": new TextEncoder().encode(
        "window.YTD.tweets.part0 = []",
      ),
      "data/tweet_media/large.mp4": new Uint8Array([1]),
    });
    const forged = forgeEntryUncompressedSize(
      zip,
      "data/tweet_media/large.mp4",
      MAX_X_ARCHIVE_UNCOMPRESSED_BYTES + 1,
    );
    expect(() => assertXArchiveZipUncompressedSize(forged)).not.toThrow();
  });

  it("rejects inconsistent central-directory metadata", () => {
    const zip = new Uint8Array(zipSync({ "data/tweets.js": new Uint8Array() }));
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = findEocd(zip);
    view.setUint16(eocd + 8, view.getUint16(eocd + 8, true) + 1, true);
    expect(() => assertXArchiveZipUncompressedSize(zip)).toThrowError(
      expect.objectContaining({ code: "X_ARCHIVE_ZIP_INVALID" }),
    );
  });

  it("rejects a filename mismatch between local and central headers", () => {
    const zip = new Uint8Array(zipSync({ "data/tweets.js": new Uint8Array() }));
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = findEocd(zip);
    const centralOffset = view.getUint32(eocd + 16, true);
    const localOffset = view.getUint32(centralOffset + 42, true);
    zip[localOffset + 30] = "x".charCodeAt(0);
    expect(() => assertXArchiveZipUncompressedSize(zip)).toThrowError(
      expect.objectContaining({ code: "X_ARCHIVE_ZIP_INVALID" }),
    );
  });

  it("rejects a stored entry whose central size would bypass the budget", () => {
    const zip = new Uint8Array(
      zipSync({
        "data/tweets.js": [new Uint8Array(1024), { level: 0 }],
      }),
    );
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const centralOffset = view.getUint32(findEocd(zip) + 16, true);
    expect(view.getUint16(centralOffset + 10, true)).toBe(0);
    view.setUint32(centralOffset + 24, 0, true);

    expect(() => assertXArchiveZipUncompressedSize(zip)).toThrowError(
      expect.objectContaining({ code: "X_ARCHIVE_ZIP_INVALID" }),
    );
  });

  it("rejects central compressed data that extends into the directory", () => {
    const zip = new Uint8Array(
      zipSync({ "data/tweets.js": new Uint8Array([1, 2, 3]) }),
    );
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const centralOffset = view.getUint32(findEocd(zip) + 16, true);
    view.setUint32(centralOffset + 20, centralOffset, true);

    expect(() => assertXArchiveZipUncompressedSize(zip)).toThrowError(
      expect.objectContaining({ code: "X_ARCHIVE_ZIP_INVALID" }),
    );
  });

  it("rejects a compression-method mismatch between headers", () => {
    const zip = new Uint8Array(
      zipSync({ "data/tweets.js": new Uint8Array([1, 2, 3]) }),
    );
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const centralOffset = view.getUint32(findEocd(zip) + 16, true);
    const localOffset = view.getUint32(centralOffset + 42, true);
    view.setUint16(
      localOffset + 8,
      view.getUint16(localOffset + 8, true) ^ 8,
      true,
    );

    expect(() => assertXArchiveZipUncompressedSize(zip)).toThrowError(
      expect.objectContaining({ code: "X_ARCHIVE_ZIP_INVALID" }),
    );
  });

  it("rejects a buffer that is not a ZIP archive", async () => {
    const zipPath = path.join(await makeTempDir(), "not.zip");
    await fs.writeFile(zipPath, "this is not a zip file at all");
    await expect(
      collectXArchive({
        archivePath: zipPath,
        ownerAccountId: OWNER,
        outDir: await makeTempDir(),
      }),
    ).rejects.toMatchObject({ code: "X_ARCHIVE_ZIP_INVALID" });
  });

  it("rejects a ZIP whose on-disk size exceeds the compressed cap", () => {
    try {
      assertXArchiveZipFileSize(MAX_X_ARCHIVE_ZIP_BYTES + 1, "huge.zip");
      expect.fail("expected compressed-size rejection");
    } catch (error) {
      expect(error).toMatchObject({
        code: "X_ARCHIVE_ZIP_TOO_LARGE",
        context: {
          archivePath: "huge.zip",
          declaredBytes: MAX_X_ARCHIVE_ZIP_BYTES + 1,
          maxBytes: MAX_X_ARCHIVE_ZIP_BYTES,
        },
      });
    }
    expect(() =>
      assertXArchiveZipFileSize(MAX_X_ARCHIVE_ZIP_BYTES, "ok.zip"),
    ).not.toThrow();
  });
});

/**
 * Overwrite the uncompressed-size field of every central-directory entry,
 * simulating a zip whose declared sizes do not match its real payload.
 */
function forgeUncompressedSizes(zip: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(zip);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let eocd = -1;
  for (let i = out.length - 22; i >= 0; i--) {
    if (
      out[i] === 0x50 &&
      out[i + 1] === 0x4b &&
      out[i + 2] === 0x05 &&
      out[i + 3] === 0x06
    ) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  for (let i = 0; i < entryCount; i++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const localOffset = view.getUint32(offset + 42, true);
    view.setUint32(offset + 24, size, true);
    view.setUint32(localOffset + 22, size, true);
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  return out;
}

function forgeEntryUncompressedSize(
  zip: Uint8Array,
  wantedName: string,
  size: number,
): Uint8Array {
  const out = new Uint8Array(zip);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const eocd = findEocd(out);
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  for (let i = 0; i < entryCount; i++) {
    const nameLen = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(
      out.subarray(offset + 46, offset + 46 + nameLen),
    );
    if (name === wantedName) {
      const localOffset = view.getUint32(offset + 42, true);
      view.setUint32(offset + 24, size, true);
      view.setUint32(localOffset + 22, size, true);
    }
    offset +=
      46 +
      nameLen +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  return out;
}

function findEocd(zip: Uint8Array): number {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error("test ZIP lacks EOCD");
}

async function zipFixtureBytes(): Promise<Uint8Array> {
  const dataDir = path.join(FIXTURE_DIR, "data");
  const entries: Record<string, Uint8Array> = {};
  for (const name of await fs.readdir(dataDir)) {
    entries[`data/${name}`] = new Uint8Array(
      await fs.readFile(path.join(dataDir, name)),
    );
  }
  return zipSync(entries);
}
