/**
 * Surface stale threads — emails the user sent that have NOT been replied
 * to in >72h must be surfaced as "still waiting on a reply".
 *
 * Seed: 3 sent-but-unanswered triage rows of varying age (24h, 72h, 7d),
 * plus 1 row that has been replied to.
 *
 * Failure modes guarded:
 *   - treating sent messages as nothing to do
 *   - surfacing the 24h-old thread (too fresh)
 *   - missing the 7-day-old thread (stalest, highest signal)
 *
 * Cited: 03-coverage-gap-matrix.md — stale-thread surfacing.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";

function checkStaleThreadsSurfaced(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) return "empty reply on stale-thread query";
  // The 7-day thread (most stale, recruiter offer) and the 72h thread
  // (vendor proposal) MUST appear. The 24h thread (just-sent intro)
  // should NOT (too fresh by user's 72h threshold).
  const staleHits = ["recruiter", "offer", "interview", "vendor", "proposal", "pricing"];
  const tooFresh = ["intro", "introduction", "this morning", "today"];
  const sawStale = staleHits.some((s) => reply.includes(s));
  if (!sawStale) {
    return `Stale threads (>72h unresponded) not surfaced. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "inbox-triage.unresponded-threads-72h",
  title: "Stale unresponded threads (>72h) surface in triage",
  domain: "lifeops.inbox-triage",
  tags: [
    "lifeops",
    "inbox-triage",
    "stale-threads",
    "followup",
    "freshness",
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
      title: "Stale Threads",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-stale-threads",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const now = Date.now();
        const rows = [
          {
            id: "stale-24h",
            offsetHours: 24,
            sender: "intro-acquaintance@example.com",
            snippet: "Hi, just sent the intro this morning, looking forward to your reply.",
          },
          {
            id: "stale-72h",
            offsetHours: 72,
            sender: "vendor-acme@example.com",
            snippet: "Following up on the pricing proposal from earlier this week.",
          },
          {
            id: "stale-7d",
            offsetHours: 24 * 7,
            sender: "recruiter@bigco.example",
            snippet: "Re: senior eng role — you got back to me, then we never closed on the interview slot.",
          },
        ];
        for (const row of rows) {
          const ts = new Date(now - row.offsetHours * 60 * 60_000).toISOString();
          await executeRawSql(
            runtime,
            `INSERT INTO app_lifeops.life_inbox_triage_entries (
               id, agent_id, source, source_message_id, channel_name, channel_type,
               classification, urgency, confidence, snippet, sender_name,
               thread_context, triage_reasoning, auto_replied, resolved,
               created_at, updated_at
             ) VALUES (
               ${sqlQuote(row.id)},
               ${sqlQuote(agentId)},
               ${sqlQuote("gmail")},
               ${sqlQuote(row.id)},
               ${sqlQuote("gmail")},
               'email',
               'awaiting-their-reply',
               'medium',
               0.7,
               ${sqlQuote(row.snippet)},
               ${sqlQuote(row.sender)},
               '[]',
               'sent, no reply yet',
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
      name: "ask-for-stale-threads",
      room: "main",
      text: "Which emails am I still waiting on a reply for that are getting old? Anything 3+ days?",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "stale-threads-surfaced",
      predicate: checkStaleThreadsSurfaced,
    },
    judgeRubric({
      name: "inbox-triage-stale-threads-rubric",
      threshold: 0.7,
      description: `User has 3 unresponded threads: 24h old (intro), 72h old (vendor pricing), and 7-day old (recruiter offer). They asked for "3+ days" stale. Correct: surfaces the 72h vendor AND 7d recruiter threads. Incorrect: surfaces the 24h intro (too fresh), or misses the 7-day recruiter thread. Score 0 if neither stale thread is surfaced.`,
    }),
  ],
});
