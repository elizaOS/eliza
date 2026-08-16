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
import { collectXArchive } from "./x-archive.ts";

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
});
