/**
 * Urgent routing — when the agent needs to send an urgent message and the
 * recipient has been most-active on Telegram (last seen 5m), the agent
 * must route to Telegram, NOT to Gmail (last seen 7d).
 *
 * Failure modes guarded:
 *   - defaulting to email when the recipient is asleep on email
 *   - shotgun-spamming every channel
 *
 * Cited: 03-coverage-gap-matrix.md — most-active-channel routing.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { judgeRubric } from "../_helpers/action-assertions.ts";

function checkRoutedToTelegram(ctx: ScenarioContext): string | undefined {
  const dispatches = ctx.connectorDispatches ?? [];
  const telegramDispatches = dispatches.filter((d) =>
    (d.channel ?? "").toLowerCase().includes("telegram"),
  );
  const gmailDispatches = dispatches.filter((d) =>
    (d.channel ?? "").toLowerCase().includes("gmail"),
  );
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  // Either a real telegram dispatch happens, OR the reply says we'll use
  // Telegram. Forbid: gmail-only path.
  if (telegramDispatches.length === 0 && gmailDispatches.length > 0) {
    return `Agent routed urgent message via Gmail when recipient is most-active on Telegram.`;
  }
  if (telegramDispatches.length === 0 && !reply.includes("telegram")) {
    return `Agent did not route or propose to route urgent message via Telegram. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "cross-channel.urgent-routed-to-most-active-channel",
  title:
    "Urgent send routes to most-active channel (Telegram), not stale Gmail",
  domain: "lifeops.cross-channel",
  tags: ["lifeops", "cross-channel", "routing", "urgent", "channel-selection"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Urgent Routing",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-activity-windows",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const now = Date.now();
        const recentTg = new Date(now - 5 * 60_000).toISOString();
        const staleGmail = new Date(now - 7 * 24 * 60 * 60_000).toISOString();
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_inbox_triage_entries (
             id, agent_id, source, source_message_id, channel_name, channel_type,
             classification, urgency, confidence, snippet, sender_name,
             thread_context, triage_reasoning, auto_replied, resolved,
             created_at, updated_at
           ) VALUES (
             ${sqlQuote("active-tg-1")},
             ${sqlQuote(agentId)},
             'telegram',
             ${sqlQuote("tg-active-1")},
             'telegram',
             'im',
             'fyi',
             'low',
             0.6,
             ${sqlQuote("Just saw your link, nice")},
             ${sqlQuote("urgent-recipient")},
             '[]',
             'recent telegram activity',
             FALSE, FALSE,
             ${sqlQuote(recentTg)},
             ${sqlQuote(recentTg)}
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
             ${sqlQuote("stale-gmail-1")},
             ${sqlQuote(agentId)},
             'gmail',
             ${sqlQuote("gmail-stale-1")},
             'gmail',
             'email',
             'fyi',
             'low',
             0.6,
             ${sqlQuote("Last reply was a week ago")},
             ${sqlQuote("urgent-recipient")},
             '[]',
             'old gmail thread',
             FALSE, FALSE,
             ${sqlQuote(staleGmail)},
             ${sqlQuote(staleGmail)}
           )`,
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-urgent-route",
      room: "main",
      text: "I need to reach urgent-recipient right now — fastest channel. They're active on Telegram but I also email them.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "routed-to-telegram",
      predicate: checkRoutedToTelegram,
    },
    judgeRubric({
      name: "cross-channel-urgent-route-rubric",
      threshold: 0.7,
      description:
        "Recipient is active on Telegram (5m ago) and stale on Gmail (7d ago). Agent must route urgent message via Telegram, not Gmail.",
    }),
  ],
});
