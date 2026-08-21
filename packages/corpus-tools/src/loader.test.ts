/**
 * Loader contract tests over the committed synthetic sample corpus plus
 * temp-dir invalid shards. Real filesystem, no mocks: the same validator path
 * production consumers use.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CorpusLoadError,
  CorpusSelectionError,
  loadCorpusMessages,
} from "./loader.ts";
import type { CorpusMessage, CorpusPlatform } from "./schema.ts";

const SAMPLE_CORPUS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/sample-corpus",
);

let tempDir: string | null = null;

const MARCH = Date.parse("2025-03-04T09:00:00.000Z");
const APRIL = Date.parse("2025-04-04T09:00:00.000Z");

/** A minimal schema-valid, verified gmail row. */
function row(
  overrides: Partial<CorpusMessage> & { id: string },
): CorpusMessage {
  return {
    platform: "gmail",
    accountId: "work",
    threadId: `thr-${overrides.id}`,
    ts: MARCH,
    direction: "in",
    senderId: "sender@example.test",
    senderDisplay: "Sender",
    recipients: [{ id: "owner", address: "owner@example.test" }],
    text: "body",
    labels: ["INBOX"],
    attachments: [],
    scrubState: "verified",
    ...overrides,
  } as CorpusMessage;
}

/** Writes a `<platform>/<account>/<yyyy-mm>.jsonl` tree into a fresh tempdir. */
async function writeShards(
  shards: Record<string, readonly CorpusMessage[]>,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "corpus-loader-"));
  for (const [relative, messages] of Object.entries(shards)) {
    const file = path.join(dir, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    );
  }
  return dir;
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("loadCorpusMessages", () => {
  it("loads only verified rows by default with deterministic ordering", async () => {
    const result = await loadCorpusMessages(SAMPLE_CORPUS_DIR);
    expect(result.shardCount).toBe(3);
    expect(result.scanned).toBe(6);
    expect(result.belowScrubFloor).toBe(1);
    expect(result.messages.map((m) => m.id)).toEqual([
      "corpus-gmail-work-1",
      "corpus-gmail-work-2",
      "corpus-tg-1",
      "corpus-gmail-work-3",
      "corpus-gmail-home-1",
    ]);
    expect(result.byPlatform).toEqual({ gmail: 4, telegram: 1 });
  });

  it("applies platform, account, thread, window, and cap selection", async () => {
    const gmailWork = await loadCorpusMessages(SAMPLE_CORPUS_DIR, {
      platforms: ["gmail"],
      accountIds: ["work"],
    });
    expect(gmailWork.messages.map((m) => m.id)).toEqual([
      "corpus-gmail-work-1",
      "corpus-gmail-work-2",
      "corpus-gmail-work-3",
    ]);

    const thread = await loadCorpusMessages(SAMPLE_CORPUS_DIR, {
      threadIds: ["corpus-thr-atlas"],
    });
    expect(thread.messages).toHaveLength(2);

    const windowed = await loadCorpusMessages(SAMPLE_CORPUS_DIR, {
      fromTs: Date.parse("2025-03-10T00:00:00Z"),
      toTs: Date.parse("2025-03-31T00:00:00Z"),
    });
    expect(windowed.messages.map((m) => m.id)).toEqual(["corpus-gmail-work-3"]);

    const capped = await loadCorpusMessages(SAMPLE_CORPUS_DIR, {
      maxMessages: 2,
    });
    expect(capped.messages.map((m) => m.id)).toEqual([
      "corpus-gmail-work-1",
      "corpus-gmail-work-2",
    ]);
  });

  it("releases lower scrub states only when the floor is loosened", async () => {
    const result = await loadCorpusMessages(SAMPLE_CORPUS_DIR, {
      minScrubState: "raw",
    });
    expect(result.belowScrubFloor).toBe(0);
    expect(result.messages.map((m) => m.id)).toContain("corpus-tg-2");
  });

  it("refuses to load a corpus with any validation issue", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "corpus-loader-"));
    const shardDir = path.join(tempDir, "gmail", "work");
    await mkdir(shardDir, { recursive: true });
    await writeFile(
      path.join(shardDir, "2025-03.jsonl"),
      `${JSON.stringify({ id: "bad-row" })}\n`,
    );
    await expect(loadCorpusMessages(tempDir)).rejects.toThrow(CorpusLoadError);
  });

  it("rejects a message id duplicated across two individually valid shards", async () => {
    tempDir = await writeShards({
      "gmail/work/2025-03.jsonl": [row({ id: "collide", ts: MARCH })],
      "gmail/home/2025-04.jsonl": [
        row({ id: "collide", accountId: "home", ts: APRIL }),
      ],
    });
    // Each shard on its own is valid; only the whole corpus reveals the clash.
    const error = await loadCorpusMessages(tempDir).catch((e) => e);
    expect(error).toBeInstanceOf(CorpusLoadError);
    expect((error as CorpusLoadError).issues).toHaveLength(1);
    expect((error as CorpusLoadError).issues[0]?.code).toBe("duplicate-id");
    expect((error as CorpusLoadError).issues[0]?.message).toContain("collide");
  });

  it("resolves a reply whose parent lives in an adjacent month shard", async () => {
    tempDir = await writeShards({
      "gmail/work/2025-03.jsonl": [row({ id: "parent", ts: MARCH })],
      "gmail/work/2025-04.jsonl": [
        row({ id: "child", ts: APRIL, replyToId: "parent" }),
      ],
    });
    const result = await loadCorpusMessages(tempDir);
    expect(result.messages.map((m) => m.id)).toEqual(["parent", "child"]);
  });

  it("rejects an unrecognized scrub floor instead of releasing every row", async () => {
    // The floor gates personal data: an unknown value used to compare against
    // `undefined`, which is false for every row, releasing even `raw` ones.
    await expect(
      loadCorpusMessages(SAMPLE_CORPUS_DIR, {
        minScrubState: "totally-clean" as never,
      }),
    ).rejects.toThrow(CorpusSelectionError);
  });

  it("rejects a scalar string where an array selection field is required", async () => {
    // `"homework".includes("home")` is true, so a bare string would silently
    // turn an account allowlist into a substring filter and widen the release.
    const widened = await loadCorpusMessages(SAMPLE_CORPUS_DIR, {
      accountIds: ["work", "home"],
    });
    expect(widened.messages.length).toBeGreaterThan(1);

    await expect(
      loadCorpusMessages(SAMPLE_CORPUS_DIR, {
        accountIds: "homework" as unknown as readonly string[],
      }),
    ).rejects.toThrow(CorpusSelectionError);
    await expect(
      loadCorpusMessages(SAMPLE_CORPUS_DIR, {
        threadIds: "corpus-thr-atlas" as unknown as readonly string[],
      }),
    ).rejects.toThrow(CorpusSelectionError);
    await expect(
      loadCorpusMessages(SAMPLE_CORPUS_DIR, {
        platforms: "gmail" as unknown as readonly CorpusPlatform[],
      }),
    ).rejects.toThrow(CorpusSelectionError);
    await expect(
      loadCorpusMessages(SAMPLE_CORPUS_DIR, {
        platforms: ["gmailx"] as unknown as readonly CorpusPlatform[],
      }),
    ).rejects.toThrow(CorpusSelectionError);
    await expect(
      loadCorpusMessages(SAMPLE_CORPUS_DIR, {
        accountIds: [7] as unknown as readonly string[],
      }),
    ).rejects.toThrow(CorpusSelectionError);
  });

  it("breaks ts ties by id, deciding which row a cap releases", async () => {
    tempDir = await writeShards({
      "gmail/home/2025-03.jsonl": [
        row({ id: "zzz-home-row", accountId: "home", ts: MARCH }),
      ],
      "gmail/work/2025-03.jsonl": [row({ id: "aaa-work-row", ts: MARCH })],
    });
    const all = await loadCorpusMessages(tempDir);
    expect(all.messages.map((m) => m.id)).toEqual([
      "aaa-work-row",
      "zzz-home-row",
    ]);
    // Without the id tiebreak the cap would keep whichever shard was walked
    // first, so identical corpora could seed different mocks.
    const capped = await loadCorpusMessages(tempDir, { maxMessages: 1 });
    expect(capped.messages.map((m) => m.id)).toEqual(["aaa-work-row"]);
  });

  it("drops replyToId when selection did not release the parent", async () => {
    tempDir = await writeShards({
      "gmail/work/2025-03.jsonl": [
        row({ id: "parent", ts: MARCH, scrubState: "raw" }),
        row({ id: "child", ts: MARCH + 1_000, replyToId: "parent" }),
      ],
    });
    const gated = await loadCorpusMessages(tempDir);
    expect(gated.belowScrubFloor).toBe(1);
    expect(gated.messages.map((m) => m.id)).toEqual(["child"]);
    expect(gated.messages[0]?.replyToId).toBeUndefined();

    // The handle survives whenever the parent is actually released.
    const loosened = await loadCorpusMessages(tempDir, {
      minScrubState: "raw",
    });
    expect(loosened.messages.map((m) => m.replyToId)).toEqual([
      undefined,
      "parent",
    ]);
  });

  it("rejects malformed numeric selection bounds at the boundary", async () => {
    await expect(
      loadCorpusMessages(SAMPLE_CORPUS_DIR, { maxMessages: -1 }),
    ).rejects.toThrow(CorpusSelectionError);
    await expect(
      loadCorpusMessages(SAMPLE_CORPUS_DIR, { maxMessages: Number.NaN }),
    ).rejects.toThrow(CorpusSelectionError);
    await expect(
      loadCorpusMessages(SAMPLE_CORPUS_DIR, { fromTs: 2, toTs: 1 }),
    ).rejects.toThrow(CorpusSelectionError);
    await expect(
      loadCorpusMessages(SAMPLE_CORPUS_DIR, {
        fromTs: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow(CorpusSelectionError);
  });
});
