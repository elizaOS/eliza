/**
 * Account-scoped Gmail backfill into canonical monthly corpus shards. The
 * Google plugin owns OAuth and API DTOs; this module owns resumable pagination,
 * idempotent local persistence, corpus normalization, and manifest production.
 * Raw owner mail remains below the caller-provided ignored data directory.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type {
  GoogleAccountRef,
  GoogleGmailExportMessage,
  GoogleGmailMessagePage,
  GoogleGmailProfile,
} from "@elizaos/plugin-google";
import { z } from "zod";
import {
  CORPUS_ANCHOR_MS,
  CORPUS_CUTOFF_MS,
  type CorpusManifest,
  type CorpusMessage,
  corpusMessageSchema,
} from "../schema.ts";
import {
  buildCorpusManifest,
  findCorpusShardFiles,
  readCorpusShard,
} from "../validator.ts";

// Gmail interprets yyyy/mm/dd searches in Pacific time. Epoch seconds keep the
// frozen UTC corpus window exact across owner and runner timezones.
const DEFAULT_QUERY = `after:${Math.floor(CORPUS_CUTOFF_MS / 1000) - 1} before:${Math.floor(CORPUS_ANCHOR_MS / 1000) + 1}`;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_FETCH_CONCURRENCY = 8;

const checkpointSchema = z.object({
  schemaVersion: z.literal(1),
  accountId: z.string().min(1),
  ownerEmail: z.string().email(),
  query: z.string().min(1),
  pageToken: z.string().min(1).optional(),
  startHistoryId: z.string().min(1).optional(),
  completedHistoryId: z.string().min(1).optional(),
  processedMessages: z.number().int().nonnegative(),
  completed: z.boolean(),
  updatedAt: z.string().datetime(),
});

type GmailCollectorCheckpoint = z.infer<typeof checkpointSchema>;

export interface GmailCorpusSource {
  getGmailProfile(params: GoogleAccountRef): Promise<GoogleGmailProfile>;
  listGmailMessagePage(
    params: GoogleAccountRef & {
      query: string;
      pageToken?: string;
      maxResults?: number;
      includeSpamTrash?: boolean;
    },
  ): Promise<GoogleGmailMessagePage>;
  getGmailExportMessage(
    params: GoogleAccountRef & {
      messageId: string;
      includeAttachmentData?: boolean;
    },
  ): Promise<GoogleGmailExportMessage>;
}

export interface GmailCorpusAccount {
  accountId: string;
  ownerEmail?: string;
}

export interface CollectGmailCorpusOptions {
  source: GmailCorpusSource;
  accounts: GmailCorpusAccount[];
  outputDir: string;
  stateDir?: string;
  query?: string;
  pageSize?: number;
  fetchConcurrency?: number;
  includeAttachmentData?: boolean;
  now?: () => Date;
}

export interface GmailCorpusAccountResult {
  accountId: string;
  ownerEmail: string;
  processedMessages: number;
  writtenMessages: number;
  duplicateMessages: number;
  completed: boolean;
  monthCounts: Record<string, number>;
}

export interface GmailCorpusCollectionResult {
  query: string;
  accounts: GmailCorpusAccountResult[];
  manifest: CorpusManifest;
}

export async function collectGmailCorpusFromRuntime(
  runtime: IAgentRuntime,
  options: Omit<CollectGmailCorpusOptions, "source">,
): Promise<GmailCorpusCollectionResult> {
  const service = runtime.getService("google");
  if (!isGmailCorpusSource(service)) {
    throw new ElizaError(
      "Google Workspace service with Gmail export methods is not loaded.",
      { code: "GMAIL_CORPUS_SERVICE_UNAVAILABLE", severity: "fatal" },
    );
  }
  return collectGmailCorpus({ ...options, source: service });
}

export async function collectGmailCorpus(
  options: CollectGmailCorpusOptions,
): Promise<GmailCorpusCollectionResult> {
  if (options.accounts.length < 1) {
    throw new ElizaError("At least one Gmail account is required.", {
      code: "GMAIL_CORPUS_ACCOUNTS_REQUIRED",
      severity: "fatal",
    });
  }
  const accountIds = new Set<string>();
  for (const account of options.accounts) {
    assertAccountPathSegment(account.accountId);
    if (accountIds.has(account.accountId)) {
      throw new ElizaError(`Duplicate Gmail account ${account.accountId}.`, {
        code: "GMAIL_CORPUS_DUPLICATE_ACCOUNT",
        context: { accountId: account.accountId },
        severity: "fatal",
      });
    }
    accountIds.add(account.accountId);
  }

  const query = options.query?.trim() || DEFAULT_QUERY;
  const stateDir = options.stateDir ?? path.join(options.outputDir, ".state");
  const now = options.now ?? (() => new Date());
  await fs.mkdir(options.outputDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  const accountResults: GmailCorpusAccountResult[] = [];

  for (const account of options.accounts) {
    accountResults.push(
      await collectAccount({
        ...options,
        account,
        query,
        stateDir,
        now,
      }),
    );
  }

  const generatedAt = now().toISOString();
  const { manifest, issues } = await buildCorpusManifest(
    options.outputDir,
    generatedAt,
  );
  if (issues.length > 0) {
    throw new ElizaError(
      `Gmail collection produced an invalid corpus: ${issues
        .map((issue) => issue.message)
        .join("; ")}`,
      {
        code: "GMAIL_CORPUS_VALIDATION_FAILED",
        context: { issueCount: issues.length },
        severity: "fatal",
      },
    );
  }
  await writeJsonAtomic(
    path.join(options.outputDir, "manifest.json"),
    manifest,
  );
  return { query, accounts: accountResults, manifest };
}

async function collectAccount(
  options: CollectGmailCorpusOptions & {
    account: GmailCorpusAccount;
    query: string;
    stateDir: string;
    now: () => Date;
  },
): Promise<GmailCorpusAccountResult> {
  const checkpointPath = path.join(
    options.stateDir,
    `gmail-${options.account.accountId}.json`,
  );
  const existingCheckpoint = await readCheckpoint(checkpointPath);
  if (
    existingCheckpoint &&
    (existingCheckpoint.accountId !== options.account.accountId ||
      existingCheckpoint.query !== options.query)
  ) {
    throw new ElizaError(
      `Gmail checkpoint ${checkpointPath} belongs to a different account or query.`,
      {
        code: "GMAIL_CORPUS_CHECKPOINT_MISMATCH",
        context: {
          accountId: options.account.accountId,
          checkpointPath,
        },
        severity: "fatal",
      },
    );
  }

  const existing = await loadExistingAccountMessages(
    options.outputDir,
    options.account.accountId,
  );
  if (existingCheckpoint?.completed) {
    return accountResult(existingCheckpoint, existing, 0, 0);
  }

  const profile = await options.source.getGmailProfile({
    accountId: options.account.accountId,
  });
  const ownerEmail = normalizeEmail(
    options.account.ownerEmail ?? profile.emailAddress,
  );
  const checkpoint: GmailCollectorCheckpoint = existingCheckpoint ?? {
    schemaVersion: 1,
    accountId: options.account.accountId,
    ownerEmail,
    query: options.query,
    startHistoryId: profile.historyId,
    processedMessages: 0,
    completed: false,
    updatedAt: options.now().toISOString(),
  };
  if (checkpoint.ownerEmail !== ownerEmail) {
    throw new ElizaError(
      `Gmail checkpoint owner ${checkpoint.ownerEmail} does not match ${ownerEmail}.`,
      {
        code: "GMAIL_CORPUS_OWNER_MISMATCH",
        context: {
          accountId: options.account.accountId,
          checkpointOwnerEmail: checkpoint.ownerEmail,
          ownerEmail,
        },
        severity: "fatal",
      },
    );
  }

  let writtenMessages = 0;
  let duplicateMessages = 0;
  let pageToken = checkpoint.pageToken;
  while (true) {
    const page = await options.source.listGmailMessagePage({
      accountId: options.account.accountId,
      query: options.query,
      pageToken,
      maxResults: normalizedPositiveInteger(
        options.pageSize,
        DEFAULT_PAGE_SIZE,
        DEFAULT_PAGE_SIZE,
      ),
      includeSpamTrash: true,
    });
    const messages = await mapWithConcurrency(
      page.messageIds,
      normalizedPositiveInteger(
        options.fetchConcurrency,
        DEFAULT_FETCH_CONCURRENCY,
        32,
      ),
      async (messageId) =>
        options.source.getGmailExportMessage({
          accountId: options.account.accountId,
          messageId,
          includeAttachmentData: options.includeAttachmentData,
        }),
    );
    const changedMonths = new Set<string>();
    for (const exported of messages) {
      const normalized = normalizeGmailMessage(
        exported,
        options.account.accountId,
        ownerEmail,
      );
      const current = existing.byId.get(normalized.id);
      if (current) {
        if (JSON.stringify(current) !== JSON.stringify(normalized)) {
          throw new ElizaError(
            `Gmail message ${normalized.id} changed after it was persisted.`,
            {
              code: "GMAIL_CORPUS_MESSAGE_CHANGED",
              context: {
                accountId: options.account.accountId,
                messageId: normalized.id,
              },
              severity: "fatal",
            },
          );
        }
        duplicateMessages += 1;
        continue;
      }
      const month = monthFor(normalized.ts);
      const shard = existing.byMonth.get(month) ?? [];
      shard.push(normalized);
      existing.byMonth.set(month, shard);
      existing.byId.set(normalized.id, normalized);
      changedMonths.add(month);
      writtenMessages += 1;
    }
    for (const month of changedMonths) {
      await writeShard(
        options.outputDir,
        options.account.accountId,
        month,
        existing.byMonth.get(month) ?? [],
      );
    }

    if (page.nextPageToken && page.nextPageToken === pageToken) {
      throw new ElizaError(
        `Gmail account ${options.account.accountId} returned a repeated page token.`,
        {
          code: "GMAIL_CORPUS_REPEATED_PAGE_TOKEN",
          context: {
            accountId: options.account.accountId,
            pageToken,
          },
          severity: "fatal",
        },
      );
    }

    checkpoint.processedMessages += page.messageIds.length;
    checkpoint.pageToken = page.nextPageToken;
    checkpoint.completed = !page.nextPageToken;
    checkpoint.completedHistoryId = checkpoint.completed
      ? profile.historyId
      : undefined;
    checkpoint.updatedAt = options.now().toISOString();
    await writeJsonAtomic(checkpointPath, checkpoint);
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  return accountResult(
    checkpoint,
    existing,
    writtenMessages,
    duplicateMessages,
  );
}

function isGmailCorpusSource(value: unknown): value is GmailCorpusSource {
  if (value === null || typeof value !== "object") return false;
  return (
    "getGmailProfile" in value &&
    typeof value.getGmailProfile === "function" &&
    "listGmailMessagePage" in value &&
    typeof value.listGmailMessagePage === "function" &&
    "getGmailExportMessage" in value &&
    typeof value.getGmailExportMessage === "function"
  );
}

function normalizeGmailMessage(
  message: GoogleGmailExportMessage,
  accountId: string,
  ownerEmail: string,
): CorpusMessage {
  if (
    message.internalDateMs < CORPUS_CUTOFF_MS ||
    message.internalDateMs > CORPUS_ANCHOR_MS
  ) {
    throw new ElizaError(
      `Gmail message ${message.id} is outside the corpus window.`,
      {
        code: "GMAIL_CORPUS_MESSAGE_OUTSIDE_WINDOW",
        context: { messageId: message.id, timestamp: message.internalDateMs },
        severity: "fatal",
      },
    );
  }
  const senderEmail = message.from?.email
    ? normalizeEmail(message.from.email)
    : undefined;
  if (!senderEmail) {
    throw new ElizaError(`Gmail message ${message.id} has no From address.`, {
      code: "GMAIL_CORPUS_MESSAGE_SENDER_MISSING",
      context: { messageId: message.id },
      severity: "fatal",
    });
  }
  const direction = senderEmail === ownerEmail ? "out" : "in";
  const recipients = [...(message.to ?? []), ...(message.cc ?? [])].map(
    (recipient) => ({
      id: normalizeEmail(recipient.email),
      display: recipient.name?.trim() || undefined,
      address: normalizeEmail(recipient.email),
    }),
  );
  const text = message.bodyText ?? htmlToText(message.bodyHtml ?? "");
  return corpusMessageSchema.parse({
    id: message.id,
    platform: "gmail",
    accountId,
    threadId: message.threadId,
    ts: message.internalDateMs,
    direction,
    senderId: senderEmail,
    senderDisplay: message.from?.name?.trim() || senderEmail,
    recipients,
    subject: message.subject?.trim() || undefined,
    text,
    snippet: message.snippet?.trim() || undefined,
    labels: message.labelIds ?? [],
    attachments: message.attachments,
    scrubState: "raw",
  });
}

async function loadExistingAccountMessages(
  outputDir: string,
  accountId: string,
): Promise<{
  byId: Map<string, CorpusMessage>;
  byMonth: Map<string, CorpusMessage[]>;
}> {
  const accountDir = path.join(outputDir, "gmail", accountId);
  const byId = new Map<string, CorpusMessage>();
  const byMonth = new Map<string, CorpusMessage[]>();
  if (!(await pathExists(accountDir))) return { byId, byMonth };
  for (const file of await findCorpusShardFiles(accountDir)) {
    const shard = await readCorpusShard(file, { rootDir: outputDir });
    if (shard.issues.length > 0) {
      throw new ElizaError(
        `Existing Gmail shard ${file} is invalid: ${shard.issues
          .map((issue) => issue.message)
          .join("; ")}`,
        {
          code: "GMAIL_CORPUS_EXISTING_SHARD_INVALID",
          context: { file, issueCount: shard.issues.length },
          severity: "fatal",
        },
      );
    }
    const month = path.basename(file, ".jsonl");
    byMonth.set(month, shard.messages);
    for (const message of shard.messages) {
      if (byId.has(message.id)) {
        throw new ElizaError(
          `Existing Gmail corpus duplicates ${message.id}.`,
          {
            code: "GMAIL_CORPUS_EXISTING_DUPLICATE",
            context: { messageId: message.id },
            severity: "fatal",
          },
        );
      }
      byId.set(message.id, message);
    }
  }
  return { byId, byMonth };
}

async function readCheckpoint(
  checkpointPath: string,
): Promise<GmailCollectorCheckpoint | undefined> {
  if (!(await pathExists(checkpointPath))) return undefined;
  return checkpointSchema.parse(
    JSON.parse(await fs.readFile(checkpointPath, "utf8")),
  );
}

async function writeShard(
  outputDir: string,
  accountId: string,
  month: string,
  messages: CorpusMessage[],
): Promise<void> {
  const shardPath = path.join(outputDir, "gmail", accountId, `${month}.jsonl`);
  await fs.mkdir(path.dirname(shardPath), { recursive: true });
  const ordered = [...messages].sort(
    (left, right) => left.ts - right.ts || left.id.localeCompare(right.id),
  );
  await writeTextAtomic(
    shardPath,
    `${ordered.map((message) => JSON.stringify(message)).join("\n")}\n`,
  );
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(filePath: string, value: string): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    // error-policy:J3 filesystem existence is an explicit valid/absent probe.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function accountResult(
  checkpoint: GmailCollectorCheckpoint,
  existing: { byMonth: Map<string, CorpusMessage[]> },
  writtenMessages: number,
  duplicateMessages: number,
): GmailCorpusAccountResult {
  return {
    accountId: checkpoint.accountId,
    ownerEmail: checkpoint.ownerEmail,
    processedMessages: checkpoint.processedMessages,
    writtenMessages,
    duplicateMessages,
    completed: checkpoint.completed,
    monthCounts: Object.fromEntries(
      [...existing.byMonth.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([month, messages]) => [month, messages.length]),
    ),
  };
}

function assertAccountPathSegment(accountId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(accountId)) {
    throw new ElizaError(
      `Gmail account id ${JSON.stringify(accountId)} is not a safe shard path segment.`,
      {
        code: "GMAIL_CORPUS_ACCOUNT_ID_INVALID",
        context: { accountId },
        severity: "fatal",
      },
    );
  }
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!z.string().email().safeParse(normalized).success) {
    throw new ElizaError(`Invalid Gmail address ${JSON.stringify(value)}.`, {
      code: "GMAIL_CORPUS_EMAIL_INVALID",
      context: { value },
      severity: "fatal",
    });
  }
  return normalized;
}

function monthFor(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function htmlToText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function normalizedPositiveInteger(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ElizaError(
      `Expected an integer from 1 through ${max}; received ${value}.`,
      {
        code: "GMAIL_CORPUS_LIMIT_INVALID",
        context: { max, value },
        severity: "fatal",
      },
    );
  }
  return value;
}

async function mapWithConcurrency<T, TResult>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(values[index]);
      }
    }),
  );
  return results;
}
