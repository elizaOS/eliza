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
import { CorpusLoadError, loadCorpusMessages } from "./loader.ts";

const SAMPLE_CORPUS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/sample-corpus",
);

let tempDir: string | null = null;

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
});
