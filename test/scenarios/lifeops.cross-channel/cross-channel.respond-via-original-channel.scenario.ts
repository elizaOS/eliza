/**
 * Reply via original channel — when responding to a Telegram message, the
 * reply MUST go back via Telegram, not Gmail. Channel preservation is a
 * non-negotiable contract.
 *
 * Failure modes guarded:
 *   - emailing a Telegram contact a reply
 *   - bouncing across channels mid-thread
 *
 * Cited: 03-coverage-gap-matrix.md — channel preservation on reply.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { judgeRubric } from "../_helpers/action-assertions.ts";

function checkReplyChannelMatchesOriginal(
  ctx: ScenarioContext,
): string | undefined {
  // The original is on Telegram. Agent reply must NOT dispatch to gmail.
  const wrongChannelDispatches = (ctx.connectorDispatches ?? []).filter((d) => {
    const ch = (d.channel ?? "").toLowerCase();
    return ch.includes("gmail") || ch.includes("email");
  });
  if (wrongChannelDispatches.length > 0) {
    return `Agent dispatched reply via gmail/email when original was Telegram. Dispatches: ${JSON.stringify(wrongChannelDispatches.map((d) => d.channel))}`;
  }
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (
    reply.includes("email") &&
    reply.includes("sending") &&
    !reply.includes("telegram")
  ) {
    return `Agent indicated email-channel reply for a Telegram-originated thread. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "cross-channel.respond-via-original-channel",
  title: "Reply preserves original channel (Telegram in, Telegram out)",
  domain: "lifeops.cross-channel",
  tags: ["lifeops", "cross-channel", "channel-preservation", "reply"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Reply Via Original Channel",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-telegram-originated-thread",
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
             ${sqlQuote("telegram-origin-1")},
             ${sqlQuote(agentId)},
             ${sqlQuote("telegram")},
             ${sqlQuote("tg-msg-1")},
             ${sqlQuote("telegram")},
             'im',
             'needs-response',
             'medium',
             0.8,
             ${sqlQuote("Hey, are we still on for dinner tonight?")},
             ${sqlQuote("alex-buddy")},
             '[]',
             'telegram-originated thread',
             FALSE, FALSE,
             ${sqlQuote(now)},
             ${sqlQuote(now)}
           )`,
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-reply",
      room: "main",
      text: "Reply to Alex saying yes, 7pm at the usual place.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "reply-channel-matches-original",
      predicate: checkReplyChannelMatchesOriginal,
    },
    judgeRubric({
      name: "cross-channel-respond-via-original-rubric",
      threshold: 0.7,
      description:
        "Alex originally messaged via Telegram. Reply must go back via Telegram, not Gmail. Agent must not switch channels.",
    }),
  ],
});
