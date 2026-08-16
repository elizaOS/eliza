/**
 * Official X data-archive collector: parses `data/tweets*.js`,
 * `data/direct-messages*.js`, and `data/like*.js` out of the archive ZIP (or an
 * already-extracted directory), strips the `window.YTD.<name>.partN =` script
 * prefix, filters rows before the corpus cutoff, and writes validated,
 * idempotently resumable monthly `CorpusMessage` JSONL shards plus the canonical
 * corpus manifest and an x-archive summary with tweet/DM-conversation counts.
 *
 * Tweets map to direction "out" with the thread id resolved to the reply-chain
 * root within the archive; DMs map per conversation with direction derived from
 * senderId versus the owner id. Likes carry no timestamps in the archive, so
 * they are counted in the summary but never fabricated into message rows.
 * Raw archives belong under the gitignored `data/` tree; only synthetic
 * fixtures are committed.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { unzipSync } from "fflate";
import {
  CORPUS_CUTOFF_MS,
  type CorpusManifest,
  type CorpusMessage,
  corpusMessageSchema,
} from "../schema.ts";
import {
  buildCorpusManifest,
  type CorpusValidationIssue,
} from "../validator.ts";

export interface XArchiveCollectorOptions {
  /** Path to the official archive ZIP or an extracted archive directory. */
  archivePath: string;
  /** The numeric X account id of the archive owner (accountId + tweet sender). */
  ownerAccountId: string;
  /** Display name recorded for owner-authored rows; defaults to the owner id. */
  ownerDisplay?: string;
  /** Root the `x/<owner>/<yyyy-mm>.jsonl` shard tree is written under. */
  outDir: string;
  /** Inclusive minimum timestamp; defaults to the corpus cutoff. */
  cutoffMs?: number;
}

export interface XArchiveSummary {
  tweetCount: number;
  dmMessageCount: number;
  dmConversationCount: number;
  likeCount: number;
  skippedBeforeCutoff: number;
  skippedInvalid: number;
  shardsWritten: number;
  shardsReused: number;
}

export interface XArchiveCollectResult {
  summary: XArchiveSummary;
  manifest: CorpusManifest;
  issues: CorpusValidationIssue[];
  shardPaths: string[];
}

interface ArchiveFileSource {
  /** Archive-relative candidate lookup by prefix, e.g. `data/tweets`. */
  readPart: (baseName: string) => Promise<{ name: string; text: string }[]>;
}

const YTD_PREFIX = /^\s*window\.YTD\.[\w-]+\.part\d+\s*=\s*/;

function stripYtdPrefix(fileName: string, raw: string): string {
  if (!YTD_PREFIX.test(raw)) {
    throw new ElizaError(
      `X archive file ${fileName} lacks the window.YTD prefix`,
      {
        code: "X_ARCHIVE_BAD_PREFIX",
        context: { fileName },
      },
    );
  }
  return raw.replace(YTD_PREFIX, "");
}

function parseYtdJson(fileName: string, raw: string): unknown[] {
  const body = stripYtdPrefix(fileName, raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    // error-policy:J2 wrap untrusted archive JSON failure with file context.
    throw new ElizaError(`X archive file ${fileName} is not valid JSON`, {
      code: "X_ARCHIVE_BAD_JSON",
      context: { fileName },
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new ElizaError(`X archive file ${fileName} is not a JSON array`, {
      code: "X_ARCHIVE_BAD_JSON",
      context: { fileName },
    });
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

async function openArchive(archivePath: string): Promise<ArchiveFileSource> {
  const stat = await fs.stat(archivePath);
  if (stat.isDirectory()) {
    const dataDir = path.join(archivePath, "data");
    return {
      async readPart(baseName) {
        const entries = await fs.readdir(dataDir);
        const wanted = entries
          .filter((name) => matchesPart(name, baseName))
          .sort();
        const out: { name: string; text: string }[] = [];
        for (const name of wanted) {
          out.push({
            name: `data/${name}`,
            text: await fs.readFile(path.join(dataDir, name), "utf8"),
          });
        }
        return out;
      },
    };
  }
  const bytes = await fs.readFile(archivePath);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(bytes), {
      filter: (file) =>
        file.name.startsWith("data/") && file.name.endsWith(".js"),
    });
  } catch (error) {
    // error-policy:J2 wrap fflate's untyped failure with the archive path.
    throw new ElizaError(`failed to read X archive ZIP ${archivePath}`, {
      code: "X_ARCHIVE_BAD_ZIP",
      context: { archivePath },
      cause: error,
    });
  }
  const decoder = new TextDecoder();
  return {
    async readPart(baseName) {
      return Object.keys(files)
        .filter((name) => matchesPart(path.posix.basename(name), baseName))
        .sort()
        .map((name) => ({ name, text: decoder.decode(files[name]) }));
    },
  };
}

/** Matches `tweets.js`, `tweets-part1.js`, ... for baseName `tweets`. */
function matchesPart(fileName: string, baseName: string): boolean {
  return new RegExp(`^${baseName}(-part\\d+)?\\.js$`).test(fileName);
}

interface RawTweet {
  id: string;
  ts: number;
  text: string;
  replyToStatusId?: string;
  replyToUserId?: string;
}

function extractTweets(rows: unknown[], fileName: string): RawTweet[] {
  const tweets: RawTweet[] = [];
  for (const row of rows) {
    if (!isRecord(row) || !isRecord(row.tweet)) continue;
    const tweet = row.tweet;
    const id = readString(tweet.id_str) ?? readString(tweet.id);
    const createdAt = readString(tweet.created_at);
    const text = readString(tweet.full_text) ?? readString(tweet.text);
    if (!id || !createdAt || !text) continue;
    const ts = Date.parse(createdAt);
    if (Number.isNaN(ts)) {
      throw new ElizaError(`unparseable tweet created_at in ${fileName}`, {
        code: "X_ARCHIVE_BAD_TIMESTAMP",
        context: { fileName, id, createdAt },
      });
    }
    tweets.push({
      id,
      ts,
      text,
      replyToStatusId: readString(tweet.in_reply_to_status_id_str),
      replyToUserId: readString(tweet.in_reply_to_user_id_str),
    });
  }
  return tweets;
}

/**
 * Resolves each tweet's thread id to the root of its reply chain, following
 * parents that exist in the archive and falling back to the referenced parent
 * id when the chain leaves the archive (partial conversation).
 */
function resolveThreadId(tweet: RawTweet, byId: Map<string, RawTweet>): string {
  let current = tweet;
  const seen = new Set<string>([current.id]);
  while (current.replyToStatusId) {
    const parent = byId.get(current.replyToStatusId);
    if (!parent || seen.has(parent.id)) return current.replyToStatusId;
    seen.add(parent.id);
    current = parent;
  }
  return current.id;
}

interface CollectContext {
  options: Required<
    Pick<XArchiveCollectorOptions, "ownerAccountId" | "cutoffMs">
  > & {
    ownerDisplay: string;
  };
  summary: XArchiveSummary;
  /** Conversation ids seen across all direct-message parts. */
  dmConversationIds: Set<string>;
}

function mapTweets(tweets: RawTweet[], ctx: CollectContext): CorpusMessage[] {
  const byId = new Map(tweets.map((tweet) => [tweet.id, tweet]));
  const surviving = new Set(
    tweets.filter((tweet) => tweet.ts >= ctx.options.cutoffMs).map((t) => t.id),
  );
  const messages: CorpusMessage[] = [];
  for (const tweet of tweets) {
    if (tweet.ts < ctx.options.cutoffMs) {
      ctx.summary.skippedBeforeCutoff += 1;
      continue;
    }
    // replyToId is only recorded when the parent lands in the same monthly
    // shard: the shard validator resolves reply references per shard, and a
    // cross-shard reference would make an otherwise-valid shard fail closed.
    const parent = tweet.replyToStatusId
      ? byId.get(tweet.replyToStatusId)
      : undefined;
    const parentInCorpus =
      parent !== undefined &&
      surviving.has(parent.id) &&
      monthOf(parent.ts) === monthOf(tweet.ts);
    messages.push(
      corpusMessageSchema.parse({
        id: `x:tweet:${tweet.id}`,
        platform: "x",
        accountId: ctx.options.ownerAccountId,
        threadId: `x:thread:${resolveThreadId(tweet, byId)}`,
        ts: tweet.ts,
        direction: "out",
        senderId: ctx.options.ownerAccountId,
        senderDisplay: ctx.options.ownerDisplay,
        recipients: tweet.replyToUserId ? [{ id: tweet.replyToUserId }] : [],
        text: tweet.text,
        labels: ["x:tweet"],
        attachments: [],
        ...(parentInCorpus
          ? { replyToId: `x:tweet:${tweet.replyToStatusId}` }
          : {}),
        scrubState: "raw",
      }),
    );
    ctx.summary.tweetCount += 1;
  }
  return messages;
}

function mapDms(
  rows: unknown[],
  fileName: string,
  ctx: CollectContext,
): CorpusMessage[] {
  const messages: CorpusMessage[] = [];
  for (const row of rows) {
    if (!isRecord(row) || !isRecord(row.dmConversation)) continue;
    const conversation = row.dmConversation;
    const conversationId = readString(conversation.conversationId);
    if (!conversationId || !Array.isArray(conversation.messages)) continue;
    let counted = false;
    for (const entry of conversation.messages) {
      if (!isRecord(entry) || !isRecord(entry.messageCreate)) continue;
      const dm = entry.messageCreate;
      const id = readString(dm.id);
      const senderId = readString(dm.senderId);
      const recipientId = readString(dm.recipientId);
      const text = readString(dm.text);
      const createdAt = readString(dm.createdAt);
      if (!id || !senderId || !text || !createdAt) {
        ctx.summary.skippedInvalid += 1;
        continue;
      }
      const ts = Date.parse(createdAt);
      if (Number.isNaN(ts)) {
        throw new ElizaError(`unparseable DM createdAt in ${fileName}`, {
          code: "X_ARCHIVE_BAD_TIMESTAMP",
          context: { fileName, id, createdAt },
        });
      }
      if (ts < ctx.options.cutoffMs) {
        ctx.summary.skippedBeforeCutoff += 1;
        continue;
      }
      const outbound = senderId === ctx.options.ownerAccountId;
      messages.push(
        corpusMessageSchema.parse({
          id: `x:dm:${id}`,
          platform: "x",
          accountId: ctx.options.ownerAccountId,
          threadId: `x:dm-conversation:${conversationId}`,
          ts,
          direction: outbound ? "out" : "in",
          senderId,
          senderDisplay: outbound ? ctx.options.ownerDisplay : senderId,
          recipients: recipientId ? [{ id: recipientId }] : [],
          text,
          labels: ["x:dm"],
          attachments: [],
          scrubState: "raw",
        }),
      );
      ctx.summary.dmMessageCount += 1;
      counted = true;
    }
    if (counted) ctx.dmConversationIds.add(conversationId);
  }
  ctx.summary.dmConversationCount = ctx.dmConversationIds.size;
  return messages;
}

function countLikes(rows: unknown[]): number {
  return rows.filter((row) => isRecord(row) && isRecord(row.like)).length;
}

function monthOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Writes monthly shards under `<outDir>/x/<owner>/`. A shard whose bytes
 * already match on disk is left untouched, which makes interrupted runs
 * resumable by simply re-running the collector.
 */
async function writeShards(
  messages: CorpusMessage[],
  outDir: string,
  ownerAccountId: string,
  summary: XArchiveSummary,
): Promise<string[]> {
  const byMonth = new Map<string, CorpusMessage[]>();
  for (const message of messages) {
    const month = monthOf(message.ts);
    const bucket = byMonth.get(month) ?? [];
    bucket.push(message);
    byMonth.set(month, bucket);
  }
  const shardDir = path.join(outDir, "x", ownerAccountId);
  await fs.mkdir(shardDir, { recursive: true });
  const written: string[] = [];
  for (const [month, bucket] of [...byMonth.entries()].sort()) {
    bucket.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    const body = `${bucket.map((message) => JSON.stringify(message)).join("\n")}\n`;
    const shardPath = path.join(shardDir, `${month}.jsonl`);
    let existing: string | undefined;
    try {
      existing = await fs.readFile(shardPath, "utf8");
    } catch {
      // error-policy:J3 a missing shard is the expected fresh-run state.
      existing = undefined;
    }
    if (existing !== undefined && sha256Hex(existing) === sha256Hex(body)) {
      summary.shardsReused += 1;
    } else {
      const tmpPath = `${shardPath}.tmp`;
      await fs.writeFile(tmpPath, body, "utf8");
      await fs.rename(tmpPath, shardPath);
      summary.shardsWritten += 1;
    }
    written.push(shardPath);
  }
  return written;
}

/**
 * Collects the official X archive at `archivePath` into validated monthly
 * `CorpusMessage` shards plus `manifest.json` and `x-archive-summary.json`
 * under `outDir`. Throws `ElizaError` on malformed archive input; validation
 * findings on the written corpus are returned as `issues`.
 */
export async function collectXArchive(
  options: XArchiveCollectorOptions,
): Promise<XArchiveCollectResult> {
  const source = await openArchive(options.archivePath);
  const ctx: CollectContext = {
    options: {
      ownerAccountId: options.ownerAccountId,
      ownerDisplay: options.ownerDisplay ?? options.ownerAccountId,
      cutoffMs: options.cutoffMs ?? CORPUS_CUTOFF_MS,
    },
    summary: {
      tweetCount: 0,
      dmMessageCount: 0,
      dmConversationCount: 0,
      likeCount: 0,
      skippedBeforeCutoff: 0,
      skippedInvalid: 0,
      shardsWritten: 0,
      shardsReused: 0,
    },
    dmConversationIds: new Set<string>(),
  };

  const tweetParts = await source.readPart("tweets");
  if (tweetParts.length === 0) {
    throw new ElizaError("X archive has no data/tweets.js", {
      code: "X_ARCHIVE_MISSING_FILE",
      context: { archivePath: options.archivePath, file: "data/tweets.js" },
    });
  }
  const tweets = tweetParts.flatMap((part) =>
    extractTweets(parseYtdJson(part.name, part.text), part.name),
  );
  const messages = mapTweets(tweets, ctx);

  for (const part of await source.readPart("direct-messages")) {
    messages.push(
      ...mapDms(parseYtdJson(part.name, part.text), part.name, ctx),
    );
  }
  for (const part of await source.readPart("like")) {
    ctx.summary.likeCount += countLikes(parseYtdJson(part.name, part.text));
  }

  const shardPaths = await writeShards(
    messages,
    options.outDir,
    ctx.options.ownerAccountId,
    ctx.summary,
  );

  const { manifest, issues } = await buildCorpusManifest(options.outDir);
  await fs.writeFile(
    path.join(options.outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(options.outDir, "x-archive-summary.json"),
    `${JSON.stringify(ctx.summary, null, 2)}\n`,
    "utf8",
  );
  return { summary: ctx.summary, manifest, issues, shardPaths };
}
