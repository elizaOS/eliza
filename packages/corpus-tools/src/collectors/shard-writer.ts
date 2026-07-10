/**
 * Month-sharded JSONL writer for collector output. Collectors emit validated
 * `CorpusMessage` rows; this module lays them out on disk exactly as
 * `validator.ts` expects to read them back — `<root>/<platform>/<account>/<yyyy-mm>.jsonl`,
 * one JSON object per line, sorted by `(ts, id)` — so a collect run and a later
 * `corpus validate` agree on shape, path, and hash without a second contract.
 *
 * Writes merge into existing shards on resume: a re-run appends only rows whose
 * id is not already present, keeping the output idempotent so an interrupted
 * 2-year backfill can be restarted without duplicating or dropping messages.
 * Every row is schema-validated before it is written — a collector cannot emit
 * an off-contract message and have it surface only later at validate time.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type CorpusMessage,
  type CorpusPlatform,
  corpusMessageSchema,
} from "../schema.ts";

export interface ShardWriteSummary {
  shardsWritten: number;
  /** Total rows present across the written shards after the merge. */
  messagesWritten: number;
  /** Rows whose id was not already on disk — the true new-message count. */
  messagesAdded: number;
  paths: string[];
}

function monthKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortMessages(messages: CorpusMessage[]): CorpusMessage[] {
  return [...messages].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}

async function readExistingShard(file: string): Promise<CorpusMessage[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => corpusMessageSchema.parse(JSON.parse(line)));
}

/**
 * Write `messages` into month shards under `rootDir`, merging with any rows
 * already on disk for the same account/month. Each incoming row is validated
 * against the corpus schema first; a row on the wrong platform/account for its
 * requested shard is rejected here rather than corrupting the layout the
 * validator derives platform/account from.
 */
export async function writeShards(
  rootDir: string,
  platform: CorpusPlatform,
  accountId: string,
  messages: CorpusMessage[],
): Promise<ShardWriteSummary> {
  const byMonth = new Map<string, Map<string, CorpusMessage>>();

  for (const raw of messages) {
    const message = corpusMessageSchema.parse(raw);
    if (message.platform !== platform || message.accountId !== accountId) {
      throw new Error(
        `message ${message.id} platform/account (${message.platform}/${message.accountId}) does not match shard target ${platform}/${accountId}`,
      );
    }
    const month = monthKey(message.ts);
    const bucket = byMonth.get(month) ?? new Map<string, CorpusMessage>();
    bucket.set(message.id, message);
    byMonth.set(month, bucket);
  }

  const summary: ShardWriteSummary = {
    shardsWritten: 0,
    messagesWritten: 0,
    messagesAdded: 0,
    paths: [],
  };

  for (const [month, incoming] of [...byMonth.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const file = path.join(rootDir, platform, accountId, `${month}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });

    const merged = new Map<string, CorpusMessage>();
    for (const existing of await readExistingShard(file)) {
      merged.set(existing.id, existing);
    }
    for (const [id, message] of incoming) {
      if (!merged.has(id)) summary.messagesAdded += 1;
      merged.set(id, message);
    }

    const rows = sortMessages([...merged.values()]);
    const body = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, file);

    summary.shardsWritten += 1;
    summary.messagesWritten += rows.length;
    summary.paths.push(file);
  }

  return summary;
}

/**
 * Content hash of a shard file, matching `validator.ts`'s hash of the raw
 * bytes. Exposed so a collector can report a manifest-style digest for its
 * output without re-reading and re-serializing rows.
 */
export async function shardSha256(file: string): Promise<string> {
  return sha256(await fs.readFile(file, "utf8"));
}
