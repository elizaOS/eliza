/**
 * Unanswered-decision bump — user-sent question across multiple channels
 * with no reply. Agent must surface it and propose a bump (resend, escalate
 * to next channel, or follow-up reminder).
 *
 * Failure modes guarded:
 *   - dropping the unanswered question silently
 *   - bumping the wrong person/channel
 *
 * Cited: 03-coverage-gap-matrix.md — decision-bump.
 */

import type { AgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";

export default scenario({
  id: "cross-channel.unanswered-decision-bump",
  title: "Unanswered question gets bumped (resend / escalate) after waiting",
  domain: "lifeops.cross-channel",
  tags: [
    "lifeops",
    "cross-channel",
    "followup",
    "bump",
    "unanswered",
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
      title: "Unanswered Decision Bump",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-stale-sent-no-reply",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString();
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_inbox_triage_entries (
             id, agent_id, source, source_message_id, channel_name, channel_type,
             classification, urgency, confidence, snippet, sender_name,
             thread_context, triage_reasoning, auto_replied, resolved,
             created_at, updated_at
           ) VALUES (
             ${sqlQuote("stale-bump-1")},
             ${sqlQuote(agentId)},
             ${sqlQuote("gmail")},
             ${sqlQuote("bump-msg-1")},
             ${sqlQuote("gmail")},
             'email',
             'awaiting-their-reply',
             'medium',
             0.8,
             ${sqlQuote("Sent you a contractor invoice 5 days ago, can you confirm payment terms?")},
             ${sqlQuote("vendor-bump@example.com")},
             '[]',
             'sent, waiting on reply 5d',
             FALSE, FALSE,
             ${sqlQuote(fiveDaysAgo)},
             ${sqlQuote(fiveDaysAgo)}
           )`,
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-for-bump-suggestions",
      room: "main",
      text: "Anything I've been waiting on a reply for that I should bump?",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "bump-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "INBOX_TRIAGE", "READ_MESSAGES"],
        description: "surface stale unanswered for bump",
        includesAny: ["vendor-bump", "invoice", "5 days", "follow up", "bump"],
      }),
    },
    judgeRubric({
      name: "cross-channel-decision-bump-rubric",
      threshold: 0.7,
      description:
        "Agent surfaces the 5-day-old vendor-bump invoice as a candidate for resend/escalation, and proposes a bump (not just lists the row).",
    }),
  ],
});
