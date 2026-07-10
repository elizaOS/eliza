/**
 * Exercises Gmail pagination, crash-resume idempotency, multi-account shard
 * layout, and manifest validation through the collector's source boundary.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import type {
  GoogleAccountRef,
  GoogleGmailExportMessage,
  GoogleGmailMessagePage,
  GoogleGmailProfile,
} from "@elizaos/plugin-google";
import { describe, expect, it, vi } from "vitest";
import {
  collectGmailCorpus,
  collectGmailCorpusFromRuntime,
  type GmailCorpusSource,
} from "./gmail.ts";

const NOW = new Date("2026-07-05T00:00:00.000Z");

function message(
  id: string,
  account: "work" | "home",
  offsetMs: number,
  overrides: Partial<GoogleGmailExportMessage> = {},
): GoogleGmailExportMessage {
  const owner = `${account}@example.test`;
  return {
    id,
    threadId: `thread-${id}`,
    internalDateMs: NOW.getTime() - offsetMs,
    historyId: `history-${id}`,
    subject: `Subject ${id}`,
    from: { email: "sender@example.test", name: "Sender" },
    to: [{ email: owner, name: "Owner" }],
    cc: [],
    snippet: `Snippet ${id}`,
    bodyText: `Body ${id}`,
    labelIds: ["INBOX"],
    headers: {},
    attachments: [],
    ...overrides,
  };
}

class Source implements GmailCorpusSource {
  readonly profileCalls = vi.fn();
  readonly pageCalls = vi.fn();
  readonly messageCalls = vi.fn();
  failToken?: string;

  constructor(
    private readonly pages: Record<
      string,
      Record<string, GoogleGmailMessagePage>
    >,
    private readonly messages: Record<string, GoogleGmailExportMessage>,
  ) {}

  async getGmailProfile(params: GoogleAccountRef): Promise<GoogleGmailProfile> {
    this.profileCalls(params);
    return {
      emailAddress: `${params.accountId}@example.test`,
      historyId: `profile-${params.accountId}`,
    };
  }

  async listGmailMessagePage(
    params: GoogleAccountRef & { pageToken?: string },
  ): Promise<GoogleGmailMessagePage> {
    this.pageCalls(params);
    const token = params.pageToken ?? "first";
    if (token === this.failToken) {
      throw new Error(`planned failure at ${token}`);
    }
    const page = this.pages[params.accountId]?.[token];
    if (!page) throw new Error(`missing page ${params.accountId}:${token}`);
    return page;
  }

  async getGmailExportMessage(
    params: GoogleAccountRef & { messageId: string },
  ): Promise<GoogleGmailExportMessage> {
    this.messageCalls(params);
    const found = this.messages[params.messageId];
    if (!found) throw new Error(`missing message ${params.messageId}`);
    return found;
  }
}

describe("Gmail corpus collector", () => {
  it("requires the account-scoped Google service on runtime entry", async () => {
    const collection = collectGmailCorpusFromRuntime(
      { getService: () => null } as never,
      {
        accounts: [{ accountId: "work" }],
        outputDir: path.join(tmpdir(), "missing-google-service"),
      },
    );

    await expect(collection).rejects.toBeInstanceOf(ElizaError);
    await expect(collection).rejects.toMatchObject({
      code: "GMAIL_CORPUS_SERVICE_UNAVAILABLE",
      severity: "fatal",
    });
  });

  it("writes two account histories into validated monthly shards", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "gmail-corpus-"));
    const source = new Source(
      {
        work: {
          first: { messageIds: ["work-in", "work-out"] },
        },
        home: {
          first: { messageIds: ["home-html", "home-attachment"] },
        },
      },
      {
        "work-in": message("work-in", "work", 60_000),
        "work-out": message("work-out", "work", 120_000, {
          from: { email: "work@example.test", name: "Owner" },
          to: [{ email: "client@example.test", name: "Client" }],
          headers: { "In-Reply-To": "work-in" },
        }),
        "home-html": message("home-html", "home", 180_000, {
          bodyText: undefined,
          bodyHtml: "<p>Hello <strong>home</strong></p>",
        }),
        "home-attachment": message("home-attachment", "home", 240_000, {
          bodyText: "",
          attachments: [
            {
              filename: "receipt.pdf",
              mimeType: "application/pdf",
              sha256: "a".repeat(64),
              bytes: 12,
            },
          ],
        }),
      },
    );

    const result = await collectGmailCorpus({
      source,
      accounts: [{ accountId: "work" }, { accountId: "home" }],
      outputDir,
      now: () => NOW,
    });

    expect(result.manifest.totals.messages).toBe(4);
    expect(result.manifest.shards).toHaveLength(2);
    expect(result.accounts).toEqual([
      expect.objectContaining({
        accountId: "work",
        writtenMessages: 2,
        completed: true,
      }),
      expect.objectContaining({
        accountId: "home",
        writtenMessages: 2,
        completed: true,
      }),
    ]);
    const homeRows = (
      await readFile(
        path.join(outputDir, "gmail", "home", "2026-07.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    expect(homeRows).toEqual([
      expect.objectContaining({ id: "home-attachment", text: "" }),
      expect.objectContaining({ id: "home-html", text: "Hello home" }),
    ]);
    expect(
      JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8")),
    ).toEqual(result.manifest);
  });

  it("resumes at the durable page token without duplicating committed rows", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "gmail-resume-"));
    const pages = {
      work: {
        first: { messageIds: ["page-one"], nextPageToken: "second" },
        second: { messageIds: ["page-two"] },
      },
    };
    const messages = {
      "page-one": message("page-one", "work", 60_000),
      "page-two": message("page-two", "work", 120_000),
    };
    const interrupted = new Source(pages, messages);
    interrupted.failToken = "second";

    await expect(
      collectGmailCorpus({
        source: interrupted,
        accounts: [{ accountId: "work" }],
        outputDir,
        now: () => NOW,
      }),
    ).rejects.toThrow("planned failure at second");

    const resumed = new Source(pages, messages);
    const result = await collectGmailCorpus({
      source: resumed,
      accounts: [{ accountId: "work" }],
      outputDir,
      now: () => NOW,
    });

    expect(resumed.pageCalls).toHaveBeenCalledTimes(1);
    expect(resumed.pageCalls).toHaveBeenCalledWith(
      expect.objectContaining({ pageToken: "second" }),
    );
    expect(resumed.messageCalls).toHaveBeenCalledTimes(1);
    expect(result.manifest.totals.messages).toBe(2);
    expect(result.accounts[0]).toMatchObject({
      processedMessages: 2,
      writtenMessages: 1,
      duplicateMessages: 0,
      completed: true,
    });

    const completedRerun = new Source({}, {});
    const rerun = await collectGmailCorpus({
      source: completedRerun,
      accounts: [{ accountId: "work" }],
      outputDir,
      now: () => NOW,
    });
    expect(completedRerun.profileCalls).not.toHaveBeenCalled();
    expect(completedRerun.pageCalls).not.toHaveBeenCalled();
    expect(rerun.manifest.totals.messages).toBe(2);
  });

  it("fails fast when a checkpoint is reused for a different query", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "gmail-query-"));
    const source = new Source({ work: { first: { messageIds: [] } } }, {});
    await collectGmailCorpus({
      source,
      accounts: [{ accountId: "work" }],
      outputDir,
      query: "after:2025/01/01 before:2026/01/01",
      now: () => NOW,
    });

    await expect(
      collectGmailCorpus({
        source,
        accounts: [{ accountId: "work" }],
        outputDir,
        query: "after:2024/01/01 before:2026/01/01",
        now: () => NOW,
      }),
    ).rejects.toThrow("different account or query");
  });

  it("rejects a repeated page token before advancing its checkpoint", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "gmail-token-"));
    const source = new Source(
      {
        work: {
          first: { messageIds: ["page-one"], nextPageToken: "repeat" },
          repeat: { messageIds: ["page-two"], nextPageToken: "repeat" },
        },
      },
      {
        "page-one": message("page-one", "work", 60_000),
        "page-two": message("page-two", "work", 120_000),
      },
    );

    await expect(
      collectGmailCorpus({
        source,
        accounts: [{ accountId: "work" }],
        outputDir,
        now: () => NOW,
      }),
    ).rejects.toThrow("repeated page token");

    const checkpoint = JSON.parse(
      await readFile(path.join(outputDir, ".state", "gmail-work.json"), "utf8"),
    );
    expect(checkpoint).toMatchObject({
      pageToken: "repeat",
      processedMessages: 1,
      completed: false,
    });
  });

  it("rejects API rows outside the frozen corpus window", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "gmail-window-"));
    const source = new Source(
      { work: { first: { messageIds: ["future"] } } },
      {
        future: message("future", "work", -1),
      },
    );

    await expect(
      collectGmailCorpus({
        source,
        accounts: [{ accountId: "work" }],
        outputDir,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({
      code: "GMAIL_CORPUS_MESSAGE_OUTSIDE_WINDOW",
      context: { messageId: "future", timestamp: NOW.getTime() + 1 },
      severity: "fatal",
    });
  });
});
