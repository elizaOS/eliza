/**
 * Deterministic unit and integration coverage for the Gmail collector against
 * an in-memory fake transport that speaks real Gmail API response shapes. The
 * harness is real at the filesystem boundary (shards, checkpoints, staging,
 * manifest under a temp directory) with no network and no mocked module
 * collaborators; retries use an injected recording sleep.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORPUS_ANCHOR_MS, CORPUS_CUTOFF_MS } from "../schema.ts";
import { corpusAccountSegment, validateCorpusTarget } from "../validator.ts";
import {
  collectGmail,
  type GmailTransport,
  GmailTransportError,
  gmailCorpusQuery,
} from "./gmail.ts";

const ACCOUNT = "owner@example.com";
const ALIAS = "owner.alias@example.com";
const ACCOUNT_SEGMENT = corpusAccountSegment(ACCOUNT);

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gmail-collect-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

function b64url(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

interface FakeMessageSpec {
  id: string;
  threadId?: string;
  ts: number;
  from: string;
  to?: string;
  cc?: string;
  subject?: string;
  labelIds?: string[];
  textPlain?: string;
  textHtml?: string;
  attachments?: Array<{ filename: string; mimeType: string; bytes: Buffer }>;
  snippet?: string;
}

function buildApiMessage(spec: FakeMessageSpec): {
  message: Record<string, unknown>;
  attachmentBytes: Map<string, Buffer>;
} {
  const headers = [
    { name: "From", value: spec.from },
    ...(spec.to ? [{ name: "To", value: spec.to }] : []),
    ...(spec.cc ? [{ name: "Cc", value: spec.cc }] : []),
    ...(spec.subject ? [{ name: "Subject", value: spec.subject }] : []),
  ];
  const attachmentBytes = new Map<string, Buffer>();
  const parts: Array<Record<string, unknown>> = [];
  if (spec.textPlain !== undefined) {
    parts.push({
      partId: "0",
      mimeType: "text/plain",
      filename: "",
      body: { data: b64url(spec.textPlain), size: spec.textPlain.length },
    });
  }
  if (spec.textHtml !== undefined) {
    parts.push({
      partId: "1",
      mimeType: "text/html",
      filename: "",
      body: { data: b64url(spec.textHtml), size: spec.textHtml.length },
    });
  }
  for (const [index, attachment] of (spec.attachments ?? []).entries()) {
    const attachmentId = `att-${spec.id}-${index}`;
    attachmentBytes.set(attachmentId, attachment.bytes);
    parts.push({
      partId: `${2 + index}`,
      mimeType: attachment.mimeType,
      filename: attachment.filename,
      body: { attachmentId, size: attachment.bytes.byteLength },
    });
  }
  return {
    message: {
      id: spec.id,
      threadId: spec.threadId ?? `thread-${spec.id}`,
      labelIds: spec.labelIds ?? ["INBOX"],
      snippet: spec.snippet ?? spec.textPlain?.slice(0, 40) ?? "",
      internalDate: String(spec.ts),
      payload: {
        partId: "",
        mimeType: "multipart/mixed",
        filename: "",
        headers,
        body: { size: 0 },
        parts,
      },
    },
    attachmentBytes,
  };
}

interface LabelChangeSpec {
  id: string;
  added?: string[];
  removed?: string[];
}

interface HistoryDeltaSpec {
  added?: FakeMessageSpec[];
  deletedIds?: string[];
  labelChanges?: LabelChangeSpec[];
  expired?: boolean;
  /** Terminal `historyId` of the last history page, when it advanced. */
  terminalHistoryId?: string;
  /** Split the events across two pages to exercise history pagination. */
  paginate?: boolean;
}

class FakeGmailTransport implements GmailTransport {
  readonly calls: string[] = [];
  historyId = "1000";
  pageSize = 2;
  historyDelta: HistoryDeltaSpec | undefined;
  failGetMessageOnce = new Set<string>();
  failListPageTokens = new Map<string, number>();
  quota429sRemaining = 0;
  quotaRetryAfterMs: number | undefined;

  private readonly messages = new Map<string, Record<string, unknown>>();
  private readonly attachments = new Map<string, Buffer>();
  private order: string[] = [];

  constructor(
    private readonly accountEmail: string,
    specs: FakeMessageSpec[],
  ) {
    for (const spec of specs) this.addMessage(spec);
  }

  addMessage(spec: FakeMessageSpec): void {
    const built = buildApiMessage(spec);
    this.messages.set(spec.id, built.message);
    for (const [id, bytes] of built.attachmentBytes) {
      this.attachments.set(`${spec.id}:${id}`, bytes);
    }
    this.order.push(spec.id);
  }

  removeMessage(id: string): void {
    this.messages.delete(id);
    this.order = this.order.filter((existing) => existing !== id);
  }

  /** Deletes the message body while the id stays in an already-served list page. */
  vanishAfterListing(id: string): void {
    this.messages.delete(id);
  }

  async getProfile(): Promise<unknown> {
    this.calls.push("getProfile");
    return { emailAddress: this.accountEmail, historyId: this.historyId };
  }

  async listMessageIds(query: string, pageToken?: string): Promise<unknown> {
    this.calls.push(`list:${pageToken ?? "first"}`);
    if (this.quota429sRemaining > 0) {
      this.quota429sRemaining -= 1;
      throw new GmailTransportError("quota", {
        status: 429,
        retryAfterMs: this.quotaRetryAfterMs,
      });
    }
    const key = pageToken ?? "first";
    const failures = this.failListPageTokens.get(key) ?? 0;
    if (failures > 0) {
      this.failListPageTokens.set(key, failures - 1);
      throw new GmailTransportError("backend", { status: 503 });
    }
    expect(query).toBe(gmailCorpusQuery());
    const start = pageToken ? Number(pageToken) : 0;
    const slice = this.order.slice(start, start + this.pageSize);
    const nextStart = start + this.pageSize;
    return {
      messages: slice.map((id) => ({
        id,
        threadId: String(this.messages.get(id)?.threadId ?? `thread-${id}`),
      })),
      ...(nextStart < this.order.length
        ? { nextPageToken: String(nextStart) }
        : {}),
    };
  }

  async getMessage(messageId: string): Promise<unknown> {
    this.calls.push(`get:${messageId}`);
    if (this.failGetMessageOnce.has(messageId)) {
      this.failGetMessageOnce.delete(messageId);
      throw new GmailTransportError("boom", { status: 500 });
    }
    const message = this.messages.get(messageId);
    if (!message) throw new GmailTransportError("missing", { status: 404 });
    return message;
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<Uint8Array> {
    this.calls.push(`attachment:${messageId}:${attachmentId}`);
    const bytes = this.attachments.get(`${messageId}:${attachmentId}`);
    if (!bytes) throw new GmailTransportError("missing", { status: 404 });
    return new Uint8Array(bytes);
  }

  /** Applies a label change to the stored message, as Gmail would. */
  private applyLabelChange(change: LabelChangeSpec): string[] {
    const message = this.messages.get(change.id);
    const labels = new Set<string>(
      Array.isArray(message?.labelIds) ? (message.labelIds as string[]) : [],
    );
    for (const label of change.added ?? []) labels.add(label);
    for (const label of change.removed ?? []) labels.delete(label);
    if (message) message.labelIds = [...labels];
    return [...labels];
  }

  async listHistory(
    startHistoryId: string,
    pageToken?: string,
  ): Promise<unknown> {
    this.calls.push(`history:${startHistoryId}:${pageToken ?? "first"}`);
    const delta = this.historyDelta;
    if (!delta || delta.expired) {
      throw new GmailTransportError("history expired", { status: 404 });
    }
    for (const spec of delta.added ?? []) {
      if (!this.messages.has(spec.id)) this.addMessage(spec);
    }
    const labelRecords = (delta.labelChanges ?? []).map((change) => {
      const labelIds = this.applyLabelChange(change);
      return {
        ...(change.added && change.added.length > 0
          ? {
              labelsAdded: [
                {
                  message: { id: change.id, labelIds },
                  labelIds: change.added,
                },
              ],
            }
          : {}),
        ...(change.removed && change.removed.length > 0
          ? {
              labelsRemoved: [
                {
                  message: { id: change.id, labelIds },
                  labelIds: change.removed,
                },
              ],
            }
          : {}),
      };
    });
    const messageRecord = {
      messagesAdded: (delta.added ?? []).map((spec) => ({
        message: { id: spec.id },
      })),
      messagesDeleted: (delta.deletedIds ?? []).map((id) => ({
        message: { id },
      })),
    };
    const terminal = delta.terminalHistoryId ?? this.historyId;
    if (delta.paginate && pageToken === undefined) {
      // The first page carries only the message events and a stale marker; the
      // terminal marker must come from the last page.
      return {
        history: [messageRecord],
        nextPageToken: "history-2",
        historyId: startHistoryId,
      };
    }
    return {
      history: delta.paginate ? labelRecords : [messageRecord, ...labelRecords],
      historyId: terminal,
    };
  }
}

const T0 = CORPUS_CUTOFF_MS + 24 * 3600 * 1000;
const MONTH = 32 * 24 * 3600 * 1000;

function baseSpecs(): FakeMessageSpec[] {
  return [
    {
      id: "m1",
      ts: T0,
      from: "Alice Sender <alice@example.net>",
      to: `Owner <${ACCOUNT}>`,
      cc: "bob@example.net, Carol <carol@example.net>",
      subject: "Hello there",
      textPlain: "First inbound message body",
    },
    {
      id: "m2",
      ts: T0 + 3600 * 1000,
      from: `Owner <${ACCOUNT}>`,
      to: "alice@example.net",
      subject: "Re: Hello there",
      labelIds: ["SENT"],
      textPlain: "Outbound reply body",
      attachments: [
        {
          filename: "notes.pdf",
          mimeType: "application/pdf",
          bytes: Buffer.from("fake-pdf-bytes"),
        },
      ],
    },
    {
      id: "m3",
      ts: T0 + MONTH,
      from: `Aliased Owner <${ALIAS}>`,
      to: "dave@example.net",
      subject: "From my alias",
      labelIds: ["INBOX"],
      textHtml: "<p>Hello &amp; <b>welcome</b></p>",
    },
    {
      id: "m4",
      ts: T0 + MONTH + 3600 * 1000,
      from: "eve@example.net",
      to: ACCOUNT,
      subject: "Attachment only",
      attachments: [
        {
          filename: "image.png",
          mimeType: "image/png",
          bytes: Buffer.from("png-bytes"),
        },
      ],
    },
    {
      id: "m5",
      ts: CORPUS_ANCHOR_MS + 1000,
      from: "late@example.net",
      to: ACCOUNT,
      subject: "Too late",
      textPlain: "outside window",
    },
    {
      id: "m6",
      ts: T0,
      from: ACCOUNT,
      subject: "A draft",
      labelIds: ["DRAFT"],
      textPlain: "draft body",
    },
  ];
}

async function collect(
  transport: GmailTransport,
  outDir: string,
  overrides: Partial<Parameters<typeof collectGmail>[0]> = {},
) {
  return collectGmail({
    transport,
    accountEmail: ACCOUNT,
    aliasEmails: [ALIAS],
    outDir,
    sleep: async () => {},
    ...overrides,
  });
}

/**
 * A pid that is provably gone: a real child is started and awaited to exit, so
 * the planted lease names a dead owner rather than a guessed number that could
 * belong to a live process on the runner.
 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return child.pid as number;
}

function lockPathFor(outDir: string): string {
  return path.join(outDir, ".state", `gmail-${ACCOUNT_SEGMENT}.lock`);
}

/**
 * Runs a real second collector process that takes the account lease and then
 * blocks forever inside the transport, so the parent can SIGKILL it and prove
 * the abandoned lease is recoverable. `bun` is the repository-pinned runtime
 * and executes the TypeScript entrypoint directly.
 */
function spawnLockHolder(outDir: string, readyPath: string): ChildProcess {
  const script = path.join(outDir, "lock-holder.ts");
  writeFileSync(
    script,
    [
      `import { promises as fs } from "node:fs";`,
      `import { collectGmail } from ${JSON.stringify(
        path.join(import.meta.dirname, "gmail.ts"),
      )};`,
      `const transport = {`,
      `  async getProfile() {`,
      `    await fs.writeFile(${JSON.stringify(readyPath)}, "ready");`,
      `    await new Promise(() => {});`,
      `    return {};`,
      `  },`,
      `  async listMessageIds() { throw new Error("unreachable"); },`,
      `  async getMessage() { throw new Error("unreachable"); },`,
      `  async getAttachment() { throw new Error("unreachable"); },`,
      `  async listHistory() { throw new Error("unreachable"); },`,
      `};`,
      `await collectGmail({`,
      `  transport,`,
      `  accountEmail: ${JSON.stringify(ACCOUNT)},`,
      `  outDir: ${JSON.stringify(outDir)},`,
      `});`,
    ].join("\n"),
    "utf8",
  );
  // `--conditions=eliza-source` is how this repository resolves `@elizaos/*`
  // to TypeScript sources without a prior build; vitest applies it to the
  // parent, and without it the child resolves the unbuilt `dist` entry and
  // dies before it can take the lease.
  const child = spawn("bun", ["--conditions=eliza-source", script], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  // Without this the child's own failures (a missing `bun`, an unresolvable
  // import) surface only as an opaque 30s readiness timeout, so its stderr is
  // buffered and reported by `waitForFile`.
  childStderr.set(child, "");
  child.stderr?.on("data", (chunk: Buffer) => {
    childStderr.set(child, `${childStderr.get(child) ?? ""}${chunk}`);
  });
  child.on("error", (error) => {
    childStderr.set(child, `${childStderr.get(child) ?? ""}${error.message}\n`);
  });
  return child;
}

const childStderr = new WeakMap<ChildProcess, string>();

async function waitForFile(
  filePath: string,
  child?: ChildProcess,
): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      await fs.stat(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const stderr = child ? childStderr.get(child) : undefined;
  throw new Error(
    `child process never reported ready at ${filePath}${
      stderr ? `\nchild stderr:\n${stderr}` : ""
    }`,
  );
}

describe("collectGmail", () => {
  it("collects a full window with pagination, MIME, direction, and attachment hashes", async () => {
    const outDir = await makeTempDir();
    const transport = new FakeGmailTransport(ACCOUNT, baseSpecs());
    const result = await collect(transport, outDir);

    expect(result.summary.mode).toBe("full");
    expect(result.summary.listedIds).toBe(6);
    expect(result.summary.skippedOutsideWindow).toBe(1);
    expect(result.summary.skippedDrafts).toBe(1);
    expect(result.summary.skippedNoText).toBe(1);
    // Only attachments on messages that reached the corpus are fetched and
    // counted: the attachment-only message is dropped for empty text before
    // its bytes are downloaded, so the counter describes the emitted shards.
    expect(result.summary.attachmentsHashed).toBe(1);
    expect(
      transport.calls.filter((call) => call.startsWith("attachment:")),
    ).toHaveLength(1);
    expect(result.manifest.totals.messages).toBe(3);
    expect(result.shardPaths).toHaveLength(2);
    // Exhaustive pagination: 6 ids at page size 2 needs 3 list pages.
    expect(
      transport.calls.filter((call) => call.startsWith("list:")),
    ).toHaveLength(3);

    const rows = (
      await fs.readFile(
        path.join(outDir, "gmail", ACCOUNT_SEGMENT, "2024-07.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => row.id)).toEqual([
      `gmail:${ACCOUNT}:m1`,
      `gmail:${ACCOUNT}:m2`,
    ]);
    expect(rows[0].direction).toBe("in");
    expect(rows[0].senderId).toBe("alice@example.net");
    expect(rows[0].senderDisplay).toBe("Alice Sender");
    expect(rows[0].recipients.map((r: { id: string }) => r.id)).toEqual([
      ACCOUNT,
      "bob@example.net",
      "carol@example.net",
    ]);
    expect(rows[0].labels).toEqual(["gmail:inbox"]);
    expect(rows[1].direction).toBe("out");
    expect(rows[1].attachments).toEqual([
      {
        filename: "notes.pdf",
        mimeType: "application/pdf",
        sha256: createHash("sha256").update("fake-pdf-bytes").digest("hex"),
        bytes: 14,
      },
    ]);

    const august = JSON.parse(
      (
        await fs.readFile(
          path.join(outDir, "gmail", ACCOUNT_SEGMENT, "2024-08.jsonl"),
          "utf8",
        )
      ).trim(),
    );
    expect(august.direction).toBe("out"); // alias-aware without SENT label
    expect(august.text).toBe("Hello & welcome");

    const validation = await validateCorpusTarget(outDir);
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it("is idempotent: a second run reconciles history and reuses byte-identical shards", async () => {
    const outDir = await makeTempDir();
    const transport = new FakeGmailTransport(ACCOUNT, baseSpecs());
    await collect(transport, outDir);
    const shardPath = path.join(
      outDir,
      "gmail",
      ACCOUNT_SEGMENT,
      "2024-07.jsonl",
    );
    const before = await fs.readFile(shardPath, "utf8");
    const statBefore = await fs.stat(shardPath);

    transport.historyDelta = {}; // no changes since checkpoint
    const second = await collect(transport, outDir);
    expect(second.summary.mode).toBe("incremental");
    expect(second.summary.fetched).toBe(0);
    expect(second.summary.reusedFromStaging).toBe(3);
    const statAfter = await fs.stat(shardPath);
    expect(await fs.readFile(shardPath, "utf8")).toBe(before);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it("resumes an interrupted listing from the checkpointed page token without refetching staged mail", async () => {
    const outDir = await makeTempDir();
    const transport = new FakeGmailTransport(ACCOUNT, baseSpecs());
    // Second page fails through all attempts; first page of ids gets staged.
    transport.failListPageTokens.set("2", 99);
    await expect(
      collect(transport, outDir, { maxAttempts: 2 }),
    ).rejects.toMatchObject({ code: "GMAIL_COLLECT_TRANSPORT_FAILED" });

    const resumed = new FakeGmailTransport(ACCOUNT, baseSpecs());
    const result = await collect(resumed, outDir);
    expect(result.summary.mode).toBe("resume");
    // Listing resumes at the persisted token instead of the first page.
    expect(resumed.calls.filter((call) => call.startsWith("list:"))).toEqual([
      "list:2",
      "list:4",
    ]);
    expect(result.manifest.totals.messages).toBe(3);
    expect((await validateCorpusTarget(outDir)).ok).toBe(true);
  });

  it("retries quota exhaustion with the server retry-after hint before succeeding", async () => {
    const outDir = await makeTempDir();
    const transport = new FakeGmailTransport(ACCOUNT, baseSpecs());
    transport.quota429sRemaining = 2;
    transport.quotaRetryAfterMs = 1234;
    const sleeps: number[] = [];
    const result = await collect(transport, outDir, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.summary.retriedCalls).toBe(2);
    expect(sleeps).toEqual([1234, 1234]);
    expect(result.manifest.totals.messages).toBe(3);
  });

  it("applies history additions and deletions on incremental runs", async () => {
    const outDir = await makeTempDir();
    const transport = new FakeGmailTransport(ACCOUNT, baseSpecs());
    await collect(transport, outDir);

    transport.historyDelta = {
      added: [
        {
          id: "m7",
          ts: T0 + 2 * MONTH,
          from: "frank@example.net",
          to: ACCOUNT,
          subject: "Brand new",
          textPlain: "new mail after first snapshot",
        },
      ],
      deletedIds: ["m1"],
    };
    const result = await collect(transport, outDir);
    expect(result.summary.mode).toBe("incremental");
    expect(result.summary.removedByHistory).toBe(1);
    expect(result.summary.fetched).toBe(1);
    expect(result.manifest.totals.messages).toBe(3);

    const july = await fs.readFile(
      path.join(outDir, "gmail", ACCOUNT_SEGMENT, "2024-07.jsonl"),
      "utf8",
    );
    expect(july).not.toContain(`gmail:${ACCOUNT}:m1`);
    expect(
      await fs.readFile(
        path.join(outDir, "gmail", ACCOUNT_SEGMENT, "2024-09.jsonl"),
        "utf8",
      ),
    ).toContain(`gmail:${ACCOUNT}:m7`);
    expect((await validateCorpusTarget(outDir)).ok).toBe(true);
  });

  it("re-evaluates label history: DRAFT removal, SENT addition, and CHAT addition", async () => {
    const outDir = await makeTempDir();
    const transport = new FakeGmailTransport(ACCOUNT, baseSpecs());
    const first = await collect(transport, outDir);
    expect(first.summary.skippedDrafts).toBe(1);
    expect(first.manifest.totals.messages).toBe(3);

    // m6 leaves DRAFT and becomes real sent mail; m1 gains SENT (direction
    // flips); m3 becomes a chat row and must leave the corpus. The events are
    // paginated and arrive alongside an unrelated add and delete.
    transport.historyDelta = {
      added: [
        {
          id: "m7",
          ts: T0 + 2 * MONTH,
          from: "frank@example.net",
          to: ACCOUNT,
          subject: "Brand new",
          textPlain: "new mail after first snapshot",
        },
      ],
      deletedIds: ["m4"],
      labelChanges: [
        { id: "m6", removed: ["DRAFT"], added: ["SENT"] },
        { id: "m1", added: ["SENT"] },
        { id: "m3", added: ["CHAT"] },
      ],
      paginate: true,
      terminalHistoryId: "2500",
    };
    const second = await collect(transport, outDir);
    expect(second.summary.mode).toBe("incremental");
    expect(second.summary.relabeledByHistory).toBe(3);
    // Both history pages were consumed.
    expect(
      transport.calls.filter((call) => call.startsWith("history:")),
    ).toEqual(["history:1000:first", "history:1000:history-2"]);
    expect(second.summary.skippedChats).toBe(1);
    expect(second.summary.skippedDrafts).toBe(0);

    const july = (
      await fs.readFile(
        path.join(outDir, "gmail", ACCOUNT_SEGMENT, "2024-07.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const byId = new Map(july.map((row) => [row.id, row]));
    // The former draft is now collected instead of frozen in excludedIds.
    expect(byId.has(`gmail:${ACCOUNT}:m6`)).toBe(true);
    // A SENT label added after the fact flips a stale inbound verdict.
    expect(byId.get(`gmail:${ACCOUNT}:m1`)?.direction).toBe("out");
    // The message relabeled CHAT is gone from the August shard.
    const augustPath = path.join(
      outDir,
      "gmail",
      ACCOUNT_SEGMENT,
      "2024-08.jsonl",
    );
    await expect(fs.stat(augustPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await validateCorpusTarget(outDir)).ok).toBe(true);
  });

  it("checkpoints the terminal history id from the response, never moving backwards", async () => {
    const outDir = await makeTempDir();
    const transport = new FakeGmailTransport(ACCOUNT, baseSpecs());
    const first = await collect(transport, outDir);
    const readCheckpoint = async () =>
      JSON.parse(await fs.readFile(first.checkpointPath, "utf8"));
    expect((await readCheckpoint()).historyId).toBe("1000");

    // The mailbox moved during reconciliation: the profile snapshot is stale
    // and only the terminal marker of the applied pages is authoritative.
    transport.historyDelta = { terminalHistoryId: "4242" };
    await collect(transport, outDir);
    expect((await readCheckpoint()).historyId).toBe("4242");

    // A page that reports an older marker must never rewind the checkpoint.
    transport.historyDelta = { terminalHistoryId: "17" };
    await collect(transport, outDir);
    expect((await readCheckpoint()).historyId).toBe("4242");
  });

  it("treats a message deleted between listing and fetch as a deletion, not a fatal error", async () => {
    const outDir = await makeTempDir();
    const transport = new FakeGmailTransport(ACCOUNT, baseSpecs());
    const listed = transport.listMessageIds.bind(transport);
    transport.listMessageIds = async (query: string, pageToken?: string) => {
      const page = await listed(query, pageToken);
      // m2 vanishes right after it is listed, exactly as a concurrent delete
      // between users.messages.list and users.messages.get would.
      transport.vanishAfterListing("m2");
      return page;
    };
    const result = await collect(transport, outDir);
    expect(result.summary.missingAtFetch).toBe(1);
    expect(result.manifest.totals.messages).toBe(2);
    expect(
      await fs.readFile(
        path.join(outDir, "gmail", ACCOUNT_SEGMENT, "2024-07.jsonl"),
        "utf8",
      ),
    ).not.toContain(`gmail:${ACCOUNT}:m2`);
    // The dead id is remembered so later runs never refetch it.
    const checkpoint = JSON.parse(
      await fs.readFile(result.checkpointPath, "utf8"),
    );
    expect(checkpoint.excludedIds).toContain("m2");
    expect((await validateCorpusTarget(outDir)).ok).toBe(true);
  });

  it("keeps accounts in distinct directories inside outDir and rejects path-bearing addresses", async () => {
    const outDir = await makeTempDir();
    // Two distinct addresses whose sanitized spelling is identical.
    const first = "a.b@example.com";
    const second = "a-b@example.com";
    expect(corpusAccountSegment(first)).not.toBe(corpusAccountSegment(second));

    for (const account of [first, second]) {
      const transport = new FakeGmailTransport(account, [
        {
          id: `${account}-m1`,
          ts: T0,
          from: "alice@example.net",
          to: account,
          subject: "Hello",
          textPlain: "body",
        },
      ]);
      const result = await collectGmail({
        transport,
        accountEmail: account,
        outDir,
        sleep: async () => {},
      });
      for (const shardPath of result.shardPaths) {
        expect(path.relative(outDir, shardPath).startsWith("..")).toBe(false);
      }
    }
    const accountDirs = await fs.readdir(path.join(outDir, "gmail"));
    expect(accountDirs).toHaveLength(2);
    expect((await validateCorpusTarget(outDir)).ok).toBe(true);

    // A traversal payload never reaches path.join in the first place.
    const escaping = "a@../../etc.x";
    await expect(
      collectGmail({
        transport: new FakeGmailTransport(escaping, []),
        accountEmail: escaping,
        outDir,
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ code: "GMAIL_COLLECT_BAD_ACCOUNT" });
  });

  it("falls back to a full rescan when the checkpointed history id has expired", async () => {
    const outDir = await makeTempDir();
    const transport = new FakeGmailTransport(ACCOUNT, baseSpecs());
    await collect(transport, outDir);

    transport.historyDelta = { expired: true };
    const result = await collect(transport, outDir);
    expect(result.summary.mode).toBe("rescan");
    // A rescan trusts nothing: every id is listed and refetched.
    expect(result.summary.reusedFromStaging).toBe(0);
    expect(result.summary.fetched).toBe(6);
    expect(result.manifest.totals.messages).toBe(3);
    expect((await validateCorpusTarget(outDir)).ok).toBe(true);
  });

  it("enforces account isolation when the transport resolves another mailbox", async () => {
    const outDir = await makeTempDir();
    const transport = new FakeGmailTransport("other@example.com", []);
    await expect(collect(transport, outDir)).rejects.toMatchObject({
      code: "GMAIL_COLLECT_ACCOUNT_MISMATCH",
    });
  });

  it("fails closed when a live process holds the account lease", async () => {
    const outDir = await makeTempDir();
    await fs.mkdir(path.join(outDir, ".state"), { recursive: true });
    // This very process is a provably live, identity-matching owner.
    await fs.writeFile(
      lockPathFor(outDir),
      `${JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        startTimeMs: null,
        acquiredAtMs: Date.now(),
      })}\n`,
    );
    const transport = new FakeGmailTransport(ACCOUNT, baseSpecs());
    await expect(collect(transport, outDir)).rejects.toMatchObject({
      code: "GMAIL_COLLECT_OUTPUT_BUSY",
    });
  });

  it("recovers a lease abandoned by a killed collector process", async () => {
    const outDir = await makeTempDir();
    const readyPath = path.join(outDir, "child-ready");
    const child = spawnLockHolder(outDir, readyPath);
    try {
      await waitForFile(readyPath, child);

      // A live competing owner still blocks this account.
      const blocked = new FakeGmailTransport(ACCOUNT, baseSpecs());
      await expect(collect(blocked, outDir)).rejects.toMatchObject({
        code: "GMAIL_COLLECT_OUTPUT_BUSY",
      });

      const exited = new Promise<void>((resolve) =>
        child.once("exit", resolve),
      );
      child.kill("SIGKILL");
      await exited;
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }

    // The killed process left its lease record behind; the next run must
    // recover it instead of failing GMAIL_COLLECT_OUTPUT_BUSY forever.
    expect(await fs.readFile(lockPathFor(outDir), "utf8")).toContain('"pid"');
    const transport = new FakeGmailTransport(ACCOUNT, baseSpecs());
    const result = await collect(transport, outDir);
    expect(result.manifest.totals.messages).toBe(3);
    expect((await validateCorpusTarget(outDir)).ok).toBe(true);
    // The lease is released on the normal path.
    await expect(fs.stat(lockPathFor(outDir))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("refuses to sweep existing shards when a rescan lists nothing", async () => {
    const outDir = await makeTempDir();
    const good = new FakeGmailTransport(ACCOUNT, baseSpecs());
    const first = await collect(good, outDir);
    expect(first.shardPaths.length).toBeGreaterThan(0);
    const shardDir = path.join(outDir, "gmail", ACCOUNT_SEGMENT);
    const before = (await fs.readdir(shardDir)).sort();

    // No historyDelta means users.history.list reports the checkpoint expired,
    // which forces a full rescan; this mailbox then lists zero messages.
    const empty = new FakeGmailTransport(ACCOUNT, []);
    await expect(collect(empty, outDir)).rejects.toMatchObject({
      code: "GMAIL_COLLECT_EMPTY_SWEEP_REFUSED",
    });

    // The refusal must be fail-closed: the shards are still on disk.
    expect((await fs.readdir(shardDir)).sort()).toEqual(before);
    expect(before.some((entry) => entry.endsWith(".jsonl"))).toBe(true);
  });

  it("sweeps shards on an empty run only when the caller opts in", async () => {
    const outDir = await makeTempDir();
    await collect(new FakeGmailTransport(ACCOUNT, baseSpecs()), outDir);
    const shardDir = path.join(outDir, "gmail", ACCOUNT_SEGMENT);

    const empty = new FakeGmailTransport(ACCOUNT, []);
    const result = await collect(empty, outDir, { allowEmptySweep: true });
    expect(result.summary.mode).toBe("rescan");
    expect(result.summary.listedIds).toBe(0);
    expect(
      (await fs.readdir(shardDir)).filter((entry) => entry.endsWith(".jsonl")),
    ).toEqual([]);
  });

  it("never lets two concurrent runs recover the same abandoned lease", async () => {
    // The stale-recovery branch is the one place the lease can be displaced,
    // so it is exercised repeatedly: a single interleaving in which both runs
    // judge the same dead record and then both take the account is a defect.
    for (let trial = 0; trial < 30; trial += 1) {
      const outDir = await makeTempDir();
      await fs.mkdir(path.join(outDir, ".state"), { recursive: true });
      await fs.writeFile(
        lockPathFor(outDir),
        `${JSON.stringify({
          pid: await deadPid(),
          hostname: os.hostname(),
          startTimeMs: null,
          acquiredAtMs: Date.now(),
        })}\n`,
        "utf8",
      );

      const settled = await Promise.allSettled([
        collect(new FakeGmailTransport(ACCOUNT, baseSpecs()), outDir),
        collect(new FakeGmailTransport(ACCOUNT, baseSpecs()), outDir),
      ]);
      const fulfilled = settled.filter((entry) => entry.status === "fulfilled");
      expect(fulfilled).toHaveLength(1);
      for (const entry of settled) {
        if (entry.status === "rejected") {
          expect(entry.reason).toMatchObject({
            code: "GMAIL_COLLECT_OUTPUT_BUSY",
          });
        }
      }
      // The winner releases cleanly and leaves no takeover residue behind.
      await expect(fs.stat(lockPathFor(outDir))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        (await fs.readdir(path.join(outDir, ".state"))).filter((entry) =>
          entry.includes(".stale-"),
        ),
      ).toEqual([]);
    }
  }, 120_000);

  it("writes private modes on shards, checkpoints, and state directories", async () => {
    const outDir = await makeTempDir();
    const transport = new FakeGmailTransport(ACCOUNT, baseSpecs());
    const result = await collect(transport, outDir);
    if (process.platform !== "win32") {
      const shardMode = (await fs.stat(result.shardPaths[0])).mode & 0o777;
      expect(shardMode).toBe(0o600);
      const checkpointMode =
        (await fs.stat(result.checkpointPath)).mode & 0o777;
      expect(checkpointMode).toBe(0o600);
      const stateDirMode =
        (await fs.stat(path.join(outDir, ".state"))).mode & 0o777;
      expect(stateDirMode).toBe(0o700);
    }
  });

  it("rejects a malformed transport response instead of fabricating rows", async () => {
    const outDir = await makeTempDir();
    const transport = new FakeGmailTransport(ACCOUNT, baseSpecs());
    transport.getMessage = async () => ({ nonsense: true });
    await expect(collect(transport, outDir)).rejects.toMatchObject({
      code: "GMAIL_COLLECT_BAD_RESPONSE",
    });
  });

  it("recovers a torn staging row by refetching only that message", async () => {
    const outDir = await makeTempDir();
    const transport = new FakeGmailTransport(ACCOUNT, baseSpecs());
    // Interrupt after the first fetch batch by failing m3 through all attempts.
    transport.failGetMessageOnce.add("m3");
    await expect(
      collect(transport, outDir, { maxAttempts: 1 }),
    ).rejects.toMatchObject({ code: "GMAIL_COLLECT_TRANSPORT_FAILED" });

    // Corrupt the staged tail as an interrupted append would.
    const stagingPath = path.join(
      outDir,
      ".state",
      `gmail-${ACCOUNT_SEGMENT}-staging.ndjson`,
    );
    const staged = await fs.readFile(stagingPath, "utf8");
    await fs.writeFile(stagingPath, `${staged.trimEnd().slice(0, -5)}\n`);

    const resumed = new FakeGmailTransport(ACCOUNT, baseSpecs());
    const result = await collect(resumed, outDir);
    expect(result.summary.mode).toBe("resume");
    expect(result.manifest.totals.messages).toBe(3);
    expect((await validateCorpusTarget(outDir)).ok).toBe(true);
  });
});
