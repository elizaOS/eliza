/**
 * Real-DB integration tests for the inbox triage back-end.
 *
 * Unlike `inbox-service.test.ts` / `inbox-repository.test.ts` (which fake
 * `runtime.adapter.db.execute`), this suite boots a REAL PGLite-backed
 * AgentRuntime via {@link createRealTestRuntime} and persists triage entries
 * into the carved `app_inbox.life_inbox_triage_*` tables — the same tables the
 * inbox plugin reads in production. We materialize those tables by registering
 * the two pure-drizzle table definitions via a schema-only test plugin so the
 * SQL plugin's migration runner creates them on init.
 *
 * The triage classifier calls `runtime.useModel(TEXT_SMALL)`; we register a
 * DETERMINISTIC fake model handler that returns rule-based classifier JSON, so
 * the test is fully hermetic (no network, no real LLM, no credentials).
 *
 * Every assertion is a triage-then-read-back round-trip against the live DB,
 * and source-scoped message deduplication is verified against the real table.
 */

import {
  type AgentRuntime,
  getConnectorAccountManager,
  ModelType,
  type ModelTypeName,
  type Plugin,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app/test/helpers/real-runtime.ts";
// The inbox-triage tables were carved into this plugin's own `app_inbox`
// schema; we register just the two triage table defs so the SQL plugin's
// migration runner materializes them — the exact tables the inbox plugin reads
// in production. No PA import is needed.
import {
  lifeEmailUnsubscribes,
  lifeInboxTriageEntries,
  lifeInboxTriageExamples,
} from "../src/db/schema.ts";
import { curateEmailCandidates } from "../src/inbox/email-curation.ts";
import {
  createInboxGmailGateway,
  type InboxGmailGateway,
} from "../src/inbox/google-gmail-seam.ts";
import { InboxService } from "../src/inbox/service.ts";
import type { InboundMessage } from "../src/inbox/types.ts";
import { InboxUnsubscribeRepository } from "../src/inbox/unsubscribe-repository.ts";
import { InboxUnsubscribeService } from "../src/inbox/unsubscribe-service.ts";

/**
 * Schema-only test plugin so `runtime.initialize()` runs the SQL plugin's
 * migration for the two carved `app_inbox` inbox triage tables, without pulling
 * in the inbox plugin's heavier service/repository modules.
 */
const inboxSchemaPlugin: Plugin = {
  name: "inbox-real-db-schema",
  description: "Test-only inbox triage table bootstrap.",
  schema: {
    lifeEmailUnsubscribes,
    lifeInboxTriageEntries,
    lifeInboxTriageExamples,
  },
};

/**
 * Deterministic, rule-based stand-in for the TEXT_SMALL classifier model.
 * Parses the triage prompt's `messages[i]: ... text: ...` lines and assigns a
 * classification from simple keyword rules, returning the exact
 * `{"results":[...]}` JSON shape the classifier parser expects. No LLM.
 */
function deterministicTriageModel(prompt: string): string {
  // The prompt lists one `text: <snippet>` line per message, in order.
  const texts = prompt
    .split("\n")
    .filter((line) => line.trim().startsWith("text:"))
    .map((line) => line.slice(line.indexOf("text:") + "text:".length).trim());

  const results = texts.map((text) => {
    const lower = text.toLowerCase();
    if (lower.includes("urgent") || lower.includes("asap")) {
      return {
        classification: "urgent",
        urgency: "high",
        confidence: 0.95,
        reasoning: "Contains urgency keyword.",
        suggestedResponse: "On it — will handle right away.",
      };
    }
    if (lower.includes("?") || lower.includes("can you")) {
      return {
        classification: "needs_reply",
        urgency: "medium",
        confidence: 0.8,
        reasoning: "Question expecting a response.",
        suggestedResponse: null,
      };
    }
    if (lower.includes("newsletter") || lower.includes("unsubscribe")) {
      return {
        classification: "ignore",
        urgency: "low",
        confidence: 0.9,
        reasoning: "Automated newsletter.",
        suggestedResponse: null,
      };
    }
    return {
      classification: "info",
      urgency: "low",
      confidence: 0.7,
      reasoning: "Informational.",
      suggestedResponse: null,
    };
  });

  return JSON.stringify({ results });
}

function inbound(
  overrides: Partial<InboundMessage> & { id: string; text: string },
): InboundMessage {
  return {
    source: "discord",
    senderName: "Test Sender",
    channelName: "general",
    channelType: "dm",
    snippet: overrides.text.slice(0, 80),
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("InboxService + InboxRepository — real PGLite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let service: InboxService;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "inbox-real-db-tests",
      // Registering the schema plugin makes runtime.initialize() create the
      // app_inbox.life_inbox_triage_* tables via the SQL plugin migration.
      plugins: [inboxSchemaPlugin],
    });
    runtime = testResult.runtime;

    // Deterministic TEXT_SMALL handler so triage is hermetic (no LLM).
    runtime.registerModel(
      ModelType.TEXT_SMALL as ModelTypeName,
      async (_rt, params) =>
        deterministicTriageModel(
          String((params as { prompt?: string }).prompt),
        ),
      "inbox-real-db-test",
      100,
    );

    service = new InboxService(runtime);
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("triages a batch, persists entries, and reads them back from the DB", async () => {
    const result = await service.triage([
      inbound({ id: "msg-urgent", text: "URGENT: server is down ASAP" }),
      inbound({ id: "msg-question", text: "Can you review my PR today?" }),
      inbound({ id: "msg-news", text: "Weekly newsletter — unsubscribe link" }),
    ]);

    expect(result.triaged).toHaveLength(3);
    expect(result.triaged.map((t) => t.classification)).toEqual([
      "urgent",
      "needs_reply",
      "ignore",
    ]);
    // Every non-classifyOnly triage persisted an entry.
    expect(result.triaged.every((t) => t.entry !== undefined)).toBe(true);

    // Round-trip: the urgent entry is really in the DB, urgency-ordered first.
    const queue = await service.list();
    const urgentEntry = queue.find((e) => e.sourceMessageId === "msg-urgent");
    expect(urgentEntry).toBeTruthy();
    expect(urgentEntry?.classification).toBe("urgent");
    expect(urgentEntry?.urgency).toBe("high");
    expect(urgentEntry?.suggestedResponse).toBe(
      "On it — will handle right away.",
    );
    // High-urgency item sorts ahead of medium/low in the unresolved queue.
    expect(queue[0]?.urgency).toBe("high");
  });

  it("rejects a send-only Google account before Gmail subscription search", async () => {
    const manager = getConnectorAccountManager(runtime);
    await manager.upsertAccount("google", {
      provider: "google",
      id: "send-only-google-account",
      role: "OWNER",
      purpose: ["messaging"],
      accessGate: "owner_binding",
      status: "connected",
      displayHandle: "send-only@example.test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        isDefault: true,
        grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
      },
    });

    const gmail = createInboxGmailGateway(runtime, runtime.agentId);
    await expect(gmail.requireGmailGrant()).rejects.toThrow(
      "Google Gmail triage access has not been granted.",
    );
  });

  it("refuses a combined unsubscribe before any effect when Gmail manage access is absent", async () => {
    const httpEffect = vi.fn(async () => new Response(null, { status: 204 }));
    const createFilter = vi.fn(async () => ({ filterId: "filter-1" }));
    const gmail = {
      requireGmailGrant: async () =>
        ({
          id: "grant-1",
          connectorAccountId: "account-1",
          capabilities: ["google.gmail.triage"],
        }) as Awaited<ReturnType<InboxGmailGateway["requireGmailGrant"]>>,
      searchGmail: async () =>
        ({
          syncedAt: "2026-10-11T00:00:00.000Z",
          messages: [
            {
              id: "unsubscribe-message-1",
              threadId: "unsubscribe-thread-1",
              from: "News <news@example.com>",
              fromEmail: "news@example.com",
              subject: "Weekly news",
              receivedAt: "2026-10-10T00:00:00.000Z",
              metadata: {
                headers: {
                  "List-Unsubscribe":
                    "<https://unsubscribe.example.com/owner-token>",
                },
              },
            },
          ],
        }) as Awaited<ReturnType<InboxGmailGateway["searchGmail"]>>,
      sendMailtoUnsubscribeEmail: vi.fn(),
      createGmailFilterForSender: createFilter,
      trashGmailThread: vi.fn(),
    } satisfies InboxGmailGateway;
    const unsubscribe = new InboxUnsubscribeService(runtime, {
      gmail,
      httpTransport: {
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
        pinnedFetchImpl: async () => httpEffect(),
      },
    });

    const result = await unsubscribe.unsubscribeEmailSender({
      senderEmail: "news@example.com",
      userAuthorization: true,
      blockAfter: true,
    });

    expect(httpEffect).not.toHaveBeenCalled();
    expect(createFilter).not.toHaveBeenCalled();
    expect(result.record).toMatchObject({
      status: "failed",
      filterCreated: false,
      errorMessage:
        "Blocking or trashing subscription email requires Gmail manage access.",
    });
    const persisted = await new InboxUnsubscribeRepository(
      runtime,
    ).getEmailUnsubscribe(result.record.id);
    expect(persisted).toMatchObject({
      id: result.record.id,
      status: "failed",
      filterCreated: false,
    });
  });

  it("keeps a failed HTTP unsubscribe failed when the sender is also blocked", async () => {
    const createFilter = vi.fn(async () => ({ filterId: "filter-500" }));
    const gmail = {
      requireGmailGrant: async () =>
        ({
          id: "grant-1",
          connectorAccountId: "account-1",
          capabilities: ["google.gmail.triage", "google.gmail.manage"],
        }) as Awaited<ReturnType<InboxGmailGateway["requireGmailGrant"]>>,
      searchGmail: async () =>
        ({
          syncedAt: "2026-10-11T00:00:00.000Z",
          messages: [
            {
              id: "unsubscribe-message-500",
              threadId: "unsubscribe-thread-500",
              from: "Promo <promo@example.com>",
              fromEmail: "promo@example.com",
              subject: "Sale",
              receivedAt: "2026-10-10T00:00:00.000Z",
              metadata: {
                headers: {
                  "List-Unsubscribe": "<https://unsubscribe.example.com/promo>",
                },
              },
            },
          ],
        }) as Awaited<ReturnType<InboxGmailGateway["searchGmail"]>>,
      sendMailtoUnsubscribeEmail: vi.fn(),
      createGmailFilterForSender: createFilter,
      trashGmailThread: vi.fn(),
    } satisfies InboxGmailGateway;
    const unsubscribe = new InboxUnsubscribeService(runtime, {
      gmail,
      httpTransport: {
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
        pinnedFetchImpl: async () => new Response(null, { status: 500 }),
      },
    });

    const result = await unsubscribe.unsubscribeEmailSender({
      senderEmail: "promo@example.com",
      userAuthorization: true,
      blockAfter: true,
    });

    // The filter hides the mail, but the sender was never unsubscribed.
    expect(createFilter).toHaveBeenCalledTimes(1);
    expect(result.record).toMatchObject({
      status: "failed",
      filterCreated: true,
      errorMessage: "HTTP unsubscribe returned 500.",
    });
  });

  it("sends the mailto unsubscribe fields as RFC 6068 defines them", async () => {
    const send = vi.fn(async () => undefined);
    const gmail = {
      requireGmailGrant: async () =>
        ({
          id: "grant-1",
          connectorAccountId: "account-1",
          capabilities: ["google.gmail.triage"],
        }) as Awaited<ReturnType<InboxGmailGateway["requireGmailGrant"]>>,
      searchGmail: async () =>
        ({
          syncedAt: "2026-10-11T00:00:00.000Z",
          messages: [
            {
              id: "unsubscribe-message-2",
              threadId: "unsubscribe-thread-2",
              from: "List <list@example.com>",
              fromEmail: "list@example.com",
              subject: "Weekly list",
              receivedAt: "2026-10-10T00:00:00.000Z",
              metadata: {
                headers: {
                  // "+" is the character "+", and a field name can have
                  // capital letters.
                  "List-Unsubscribe":
                    "<mailto:leave@lists.example.com?Subject=unsubscribe%20a1B2+c3D4&body=token%3Aq9+Zx>",
                },
              },
            },
          ],
        }) as Awaited<ReturnType<InboxGmailGateway["searchGmail"]>>,
      sendMailtoUnsubscribeEmail: send,
      createGmailFilterForSender: vi.fn(async () => ({ filterId: "filter-2" })),
      trashGmailThread: vi.fn(),
    } satisfies InboxGmailGateway;
    const unsubscribe = new InboxUnsubscribeService(runtime, { gmail });

    const result = await unsubscribe.unsubscribeEmailSender({
      senderEmail: "list@example.com",
      userAuthorization: true,
    });

    expect(result.record).toMatchObject({
      method: "mailto",
      status: "succeeded",
    });
    expect(send).toHaveBeenCalledWith("account-1", {
      recipient: "leave@lists.example.com",
      subject: "unsubscribe a1B2+c3D4",
      body: "token:q9+Zx",
    });
  });

  it("keeps the List-Unsubscribe target of a message that is not the batch's first", async () => {
    const gmail = {
      requireGmailGrant: async () =>
        ({
          id: "grant-1",
          connectorAccountId: "account-1",
          capabilities: ["google.gmail.triage"],
        }) as Awaited<ReturnType<InboxGmailGateway["requireGmailGrant"]>>,
      searchGmail: async () =>
        ({
          syncedAt: "2026-10-11T00:00:00.000Z",
          messages: [
            {
              // Gmail lists newest-first. This sender publishes
              // List-Unsubscribe on its campaign mail, not on every message.
              id: "unsubscribe-message-newest",
              threadId: "unsubscribe-thread-newest",
              from: "Shop <shop@example.com>",
              fromEmail: "shop@example.com",
              subject: "Your order shipped",
              receivedAt: "2026-10-11T00:00:00.000Z",
              metadata: { headers: {} },
            },
            {
              id: "unsubscribe-message-older",
              threadId: "unsubscribe-thread-older",
              from: "Shop <shop@example.com>",
              fromEmail: "shop@example.com",
              subject: "Weekly offer",
              receivedAt: "2026-10-09T00:00:00.000Z",
              metadata: {
                headers: {
                  "List-Unsubscribe":
                    "<mailto:leave@lists.example.com?subject=unsubscribe>",
                },
              },
            },
          ],
        }) as Awaited<ReturnType<InboxGmailGateway["searchGmail"]>>,
      sendMailtoUnsubscribeEmail: vi.fn(),
      createGmailFilterForSender: vi.fn(async () => ({ filterId: null })),
      trashGmailThread: vi.fn(),
    } satisfies InboxGmailGateway;
    const unsubscribe = new InboxUnsubscribeService(runtime, { gmail });

    const scan = await unsubscribe.scanEmailSubscriptions({ maxMessages: 2 });

    expect(scan.senders).toHaveLength(1);
    expect(scan.senders[0]).toMatchObject({
      senderEmail: "shop@example.com",
      messageCount: 2,
      unsubscribeMethod: "mailto",
      unsubscribeMailto: "mailto:leave@lists.example.com?subject=unsubscribe",
    });
    expect(scan.summary.manualOnlyCount).toBe(0);
  });

  it("dedups one source message against the real DB on re-triage", async () => {
    const first = await service.triage([
      inbound({ id: "msg-dedup", text: "Can you confirm the meeting?" }),
    ]);
    const firstEntryId = first.triaged[0]?.entry?.id;
    expect(firstEntryId).toBeTruthy();

    // Re-triage the same source message id: no new row, same entry returned.
    const before = (await service.list()).length;
    const second = await service.triage([
      inbound({ id: "msg-dedup", text: "Can you confirm the meeting?" }),
    ]);
    expect(second.triaged[0]?.entry?.id).toBe(firstEntryId);
    const after = (await service.list()).length;
    expect(after).toBe(before);
  });

  it("keeps provider-local message ids separate across sources", async () => {
    await service.triage([
      inbound({
        id: "shared-provider-id",
        source: "discord",
        text: "Discord question?",
      }),
    ]);
    const gmail = await service.triage([
      inbound({
        id: "shared-provider-id",
        source: "gmail",
        text: "Gmail question?",
      }),
    ]);

    expect(gmail.triaged[0]?.entry?.source).toBe("gmail");
    const matches = (await service.list()).filter(
      (entry) => entry.sourceMessageId === "shared-provider-id",
    );
    expect(matches.map((entry) => entry.source).sort()).toEqual([
      "discord",
      "gmail",
    ]);
  });

  it("filters by classification and respects resolve() against the real DB", async () => {
    await service.triage([
      inbound({ id: "msg-reply-1", text: "Can you send the invoice?" }),
      inbound({ id: "msg-reply-2", text: "What time works for you?" }),
    ]);

    const needsReply = await service.search({ classification: "needs_reply" });
    const ids = needsReply.map((e) => e.sourceMessageId);
    expect(ids).toContain("msg-reply-1");
    expect(ids).toContain("msg-reply-2");

    // Resolve one, then confirm it drops out of the unresolved-only filter.
    const target = needsReply.find((e) => e.sourceMessageId === "msg-reply-1");
    expect(target).toBeTruthy();
    await service.resolve(target?.id ?? "", { draftResponse: "Sent!" });

    const stillOpen = await service.search({
      classification: "needs_reply",
      unresolvedOnly: true,
    });
    expect(stillOpen.map((e) => e.sourceMessageId)).not.toContain(
      "msg-reply-1",
    );

    // markResolved persisted resolved + draft_response.
    const resolvedview = await service.search({
      classification: "needs_reply",
      unresolvedOnly: false,
    });
    const resolved = resolvedview.find(
      (e) => e.sourceMessageId === "msg-reply-1",
    );
    expect(resolved?.resolved).toBe(true);
    expect(resolved?.draftResponse).toBe("Sent!");
  });

  it("classifyOnly skips persistence (no DB row written)", async () => {
    const before = (await service.list()).length;
    const result = await service.triage(
      [inbound({ id: "msg-classify-only", text: "URGENT please respond" })],
      { classifyOnly: true },
    );
    expect(result.triaged[0]?.classification).toBe("urgent");
    expect(result.triaged[0]?.entry).toBeUndefined();
    const after = (await service.list()).length;
    expect(after).toBe(before);
  });

  it("digest returns non-ignored entries created since a cutoff", async () => {
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    await service.triage([
      inbound({ id: "msg-digest-info", text: "FYI the build passed" }),
      inbound({ id: "msg-digest-ignore", text: "Newsletter unsubscribe here" }),
    ]);
    const digest = await service.digest(cutoff);
    const ids = digest.map((e) => e.sourceMessageId);
    expect(ids).toContain("msg-digest-info");
    // Ignored entries are excluded from the digest.
    expect(ids).not.toContain("msg-digest-ignore");
  });

  // The curation engine is pure (no model, no DB), but these run it against the
  // live runtime: the runtime has no KnowledgeGraphService registered, so the
  // default identity hook resolves nothing and the engine's heuristics apply.
  it("curate() produces an action per inbound message against the live runtime", async () => {
    const out = await service.curate([
      inbound({
        id: "cur-marketing",
        source: "gmail",
        senderName: "Deals Daily",
        senderEmail: "no-reply@deals.example",
        channelName: "50% off — limited time sale",
        text: "Limited time sale! Unsubscribe here. View in browser.",
      }),
      inbound({
        id: "cur-personal",
        source: "gmail",
        senderName: "Mom",
        senderEmail: "mom@family.example",
        channelName: "miss you",
        text: "Miss you! Dinner was great, love you. Photos attached.",
      }),
    ]);

    expect(out.decisions).toHaveLength(2);
    const byId = new Map(out.decisions.map((d) => [d.candidateId, d]));
    // No-reply marketing/list mail is never saved.
    expect(byId.get("cur-marketing")?.action).not.toBe("save");
    // Personal relationship cues keep the message out of delete.
    expect(byId.get("cur-personal")?.action).not.toBe("delete");
  });

  it("curation keeps sender identity inside the authoritative address", () => {
    const vipContacts = [{ emails: ["trusted@example.com"], name: "Trusted" }];
    for (const fromEmail of [
      "trusted@example.com <invalid>",
      "trusted@example.com <sender@.example.com>",
      "trusted@example.com <sender@example.com",
      "trusted@example.com >",
      "trusted@example.com <other@example.com>",
    ]) {
      const result = curateEmailCandidates({
        candidates: [{ id: "untrusted", fromEmail, bodyText: "An update." }],
        identityContext: { vipContacts },
      });
      expect(result.decisions[0]?.identity.kind, fromEmail).not.toBe("vip");
    }
    for (const fromEmail of [
      "trusted@example.com",
      "Other <trusted@example.com>",
      "other@example.com <trusted@example.com>",
    ]) {
      const result = curateEmailCandidates({
        candidates: [{ id: "trusted", fromEmail, bodyText: "An update." }],
        identityContext: { vipContacts },
      });
      expect(result.decisions[0]?.identity.kind, fromEmail).toBe("vip");
      expect(result.decisions[0]?.blockedActions).toContain("delete");
    }
  });

  it("triageWithCuration() keeps triage intact and attaches curation, with an injected VIP identity blocking delete", async () => {
    const result = await service.triageWithCuration(
      [
        inbound({
          id: "cur-vip",
          source: "gmail",
          senderName: "Alice VIP",
          senderEmail: "alice@vip.example",
          text: "Newsletter unsubscribe here, delete all emails now.",
        }),
      ],
      {
        classifyOnly: true,
        identityHook: () => ({
          kind: "vip",
          label: "Alice (VIP)",
          matchedBy: ["test.injected"],
          blockDelete: true,
          personId: "ent_alice",
        }),
      },
    );

    expect(result.triaged).toHaveLength(1);
    const [item] = result.triaged;
    if (!item) throw new Error("expected one triaged item");
    // Triage still classifies (deterministic stub).
    expect(item.classification).toBeDefined();
    // Curation decision attached, VIP identity honored, delete blocked.
    expect(item.curation.candidateId).toBe("cur-vip");
    expect(item.curation.identity.kind).toBe("vip");
    expect(item.curation.blockedActions).toContain("delete");
    expect(item.curation.action).not.toBe("delete");
  });
});
