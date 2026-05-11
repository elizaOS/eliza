/**
 * First-name disambiguation — when the user says "reply to Jill" and TWO
 * triage entries are from people named Jill, the agent must clarify which
 * Jill, NOT silently pick one.
 *
 * Seed: Jill Anderson (vendor pricing) and Jill Park (coffee plans). User
 * prompt: "reply to Jill saying yes that works".
 *
 * Failure modes guarded:
 *   - silently sending to the wrong Jill
 *   - drafting to both Jills
 *   - drafting to neither and saying "done"
 *
 * Cited: 03-coverage-gap-matrix.md — first-name ambiguity.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";

function checkAgentDisambiguated(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) return "empty reply on ambiguous Jill prompt";
  // The agent should clarify rather than silently pick. Look for clarifying
  // language OR mention of BOTH Jills.
  const clarifySignals = [
    "which jill",
    "two jill",
    "anderson",
    "park",
    "which one",
    "do you mean",
    "could you clarify",
    "ambiguous",
    "more than one",
    "multiple",
  ];
  const sawClarify = clarifySignals.some((s) => reply.includes(s));
  if (!sawClarify) {
    return `Agent did not clarify which Jill (Anderson or Park). Reply: ${reply.slice(0, 400)}`;
  }
  // No action should have been fired to send a draft to either Jill until
  // disambiguated.
  const sendingDispatches = (ctx.connectorDispatches ?? []).filter((d) => {
    const blob = JSON.stringify(d.payload ?? "").toLowerCase();
    return (
      blob.includes("anderson") ||
      blob.includes("park") ||
      blob.includes("jill")
    );
  });
  if (sendingDispatches.length > 0) {
    return `Agent dispatched a message to one of the Jills without clarifying which. Dispatches: ${JSON.stringify(sendingDispatches.map((d) => d.channel))}`;
  }
  return undefined;
}

export default scenario({
  id: "inbox-triage.first-name-disambig",
  title: "Ambiguous first name (two Jills) → agent clarifies, does not send",
  domain: "lifeops.inbox-triage",
  tags: [
    "lifeops",
    "inbox-triage",
    "disambiguation",
    "clarification",
    "negative-path",
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
      title: "Jill Disambiguation",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-two-jills",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const now = new Date().toISOString();
        const rows = [
          {
            id: "jill-anderson",
            sender: "jill.anderson@vendor.example",
            snippet: "Quote: 200 units at $45/each, can you confirm?",
            classification: "needs-response",
          },
          {
            id: "jill-park",
            sender: "jill.park@friend.example",
            snippet: "Hey want to grab coffee Saturday at 10am?",
            classification: "needs-response",
          },
        ];
        for (const row of rows) {
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
               ${sqlQuote(row.classification)},
               'medium',
               0.7,
               ${sqlQuote(row.snippet)},
               ${sqlQuote(row.sender)},
               '[]',
               'ambiguous-name seed',
               FALSE, FALSE,
               ${sqlQuote(now)},
               ${sqlQuote(now)}
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
      name: "ambiguous-reply-request",
      room: "main",
      text: "Reply to Jill saying yes that works.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-disambiguated",
      predicate: checkAgentDisambiguated,
    },
    {
      type: "messageDelivered",
      expected: false,
    },
    judgeRubric({
      name: "inbox-triage-first-name-disambig-rubric",
      threshold: 0.7,
      description: `Two Jills in inbox (Anderson vendor, Park friend). User said "reply to Jill". Correct: agent asks which Jill or presents both options. Incorrect: silently picks one and drafts/sends, or claims "done" without picking. Score 0 if a draft is created bound to one specific Jill without clarification.`,
    }),
  ],
});
