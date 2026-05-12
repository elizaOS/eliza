/**
 * Inbox triage on a 500-unread inbox — agent must summarize / batch, NOT
 * enumerate every row, and NOT fabricate counts that disagree with the
 * seeded data.
 *
 * Failure modes guarded:
 *   - dumping all 500 entries verbatim (token explosion)
 *   - producing a reply with a row count that contradicts the seed
 *   - silently truncating without telling the user
 *
 * The seed inserts 500 synthetic triage rows of mixed urgency. The agent
 * must (a) acknowledge the volume, (b) batch / summarize, and (c) NOT call
 * 500 individual INBOX_TRIAGE actions.
 *
 * Cited: 03-coverage-gap-matrix.md — "large inbox / batched summary" has
 * no scenario today.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import { judgeRubric } from "../_helpers/action-assertions.ts";

const TOTAL_UNREAD = 500;

function checkAgentBatchedRatherThanEnumerated(
  ctx: ScenarioContext,
): string | undefined {
  // The agent should NOT have fired 500 separate INBOX_TRIAGE actions.
  // A correct response uses CHECKIN / MESSAGE / INBOX_TRIAGE a handful of
  // times to summarize, not once per row.
  const triageCalls = ctx.actionsCalled.filter(
    (action) =>
      action.actionName === "INBOX_TRIAGE" || action.actionName === "MESSAGE",
  );
  if (triageCalls.length > 50) {
    return `Agent fired ${triageCalls.length} INBOX_TRIAGE/MESSAGE calls on a 500-row inbox; expected batched summary (<=50 calls).`;
  }
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) {
    return "agent returned empty response on 500-unread brief";
  }
  // Reply must acknowledge the volume in some shape — a number, the word
  // "many", "batch", "summarize", etc. A reply that doesn't mention
  // volume on a 500-row inbox is presumed fabricated / cached.
  const volumeSignals = [
    "500",
    "hundred",
    "many",
    "batch",
    "summari",
    "lots",
    "large",
    "volume",
    "high volume",
    "bulk",
  ];
  if (!volumeSignals.some((signal) => reply.includes(signal))) {
    return `Agent reply did not acknowledge inbox volume on a 500-row inbox. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "inbox-triage.500-unread",
  title: "500-unread inbox is batched/summarized, not enumerated row-by-row",
  domain: "lifeops.inbox-triage",
  tags: [
    "lifeops",
    "inbox-triage",
    "volume",
    "batching",
    "robustness",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Inbox Triage 500 Unread",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-500-unread-triage-entries",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const baseTime = Date.now() - 6 * 60 * 60_000;
        const urgencies = ["low", "medium", "high"] as const;
        const classifications = [
          "needs-response",
          "fyi",
          "newsletter",
          "calendar",
          "billing",
        ];
        for (let i = 0; i < TOTAL_UNREAD; i++) {
          const urgency = urgencies[i % urgencies.length];
          const classification = classifications[i % classifications.length];
          const ts = new Date(baseTime + i * 10_000).toISOString();
          await executeRawSql(
            runtime,
            `INSERT INTO app_lifeops.life_inbox_triage_entries (
               id, agent_id, source, source_room_id, source_entity_id, source_message_id,
               channel_name, channel_type, deep_link, classification, urgency, confidence,
               snippet, sender_name, thread_context, triage_reasoning, suggested_response,
               auto_replied, resolved, created_at, updated_at
             ) VALUES (
               ${sqlQuote(`bulk-triage-${i}`)},
               ${sqlQuote(agentId)},
               ${sqlQuote("gmail")},
               NULL, NULL, NULL,
               ${sqlQuote("gmail")},
               'email',
               NULL,
               ${sqlQuote(classification)},
               ${sqlQuote(urgency)},
               0.5,
               ${sqlQuote(`Synthetic inbox row ${i} (${classification})`)},
               ${sqlQuote(`sender-${i}@example.com`)},
               '[]',
               'bulk-synthetic',
               NULL,
               FALSE, FALSE,
               ${sqlQuote(ts)},
               ${sqlQuote(ts)}
             )`,
          );
        }
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-to-triage-large-inbox",
      room: "main",
      text: "I have a huge backlog of unread email. Give me a summary of what's in there so I can decide what to deal with first.",
      timeoutMs: 180_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-batched-not-enumerated",
      predicate: checkAgentBatchedRatherThanEnumerated,
    },
    judgeRubric({
      name: "inbox-triage-500-unread-rubric",
      threshold: 0.7,
      description: `The user has a 500-row unread triage queue (mixed urgency). They asked for a summary. A correct reply: acknowledges the volume (mentions hundreds / many / batched), groups by urgency or classification, and does NOT list 500 rows one at a time. An incorrect reply: enumerates dozens of individual senders/subjects, claims an unverifiable specific count not in the seed, or returns a generic "your inbox is empty" / single-row reply. Score 0 if the agent enumerates more than ~20 individual rows or claims a small total count.`,
    }),
  ],
});
