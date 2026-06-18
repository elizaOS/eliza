/**
 * InboxUnsubscribeService unit tests.
 *
 * The service is the standalone successor to PA's `service-mixin-email-unsubscribe`.
 * We inject a mock {@link InboxGmailGateway} (so no `@elizaos/plugin-google`
 * runtime service or connector-account manager is needed) and a fake in-memory
 * repository, then assert: List-Unsubscribe header parsing → sender scan, the
 * two-phase authorization gate, the HTTP one-click / mailto branches, the Gmail
 * manage capability gate for block/trash, and that the outcome is persisted.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EmailUnsubscribeRecord,
  EmailUnsubscribeRequest,
} from "../src/inbox/email-unsubscribe-types.ts";
import type { InboxGmailGateway } from "../src/inbox/google-gmail-seam.ts";
import type { InboxUnsubscribeRepository } from "../src/inbox/unsubscribe-repository.ts";
import { InboxUnsubscribeService } from "../src/inbox/unsubscribe-service.ts";

const AGENT_ID = "11111111-1111-1111-1111-111111111111" as UUID;

function makeRuntime(): IAgentRuntime {
  return { agentId: AGENT_ID } as unknown as IAgentRuntime;
}

function fakeRepository(): {
  repository: InboxUnsubscribeRepository;
  records: EmailUnsubscribeRecord[];
} {
  const records: EmailUnsubscribeRecord[] = [];
  const repository = {
    createEmailUnsubscribe: async (record: EmailUnsubscribeRecord) => {
      records.push(record);
    },
    listEmailUnsubscribes: async (args: { limit?: number } = {}) =>
      records.slice(0, args.limit ?? 100),
    getEmailUnsubscribe: async (id: string) =>
      records.find((record) => record.id === id) ?? null,
    findEmailUnsubscribeBySender: async (senderEmail: string) =>
      records.find(
        (record) => record.senderEmail === senderEmail.trim().toLowerCase(),
      ) ?? null,
  } as unknown as InboxUnsubscribeRepository;
  return { repository, records };
}

function grant(capabilities: string[]) {
  return {
    id: "connector-account:acct-1",
    agentId: AGENT_ID,
    provider: "google" as const,
    connectorAccountId: "acct-1",
    side: "owner" as const,
    identity: {},
    identityEmail: "owner@example.com",
    grantedScopes: [],
    capabilities,
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
  };
}

/** A Gmail message-summary shape with List-Unsubscribe headers in metadata. */
function gmailMessage(args: {
  id: string;
  fromEmail: string;
  from?: string;
  subject?: string;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  listId?: string;
}) {
  const headers: Record<string, string> = {};
  if (args.listUnsubscribe) headers["List-Unsubscribe"] = args.listUnsubscribe;
  if (args.listUnsubscribePost)
    headers["List-Unsubscribe-Post"] = args.listUnsubscribePost;
  if (args.listId) headers["List-Id"] = args.listId;
  return {
    id: `${AGENT_ID}:google:owner:gmail:${args.id}`,
    externalId: args.id,
    agentId: AGENT_ID,
    provider: "google" as const,
    side: "owner" as const,
    threadId: `thread-${args.id}`,
    subject: args.subject ?? "Weekly digest",
    from: args.from ?? args.fromEmail,
    fromEmail: args.fromEmail,
    replyTo: null,
    to: [],
    cc: [],
    snippet: "",
    receivedAt: "2026-06-17T08:00:00.000Z",
    isUnread: true,
    isImportant: false,
    likelyReplyNeeded: false,
    triageScore: 70,
    triageReason: "Unread inbox message.",
    labels: ["UNREAD", "INBOX"],
    htmlLink: null,
    metadata: { googlePlugin: true, headers },
    syncedAt: "2026-06-17T08:00:00.000Z",
    updatedAt: "2026-06-17T08:00:00.000Z",
    connectorAccountId: "acct-1",
    grantId: "connector-account:acct-1",
    accountEmail: "owner@example.com",
  };
}

function makeGateway(
  overrides: Partial<InboxGmailGateway> & {
    capabilities?: string[];
    messages?: ReturnType<typeof gmailMessage>[];
  } = {},
): InboxGmailGateway {
  const capabilities = overrides.capabilities ?? ["google.gmail.triage"];
  const messages = overrides.messages ?? [];
  return {
    requireGmailGrant:
      overrides.requireGmailGrant ?? vi.fn(async () => grant(capabilities)),
    searchGmail:
      overrides.searchGmail ??
      vi.fn(async () => ({
        query: "scan",
        messages,
        source: "synced" as const,
        syncedAt: "2026-06-17T08:00:00.000Z",
        summary: {
          totalCount: messages.length,
          unreadCount: messages.length,
          importantCount: 0,
          replyNeededCount: 0,
        },
      })),
    sendMailtoUnsubscribeEmail:
      overrides.sendMailtoUnsubscribeEmail ?? vi.fn(async () => undefined),
    createGmailFilterForSender:
      overrides.createGmailFilterForSender ??
      vi.fn(async () => ({ filterId: "filter-1" })),
    trashGmailThread:
      overrides.trashGmailThread ?? vi.fn(async () => undefined),
  };
}

function makeService(gmail: InboxGmailGateway) {
  const { repository, records } = fakeRepository();
  const service = new InboxUnsubscribeService(makeRuntime(), {
    gmail,
    repository,
  });
  return { service, records };
}

describe("InboxUnsubscribeService", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockReset();
  });

  describe("scanEmailSubscriptions", () => {
    it("groups senders and classifies the unsubscribe method from headers", async () => {
      const gateway = makeGateway({
        messages: [
          gmailMessage({
            id: "m1",
            fromEmail: "news@brand.com",
            from: "Brand News",
            listUnsubscribe: "<https://brand.com/unsub>",
            listUnsubscribePost: "List-Unsubscribe=One-Click",
            listId: "brand-news",
          }),
          gmailMessage({
            id: "m2",
            fromEmail: "news@brand.com",
            from: "Brand News",
            listUnsubscribe: "<https://brand.com/unsub>",
          }),
          gmailMessage({
            id: "m3",
            fromEmail: "promo@shop.com",
            from: "Shop Promo",
            listUnsubscribe: "<mailto:unsub@shop.com>",
          }),
        ],
      });
      const { service } = makeService(gateway);

      const result = await service.scanEmailSubscriptions();

      expect(result.summary.scannedMessageCount).toBe(3);
      expect(result.summary.uniqueSenderCount).toBe(2);
      expect(result.summary.oneClickEligibleCount).toBe(1);
      expect(result.summary.mailtoOnlyCount).toBe(1);

      const brand = result.senders.find(
        (sender) => sender.senderEmail === "news@brand.com",
      );
      expect(brand?.messageCount).toBe(2);
      expect(brand?.unsubscribeMethod).toBe("http_one_click");
      expect(brand?.unsubscribeHttpUrl).toBe("https://brand.com/unsub");
      expect(brand?.listId).toBe("brand-news");

      const shop = result.senders.find(
        (sender) => sender.senderEmail === "promo@shop.com",
      );
      expect(shop?.unsubscribeMethod).toBe("mailto");
      expect(shop?.unsubscribeMailto).toBe("mailto:unsub@shop.com");
    });

    it("falls back to manual_only when no List-Unsubscribe header is present", async () => {
      const gateway = makeGateway({
        messages: [gmailMessage({ id: "m1", fromEmail: "x@y.com" })],
      });
      const { service } = makeService(gateway);
      const result = await service.scanEmailSubscriptions();
      expect(result.senders[0]?.unsubscribeMethod).toBe("manual_only");
      expect(result.summary.manualOnlyCount).toBe(1);
    });
  });

  describe("unsubscribeEmailSender authorization gate", () => {
    it("rejects without explicit userAuthorization (HTTP 409)", async () => {
      const { service } = makeService(makeGateway());
      const request: EmailUnsubscribeRequest = {
        senderEmail: "news@brand.com",
      };
      await expect(service.unsubscribeEmailSender(request)).rejects.toThrow(
        /explicit user authorization/,
      );
    });
  });

  describe("unsubscribeEmailSender execution", () => {
    it("performs an HTTP one-click POST and records success", async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        url: "https://brand.com/unsub/done",
      } as Response);
      const gateway = makeGateway({
        messages: [
          gmailMessage({
            id: "m1",
            fromEmail: "news@brand.com",
            listUnsubscribe: "<https://brand.com/unsub>",
            listUnsubscribePost: "List-Unsubscribe=One-Click",
          }),
        ],
      });
      const { service, records } = makeService(gateway);

      const { record } = await service.unsubscribeEmailSender({
        senderEmail: "news@brand.com",
        userAuthorization: true,
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://brand.com/unsub",
        expect.objectContaining({ method: "POST" }),
      );
      expect(record.method).toBe("http_one_click");
      expect(record.status).toBe("succeeded");
      expect(record.httpStatusCode).toBe(200);
      expect(record.httpFinalUrl).toBe("https://brand.com/unsub/done");
      expect(records).toHaveLength(1);
      expect(records[0]?.metadata.connectorAccountId).toBe("acct-1");
    });

    it("sends a mailto unsubscribe through the Gmail gateway", async () => {
      const sendMailto = vi.fn(async () => undefined);
      const gateway = makeGateway({
        sendMailtoUnsubscribeEmail: sendMailto,
        messages: [
          gmailMessage({
            id: "m1",
            fromEmail: "promo@shop.com",
            listUnsubscribe: "<mailto:unsub@shop.com?subject=stop>",
          }),
        ],
      });
      const { service } = makeService(gateway);

      const { record } = await service.unsubscribeEmailSender({
        senderEmail: "promo@shop.com",
        userAuthorization: true,
      });

      expect(sendMailto).toHaveBeenCalledWith("acct-1", {
        recipient: "unsub@shop.com",
        subject: "stop",
        body: null,
      });
      expect(record.method).toBe("mailto");
      expect(record.status).toBe("succeeded");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("requires gmail.manage capability before blocking/trashing", async () => {
      const gateway = makeGateway({
        capabilities: ["google.gmail.triage"],
        messages: [
          gmailMessage({
            id: "m1",
            fromEmail: "news@brand.com",
            listUnsubscribe: "<https://brand.com/unsub>",
          }),
        ],
      });
      const { service, records } = makeService(gateway);

      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        url: "https://brand.com/unsub",
      } as Response);

      const { record } = await service.unsubscribeEmailSender({
        senderEmail: "news@brand.com",
        userAuthorization: true,
        blockAfter: true,
      });

      // The manage gate fails inside the try → status becomes "failed" and the
      // error is recorded rather than thrown out of the service.
      expect(record.status).toBe("failed");
      expect(record.errorMessage).toMatch(/Gmail manage access/);
      expect(record.filterCreated).toBe(false);
      expect(records).toHaveLength(1);
    });

    it("creates a block filter and trashes threads when manage is granted", async () => {
      const createFilter = vi.fn(async () => ({ filterId: "filter-9" }));
      const trash = vi.fn(async () => undefined);
      const gateway = makeGateway({
        capabilities: ["google.gmail.triage", "google.gmail.manage"],
        createGmailFilterForSender: createFilter,
        trashGmailThread: trash,
        messages: [
          gmailMessage({
            id: "m1",
            fromEmail: "news@brand.com",
            listUnsubscribe: "<https://brand.com/unsub>",
          }),
        ],
      });
      const { service } = makeService(gateway);

      fetchSpy.mockResolvedValue({
        ok: true,
        status: 202,
        url: "https://brand.com/unsub",
      } as Response);

      const { record } = await service.unsubscribeEmailSender({
        senderEmail: "news@brand.com",
        userAuthorization: true,
        blockAfter: true,
        trashExisting: true,
      });

      expect(createFilter).toHaveBeenCalledWith("acct-1", "news@brand.com");
      expect(trash).toHaveBeenCalledWith("acct-1", "thread-m1");
      expect(record.filterCreated).toBe(true);
      expect(record.filterId).toBe("filter-9");
      expect(record.threadsTrashed).toBe(1);
      expect(record.status).toBe("succeeded");
    });

    it("records blocked_no_mechanism when no unsubscribe surface exists", async () => {
      const gateway = makeGateway({
        messages: [gmailMessage({ id: "m1", fromEmail: "noheaders@x.com" })],
      });
      const { service } = makeService(gateway);

      const { record } = await service.unsubscribeEmailSender({
        senderEmail: "noheaders@x.com",
        userAuthorization: true,
      });

      expect(record.status).toBe("blocked_no_mechanism");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("summarizeEmailUnsubscribeScan", () => {
    it("summarizes an empty scan and a populated scan", async () => {
      const { service } = makeService(makeGateway());
      const empty = service.summarizeEmailUnsubscribeScan({
        syncedAt: "now",
        query: "q",
        summary: {
          scannedMessageCount: 12,
          uniqueSenderCount: 0,
          oneClickEligibleCount: 0,
          mailtoOnlyCount: 0,
          manualOnlyCount: 0,
        },
        senders: [],
      });
      expect(empty).toMatch(/No active promotional senders/);

      const populated = service.summarizeEmailUnsubscribeScan({
        syncedAt: "now",
        query: "q",
        summary: {
          scannedMessageCount: 3,
          uniqueSenderCount: 1,
          oneClickEligibleCount: 1,
          mailtoOnlyCount: 0,
          manualOnlyCount: 0,
        },
        senders: [
          {
            senderEmail: "news@brand.com",
            senderDisplay: "Brand",
            senderDomain: "brand.com",
            listId: null,
            messageCount: 3,
            firstSeenAt: "now",
            latestSeenAt: "now",
            unsubscribeMethod: "http_one_click",
            unsubscribeHttpUrl: "https://brand.com/unsub",
            unsubscribeMailto: null,
            listUnsubscribePost: null,
            sampleSubjects: [],
            latestMessageId: "m1",
            latestThreadId: "t1",
            allMessageIds: ["m1"],
            allThreadIds: ["t1"],
          },
        ],
      });
      expect(populated).toMatch(/Found 1 senders across 3 messages/);
      expect(populated).toMatch(
        /Brand <news@brand.com>: 3 msgs, http_one_click/,
      );
    });
  });
});
