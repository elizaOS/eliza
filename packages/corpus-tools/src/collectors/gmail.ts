/**
 * Snapshot-consistent Gmail API collector for the local personal corpus. The
 * collector never holds OAuth material: callers inject a `GmailTransport`
 * (normally an adapter over the plugin-google account-scoped client) and this
 * module owns exhaustive pagination inside the frozen UTC corpus window,
 * bounded quota retries, durable per-account checkpoints with crash-safe
 * resume, real Gmail History reconciliation for completed checkpoints (an
 * expired history id triggers a full rescan rather than trusting the old
 * marker), alias/SENT-aware direction, MIME text extraction, attachment
 * SHA-256 hashing, and idempotent private monthly shards.
 *
 * Compromises kept at this boundary: attachment-only messages carry no
 * fabricated text and are counted instead of emitted; `replyToId` is not
 * mapped because Gmail exposes RFC 822 references rather than same-shard
 * corpus ids; drafts and chat rows are excluded. Raw mail bytes never leave
 * the local output tree, and all output is written mode 0600 under 0700
 * directories.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import {
  CORPUS_ANCHOR_ISO,
  CORPUS_ANCHOR_MS,
  CORPUS_CUTOFF_ISO,
  CORPUS_CUTOFF_MS,
  type CorpusManifest,
  type CorpusMessage,
  type CorpusRecipient,
  corpusMessageSchema,
} from "../schema.ts";
import {
  buildCorpusManifest,
  type CorpusValidationIssue,
} from "../validator.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const MAX_BACKOFF_MS = 64_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const CHECKPOINT_SCHEMA_VERSION = 1;

/** Typed transport failure; `status` drives retry and history-expiry logic. */
export class GmailTransportError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { status: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "GmailTransportError";
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Minimal authenticated Gmail surface the collector consumes. Methods mirror
 * `users.getProfile`, `users.messages.list`, `users.messages.get`
 * (`format: "full"`), `users.messages.attachments.get`, and
 * `users.history.list`; adapters translate HTTP/auth failures into
 * `GmailTransportError` with the upstream status.
 */
export interface GmailTransport {
  getProfile(): Promise<unknown>;
  listMessageIds(query: string, pageToken?: string): Promise<unknown>;
  getMessage(messageId: string): Promise<unknown>;
  getAttachment(messageId: string, attachmentId: string): Promise<Uint8Array>;
  listHistory(startHistoryId: string, pageToken?: string): Promise<unknown>;
}

export interface GmailCollectorOptions {
  transport: GmailTransport;
  /** Owner account email the transport must resolve to; enforces isolation. */
  accountEmail: string;
  /** Additional send-as addresses treated as the owner for direction. */
  aliasEmails?: readonly string[];
  /** Root under which `gmail/<account>/<yyyy-mm>.jsonl` is written. */
  outDir: string;
  /** Retry bound per transport call. */
  maxAttempts?: number;
  /** Backoff base for retryable statuses without a Retry-After hint. */
  backoffBaseMs?: number;
  /** Injectable delay, defaulting to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface GmailCollectSummary {
  schemaVersion: 1;
  accountEmail: string;
  mode: "full" | "resume" | "incremental" | "rescan";
  listedIds: number;
  fetched: number;
  reusedFromStaging: number;
  removedByHistory: number;
  skippedOutsideWindow: number;
  skippedDrafts: number;
  skippedChats: number;
  skippedNoText: number;
  attachmentsHashed: number;
  retriedCalls: number;
  shardCount: number;
}

export interface GmailCollectResult {
  summary: GmailCollectSummary;
  manifest: CorpusManifest;
  issues: CorpusValidationIssue[];
  shardPaths: string[];
  checkpointPath: string;
}

const gmailProfileSchema = z.object({
  emailAddress: z.string().trim().min(3),
  historyId: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
});

const gmailListPageSchema = z.object({
  messages: z
    .array(z.object({ id: z.string().min(1), threadId: z.string().min(1) }))
    .optional(),
  nextPageToken: z.string().min(1).optional(),
});

const gmailBodySchema = z.object({
  data: z.string().optional(),
  attachmentId: z.string().min(1).optional(),
  size: z.number().int().nonnegative().optional(),
});

interface GmailPartInput {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: z.infer<typeof gmailBodySchema>;
  parts?: GmailPartInput[];
}

const gmailPartSchema: z.ZodType<GmailPartInput> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional(),
    body: gmailBodySchema.optional(),
    parts: z.array(gmailPartSchema).optional(),
  }),
);

const gmailMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  labelIds: z.array(z.string().min(1)).optional(),
  snippet: z.string().optional(),
  internalDate: z.string().regex(/^\d+$/),
  payload: gmailPartSchema,
});

const gmailHistoryPageSchema = z.object({
  history: z
    .array(
      z.object({
        messagesAdded: z
          .array(z.object({ message: z.object({ id: z.string().min(1) }) }))
          .optional(),
        messagesDeleted: z
          .array(z.object({ message: z.object({ id: z.string().min(1) }) }))
          .optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().min(1).optional(),
  historyId: z
    .union([z.string().regex(/^\d+$/), z.number().int().positive()])
    .optional(),
});

const checkpointSchema = z.object({
  schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
  accountEmail: z.string().min(3),
  query: z.string().min(1),
  cutoffIso: z.literal(CORPUS_CUTOFF_ISO),
  historyId: z.string().regex(/^\d+$/),
  pageToken: z.string().min(1).optional(),
  listComplete: z.boolean(),
  ids: z.array(z.string().min(1)),
  /** Ids fetched and deliberately not emitted (drafts, chats, out-of-window,
   * no-text); persisted so incremental runs do not refetch them forever. */
  excludedIds: z.array(z.string().min(1)).default([]),
  completed: z.boolean(),
});

type GmailCheckpoint = z.infer<typeof checkpointSchema>;

function collectError(
  code: string,
  message: string,
  context: Record<string, unknown> = {},
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, { code, context, cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoundary<T>(
  schema: z.ZodType<T>,
  value: unknown,
  location: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw collectError(
      "GMAIL_COLLECT_BAD_RESPONSE",
      `${location} did not match the expected Gmail API shape`,
      {
        location,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      },
    );
  }
  return parsed.data;
}

/**
 * The corpus window is expressed in epoch seconds because Gmail's
 * `after:yyyy/mm/dd` form is interpreted in the mailbox's local timezone and
 * would shift the frozen UTC cutoff by up to a day.
 */
export function gmailCorpusQuery(): string {
  const afterSec = Math.floor(CORPUS_CUTOFF_MS / 1000);
  const beforeSec = Math.ceil(CORPUS_ANCHOR_MS / 1000);
  return `after:${afterSec} before:${beforeSec} -in:chats`;
}

function canonicalEmail(value: string, location: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw collectError(
      "GMAIL_COLLECT_BAD_ACCOUNT",
      `${location} must be a canonical email address`,
      { location },
    );
  }
  return email;
}

function accountFileSlug(email: string): string {
  return email.replace(/[^a-z0-9]+/g, "_");
}

function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

interface ParsedAddress {
  address?: string;
  display?: string;
}

function parseAddress(raw: string): ParsedAddress {
  const angled = raw.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (angled) {
    const display = angled[1]?.trim();
    return {
      address: angled[2].toLowerCase(),
      display: display && display.length > 0 ? display : undefined,
    };
  }
  const bare = raw.trim();
  if (/^[^\s@]+@[^\s@]+$/.test(bare)) {
    return { address: bare.toLowerCase() };
  }
  return { display: bare.length > 0 ? bare : undefined };
}

function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuotes = false;
  let current = "";
  for (const char of value) {
    if (char === '"') inQuotes = !inQuotes;
    if (!inQuotes) {
      if (char === "<") depth += 1;
      if (char === ">") depth = Math.max(0, depth - 1);
      if (char === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function headerValue(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string | undefined {
  const match = headers?.find(
    (header) => header.name.toLowerCase() === name.toLowerCase(),
  );
  const value = match?.value.trim();
  return value && value.length > 0 ? value : undefined;
}

interface FlattenedPart {
  mimeType: string;
  filename?: string;
  body?: z.infer<typeof gmailBodySchema>;
}

function flattenParts(part: GmailPartInput, into: FlattenedPart[]): void {
  if (part.parts && part.parts.length > 0) {
    for (const child of part.parts) flattenParts(child, into);
    return;
  }
  into.push({
    mimeType: (part.mimeType ?? "application/octet-stream").toLowerCase(),
    filename:
      part.filename && part.filename.trim().length > 0
        ? part.filename
        : undefined,
    body: part.body,
  });
}

function extractText(parts: FlattenedPart[]): string {
  const plain = parts.find(
    (part) => part.mimeType === "text/plain" && !part.filename,
  );
  if (plain?.body?.data) {
    return decodeBase64Url(plain.body.data).toString("utf8").trim();
  }
  const html = parts.find(
    (part) => part.mimeType === "text/html" && !part.filename,
  );
  if (html?.body?.data) {
    return stripHtml(decodeBase64Url(html.body.data).toString("utf8"));
  }
  return "";
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (process.platform !== "win32") {
    await fs.chmod(dir, PRIVATE_DIRECTORY_MODE);
  }
}

async function writePrivateAtomic(
  filePath: string,
  body: string,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, body, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  await fs.rename(tempPath, filePath);
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    // error-policy:J3 a missing state file is the explicit fresh-run state.
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw collectError(
      "GMAIL_COLLECT_STATE_READ_FAILED",
      "Gmail collector state file could not be read",
      { filePath },
      error,
    );
  }
}

interface RunContext {
  options: Required<
    Pick<GmailCollectorOptions, "maxAttempts" | "backoffBaseMs" | "sleep">
  > &
    GmailCollectorOptions;
  summary: GmailCollectSummary;
}

async function withRetry<T>(
  ctx: RunContext,
  operation: string,
  call: () => Promise<T>,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await call();
    } catch (error) {
      // error-policy:J2 bounded quota/5xx retry; terminal failures rethrow typed.
      const retryable =
        error instanceof GmailTransportError &&
        RETRYABLE_STATUSES.has(error.status);
      if (!retryable || attempt >= ctx.options.maxAttempts) {
        throw collectError(
          "GMAIL_COLLECT_TRANSPORT_FAILED",
          `Gmail ${operation} failed after ${attempt} attempt(s)`,
          {
            operation,
            attempts: attempt,
            status:
              error instanceof GmailTransportError ? error.status : undefined,
          },
          error,
        );
      }
      ctx.summary.retriedCalls += 1;
      const transportError = error as GmailTransportError;
      const backoff = Math.min(
        ctx.options.backoffBaseMs * 2 ** (attempt - 1),
        MAX_BACKOFF_MS,
      );
      await ctx.options.sleep(transportError.retryAfterMs ?? backoff);
    }
  }
}

/** Pre-validation candidate row; text may still be empty and attachments unfilled. */
interface CandidateGmailMessage {
  normalized: Omit<CorpusMessage, "subject" | "snippet" | "replyToId"> & {
    subject?: string;
    snippet?: string;
  };
  parts: FlattenedPart[];
}

function normalizeGmailMessage(
  raw: unknown,
  accountEmail: string,
  ownerAddresses: ReadonlySet<string>,
  summary: GmailCollectSummary,
): CandidateGmailMessage | undefined {
  const message = parseBoundary(
    gmailMessageSchema,
    raw,
    "users.messages.get response",
  );
  const labelIds = message.labelIds ?? [];
  if (labelIds.includes("DRAFT")) {
    summary.skippedDrafts += 1;
    return undefined;
  }
  if (labelIds.includes("CHAT")) {
    summary.skippedChats += 1;
    return undefined;
  }
  const ts = Number(message.internalDate);
  if (
    !Number.isSafeInteger(ts) ||
    ts < CORPUS_CUTOFF_MS ||
    ts > CORPUS_ANCHOR_MS
  ) {
    summary.skippedOutsideWindow += 1;
    return undefined;
  }

  const headers = message.payload.headers;
  const fromRaw = headerValue(headers, "From");
  const from = fromRaw ? parseAddress(fromRaw) : {};
  const fromOwner =
    from.address !== undefined && ownerAddresses.has(from.address);
  const direction: "in" | "out" =
    fromOwner || labelIds.includes("SENT") ? "out" : "in";

  const parts: FlattenedPart[] = [];
  flattenParts(message.payload, parts);
  const text = extractText(parts);

  const recipients: CorpusRecipient[] = [];
  for (const headerName of ["To", "Cc"]) {
    const value = headerValue(headers, headerName);
    if (!value) continue;
    for (const entry of splitAddressList(value)) {
      const parsed = parseAddress(entry);
      const id = parsed.address ?? parsed.display;
      if (!id) continue;
      recipients.push({
        id,
        address: parsed.address,
        display: parsed.display,
      });
    }
  }

  return {
    normalized: {
      id: `gmail:${accountEmail}:${message.id}`,
      platform: "gmail" as const,
      accountId: accountEmail,
      threadId: `gmail:${accountEmail}:thread:${message.threadId}`,
      ts,
      direction,
      senderId:
        from.address ?? (direction === "out" ? accountEmail : "unknown"),
      senderDisplay:
        from.display ??
        from.address ??
        (direction === "out" ? accountEmail : "unknown"),
      recipients,
      subject: headerValue(headers, "Subject"),
      snippet:
        message.snippet && message.snippet.trim().length > 0
          ? message.snippet
          : undefined,
      labels: labelIds.map((label) => `gmail:${label.toLowerCase()}`),
      text,
      attachments: [],
      scrubState: "raw" as const,
    },
    parts,
  };
}

async function fetchAndNormalize(
  ctx: RunContext,
  messageId: string,
  accountEmail: string,
  ownerAddresses: ReadonlySet<string>,
): Promise<CorpusMessage | undefined> {
  const raw = await withRetry(ctx, `messages.get(${messageId})`, () =>
    ctx.options.transport.getMessage(messageId),
  );
  const result = normalizeGmailMessage(
    raw,
    accountEmail,
    ownerAddresses,
    ctx.summary,
  );
  if (!result) return undefined;

  for (const part of result.parts) {
    if (!part.filename || !part.body?.attachmentId) continue;
    const bytes = await withRetry(ctx, `attachments.get(${messageId})`, () =>
      ctx.options.transport.getAttachment(
        messageId,
        part.body?.attachmentId as string,
      ),
    );
    ctx.summary.attachmentsHashed += 1;
    result.normalized.attachments.push({
      filename: part.filename,
      mimeType: part.mimeType,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    });
  }

  if (result.normalized.text.trim().length === 0) {
    // Attachment-only or bodyless mail is counted, never given fabricated text.
    ctx.summary.skippedNoText += 1;
    return undefined;
  }
  return corpusMessageSchema.parse(result.normalized);
}

async function loadCheckpoint(
  checkpointPath: string,
  accountEmail: string,
  query: string,
): Promise<GmailCheckpoint | undefined> {
  const raw = await readOptionalFile(checkpointPath);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // error-policy:J3 a corrupt checkpoint is an explicit rescan trigger.
    return undefined;
  }
  const checkpoint = checkpointSchema.safeParse(parsed);
  if (!checkpoint.success) return undefined;
  if (
    checkpoint.data.accountEmail !== accountEmail ||
    checkpoint.data.query !== query
  ) {
    return undefined;
  }
  return checkpoint.data;
}

async function loadStaging(
  stagingPath: string,
  accountEmail: string,
): Promise<Map<string, CorpusMessage>> {
  const rows = new Map<string, CorpusMessage>();
  const raw = await readOptionalFile(stagingPath);
  if (raw === undefined) return rows;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // error-policy:J3 a torn trailing row from a crash is dropped and refetched.
      continue;
    }
    const message = corpusMessageSchema.safeParse(parsed);
    if (!message.success || message.data.accountId !== accountEmail) continue;
    rows.set(message.data.id, message.data);
  }
  return rows;
}

async function listAllIds(
  ctx: RunContext,
  query: string,
  checkpoint: GmailCheckpoint,
  saveCheckpoint: (next: GmailCheckpoint) => Promise<void>,
): Promise<GmailCheckpoint> {
  let state = checkpoint;
  const seen = new Set(state.ids);
  while (!state.listComplete) {
    const pageToken = state.pageToken;
    const page = parseBoundary(
      gmailListPageSchema,
      await withRetry(ctx, "messages.list", () =>
        ctx.options.transport.listMessageIds(query, pageToken),
      ),
      "users.messages.list response",
    );
    // Pagination under mailbox mutation may repeat ids across pages.
    for (const entry of page.messages ?? []) seen.add(entry.id);
    state = {
      ...state,
      ids: [...seen],
      pageToken: page.nextPageToken,
      listComplete: page.nextPageToken === undefined,
    };
    await saveCheckpoint(state);
  }
  return state;
}

interface HistoryDelta {
  added: Set<string>;
  deleted: Set<string>;
  expired: boolean;
}

async function listHistoryDelta(
  ctx: RunContext,
  startHistoryId: string,
): Promise<HistoryDelta> {
  const added = new Set<string>();
  const deleted = new Set<string>();
  let pageToken: string | undefined;
  do {
    let raw: unknown;
    try {
      raw = await withRetry(ctx, "history.list", () =>
        ctx.options.transport.listHistory(startHistoryId, pageToken),
      );
    } catch (error) {
      // error-policy:J4 an expired/invalid history id is Gmail's documented
      // signal that the delta is unavailable; the caller performs a full rescan.
      if (
        error instanceof ElizaError &&
        error.cause instanceof GmailTransportError &&
        (error.cause.status === 404 || error.cause.status === 400)
      ) {
        return { added, deleted, expired: true };
      }
      throw error;
    }
    const page = parseBoundary(
      gmailHistoryPageSchema,
      raw,
      "users.history.list response",
    );
    for (const record of page.history ?? []) {
      for (const entry of record.messagesAdded ?? [])
        added.add(entry.message.id);
      for (const entry of record.messagesDeleted ?? []) {
        deleted.add(entry.message.id);
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return { added, deleted, expired: false };
}

/** Writes the desired Gmail shard set idempotently; unchanged shards are reused. */
async function writeShards(
  messages: CorpusMessage[],
  outDir: string,
  accountEmail: string,
): Promise<{ paths: string[]; written: number; reused: number }> {
  const shardDir = path.join(outDir, "gmail", accountEmail);
  await ensurePrivateDir(path.join(outDir, "gmail"));
  await ensurePrivateDir(shardDir);

  const buckets = new Map<string, CorpusMessage[]>();
  for (const message of messages) {
    const month = new Date(message.ts).toISOString().slice(0, 7);
    const bucket = buckets.get(month) ?? [];
    bucket.push(message);
    buckets.set(month, bucket);
  }

  const paths: string[] = [];
  const wanted = new Set<string>();
  let written = 0;
  let reused = 0;
  for (const [month, bucket] of [...buckets.entries()].sort()) {
    bucket.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    const fileName = `${month}.jsonl`;
    wanted.add(fileName);
    const shardPath = path.join(shardDir, fileName);
    const body = `${bucket.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const existing = await readOptionalFile(shardPath);
    if (existing === body) {
      reused += 1;
    } else {
      await writePrivateAtomic(shardPath, body);
      written += 1;
    }
    paths.push(shardPath);
  }

  for (const entry of await fs.readdir(shardDir)) {
    if (/^\d{4}-\d{2}\.jsonl$/.test(entry) && !wanted.has(entry)) {
      await fs.unlink(path.join(shardDir, entry));
    }
  }
  return { paths, written, reused };
}

/**
 * Collects one Gmail account into canonical local corpus shards. Reruns are
 * idempotent: an interrupted run resumes from the durable checkpoint and
 * staging file, and a completed checkpoint is reconciled through Gmail
 * History instead of being trusted indefinitely.
 */
export async function collectGmail(
  options: GmailCollectorOptions,
): Promise<GmailCollectResult> {
  const accountEmail = canonicalEmail(options.accountEmail, "accountEmail");
  const ownerAddresses = new Set([
    accountEmail,
    ...(options.aliasEmails ?? []).map((alias, index) =>
      canonicalEmail(alias, `aliasEmails[${index}]`),
    ),
  ]);
  const ctx: RunContext = {
    options: {
      ...options,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      backoffBaseMs: options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      sleep:
        options.sleep ??
        ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    },
    summary: {
      schemaVersion: 1,
      accountEmail,
      mode: "full",
      listedIds: 0,
      fetched: 0,
      reusedFromStaging: 0,
      removedByHistory: 0,
      skippedOutsideWindow: 0,
      skippedDrafts: 0,
      skippedChats: 0,
      skippedNoText: 0,
      attachmentsHashed: 0,
      retriedCalls: 0,
      shardCount: 0,
    },
  };
  const query = gmailCorpusQuery();

  const stateDir = path.join(options.outDir, ".state");
  await ensurePrivateDir(options.outDir);
  await ensurePrivateDir(stateDir);
  const slug = accountFileSlug(accountEmail);
  const checkpointPath = path.join(stateDir, `gmail-${slug}.json`);
  // Staging must not use the .jsonl extension: the manifest builder sweeps
  // every .jsonl under outDir and would reject this non-shard file.
  const stagingPath = path.join(stateDir, `gmail-${slug}-staging.ndjson`);
  const lockPath = path.join(stateDir, `gmail-${slug}.lock`);

  try {
    await fs.mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    // error-policy:J2 a held lock means another collector owns this account.
    throw collectError(
      isRecord(error) && error.code === "EEXIST"
        ? "GMAIL_COLLECT_OUTPUT_BUSY"
        : "GMAIL_COLLECT_STATE_WRITE_FAILED",
      "Gmail collector state lock could not be acquired",
      { lockPath },
      error,
    );
  }

  const releaseLock = async (suppress: boolean): Promise<void> => {
    try {
      await fs.rmdir(lockPath);
    } catch (error) {
      // error-policy:J6 lock teardown failure only leaves a stale lock behind;
      // the next run fails closed with GMAIL_COLLECT_OUTPUT_BUSY. On the
      // failure path the original collection error must not be masked.
      if (suppress) return;
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
  };

  let result: GmailCollectResult;
  try {
    result = await runCollection();
  } catch (error) {
    await releaseLock(true);
    throw error;
  }
  await releaseLock(false);
  return result;

  async function runCollection(): Promise<GmailCollectResult> {
    const profile = parseBoundary(
      gmailProfileSchema,
      await withRetry(ctx, "getProfile", () =>
        ctx.options.transport.getProfile(),
      ),
      "users.getProfile response",
    );
    const profileEmail = canonicalEmail(
      profile.emailAddress,
      "profile.emailAddress",
    );
    if (profileEmail !== accountEmail) {
      throw collectError(
        "GMAIL_COLLECT_ACCOUNT_MISMATCH",
        "Gmail transport is authorized for a different account",
        { expected: accountEmail, actual: profileEmail },
      );
    }
    const profileHistoryId = String(profile.historyId);

    const saveCheckpoint = async (next: GmailCheckpoint): Promise<void> => {
      await writePrivateAtomic(
        checkpointPath,
        `${JSON.stringify(next, null, 2)}\n`,
      );
    };

    let checkpoint = await loadCheckpoint(checkpointPath, accountEmail, query);
    let staging = await loadStaging(stagingPath, accountEmail);

    if (checkpoint?.completed) {
      const delta = await listHistoryDelta(ctx, checkpoint.historyId);
      if (delta.expired) {
        ctx.summary.mode = "rescan";
        checkpoint = undefined;
        staging = new Map();
      } else {
        ctx.summary.mode = "incremental";
        const ids = new Set(checkpoint.ids);
        for (const id of delta.added) ids.add(id);
        const excluded = new Set(checkpoint.excludedIds);
        for (const id of delta.deleted) {
          if (ids.delete(id)) ctx.summary.removedByHistory += 1;
          excluded.delete(id);
          staging.delete(`gmail:${accountEmail}:${id}`);
        }
        // A history-added id may have been excluded before (e.g. a sent
        // draft); it must be re-evaluated rather than stay excluded.
        for (const id of delta.added) excluded.delete(id);
        checkpoint = {
          ...checkpoint,
          ids: [...ids],
          excludedIds: [...excluded],
          historyId: profileHistoryId,
          completed: false,
        };
        await saveCheckpoint(checkpoint);
      }
    } else if (checkpoint) {
      ctx.summary.mode = "resume";
    }

    if (!checkpoint) {
      if (ctx.summary.mode !== "rescan") ctx.summary.mode = "full";
      staging = new Map();
      await fs.rm(stagingPath, { force: true });
      checkpoint = {
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        accountEmail,
        query,
        cutoffIso: CORPUS_CUTOFF_ISO,
        // The snapshot marker is captured before listing so mailbox changes
        // during this run are reconciled by the next incremental run.
        historyId: profileHistoryId,
        listComplete: false,
        ids: [],
        excludedIds: [],
        completed: false,
      };
      await saveCheckpoint(checkpoint);
    }

    checkpoint = await listAllIds(ctx, query, checkpoint, saveCheckpoint);
    ctx.summary.listedIds = checkpoint.ids.length;

    const wantedCorpusIds = new Set<string>();
    const collected: CorpusMessage[] = [];
    const excludedIds = new Set(checkpoint.excludedIds);
    let stagingDirty = false;
    for (const messageId of [...checkpoint.ids].sort()) {
      const corpusId = `gmail:${accountEmail}:${messageId}`;
      if (wantedCorpusIds.has(corpusId)) continue;
      wantedCorpusIds.add(corpusId);
      if (excludedIds.has(messageId)) continue;
      const staged = staging.get(corpusId);
      if (staged) {
        ctx.summary.reusedFromStaging += 1;
        collected.push(staged);
        continue;
      }
      const normalized = await fetchAndNormalize(
        ctx,
        messageId,
        accountEmail,
        ownerAddresses,
      );
      ctx.summary.fetched += 1;
      if (!normalized) {
        excludedIds.add(messageId);
        continue;
      }
      collected.push(normalized);
      staging.set(corpusId, normalized);
      await fs.appendFile(stagingPath, `${JSON.stringify(normalized)}\n`, {
        mode: PRIVATE_FILE_MODE,
      });
      stagingDirty = true;
    }

    // Compact staging when history removals or dedup dropped rows so a
    // deleted message cannot resurrect from stale staging on a later resume.
    const staleStaging = [...staging.keys()].some(
      (id) => !wantedCorpusIds.has(id),
    );
    if (staleStaging || stagingDirty) {
      const body = collected.map((row) => JSON.stringify(row)).join("\n");
      await writePrivateAtomic(stagingPath, body.length > 0 ? `${body}\n` : "");
    }

    const shardResult = await writeShards(
      collected,
      options.outDir,
      accountEmail,
    );
    ctx.summary.shardCount = shardResult.paths.length;

    const { manifest, issues } = await buildCorpusManifest(
      options.outDir,
      CORPUS_ANCHOR_ISO,
    );
    if (issues.length > 0) {
      throw collectError(
        "GMAIL_COLLECT_MANIFEST_INVALID",
        "Gmail output failed corpus manifest validation",
        { issueCount: issues.length, issues },
      );
    }
    await writePrivateAtomic(
      path.join(options.outDir, "gmail", accountEmail, "summary.json"),
      `${JSON.stringify(ctx.summary, null, 2)}\n`,
    );
    await writePrivateAtomic(
      path.join(options.outDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await saveCheckpoint({
      ...checkpoint,
      excludedIds: [...excludedIds].sort(),
      completed: true,
    });

    return {
      summary: ctx.summary,
      manifest,
      issues,
      shardPaths: shardResult.paths,
      checkpointPath,
    };
  }
}
