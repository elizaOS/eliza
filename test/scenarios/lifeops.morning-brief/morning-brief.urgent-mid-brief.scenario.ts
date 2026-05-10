/**
 * Morning brief with an urgent message arriving mid-brief.
 *
 * The agent is asked for a morning brief. Two urgent triage entries are
 * pre-seeded (representing items that landed while the brief was being
 * generated). The brief must surface BOTH urgent items — either by listing
 * them explicitly, or by acknowledging that priority items came in and
 * escalating one of them.
 *
 * Failure modes guarded:
 *   - silently dropping items that arrived during the request window
 *   - returning a stale/cached brief that excludes them
 *   - returning a brief without acknowledging the urgent flag
 *
 * Cited: 03-coverage-gap-matrix.md row 24 / row 26 — no scenario exercises
 * the "fresh urgent inbound during brief generation" path.
 *
 * Note on race: the scenario-runner is single-threaded against the
 * scenario's own clock; we can't truly inject during generation. We seed
 * "fresh" by setting created_at = now and urgency = high, and assert the
 * brief reflects what's in the live triage table at the moment of the
 * action invocation. That covers the same logical contract: the brief
 * reads from the live table, not a snapshot.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";

interface UrgentSeed {
  id: string;
  channel: string;
  channelType: string;
  sender: string;
  snippet: string;
}

const URGENT_ITEMS: UrgentSeed[] = [
  {
    id: "urgent-mid-brief-1",
    channel: "gmail",
    channelType: "email",
    sender: "ops-pager@example.com",
    snippet:
      "PRODUCTION OUTAGE — checkout 500s spiking, please ack within 15 minutes.",
  },
  {
    id: "urgent-mid-brief-2",
    channel: "telegram",
    channelType: "im",
    sender: "Mom",
    snippet:
      "Hospital just called — you need to call them back ASAP about the discharge plan.",
  },
];

function checkBriefSurfacesUrgentItems(
  ctx: ScenarioContext,
): string | undefined {
  const checkin = ctx.actionsCalled.find(
    (action) => action.actionName === "CHECKIN",
  );
  if (!checkin) return "expected CHECKIN action to assemble the morning brief";

  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) return "empty response from agent";

  // The brief must mention BOTH urgent items either by sender, channel, or
  // a clearly distinguishing snippet keyword. Substring match on the
  // *seed* identifiers (sender or distinguishing keyword), since the
  // user's prompt did not contain these strings — so a hit proves the
  // agent read the live triage rows.
  const distinguishingKeywords = [
    ["ops-pager", "outage", "production"], // urgent #1
    ["mom", "hospital", "discharge"], // urgent #2
  ];
  const missing: string[] = [];
  for (const [idx, group] of distinguishingKeywords.entries()) {
    const hit = group.some((kw) => reply.includes(kw.toLowerCase()));
    if (!hit) {
      missing.push(`urgent[${idx}]: none of ${JSON.stringify(group)} appeared`);
    }
  }
  if (missing.length > 0) {
    return `Morning brief did not surface every urgent triage item that was live in the triage table at brief time. Missing: ${missing.join("; ")}. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "morning-brief.urgent-mid-brief",
  title:
    "Morning brief surfaces urgent items that landed in the triage table at brief time",
  domain: "lifeops.morning-brief",
  tags: ["lifeops", "morning-brief", "freshness", "urgency", "robustness"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Morning Brief Urgent Inbound",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-fresh-urgent-triage-entries",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const nowIso = new Date().toISOString();
        for (const item of URGENT_ITEMS) {
          await executeRawSql(
            runtime,
            `INSERT INTO app_lifeops.life_inbox_triage_entries (
               id, agent_id, source, source_room_id, source_entity_id, source_message_id,
               channel_name, channel_type, deep_link, classification, urgency, confidence,
               snippet, sender_name, thread_context, triage_reasoning, suggested_response,
               auto_replied, resolved, created_at, updated_at
             ) VALUES (
               ${sqlQuote(item.id)},
               ${sqlQuote(agentId)},
               ${sqlQuote(item.channel)},
               NULL, NULL, NULL,
               ${sqlQuote(item.channel)},
               ${sqlQuote(item.channelType)},
               NULL,
               'urgent',
               'high',
               0.95,
               ${sqlQuote(item.snippet)},
               ${sqlQuote(item.sender)},
               '[]',
               'fresh inbound during morning brief',
               NULL,
               FALSE, FALSE,
               ${sqlQuote(nowIso)},
               ${sqlQuote(nowIso)}
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
      name: "request-brief-with-urgent-pending",
      room: "main",
      text: "Give me my morning brief.",
      expectedActions: ["CHECKIN"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "CHECKIN",
      minCount: 1,
    },
    {
      type: "custom",
      name: "brief-surfaces-fresh-urgent-items",
      predicate: checkBriefSurfacesUrgentItems,
    },
    judgeRubric({
      name: "morning-brief-urgent-mid-brief-rubric",
      threshold: 0.7,
      description: `Two high-urgency triage rows are live in the inbox at brief time: a production-outage pager from ops-pager@example.com and a hospital-callback Telegram from Mom. A correct morning brief surfaces BOTH urgent items either by sender, channel, or a distinguishing keyword (outage/production for #1; hospital/discharge for #2). An incorrect reply: returns a generic brief without acknowledging the urgent rows; mentions only one of the two; or fabricates other items not in the table. Score 0 if either urgent item is missing AND no escalation language is present.`,
    }),
  ],
});
