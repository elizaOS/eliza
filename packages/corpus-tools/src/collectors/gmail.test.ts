/**
 * Deterministic unit and integration coverage for the Gmail collector against
 * an in-memory fake transport that speaks real Gmail API response shapes. The
 * harness is real at the filesystem boundary (shards, checkpoints, staging,
 * manifest under a temp directory) with no network and no mocked module
 * collaborators; retries use an injected recording sleep.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORPUS_ANCHOR_MS, CORPUS_CUTOFF_MS } from "../schema.ts";
import { validateCorpusTarget } from "../validator.ts";
import {
  collectGmail,
  type GmailTransport,
  GmailTransportError,
  gmailCorpusQuery,
} from "./gmail.ts";

const ACCOUNT = "owner@example.com";
const ALIAS = "owner.alias@example.com";

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

interface HistoryDeltaSpec {
  added?: FakeMessageSpec[];
  deletedIds?: string[];
  expired?: boolean;
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

  async listHistory(
    startHistoryId: string,
    _pageToken?: string,
  ): Promise<unknown> {
    this.calls.push(`history:${startHistoryId}`);
    const delta = this.historyDelta;
    if (!delta || delta.expired) {
      throw new GmailTransportError("history expired", { status: 404 });
    }
    for (const spec of delta.added ?? []) {
      if (!this.messages.has(spec.id)) this.addMessage(spec);
    }
    return {
      history: [
        {
          messagesAdded: (delta.added ?? []).map((spec) => ({
            message: { id: spec.id },
          })),
          messagesDeleted: (delta.deletedIds ?? []).map((id) => ({
            message: { id },
          })),
        },
      ],
      historyId: this.historyId,
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
    expect(result.summary.attachmentsHashed).toBe(2);
    expect(result.manifest.totals.messages).toBe(3);
    expect(result.shardPaths).toHaveLength(2);
    // Exhaustive pagination: 6 ids at page size 2 needs 3 list pages.
    expect(
      transport.calls.filter((call) => call.startsWith("list:")),
    ).toHaveLength(3);

    const rows = (
      await fs.readFile(
        path.join(outDir, "gmail", ACCOUNT, "2024-07.jsonl"),
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
          path.join(outDir, "gmail", ACCOUNT, "2024-08.jsonl"),
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
    const shardPath = path.join(outDir, "gmail", ACCOUNT, "2024-07.jsonl");
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
      path.join(outDir, "gmail", ACCOUNT, "2024-07.jsonl"),
      "utf8",
    );
    expect(july).not.toContain(`gmail:${ACCOUNT}:m1`);
    expect(
      await fs.readFile(
        path.join(outDir, "gmail", ACCOUNT, "2024-09.jsonl"),
        "utf8",
      ),
    ).toContain(`gmail:${ACCOUNT}:m7`);
    expect((await validateCorpusTarget(outDir)).ok).toBe(true);
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

  it("fails closed when another collector holds the account lock", async () => {
    const outDir = await makeTempDir();
    const lockPath = path.join(
      outDir,
      ".state",
      "gmail-owner_example_com.lock",
    );
    await fs.mkdir(lockPath, { recursive: true });
    const transport = new FakeGmailTransport(ACCOUNT, baseSpecs());
    await expect(collect(transport, outDir)).rejects.toMatchObject({
      code: "GMAIL_COLLECT_OUTPUT_BUSY",
    });
  });

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
      "gmail-owner_example_com-staging.ndjson",
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
