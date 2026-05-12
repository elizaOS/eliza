/**
 * Entity-aware priority bump — a message from a known VIP must escalate
 * regardless of its raw urgency score.
 *
 * Seed: a "low" urgency triage row from a VIP-flagged sender (board chair),
 * alongside a "high" urgency row from a random pager. The agent must
 * surface the VIP row at or near the top, NOT discount it as "low".
 *
 * Failure modes guarded:
 *   - ranking purely by the seeded urgency column
 *   - ignoring VIP / relationship signal
 *
 * Cited: 03-coverage-gap-matrix.md — VIP escalation.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { judgeRubric } from "../_helpers/action-assertions.ts";

const VIP_SENDER = "board-chair@example.com";

function checkVipSurfaced(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) return "empty reply on VIP escalation";
  if (!reply.includes("board") && !reply.includes("chair")) {
    return `Reply did not surface the VIP (board chair) entry. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "inbox-triage.escalate-from-known-VIP",
  title: "Low-urgency mail from VIP escalates to top of triage",
  domain: "lifeops.inbox-triage",
  tags: ["lifeops", "inbox-triage", "vip", "entity-aware", "ranking"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "VIP Escalation",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-vip-and-noise",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const now = new Date().toISOString();
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_inbox_triage_entries (
             id, agent_id, source, source_message_id, channel_name, channel_type,
             classification, urgency, confidence, snippet, sender_name,
             thread_context, triage_reasoning, auto_replied, resolved,
             created_at, updated_at
           ) VALUES (
             ${sqlQuote("triage-vip-low")},
             ${sqlQuote(agentId)},
             ${sqlQuote("gmail")},
             ${sqlQuote("msg-vip-low")},
             ${sqlQuote("gmail")},
             'email',
             'needs-response',
             'low',
             0.4,
             ${sqlQuote("Quick check-in — would love your thoughts on the next board meeting agenda.")},
             ${sqlQuote(VIP_SENDER)},
             '[]',
             'board chair, low explicit urgency but high relationship weight',
             FALSE, FALSE,
             ${sqlQuote(now)},
             ${sqlQuote(now)}
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
             ${sqlQuote("triage-noise-high")},
             ${sqlQuote(agentId)},
             ${sqlQuote("gmail")},
             ${sqlQuote("msg-noise-high")},
             ${sqlQuote("gmail")},
             'email',
             'fyi',
             'high',
             0.6,
             ${sqlQuote("Your SaaS trial expires in 3 days, click here to upgrade.")},
             ${sqlQuote("noreply@randomsaas.example")},
             '[]',
             'noisy marketing escalation',
             FALSE, FALSE,
             ${sqlQuote(now)},
             ${sqlQuote(now)}
           )`,
        );
        // Mark VIP in the relationships service (best-effort if table exists).
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_relationship_people
             (id, agent_id, display_name, primary_email, tier, created_at, updated_at)
           VALUES (
             ${sqlQuote("vip-board-chair")},
             ${sqlQuote(agentId)},
             ${sqlQuote("Board Chair")},
             ${sqlQuote(VIP_SENDER)},
             'vip',
             ${sqlQuote(now)},
             ${sqlQuote(now)}
           )
           ON CONFLICT DO NOTHING`,
        ).catch(() => undefined);
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-for-triage",
      room: "main",
      text: "Triage my inbox — top things only.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "vip-surfaced-at-top",
      predicate: checkVipSurfaced,
    },
    judgeRubric({
      name: "inbox-triage-vip-escalation-rubric",
      threshold: 0.7,
      description: `Inbox has a "low urgency" email from the board chair (VIP) and a "high urgency" marketing email from a SaaS trial. Correct: agent surfaces the board chair email at or near the top, recognizes the relationship weight overrides the urgency column. Incorrect: leads with the SaaS trial expiration, or omits the board chair entirely. Score 0 if the SaaS trial leads and the board chair is missing.`,
    }),
  ],
});
