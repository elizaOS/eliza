/**
 * Snapshot-consistent Gmail API collector for the local personal corpus. The
 * collector never holds OAuth material: callers inject a `GmailTransport`
 * (normally an adapter over the plugin-google account-scoped client) and this
 * module owns exhaustive pagination inside the frozen UTC corpus window,
 * bounded quota retries, durable per-account checkpoints guarded by a
 * PID/start-time lease that a killed process cannot leave held forever, real
 * Gmail History reconciliation for completed checkpoints (message, deletion and
 * label events; an expired history id triggers a full rescan rather than
 * trusting the old marker), alias/SENT-aware direction, MIME text extraction,
 * attachment SHA-256 hashing, and idempotent private monthly shards written
 * under a sanitized account segment.
 *
 * Compromises kept at this boundary: attachment-only messages carry no
 * fabricated text and are counted instead of emitted; `replyToId` is not
 * mapped because Gmail exposes RFC 822 references rather than same-shard
 * corpus ids; drafts and chat rows are excluded. Raw mail bytes never leave
 * the local output tree, and all output is written mode 0600 under 0700
 * directories.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
  corpusAccountSegment,
} from "../validator.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const MAX_BACKOFF_MS = 64_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const CHECKPOINT_SCHEMA_VERSION = 1;
/**
 * Only used when a lease cannot be identified (unparsable record, or a host
 * whose process start times are unreadable). A lease whose owner process is
 * provably gone is recovered immediately, without waiting out this bound.
 */
const LOCK_UNIDENTIFIED_STALE_MS = 6 * 60 * 60 * 1000;
const LOCK_ACQUIRE_ATTEMPTS = 4;

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
 *
 * `listHistory` must forward every history-record field the collector consumes
 * — `messagesAdded`, `messagesDeleted`, `labelsAdded`, `labelsRemoved`, the
 * page's terminal `historyId`, and `nextPageToken` — because labels decide both
 * inclusion (DRAFT/CHAT) and direction (SENT). An adapter that projects the
 * response down to add/delete events freezes stale verdicts in the corpus.
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
  /**
   * Permits the stale-shard sweep to delete existing shards on a run that
   * emitted no messages. Off by default: an empty listing is far more often a
   * transient Gmail condition than a genuinely emptied mailbox, and the shards
   * are the only local copy of the owner's mail.
   */
  allowEmptySweep?: boolean;
}

export interface GmailCollectSummary {
  schemaVersion: 1;
  accountEmail: string;
  mode: "full" | "resume" | "incremental" | "rescan";
  listedIds: number;
  fetched: number;
  reusedFromStaging: number;
  removedByHistory: number;
  /** Ids re-evaluated because Gmail history reported a label change. */
  relabeledByHistory: number;
  /** Ids that vanished between listing and fetch; treated as deletions. */
  missingAtFetch: number;
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

const gmailLabelChangeSchema = z.object({
  message: z.object({ id: z.string().min(1) }),
  labelIds: z.array(z.string().min(1)).optional(),
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
        labelsAdded: z.array(gmailLabelChangeSchema).optional(),
        labelsRemoved: z.array(gmailLabelChangeSchema).optional(),
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
  if (!/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(email)) {
    throw collectError(
      "GMAIL_COLLECT_BAD_ACCOUNT",
      `${location} must be a canonical email address`,
      { location },
    );
  }
  return email;
}

function accountFileSlug(email: string): string {
  return corpusAccountSegment(email);
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

const execFileAsync = promisify(execFile);

const lockLeaseSchema = z.object({
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  /** Owner process start time; `null` when the platform cannot report it. */
  startTimeMs: z.number().int().nonnegative().nullable(),
  acquiredAtMs: z.number().int().nonnegative(),
});

type LockLease = z.infer<typeof lockLeaseSchema>;

/**
 * Second-resolution start time of a live process, used to distinguish a real
 * lease owner from a recycled PID. Returns `undefined` when the platform
 * cannot answer, which makes the caller fall back to the age bound.
 */
async function processStartTimeMs(pid: number): Promise<number | undefined> {
  if (process.platform === "linux") {
    const raw = await readOptionalFile(`/proc/${pid}/stat`);
    if (raw === undefined) return undefined;
    // Field 22 (starttime, clock ticks since boot) follows the comm field,
    // which may itself contain spaces inside parentheses.
    const fields = raw.slice(raw.lastIndexOf(") ") + 2).split(" ");
    const ticks = Number(fields[19]);
    if (!Number.isFinite(ticks)) return undefined;
    return Math.floor((ticks / 100) * 1000);
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("ps", [
        "-p",
        String(pid),
        "-o",
        "lstart=",
      ]);
      const parsed = Date.parse(stdout.trim());
      return Number.isFinite(parsed) ? parsed : undefined;
    } catch {
      // error-policy:J3 an unreadable/absent process is an explicit "unknown"
      // start time, never a fabricated identity match.
      return undefined;
    }
  }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // error-policy:J3 EPERM means the pid exists under another user; only
    // ESRCH proves the owner is gone.
    return isRecord(error) && error.code === "EPERM";
  }
}

/** Whether a lease record still names a live, identity-matching owner. */
async function isLeaseHeld(lease: LockLease, nowMs: number): Promise<boolean> {
  if (lease.hostname !== os.hostname()) {
    // A foreign host's liveness is unknowable here; fail closed until the
    // record ages out.
    return nowMs - lease.acquiredAtMs < LOCK_UNIDENTIFIED_STALE_MS;
  }
  if (!isProcessAlive(lease.pid)) return false;
  const startTimeMs = await processStartTimeMs(lease.pid);
  if (startTimeMs === undefined || lease.startTimeMs === null) {
    return nowMs - lease.acquiredAtMs < LOCK_UNIDENTIFIED_STALE_MS;
  }
  // A live pid whose start time moved is a recycled pid, not the owner.
  return Math.abs(startTimeMs - lease.startTimeMs) <= 1_000;
}

/**
 * Takes the per-account collector lease. The record carries PID, hostname and
 * process start time so a lease abandoned by SIGKILL/OOM is recovered on the
 * next run, while a lease whose owner is still running stays fail-closed.
 */
async function acquireAccountLock(lockPath: string): Promise<LockLease> {
  const lease: LockLease = {
    pid: process.pid,
    hostname: os.hostname(),
    startTimeMs: (await processStartTimeMs(process.pid)) ?? null,
    acquiredAtMs: Date.now(),
  };
  const body = `${JSON.stringify(lease)}\n`;

  for (let attempt = 1; attempt <= LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", PRIVATE_FILE_MODE);
      try {
        await handle.writeFile(body, "utf8");
      } finally {
        await handle.close();
      }
      return lease;
    } catch (error) {
      // error-policy:J2 only a contended lease is retried; anything else is a
      // typed state-write failure for the caller.
      if (!isRecord(error) || error.code !== "EEXIST") {
        throw collectError(
          "GMAIL_COLLECT_STATE_WRITE_FAILED",
          "Gmail collector state lock could not be acquired",
          { lockPath },
          error,
        );
      }
    }

    const raw = await readOptionalFile(lockPath);
    if (raw === undefined) continue; // the holder released between calls
    const now = Date.now();
    let held: boolean;
    const parsed = (() => {
      try {
        return lockLeaseSchema.safeParse(JSON.parse(raw));
      } catch {
        // error-policy:J3 a torn lease record cannot identify an owner.
        return undefined;
      }
    })();
    if (parsed?.success) {
      held = await isLeaseHeld(parsed.data, now);
    } else {
      const stat = await fs.stat(lockPath).catch(() => undefined);
      held =
        stat === undefined || now - stat.mtimeMs < LOCK_UNIDENTIFIED_STALE_MS;
    }
    if (held) {
      throw collectError(
        "GMAIL_COLLECT_OUTPUT_BUSY",
        "Gmail collector state lock is held by a live collector for this account",
        { lockPath, holder: parsed?.success ? parsed.data : "unidentified" },
      );
    }
    // Unlinking `lockPath` directly would be a TOCTOU hole: between the read
    // above and the removal, another recoverer can have swept the same dead
    // record and installed its own live lease, which the removal would then
    // destroy, leaving two collectors on one account. `rename` is atomic, so
    // exactly one recoverer wins the right to displace a record; the loser's
    // rename fails and it falls through to the `wx` open, where it sees the
    // winner's lease. The renamed body is compared against the record this
    // process judged dead, and a record that changed underneath is put back
    // rather than discarded.
    const takeoverPath = `${lockPath}.stale-${process.pid}-${now}`;
    try {
      await fs.rename(lockPath, takeoverPath);
    } catch (error) {
      // error-policy:J3 losing the takeover race is an expected outcome; the
      // next `wx` attempt observes whichever lease actually won.
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw collectError(
          "GMAIL_COLLECT_STATE_WRITE_FAILED",
          "Gmail collector stale lease could not be displaced",
          { lockPath },
          error,
        );
      }
      continue;
    }
    const takenOver = await readOptionalFile(takeoverPath);
    if (takenOver !== raw) {
      try {
        await fs.rename(takeoverPath, lockPath);
      } catch {
        // error-policy:J6 the restore is best effort; if it fails the record is
        // gone and the next `wx` attempt re-establishes a single owner.
      }
      continue;
    }
    await fs.rm(takeoverPath, { force: true });
  }

  throw collectError(
    "GMAIL_COLLECT_OUTPUT_BUSY",
    "Gmail collector state lock could not be acquired after stale recovery",
    { lockPath, attempts: LOCK_ACQUIRE_ATTEMPTS },
  );
}

/** Releases the lease only when this process still owns the record. */
async function releaseAccountLock(
  lockPath: string,
  lease: LockLease,
): Promise<void> {
  const raw = await readOptionalFile(lockPath);
  if (raw === undefined) return;
  let current: unknown;
  try {
    current = JSON.parse(raw);
  } catch {
    // error-policy:J3 an unidentifiable record is not provably ours to remove.
    return;
  }
  const parsed = lockLeaseSchema.safeParse(current);
  if (
    !parsed.success ||
    parsed.data.pid !== lease.pid ||
    parsed.data.hostname !== lease.hostname ||
    parsed.data.acquiredAtMs !== lease.acquiredAtMs
  ) {
    return;
  }
  await fs.rm(lockPath, { force: true });
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
  let raw: unknown;
  try {
    raw = await withRetry(ctx, `messages.get(${messageId})`, () =>
      ctx.options.transport.getMessage(messageId),
    );
  } catch (error) {
    // error-policy:J4 a 404 means the message was deleted between listing and
    // fetch; that is a mailbox state, not a run-fatal transport failure. It is
    // recorded as an exclusion so later runs never refetch the dead id.
    if (
      error instanceof ElizaError &&
      error.cause instanceof GmailTransportError &&
      error.cause.status === 404
    ) {
      ctx.summary.missingAtFetch += 1;
      return undefined;
    }
    throw error;
  }
  const result = normalizeGmailMessage(
    raw,
    accountEmail,
    ownerAddresses,
    ctx.summary,
  );
  if (!result) return undefined;

  if (result.normalized.text.trim().length === 0) {
    // Attachment-only or bodyless mail is counted, never given fabricated text.
    // Decided before the attachment loop below so a message that will be
    // dropped neither spends quota on its attachment bytes nor inflates
    // `attachmentsHashed` past the attachments actually present in the corpus.
    ctx.summary.skippedNoText += 1;
    return undefined;
  }

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
  /**
   * Ids whose label set changed. Labels decide both inclusion (DRAFT/CHAT) and
   * direction (SENT), so these must be refetched and re-evaluated rather than
   * left on their previous verdict.
   */
  relabeled: Set<string>;
  /** Terminal marker from the last history page; the authoritative checkpoint. */
  terminalHistoryId?: string;
  expired: boolean;
}

async function listHistoryDelta(
  ctx: RunContext,
  startHistoryId: string,
): Promise<HistoryDelta> {
  const added = new Set<string>();
  const deleted = new Set<string>();
  const relabeled = new Set<string>();
  let terminalHistoryId: string | undefined;
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
        return { added, deleted, relabeled, expired: true };
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
      for (const entry of [
        ...(record.labelsAdded ?? []),
        ...(record.labelsRemoved ?? []),
      ]) {
        relabeled.add(entry.message.id);
      }
    }
    if (page.historyId !== undefined) {
      terminalHistoryId = String(page.historyId);
    }
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return { added, deleted, relabeled, terminalHistoryId, expired: false };
}

/** Gmail history ids are monotonic; never move a checkpoint backwards. */
function maxHistoryId(left: string, right: string): string {
  return BigInt(left) >= BigInt(right) ? left : right;
}

/** Writes the desired Gmail shard set idempotently; unchanged shards are reused. */
async function writeShards(
  messages: CorpusMessage[],
  outDir: string,
  accountSlug: string,
  allowEmptySweep: boolean,
): Promise<{ paths: string[]; written: number; reused: number }> {
  // The path segment is the sanitized slug, never the raw address: an address
  // is untrusted input and a raw join would let it escape `outDir` and let the
  // stale-shard sweep below unlink files outside the account directory.
  const shardDir = path.join(outDir, "gmail", accountSlug);
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

  const stale = (await fs.readdir(shardDir)).filter(
    (entry) => /^\d{4}-\d{2}\.jsonl$/.test(entry) && !wanted.has(entry),
  );
  // A run that emitted nothing has no evidence that the mailbox is empty: a
  // transient backend condition, a momentarily non-matching query, or an
  // adapter returning an empty page all reach here after an expired history id
  // forces a full rescan. Sweeping on that signal would unlink the only local
  // copy of the owner's mail, so an emptying run fails closed and the operator
  // opts in explicitly once the emptiness is confirmed.
  if (messages.length === 0 && stale.length > 0 && !allowEmptySweep) {
    throw collectError(
      "GMAIL_COLLECT_EMPTY_SWEEP_REFUSED",
      "Gmail run produced no messages but existing shards would be deleted; rerun with allowEmptySweep once the empty result is confirmed",
      { shardDir, staleShards: stale.sort() },
    );
  }
  for (const entry of stale) {
    await fs.unlink(path.join(shardDir, entry));
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
      relabeledByHistory: 0,
      missingAtFetch: 0,
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

  const lease = await acquireAccountLock(lockPath);

  const releaseLock = async (suppress: boolean): Promise<void> => {
    try {
      await releaseAccountLock(lockPath, lease);
    } catch (error) {
      // error-policy:J6 teardown failure only leaves a lease record behind;
      // it names this dead process and the next run recovers it. On the
      // failure path the original collection error must not be masked.
      if (suppress) return;
      throw error;
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
        // A label change can flip inclusion (DRAFT/CHAT) or direction (SENT)
        // without any messagesAdded event, so drop every cached verdict for
        // the affected ids and force a refetch.
        for (const id of delta.relabeled) {
          if (delta.deleted.has(id)) continue;
          ids.add(id);
          excluded.delete(id);
          staging.delete(`gmail:${accountEmail}:${id}`);
          ctx.summary.relabeledByHistory += 1;
        }
        checkpoint = {
          ...checkpoint,
          ids: [...ids],
          excludedIds: [...excluded],
          // The authoritative marker is the terminal history id of the pages
          // just applied, not the pre-reconciliation profile snapshot.
          historyId: maxHistoryId(
            checkpoint.historyId,
            delta.terminalHistoryId ?? profileHistoryId,
          ),
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
      slug,
      options.allowEmptySweep ?? false,
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
      path.join(options.outDir, "gmail", slug, "summary.json"),
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
