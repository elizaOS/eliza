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
 * and dedup-by-`source_message_id` is verified against the real table.
 */

import {
  type AgentRuntime,
  ModelType,
  type ModelTypeName,
  type Plugin,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/test/helpers/real-runtime.ts";
// The inbox-triage tables were carved into this plugin's own `app_inbox`
// schema; we register just the two triage table defs so the SQL plugin's
// migration runner materializes them — the exact tables the inbox plugin reads
// in production. No PA import is needed.
import {
  lifeInboxTriageEntries,
  lifeInboxTriageExamples,
} from "../src/db/schema.ts";
import { InboxService } from "../src/inbox/service.ts";
import type { InboundMessage } from "../src/inbox/types.ts";

/**
 * Schema-only test plugin so `runtime.initialize()` runs the SQL plugin's
 * migration for the two carved `app_inbox` inbox triage tables, without pulling
 * in the inbox plugin's heavier service/repository modules.
 */
const inboxSchemaPlugin: Plugin = {
  name: "inbox-real-db-schema",
  description: "Test-only inbox triage table bootstrap.",
  schema: { lifeInboxTriageEntries, lifeInboxTriageExamples },
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

  it("dedups by source_message_id against the real DB on re-triage", async () => {
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
