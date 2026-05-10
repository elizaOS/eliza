/**
 * Morning brief on an empty inbox.
 *
 * Failure mode this guards against: when the user has zero unread messages,
 * triage entries, and pending drafts, the brief generator must say so —
 * NOT fabricate fake messages, NOT crash, NOT echo a stale fixture. The
 * SOFT existing morning-brief tests pre-seed answers and substring-match
 * (see audits/lifeops-2026-05-09/02-scenario-larp-audit.md), so this is the
 * negative-path counterpart that they all skip.
 *
 * Seed: explicitly clear inbox triage, approval queue, and life_task_occurrences
 * to emulate "empty inbox / nothing to do".
 *
 * Assertion: the agent must (a) call CHECKIN, (b) the response must NOT
 * contain any specific person/subject line, AND (c) the judge must rule the
 * reply is a degenerate/empty-state reply.
 *
 * Cited: 02-scenario-larp-audit.md §lifeops-morning-brief-fixtures (LARP
 * pre-bakes investor / clinic strings); 03-coverage-gap-matrix.md row 24
 * "morning brief covers empty inbox" — currently no scenario.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";

// LARP-bait substrings that the existing morning-brief fixtures pre-seed —
// if any of these appear in a reply on an empty inbox, the agent invented
// them. Source: lifeops-morning-brief-fixtures.ts (audit §02).
const FORBIDDEN_FABRICATION_STRINGS = [
  "investor diligence packet",
  "clinic intake packet",
  "wire cutoff",
  "Re: Investor diligence",
  "Sarah",
  "Marco",
  "Suran",
];

function checkResponseIsHonestlyEmpty(ctx: ScenarioContext): string | undefined {
  const checkin = ctx.actionsCalled.find(
    (action) => action.actionName === "CHECKIN",
  );
  if (!checkin) {
    return "expected the agent to invoke CHECKIN to assemble a morning brief";
  }
  const data = checkin.result?.data as
    | { habitSummaries?: unknown[]; overdueTodos?: unknown[] }
    | undefined;
  if (!data) {
    return "CHECKIN was called but produced no structured data";
  }
  // The brief reply travels through ctx.turns[0].responseText.
  const reply = String(
    ctx.turns?.[0]?.responseText ?? "",
  ).toLowerCase();
  if (reply.length === 0) {
    return "agent returned an empty response on empty-inbox brief";
  }
  for (const forbidden of FORBIDDEN_FABRICATION_STRINGS) {
    if (reply.includes(forbidden.toLowerCase())) {
      return `agent fabricated content not present in the inbox: "${forbidden}"`;
    }
  }
  // The reply must contain a recognizable empty-state signal.
  const emptyStateSignals = [
    "no unread",
    "nothing",
    "empty",
    "all clear",
    "inbox is clear",
    "no new",
    "no messages",
    "no pending",
    "no items",
    "nothing pressing",
    "nothing to triage",
    "you're caught up",
    "you are caught up",
    "all caught up",
    "no urgent",
    "clear inbox",
  ];
  const hasEmptySignal = emptyStateSignals.some((signal) =>
    reply.includes(signal),
  );
  if (!hasEmptySignal) {
    return `expected an explicit empty-state signal in the reply (one of: ${emptyStateSignals.slice(0, 4).join(", ")}, ...). Reply: ${reply.slice(0, 200)}`;
  }
  return undefined;
}

export default scenario({
  id: "morning-brief.empty-inbox",
  title: "Morning brief on a truly empty inbox reports the empty state honestly",
  domain: "lifeops.morning-brief",
  tags: [
    "lifeops",
    "morning-brief",
    "negative-path",
    "no-fabrication",
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
      title: "Morning Brief Empty Inbox",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "ensure-truly-empty-inbox",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        // Clear out anything the runtime might pick up. These tables exist
        // in the lifeops PG schema; deletes are idempotent on an empty DB.
        await executeRawSql(
          runtime,
          `DELETE FROM app_lifeops.life_inbox_triage_entries WHERE agent_id = ${sqlQuote(agentId)}`,
        );
        await executeRawSql(
          runtime,
          `DELETE FROM app_lifeops.life_task_occurrences WHERE agent_id = ${sqlQuote(agentId)} AND state IN ('pending','active','in_progress')`,
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-for-morning-brief",
      room: "main",
      text: "Give me my morning brief — what needs my attention right now?",
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
      name: "empty-inbox-honest-reply",
      predicate: checkResponseIsHonestlyEmpty,
    },
    judgeRubric({
      name: "morning-brief-empty-inbox-rubric",
      threshold: 0.7,
      description: `The user asked for a morning brief while their inbox, triage queue, and todo list are EMPTY. A correct reply: explicitly states there is nothing pressing / inbox is clear / no urgent items, OR enumerates ZERO triage entries and ZERO overdue items. An incorrect reply: invents subjects, names, or counts; describes a "Pending Drafts" section with non-zero items; says "here are 3 things you should know" with fabricated content; mentions any of: investor diligence, Sarah, Suran, Marco, clinic intake, wire cutoff. Score 0 if the agent fabricates ANY specific subject, sender, or count > 0.`,
    }),
  ],
});
