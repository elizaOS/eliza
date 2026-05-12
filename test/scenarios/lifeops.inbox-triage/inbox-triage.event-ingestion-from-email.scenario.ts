/**
 * Event extraction from email body — agent must propose a CALENDAR add
 * (not just acknowledge the date in prose) when an inbox entry contains
 * an event invitation.
 *
 * Seed: a triage row that says "We're doing the team offsite Nov 18-20 at
 * Lake Tahoe, please confirm". The agent, when asked "anything I should
 * add to my calendar from inbox?", must produce a CALENDAR action (or
 * propose one explicitly) and reference the dates Nov 18-20.
 *
 * Failure modes guarded:
 *   - reply-only without proposing a calendar add
 *   - wrong dates extracted
 *   - silently dropping the event
 *
 * Cited: 03-coverage-gap-matrix.md — event extraction from inbox.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";

function checkEventProposed(ctx: ScenarioContext): string | undefined {
  const calendarCalls = ctx.actionsCalled.filter(
    (a) => a.actionName === "CALENDAR",
  );
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  // Either a CALENDAR action was invoked, OR the reply explicitly proposes
  // adding the event with the right dates.
  const datesInBlob = (text: string) =>
    text.includes("nov 18") ||
    text.includes("november 18") ||
    text.includes("11/18") ||
    text.includes("11-18");
  if (calendarCalls.length > 0) {
    const blob = calendarCalls
      .map((c) =>
        JSON.stringify({ p: c.parameters, d: c.result?.data }).toLowerCase(),
      )
      .join(" || ");
    if (!datesInBlob(blob)) {
      return `CALENDAR action called but did not reference Nov 18 dates from the inbox. Payload: ${blob.slice(0, 400)}`;
    }
    return undefined;
  }
  // No CALENDAR call — verify the agent at least proposes one in the reply.
  const proposeSignals = [
    "add to your calendar",
    "add this to",
    "i can add",
    "should i add",
    "do you want me to add",
    "create a calendar",
    "block off",
  ];
  const sawPropose = proposeSignals.some((s) => reply.includes(s));
  const sawDates = datesInBlob(reply);
  if (!sawPropose && !sawDates) {
    return `Agent did not propose a calendar entry or reference the Nov 18 dates from the inbox. Reply: ${reply.slice(0, 400)}`;
  }
  if (!sawDates) {
    return `Agent proposed an add but did not extract the Nov 18 date. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "inbox-triage.event-ingestion-from-email",
  title: "Agent extracts event from inbox entry and proposes calendar add",
  domain: "lifeops.inbox-triage",
  tags: [
    "lifeops",
    "inbox-triage",
    "event-extraction",
    "calendar",
    "cross-action",
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
      title: "Event Extraction From Email",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-triage-entry-with-event",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const nowIso = new Date().toISOString();
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_inbox_triage_entries (
             id, agent_id, source, source_message_id, channel_name, channel_type,
             classification, urgency, confidence, snippet, sender_name,
             thread_context, triage_reasoning, auto_replied, resolved,
             created_at, updated_at
           ) VALUES (
             ${sqlQuote("triage-event-1")},
             ${sqlQuote(agentId)},
             ${sqlQuote("gmail")},
             ${sqlQuote("msg-event-1")},
             ${sqlQuote("gmail")},
             'email',
             'calendar',
             'medium',
             0.8,
             ${sqlQuote("Team offsite is confirmed for November 18-20, 2025 at Lake Tahoe. Please confirm you can make it.")},
             ${sqlQuote("ops-coordinator@example.com")},
             '[]',
             'event invite embedded in email body',
             FALSE, FALSE,
             ${sqlQuote(nowIso)},
             ${sqlQuote(nowIso)}
           )`,
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-anything-for-calendar",
      room: "main",
      text: "Anything in my inbox I should add to my calendar?",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "event-extracted-with-dates",
      predicate: checkEventProposed,
    },
    judgeRubric({
      name: "inbox-triage-event-extraction-rubric",
      threshold: 0.7,
      description: `Inbox has a team-offsite invite for Nov 18-20 at Lake Tahoe. Correct: agent either proposes a calendar add or invokes the CALENDAR action with the correct dates (Nov 18). Incorrect: agent only summarizes without offering to add, OR extracts wrong dates. Score 0 if neither the dates nor a calendar proposal appears.`,
    }),
  ],
});
