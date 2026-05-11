/**
 * Spam quarantine review — the user asks the agent to surface anything in
 * the spam queue that might be a false positive. Agent must distinguish
 * actual spam from likely-legit-but-mis-classified mail.
 *
 * Seed: 3 spam rows — two obvious spam (Nigerian prince, crypto pump), one
 * likely false-positive (a calendar invite from a known domain).
 *
 * Failure modes guarded:
 *   - treating all spam as legitimate ("here are 3 messages to handle!")
 *   - missing the false-positive entirely
 *   - bulk-deleting without flagging the false-positive
 *
 * Cited: 03-coverage-gap-matrix.md — spam queue review.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";

const FALSE_POSITIVE_TOKEN = "calendar-invite-from-known-domain";

function checkAgentSurfacesFalsePositive(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) return "empty reply on spam review";
  // The reply must reference the false-positive or otherwise distinguish
  // real spam from possible false-positive.
  const fpSignals = [
    "calendar",
    "invite",
    "false positive",
    "not actually spam",
    "looks legit",
    "looks legitimate",
    "may not be spam",
    "might not be spam",
    "not spam",
    "real",
    "knownco",
    "known domain",
  ];
  const sawFp = fpSignals.some((s) => reply.includes(s));
  if (!sawFp) {
    return `Spam review did not flag the likely false-positive calendar invite. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "inbox-triage.spam-quarantine-review",
  title: "Spam quarantine review surfaces likely false-positive among real spam",
  domain: "lifeops.inbox-triage",
  tags: [
    "lifeops",
    "inbox-triage",
    "spam",
    "false-positive",
    "ranking",
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
      title: "Spam Quarantine Review",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-spam-with-false-positive",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const nowIso = new Date().toISOString();
        const rows = [
          {
            id: "spam-1",
            sender: "prince@nigeria-bank.tk",
            snippet:
              "Greetings dear friend, I have $14M to transfer urgently, please respond.",
            classification: "spam",
          },
          {
            id: "spam-2",
            sender: "pump@crypto-moonshot.io",
            snippet: "LAST CHANCE — DOGEMOON to the moon. Buy now or regret.",
            classification: "spam",
          },
          {
            id: "spam-fp",
            sender: "calendar@knownco.com",
            snippet: `${FALSE_POSITIVE_TOKEN}: invitation to Q4 board sync, you previously RSVPed yes.`,
            classification: "spam",
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
               'low',
               0.6,
               ${sqlQuote(row.snippet)},
               ${sqlQuote(row.sender)},
               '[]',
               'spam quarantine entry',
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
      name: "ask-to-review-spam",
      room: "main",
      text: "Look at my spam folder — anything in there that's actually legit and got flagged by mistake?",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "false-positive-surfaced",
      predicate: checkAgentSurfacesFalsePositive,
    },
    judgeRubric({
      name: "inbox-triage-spam-review-rubric",
      threshold: 0.7,
      description: `Spam queue has 2 obvious spam (Nigerian prince, crypto pump) and 1 likely false-positive (calendar invite from a known domain the user previously RSVPed to). Correct: agent identifies the calendar invite as a likely false-positive and suggests un-spamming it. Incorrect: treats all 3 as real spam, or asks the user to action the Nigerian prince email. Score 0 if the false-positive is not flagged.`,
    }),
  ],
});
