import { PGlite } from "@electric-sql/pglite";
import type { LifeOpsGmailSpamReviewItem } from "../contracts/index.js";
import type { IAgentRuntime } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifeOpsRepository } from "./repository.js";

const BOOTSTRAP = `CREATE TABLE IF NOT EXISTS life_gmail_spam_review_items (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  side TEXT NOT NULL DEFAULT 'owner',
  grant_id TEXT NOT NULL DEFAULT '',
  account_email TEXT,
  message_id TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  from_display TEXT NOT NULL,
  from_email TEXT,
  received_at TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  label_ids_json TEXT NOT NULL DEFAULT '[]',
  rationale TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT,
  UNIQUE(agent_id, provider, side, grant_id, external_message_id)
)`;

const AGENT_ID = "agent-gmail-spam-review";

interface Harness {
  runtime: IAgentRuntime;
  repository: LifeOpsRepository;
  pgClient: PGlite;
}

function item(
  overrides: Partial<LifeOpsGmailSpamReviewItem> = {},
): LifeOpsGmailSpamReviewItem {
  return {
    id: "life-gmail-spam-1",
    agentId: AGENT_ID,
    provider: "google",
    side: "owner",
    grantId: "grant-1",
    accountEmail: "owner@example.test",
    messageId: "life-gmail-1",
    externalMessageId: "gmail-ext-1",
    threadId: "thread-1",
    subject: "Sketchy invoice",
    from: "Sketchy Sender",
    fromEmail: "sender@example.test",
    receivedAt: "2026-04-22T12:00:00.000Z",
    snippet: "open this attachment",
    labels: ["SPAM"],
    rationale: "Gmail labels this message as spam.",
    confidence: 0.92,
    status: "pending",
    createdAt: "2026-04-22T12:01:00.000Z",
    updatedAt: "2026-04-22T12:01:00.000Z",
    reviewedAt: null,
    ...overrides,
  };
}

async function createHarness(): Promise<Harness> {
  const pgClient = new PGlite();
  const db = drizzle(pgClient);
  await db.execute(sql.raw(BOOTSTRAP));
  const runtime = {
    agentId: AGENT_ID,
    adapter: { db },
  } as unknown as IAgentRuntime;
  return {
    runtime,
    repository: new LifeOpsRepository(runtime),
    pgClient,
  };
}

describe("LifeOps Gmail spam review repository", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.pgClient.close();
  });

  it("persists spam review items idempotently without resetting reviewed status", async () => {
    await harness.repository.upsertGmailSpamReviewItem(item());
    await harness.repository.updateGmailSpamReviewItemStatus(
      AGENT_ID,
      "google",
      "life-gmail-spam-1",
      "not_spam",
      "2026-04-22T12:05:00.000Z",
      "2026-04-22T12:05:00.000Z",
    );
    await harness.repository.upsertGmailSpamReviewItem(
      item({
        id: "life-gmail-spam-1-new-attempt",
        subject: "Updated sketchy invoice",
        rationale: "Updated spam rationale.",
        confidence: 0.88,
        updatedAt: "2026-04-22T12:10:00.000Z",
      }),
    );

    const items = await harness.repository.listGmailSpamReviewItems(
      AGENT_ID,
      "google",
      { maxResults: 10 },
      "owner",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "life-gmail-spam-1",
      subject: "Updated sketchy invoice",
      status: "not_spam",
      reviewedAt: "2026-04-22T12:05:00.000Z",
      rationale: "Updated spam rationale.",
    });
  });

  it("filters queue items by status and updates review timestamps", async () => {
    await harness.repository.upsertGmailSpamReviewItem(item());
    await harness.repository.updateGmailSpamReviewItemStatus(
      AGENT_ID,
      "google",
      "life-gmail-spam-1",
      "confirmed_spam",
      "2026-04-22T12:30:00.000Z",
      "2026-04-22T12:30:00.000Z",
    );

    const pending = await harness.repository.listGmailSpamReviewItems(
      AGENT_ID,
      "google",
      { maxResults: 10, status: "pending" },
      "owner",
    );
    const confirmed = await harness.repository.listGmailSpamReviewItems(
      AGENT_ID,
      "google",
      { maxResults: 10, status: "confirmed_spam" },
      "owner",
    );

    expect(pending).toEqual([]);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.reviewedAt).toBe("2026-04-22T12:30:00.000Z");
  });
});
