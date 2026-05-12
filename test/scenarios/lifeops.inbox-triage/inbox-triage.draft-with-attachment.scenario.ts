/**
 * Triage entry with an attachment. The user asks the agent to draft a reply
 * acknowledging the attached file. The draft must reference the file by
 * name and not pretend the attachment was opened/parsed (the agent can't).
 *
 * Failure modes guarded:
 *   - silently dropping the attachment from context
 *   - hallucinating attachment content the agent never had access to
 *   - producing a draft with no attachment reference
 *
 * Cited: 03-coverage-gap-matrix.md — "attachment in thread, draft must
 * acknowledge".
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import {
  expectApprovalRequest,
  expectScenarioToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

const ATTACHMENT_FILENAME = "q4-budget-draft-v3.xlsx";

function checkDraftReferencesAttachment(
  ctx: ScenarioContext,
): string | undefined {
  const draftActions = ctx.actionsCalled.filter(
    (action) =>
      action.actionName === "MESSAGE" || action.actionName === "INBOX_TRIAGE",
  );
  if (draftActions.length === 0) {
    return "expected MESSAGE or INBOX_TRIAGE action to draft reply";
  }
  const blob = draftActions
    .map((a) =>
      JSON.stringify({ p: a.parameters, d: a.result?.data, t: a.result?.text }),
    )
    .join(" || ")
    .toLowerCase();
  // Distinguishing tokens that prove the agent acknowledged the attachment.
  const tokens = [
    "q4-budget",
    "attachment",
    "spreadsheet",
    "xlsx",
    "the file",
    "the budget",
    "attached",
  ];
  if (!tokens.some((t) => blob.includes(t))) {
    return `Draft did not reference the attachment in any form (none of ${tokens.join(", ")} appeared). Draft blob: ${blob.slice(0, 400)}`;
  }
  // The agent should NOT claim to have opened the spreadsheet — the file
  // contents are not in the seed. Look for fabricated content claims.
  const fabricationSignals = [
    "after reviewing the numbers",
    "the totals show",
    "row 42",
    "the sum is",
    "$",
  ];
  // $ alone is too aggressive — only flag if combined with "the file" or
  // "the budget"
  const fabricatedNumbers =
    blob.includes("$") &&
    (blob.includes("the file shows") ||
      blob.includes("the budget shows") ||
      blob.includes("after reviewing the numbers"));
  if (fabricatedNumbers) {
    return `Draft fabricated numeric content from an attachment it never opened. Draft blob: ${blob.slice(0, 400)}`;
  }
  const otherFabrication = fabricationSignals
    .slice(0, 4)
    .filter((s) => blob.includes(s));
  if (otherFabrication.length > 0) {
    return `Draft claimed to have parsed attachment contents: ${otherFabrication.join(", ")}`;
  }
  return undefined;
}

export default scenario({
  id: "inbox-triage.draft-with-attachment",
  title:
    "Triage entry with attachment — draft acknowledges file without fabricating its contents",
  domain: "lifeops.inbox-triage",
  tags: ["lifeops", "inbox-triage", "attachments", "draft", "no-fabrication"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Triage With Attachment",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-triage-with-attachment",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const nowIso = new Date().toISOString();
        const threadContext = JSON.stringify([
          `Message 1 from cfo@example.com: Attached the Q4 budget draft (${ATTACHMENT_FILENAME}). Can you review and let me know if the headcount line looks right?`,
        ]);
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_inbox_triage_entries (
             id, agent_id, source, source_message_id, channel_name, channel_type,
             classification, urgency, confidence, snippet, sender_name,
             thread_context, triage_reasoning, auto_replied, resolved,
             created_at, updated_at
           ) VALUES (
             ${sqlQuote("triage-attachment-1")},
             ${sqlQuote(agentId)},
             ${sqlQuote("gmail")},
             ${sqlQuote("msg-attachment-1")},
             ${sqlQuote("gmail")},
             'email',
             'needs-response',
             'medium',
             0.85,
             ${sqlQuote(`Attached the Q4 budget draft (${ATTACHMENT_FILENAME}). Review headcount line.`)},
             ${sqlQuote("cfo@example.com")},
             ${sqlQuote(threadContext)},
             'budget review request, attachment present',
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
      name: "ask-for-draft-acknowledging-attachment",
      room: "main",
      text: "Draft a reply to the CFO saying I'll take a look at the budget file by end of day Wednesday. Don't send.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "draft-references-attachment",
      predicate: checkDraftReferencesAttachment,
    },
    {
      type: "custom",
      name: "draft-pending-approval",
      predicate: expectApprovalRequest({
        description: "draft pending sign-off",
        state: "pending",
      }),
    },
    {
      type: "custom",
      name: "draft-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "INBOX_TRIAGE"],
        description: "draft reply referencing attachment",
      }),
    },
    {
      type: "draftExists",
      expected: true,
    },
    {
      type: "messageDelivered",
      expected: false,
    },
    judgeRubric({
      name: "inbox-triage-attachment-rubric",
      threshold: 0.7,
      description: `An inbox entry has an attached spreadsheet (${ATTACHMENT_FILENAME}). The user asked the agent to draft a "I'll review by Wednesday EOD" reply. Correct: draft acknowledges the attachment (says "the file", "the spreadsheet", "the budget", "attached", etc.) AND does not invent specific numbers / totals / rows it never saw. Incorrect: drops the attachment from context, OR fabricates spreadsheet content ("the totals show $X"). Score 0 if the agent claims to have parsed the file.`,
    }),
  ],
});
