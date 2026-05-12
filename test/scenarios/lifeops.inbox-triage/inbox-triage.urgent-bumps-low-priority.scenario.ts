/**
 * Triage ranking — urgent items must surface BEFORE low-priority items in
 * the agent's summary, regardless of insertion order.
 *
 * Seed: insert the low-priority row FIRST (oldest), then the urgent row.
 * If the agent ranks by insertion order or by recency-only, the low row
 * would surface first. A correct ranking surfaces the urgent row first.
 *
 * Failure modes guarded:
 *   - reverse-chronological-only ranking (newest first ignores urgency)
 *   - insertion-order ranking
 *   - returning items in arbitrary order
 *
 * Cited: 03-coverage-gap-matrix.md — "urgent bumps low-priority" ranking.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { judgeRubric } from "../_helpers/action-assertions.ts";

const LOW_KEYWORD = "office-supplies-receipt";
const URGENT_KEYWORD = "wire-transfer-deadline";

function checkUrgentBeforeLow(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) return "empty reply from agent";
  const urgentIdx = reply.indexOf(URGENT_KEYWORD);
  const lowIdx = reply.indexOf(LOW_KEYWORD);
  if (urgentIdx === -1 && lowIdx === -1) {
    // Neither hit verbatim — check looser signals.
    const urgentSignals = ["wire", "transfer", "deadline", "urgent"];
    const lowSignals = ["office supplies", "supplies", "receipt"];
    const urgentHit = urgentSignals.some((s) => reply.includes(s));
    const lowHit = lowSignals.some((s) => reply.includes(s));
    if (!urgentHit) {
      return `Reply did not surface the urgent wire-transfer item. Reply: ${reply.slice(0, 400)}`;
    }
    if (lowHit && urgentHit) {
      // Find earliest position for each group.
      const earliestUrgent = Math.min(
        ...urgentSignals.map((s) => reply.indexOf(s)).filter((i) => i >= 0),
      );
      const earliestLow = Math.min(
        ...lowSignals.map((s) => reply.indexOf(s)).filter((i) => i >= 0),
      );
      if (earliestUrgent > earliestLow) {
        return `Low-priority item surfaced before urgent: urgent@${earliestUrgent}, low@${earliestLow}. Reply: ${reply.slice(0, 400)}`;
      }
    }
    return undefined;
  }
  if (urgentIdx === -1) {
    return `Urgent item not surfaced. Reply: ${reply.slice(0, 400)}`;
  }
  if (lowIdx !== -1 && lowIdx < urgentIdx) {
    return `Low-priority surfaced before urgent: lowIdx=${lowIdx} urgentIdx=${urgentIdx}. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "inbox-triage.urgent-bumps-low-priority",
  title:
    "Urgent triage item surfaces before low-priority regardless of arrival order",
  domain: "lifeops.inbox-triage",
  tags: ["lifeops", "inbox-triage", "ranking", "urgency", "ordering"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Triage Urgent vs Low Ranking",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-low-then-urgent",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const earlier = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
        const later = new Date(Date.now() - 5 * 60_000).toISOString();
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_inbox_triage_entries (
             id, agent_id, source, source_message_id, channel_name, channel_type,
             classification, urgency, confidence, snippet, sender_name,
             thread_context, triage_reasoning, auto_replied, resolved,
             created_at, updated_at
           ) VALUES (
             ${sqlQuote("triage-low-1")},
             ${sqlQuote(agentId)},
             ${sqlQuote("gmail")},
             ${sqlQuote("msg-low-1")},
             ${sqlQuote("gmail")},
             'email',
             'fyi',
             'low',
             0.4,
             ${sqlQuote(`Forwarding ${LOW_KEYWORD}: receipt PDF attached, no action needed.`)},
             ${sqlQuote("office-admin@example.com")},
             '[]',
             'low-priority receipt forward',
             FALSE, FALSE,
             ${sqlQuote(earlier)},
             ${sqlQuote(earlier)}
           )`,
        );
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_inbox_triage_entries (
             id, agent_id, source, source_message_id, channel_name, channel_type,
             classification, urgency, confidence, snippet, sender_name,
             thread_context, triage_reasoning, auto_replied, resolved,
             created_at, updated_at
           ) VALUES (
             ${sqlQuote("triage-urgent-1")},
             ${sqlQuote(agentId)},
             ${sqlQuote("gmail")},
             ${sqlQuote("msg-urgent-1")},
             ${sqlQuote("gmail")},
             'email',
             'needs-response',
             'high',
             0.95,
             ${sqlQuote(`URGENT ${URGENT_KEYWORD}: wire must clear by 4pm today or deal slips.`)},
             ${sqlQuote("cfo@example.com")},
             '[]',
             'urgent wire-transfer deadline',
             FALSE, FALSE,
             ${sqlQuote(later)},
             ${sqlQuote(later)}
           )`,
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-for-triage-summary",
      room: "main",
      text: "What should I look at in my inbox right now?",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "urgent-surfaces-before-low",
      predicate: checkUrgentBeforeLow,
    },
    judgeRubric({
      name: "inbox-triage-urgent-bumps-low-rubric",
      threshold: 0.7,
      description: `Inbox has two rows: an old low-priority office-supplies receipt and a fresh URGENT wire-transfer deadline. The agent must surface the urgent wire-transfer item first or as the top recommendation. Score 0 if the agent leads with the office-supplies receipt, or omits the urgent item entirely.`,
    }),
  ],
});
