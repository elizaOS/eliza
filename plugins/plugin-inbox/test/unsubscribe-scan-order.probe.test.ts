/**
 * Deterministic probe for the unsubscribe scan chronology defect (#27807).
 *
 * Mocks {@link InboxGmailGateway} so `searchGmail` returns three messages from a
 * single sender in Gmail's native newest-first order (the ordering
 * `plugin-google-workspace` GoogleGmailClient.searchMessages returns from
 * `gmail.users.messages.list`). The aggregation in `scanEmailSubscriptions`
 * must derive `firstSeenAt` = oldest, `latestSeenAt` = newest, and point
 * `latestMessageId`/`latestThreadId` at the newest message regardless of
 * iteration order. This probe fails before the fix (firstSeenAt collapses to
 * the newest message) and passes after; the permanent regression coverage lives
 * in `unsubscribe-service.test.ts`.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { InboxGmailGateway } from "../src/inbox/google-gmail-seam.ts";
import type { InboxUnsubscribeRepository } from "../src/inbox/unsubscribe-repository.ts";
import { InboxUnsubscribeService } from "../src/inbox/unsubscribe-service.ts";

const AGENT_ID = "11111111-1111-1111-1111-111111111111" as UUID;

function probeMessage(id: string, receivedAt: string) {
  return {
    id: `${AGENT_ID}:google:owner:gmail:${id}`,
    externalId: id,
    agentId: AGENT_ID,
    provider: "google" as const,
    side: "owner" as const,
    threadId: `thread-${id}`,
    subject: `digest ${id}`,
    from: "Brand News",
    fromEmail: "news@brand.com",
    replyTo: null,
    to: [],
    cc: [],
    snippet: "",
    receivedAt,
    isUnread: true,
    isImportant: false,
    likelyReplyNeeded: false,
    triageScore: 70,
    triageReason: "Unread inbox message.",
    labels: ["UNREAD", "INBOX"],
    htmlLink: null,
    metadata: {
      googlePlugin: true,
      headers: { "List-Unsubscribe": "<https://brand.com/unsub>" },
    },
    syncedAt: "2026-06-17T09:00:00.000Z",
    updatedAt: "2026-06-17T09:00:00.000Z",
    connectorAccountId: "acct-1",
    grantId: "connector-account:acct-1",
    accountEmail: "owner@example.com",
  };
}

describe("scanEmailSubscriptions ordering probe (#27807)", () => {
  it("derives chronological extremes from Gmail's newest-first feed", async () => {
    // Gmail returns newest-first: m3 (newest) → m2 → m1 (oldest).
    const messages = [
      probeMessage("m3", "2026-06-17T09:00:00.000Z"),
      probeMessage("m2", "2026-06-16T09:00:00.000Z"),
      probeMessage("m1", "2026-06-15T09:00:00.000Z"),
    ];
    const gmail: InboxGmailGateway = {
      requireGmailGrant: vi.fn(async () => ({
        id: "connector-account:acct-1",
        agentId: AGENT_ID,
        provider: "google" as const,
        connectorAccountId: "acct-1",
        side: "owner" as const,
        identity: {},
        identityEmail: "owner@example.com",
        grantedScopes: [],
        capabilities: ["google.gmail.triage"],
        tokenRef: null,
        mode: "local" as const,
        executionTarget: "local" as const,
        sourceOfTruth: "connector_account" as const,
        preferredByAgent: true,
        cloudConnectionId: null,
        metadata: {},
        lastRefreshAt: null,
        createdAt: "2026-06-17T00:00:00.000Z",
        updatedAt: "2026-06-17T00:00:00.000Z",
      })),
      searchGmail: vi.fn(async () => ({
        query: "scan",
        messages,
        source: "synced" as const,
        syncedAt: "2026-06-17T09:00:00.000Z",
        summary: {
          totalCount: messages.length,
          unreadCount: messages.length,
          importantCount: 0,
          replyNeededCount: 0,
        },
      })),
      sendMailtoUnsubscribeEmail: vi.fn(async () => undefined),
      createGmailFilterForSender: vi.fn(async () => ({ filterId: null })),
      trashGmailThread: vi.fn(async () => undefined),
    } as unknown as InboxGmailGateway;
    const repository = {
      createEmailUnsubscribe: async () => undefined,
      listEmailUnsubscribes: async () => [],
    } as unknown as InboxUnsubscribeRepository;

    const service = new InboxUnsubscribeService(
      { agentId: AGENT_ID } as unknown as IAgentRuntime,
      { gmail, repository },
    );
    const result = await service.scanEmailSubscriptions();
    const sender = result.senders.find(
      (candidate) => candidate.senderEmail === "news@brand.com",
    );

    expect(sender?.firstSeenAt).toBe("2026-06-15T09:00:00.000Z");
    expect(sender?.latestSeenAt).toBe("2026-06-17T09:00:00.000Z");
    expect(sender?.latestMessageId).toBe(`${AGENT_ID}:google:owner:gmail:m3`);
    expect(sender?.latestThreadId).toBe("thread-m3");
  });
});
