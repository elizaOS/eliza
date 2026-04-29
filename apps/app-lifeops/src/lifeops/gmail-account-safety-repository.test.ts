import { PGlite } from "@electric-sql/pglite";
import type {
  LifeOpsConnectorGrant,
  LifeOpsGmailMessageSummary,
} from "../contracts/index.js";
import type { IAgentRuntime } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLifeOpsConnectorGrant,
  createLifeOpsGmailSyncState,
  LifeOpsRepository,
} from "./repository.js";
import { LifeOpsService } from "./service.js";

const BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS life_connector_grants (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  side TEXT NOT NULL DEFAULT 'owner',
  identity_json TEXT NOT NULL DEFAULT '{}',
  identity_email TEXT,
  granted_scopes_json TEXT NOT NULL DEFAULT '[]',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  token_ref TEXT,
  mode TEXT NOT NULL DEFAULT 'oauth',
  execution_target TEXT NOT NULL DEFAULT 'local',
  source_of_truth TEXT NOT NULL DEFAULT 'local_storage',
  preferred_by_agent BOOLEAN NOT NULL DEFAULT false,
  cloud_connection_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  last_refresh_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_id, provider, side, mode, identity_email)
);

CREATE TABLE IF NOT EXISTS life_gmail_messages (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  side TEXT NOT NULL DEFAULT 'owner',
  external_message_id TEXT NOT NULL,
  grant_id TEXT,
  thread_id TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  from_display TEXT NOT NULL DEFAULT '',
  from_email TEXT,
  reply_to TEXT,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  snippet TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  is_unread BOOLEAN NOT NULL DEFAULT true,
  is_important BOOLEAN NOT NULL DEFAULT false,
  likely_reply_needed BOOLEAN NOT NULL DEFAULT false,
  triage_score INTEGER NOT NULL DEFAULT 0,
  triage_reason TEXT NOT NULL DEFAULT '',
  label_ids_json TEXT NOT NULL DEFAULT '[]',
  html_link TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_id, provider, side, grant_id, external_message_id)
);

CREATE TABLE IF NOT EXISTS life_gmail_sync_states (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  side TEXT NOT NULL DEFAULT 'owner',
  mailbox TEXT NOT NULL,
  grant_id TEXT,
  max_results INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_id, provider, side, grant_id, mailbox)
);

CREATE TABLE IF NOT EXISTS life_gmail_spam_review_items (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  side TEXT NOT NULL DEFAULT 'owner',
  grant_id TEXT NOT NULL,
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

const AGENT_ID = "agent-gmail-account-safety";

interface Harness {
  runtime: IAgentRuntime;
  repository: LifeOpsRepository;
  pgClient: PGlite;
}

function message(
  grantId: string,
  overrides: Partial<LifeOpsGmailMessageSummary> = {},
): LifeOpsGmailMessageSummary {
  const now = "2026-04-22T12:00:00.000Z";
  return {
    id: `life-gmail-${grantId}`,
    externalId: "same-gmail-message",
    grantId,
    accountEmail: `${grantId}@example.test`,
    agentId: AGENT_ID,
    provider: "google",
    side: "owner",
    threadId: `thread-${grantId}`,
    subject: `Subject ${grantId}`,
    from: "Sender",
    fromEmail: "sender@example.test",
    replyTo: null,
    to: [`${grantId}@example.test`],
    cc: [],
    snippet: "snippet",
    receivedAt: now,
    isUnread: true,
    isImportant: false,
    likelyReplyNeeded: false,
    triageScore: 1,
    triageReason: "unread",
    labels: ["INBOX", "UNREAD"],
    htmlLink: null,
    metadata: {},
    syncedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function grant(
  id: string,
  email: string,
  preferredByAgent: boolean,
): LifeOpsConnectorGrant {
  return {
    ...createLifeOpsConnectorGrant({
      agentId: AGENT_ID,
      provider: "google",
      side: "owner",
      identity: { email },
      grantedScopes: ["https://www.googleapis.com/auth/gmail.metadata"],
      capabilities: ["google.gmail.triage"],
      tokenRef: null,
      mode: "local",
      preferredByAgent,
      metadata: {},
      lastRefreshAt: "2026-04-22T12:00:00.000Z",
    }),
    id,
  };
}

async function createHarness(): Promise<Harness> {
  const pgClient = new PGlite();
  const db = drizzle(pgClient);
  await db.execute(sql.raw(BOOTSTRAP));
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Milady" },
    adapter: { db },
  } as unknown as IAgentRuntime;
  return {
    runtime,
    repository: new LifeOpsRepository(runtime),
    pgClient,
  };
}

describe("LifeOps Gmail account safety repository", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.pgClient.close();
  });

  it("stores two grants with the same Gmail external message id independently", async () => {
    await harness.repository.upsertGmailMessage(message("grant-a"));
    await harness.repository.upsertGmailMessage(message("grant-b"));

    const grantAMessages = await harness.repository.listGmailMessages(
      AGENT_ID,
      "google",
      { maxResults: 10, grantId: "grant-a" },
      "owner",
    );
    const grantBMessages = await harness.repository.listGmailMessages(
      AGENT_ID,
      "google",
      { maxResults: 10, grantId: "grant-b" },
      "owner",
    );

    expect(grantAMessages).toHaveLength(1);
    expect(grantAMessages[0]).toMatchObject({
      grantId: "grant-a",
      subject: "Subject grant-a",
    });
    expect(grantBMessages).toHaveLength(1);
    expect(grantBMessages[0]).toMatchObject({
      grantId: "grant-b",
      subject: "Subject grant-b",
    });
  });

  it("scopes prune and sync-state freshness to the owning Gmail grant", async () => {
    await harness.repository.upsertGmailMessage(message("grant-a"));
    await harness.repository.upsertGmailMessage(
      message("grant-a", {
        id: "life-gmail-grant-a-stale",
        externalId: "stale-grant-a-message",
      }),
    );
    await harness.repository.upsertGmailMessage(
      message("grant-b", {
        id: "life-gmail-grant-b-other",
        externalId: "stale-grant-a-message",
      }),
    );

    await harness.repository.pruneGmailMessages(
      AGENT_ID,
      "google",
      ["same-gmail-message"],
      "owner",
      "grant-a",
    );

    expect(
      await harness.repository.listGmailMessages(
        AGENT_ID,
        "google",
        { maxResults: 10, grantId: "grant-a" },
        "owner",
      ),
    ).toHaveLength(1);
    expect(
      await harness.repository.listGmailMessages(
        AGENT_ID,
        "google",
        { maxResults: 10, grantId: "grant-b" },
        "owner",
      ),
    ).toHaveLength(1);

    await harness.repository.upsertGmailSyncState(
      createLifeOpsGmailSyncState({
        agentId: AGENT_ID,
        provider: "google",
        side: "owner",
        mailbox: "me",
        grantId: "grant-a",
        maxResults: 10,
        syncedAt: "2026-04-22T12:00:00.000Z",
      }),
    );
    await harness.repository.upsertGmailSyncState(
      createLifeOpsGmailSyncState({
        agentId: AGENT_ID,
        provider: "google",
        side: "owner",
        mailbox: "me",
        grantId: "grant-b",
        maxResults: 25,
        syncedAt: "2026-04-22T12:05:00.000Z",
      }),
    );

    await harness.repository.upsertGmailSyncState(
      createLifeOpsGmailSyncState({
        agentId: AGENT_ID,
        provider: "google",
        side: "owner",
        mailbox: "me",
        grantId: "grant-a",
        maxResults: 50,
        syncedAt: "2026-04-22T12:10:00.000Z",
      }),
    );

    await expect(
      harness.repository.getGmailSyncState(
        AGENT_ID,
        "google",
        "me",
        "owner",
        "grant-a",
      ),
    ).resolves.toMatchObject({
      grantId: "grant-a",
      maxResults: 50,
    });
    await expect(
      harness.repository.getGmailSyncState(
        AGENT_ID,
        "google",
        "me",
        "owner",
        "grant-b",
      ),
    ).resolves.toMatchObject({
      grantId: "grant-b",
      maxResults: 25,
    });
  });

  it("disconnects a requested Gmail grant without deleting adjacent account cache", async () => {
    await harness.repository.upsertConnectorGrant(
      grant("grant-a", "owner-a@example.test", true),
    );
    await harness.repository.upsertConnectorGrant(
      grant("grant-b", "owner-b@example.test", false),
    );
    await harness.repository.upsertGmailMessage(message("grant-a"));
    await harness.repository.upsertGmailMessage(message("grant-b"));
    await harness.repository.upsertGmailSyncState(
      createLifeOpsGmailSyncState({
        agentId: AGENT_ID,
        provider: "google",
        side: "owner",
        mailbox: "me",
        grantId: "grant-a",
        maxResults: 10,
        syncedAt: "2026-04-22T12:00:00.000Z",
      }),
    );
    await harness.repository.upsertGmailSyncState(
      createLifeOpsGmailSyncState({
        agentId: AGENT_ID,
        provider: "google",
        side: "owner",
        mailbox: "me",
        grantId: "grant-b",
        maxResults: 10,
        syncedAt: "2026-04-22T12:00:00.000Z",
      }),
    );

    const service = new LifeOpsService(harness.runtime);
    vi.spyOn(service, "recordConnectorAudit").mockResolvedValue(undefined);

    await service.disconnectGoogleConnector(
      { side: "owner", mode: "local", grantId: "grant-a" },
      new URL("http://127.0.0.1:31337"),
    );

    const remainingGrants = await harness.repository.listConnectorGrants(AGENT_ID);
    expect(remainingGrants.map((item) => item.id)).toEqual(["grant-b"]);
    await expect(
      harness.repository.listGmailMessages(
        AGENT_ID,
        "google",
        { maxResults: 10, grantId: "grant-a" },
        "owner",
      ),
    ).resolves.toEqual([]);
    await expect(
      harness.repository.listGmailMessages(
        AGENT_ID,
        "google",
        { maxResults: 10, grantId: "grant-b" },
        "owner",
      ),
    ).resolves.toHaveLength(1);
    await expect(
      harness.repository.getGmailSyncState(
        AGENT_ID,
        "google",
        "me",
        "owner",
        "grant-a",
      ),
    ).resolves.toBeNull();
    await expect(
      harness.repository.getGmailSyncState(
        AGENT_ID,
        "google",
        "me",
        "owner",
        "grant-b",
      ),
    ).resolves.toMatchObject({ grantId: "grant-b" });
  });
});
