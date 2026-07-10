/**
 * Shard-writer tests. Proves collector output lands in the exact
 * <platform>/<account>/<yyyy-mm>.jsonl layout the validator reads back, merges
 * idempotently on rerun (new-count accurate, no duplicates), splits across
 * months, rejects cross-account rows, and passes a full `validateCorpusTarget`
 * round-trip against real files on disk.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CORPUS_CUTOFF_MS, type CorpusMessage } from "../schema.ts";
import { validateCorpusTarget } from "../validator.ts";
import { writeShards } from "./shard-writer.ts";

const JULY = Date.parse("2024-07-10T12:00:00.000Z");
const AUGUST = Date.parse("2024-08-02T09:00:00.000Z");

function message(id: string, ts: number): CorpusMessage {
  return {
    id: `signal:primary:${id}`,
    platform: "signal",
    accountId: "primary",
    threadId: "signal:primary:conv-1",
    ts,
    direction: "in",
    senderId: "peer",
    senderDisplay: "Peer",
    recipients: [{ id: "owner" }],
    text: `body ${id}`,
    labels: [],
    attachments: [],
    scrubState: "raw",
  };
}

async function outDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "signal-shards-"));
}

describe("writeShards", () => {
  it("writes month shards in the validator layout and validates", async () => {
    const dir = await outDir();
    const summary = await writeShards(dir, "signal", "primary", [
      message("m1", JULY),
      message("m2", JULY + 1000),
      message("m3", AUGUST),
    ]);
    expect(summary.shardsWritten).toBe(2);
    expect(summary.messagesAdded).toBe(3);
    expect(summary.paths).toContain(
      path.join(dir, "signal", "primary", "2024-07.jsonl"),
    );

    const validation = await validateCorpusTarget(dir);
    expect(validation.ok).toBe(true);
    expect(validation.manifest.totals.messages).toBe(3);
  });

  it("is idempotent on rerun and reports only newly added rows", async () => {
    const dir = await outDir();
    await writeShards(dir, "signal", "primary", [
      message("m1", JULY),
      message("m2", JULY + 1000),
    ]);
    const second = await writeShards(dir, "signal", "primary", [
      message("m2", JULY + 1000),
      message("m3", JULY + 2000),
    ]);
    expect(second.messagesAdded).toBe(1);

    const shard = await readFile(
      path.join(dir, "signal", "primary", "2024-07.jsonl"),
      "utf8",
    );
    const ids = shard
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).id);
    expect(ids).toEqual([
      "signal:primary:m1",
      "signal:primary:m2",
      "signal:primary:m3",
    ]);
  });

  it("rejects a row that does not belong to the shard target", async () => {
    const dir = await outDir();
    const foreign = { ...message("x", JULY), accountId: "secondary" };
    await expect(
      writeShards(dir, "signal", "primary", [foreign]),
    ).rejects.toThrow(/does not match shard target/);
  });

  it("rejects an off-cutoff row via schema validation", async () => {
    const dir = await outDir();
    const tooOld = { ...message("old", CORPUS_CUTOFF_MS - 1) };
    await expect(
      writeShards(dir, "signal", "primary", [tooOld]),
    ).rejects.toThrow();
  });
});
