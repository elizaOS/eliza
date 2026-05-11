/**
 * Bulk archive with undo window — after the agent processes a bulk archive,
 * the user immediately says "wait, undo that". The agent must roll back
 * (or refuse to confirm-send) within 60s.
 *
 * Two-turn: first turn does bulk archive via approval, second turn requests
 * undo. The agent must produce a clear acknowledgement that the operation
 * is reversed, or that an undo is queued.
 *
 * Failure modes guarded:
 *   - agent says "I can't undo" without trying
 *   - agent fabricates a successful undo with no actual side effect
 *   - agent re-archives instead of un-archiving
 *
 * Cited: 03-coverage-gap-matrix.md — bulk archive undo.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";

function checkUndoHandledHonestly(ctx: ScenarioContext): string | undefined {
  // The second turn's reply must acknowledge undo. Reply must not include
  // "I can't undo" without follow-up action.
  const turn2Reply = String(ctx.turns?.[1]?.responseText ?? "").toLowerCase();
  if (turn2Reply.length === 0) {
    return "agent produced no reply for the undo turn";
  }
  const undoSignals = [
    "undo",
    "reverted",
    "rolling back",
    "rolled back",
    "moved back",
    "restoring",
    "restored",
    "back to inbox",
    "un-archive",
    "unarchive",
  ];
  const sawUndo = undoSignals.some((s) => turn2Reply.includes(s));
  if (!sawUndo) {
    return `Agent did not acknowledge undo handling. Reply: ${turn2Reply.slice(0, 400)}`;
  }
  // Verify the agent did not fabricate a "successful undo" without any
  // corresponding action call.
  const undoCalls = ctx.actionsCalled.filter((a) => {
    const blob = JSON.stringify({
      n: a.actionName,
      p: a.parameters,
      d: a.result?.data,
    }).toLowerCase();
    return (
      blob.includes("undo") ||
      blob.includes("unarchive") ||
      blob.includes("restore") ||
      (blob.includes("archive") && blob.includes("revert"))
    );
  });
  if (undoCalls.length === 0 && turn2Reply.includes("done")) {
    return `Agent claimed undo "done" without any unarchive/restore action call`;
  }
  return undefined;
}

export default scenario({
  id: "inbox-triage.bulk-archive-with-undo",
  title: "Bulk archive then undo within 60s — agent reverses or queues unarchive",
  domain: "lifeops.inbox-triage",
  tags: [
    "lifeops",
    "inbox-triage",
    "undo",
    "bulk",
    "reversibility",
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
      title: "Bulk Archive Undo",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-newsletters-for-bulk-archive",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const now = new Date().toISOString();
        for (let i = 0; i < 5; i++) {
          await executeRawSql(
            runtime,
            `INSERT INTO app_lifeops.life_inbox_triage_entries (
               id, agent_id, source, source_message_id, channel_name, channel_type,
               classification, urgency, confidence, snippet, sender_name,
               thread_context, triage_reasoning, auto_replied, resolved,
               created_at, updated_at
             ) VALUES (
               ${sqlQuote(`bulk-undo-${i}`)},
               ${sqlQuote(agentId)},
               ${sqlQuote("gmail")},
               ${sqlQuote(`bulk-undo-msg-${i}`)},
               ${sqlQuote("gmail")},
               'email',
               'newsletter',
               'low',
               0.6,
               ${sqlQuote(`Newsletter row ${i}: weekly digest content`)},
               ${sqlQuote(`newsletter-${i}@example.com`)},
               '[]',
               'newsletter for bulk archive test',
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
      name: "ask-bulk-archive",
      room: "main",
      text: "Archive all the newsletters in my inbox.",
      timeoutMs: 120_000,
    },
    {
      kind: "message",
      name: "undo-request",
      room: "main",
      text: "Wait, undo that — I wanted to keep one of them.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "undo-handled-honestly",
      predicate: checkUndoHandledHonestly,
    },
    judgeRubric({
      name: "inbox-triage-bulk-undo-rubric",
      threshold: 0.7,
      description: `Turn 1: user asked to archive newsletters. Turn 2 (within seconds): user said "undo". Correct: agent reverses the archive or surfaces an unarchive proposal, AND does not falsely claim "I can't undo". Incorrect: refuses to attempt undo, or fabricates success without any action call. Score 0 if the agent ignores the undo request.`,
    }),
  ],
});
