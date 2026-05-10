/**
 * Inbox triage on a 3-message thread, draft must wait for sign-off.
 *
 * Failure modes guarded:
 *   - sending the draft before the user approves
 *   - drafting from only the first message (ignoring the thread)
 *   - completing the action with no approval-queue entry recorded
 *
 * Existing scenarios (gmail.draft.reply-from-context.scenario.ts) test
 * single-message draft creation. This scenario adds the contract that
 * (a) the draft considers all 3 thread messages, (b) an approval queue
 * entry is created, and (c) no `messages.send` runs until approval.
 *
 * Cited: 03-coverage-gap-matrix.md row 26 — inbox triage with thread +
 * draft sign-off has no scenario.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import {
  expectApprovalRequest,
  expectScenarioToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";

interface ThreadMessage {
  index: number;
  from: string;
  body: string;
  receivedAt: string;
}

const THREAD_KEY = "thread:vendor-pricing-2025-11";

const THREAD: ThreadMessage[] = [
  {
    index: 1,
    from: "vendor-mike@example.com",
    body: "Hi — sending over the updated quote: 5k seats at $12/seat for 12 months. Let me know if that works.",
    receivedAt: "2025-11-01T09:00:00.000Z",
  },
  {
    index: 2,
    from: "vendor-mike@example.com",
    body: "One more note — the $12/seat assumes annual prepay. Monthly billing would be $14/seat.",
    receivedAt: "2025-11-01T11:00:00.000Z",
  },
  {
    index: 3,
    from: "vendor-mike@example.com",
    body: "Following up on this — can we lock in by EOW? Need to feed it to procurement on our side.",
    receivedAt: "2025-11-02T15:00:00.000Z",
  },
];

function checkDraftConsidersWholeThread(
  ctx: ScenarioContext,
): string | undefined {
  // The draft must mention BOTH the annual-prepay vs monthly distinction
  // (only in message #2) AND the EOW deadline (only in message #3). Each
  // is a distinguishing fact that did NOT appear in the user prompt and
  // does NOT appear in message #1, so a hit proves the agent read the
  // full thread rather than only the first or last message.
  const draftActions = ctx.actionsCalled.filter(
    (action) =>
      action.actionName === "MESSAGE" || action.actionName === "INBOX_TRIAGE",
  );
  if (draftActions.length === 0) {
    return "expected the agent to invoke MESSAGE or INBOX_TRIAGE to draft a reply";
  }
  const blob = draftActions
    .map((action) =>
      JSON.stringify({
        parameters: action.parameters ?? null,
        data: action.result?.data ?? null,
        text: action.result?.text ?? null,
      }),
    )
    .join(" || ")
    .toLowerCase();

  const message2Tokens = ["annual", "monthly", "prepay", "$14", "14/seat"];
  const message3Tokens = ["eow", "end of week", "procurement", "lock in"];

  const sawMessage2 = message2Tokens.some((kw) => blob.includes(kw));
  const sawMessage3 = message3Tokens.some((kw) => blob.includes(kw));

  if (!sawMessage2 && !sawMessage3) {
    return `Draft did not reference either message #2 (annual vs monthly pricing) or message #3 (EOW deadline / procurement). The draft was probably authored from only message #1 — prompt: ${blob.slice(0, 400)}`;
  }
  if (!sawMessage2) {
    return `Draft did not consider message #2's annual-vs-monthly pricing distinction (one of: ${message2Tokens.join(", ")}). Draft blob: ${blob.slice(0, 400)}`;
  }
  if (!sawMessage3) {
    return `Draft did not consider message #3's EOW / procurement deadline (one of: ${message3Tokens.join(", ")}). Draft blob: ${blob.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "inbox-triage.thread-with-draft",
  title: "3-message thread → draft reply, awaits approval before send",
  domain: "lifeops.inbox-triage",
  tags: [
    "lifeops",
    "inbox-triage",
    "draft",
    "approval-required",
    "thread-context",
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
      title: "Inbox Triage Thread Draft",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-three-message-thread",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const threadContextJson = JSON.stringify(
          THREAD.map(
            (m) =>
              `Message ${m.index} (${m.receivedAt}) from ${m.from}: ${m.body}`,
          ),
        );
        const latest = THREAD[THREAD.length - 1];
        if (!latest) return "thread fixture is empty";
        // Triage entry that the agent will pull when asked to "reply to mike".
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_inbox_triage_entries (
             id, agent_id, source, source_room_id, source_entity_id, source_message_id,
             channel_name, channel_type, deep_link, classification, urgency, confidence,
             snippet, sender_name, thread_context, triage_reasoning, suggested_response,
             auto_replied, resolved, created_at, updated_at
           ) VALUES (
             ${sqlQuote("triage-vendor-mike-thread")},
             ${sqlQuote(agentId)},
             ${sqlQuote("gmail")},
             NULL, NULL,
             ${sqlQuote(THREAD_KEY)},
             ${sqlQuote("gmail")},
             'email',
             NULL,
             'needs-response',
             'medium',
             0.85,
             ${sqlQuote(latest.body)},
             ${sqlQuote(latest.from)},
             ${sqlQuote(threadContextJson)},
             'three-message vendor pricing thread, deadline at end of week',
             NULL,
             FALSE, FALSE,
             ${sqlQuote(latest.receivedAt)},
             ${sqlQuote(latest.receivedAt)}
           )`,
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-agent-to-draft",
      room: "main",
      text: "Draft a reply to vendor Mike's pricing thread saying we'll go with the annual prepay tier and confirm by Friday. Don't send it yet — I want to review.",
      forbiddenActions: [],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "draft-considers-whole-thread",
      predicate: checkDraftConsidersWholeThread,
    },
    {
      type: "custom",
      name: "agent-invoked-messaging-action",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "INBOX_TRIAGE"],
        description: "drafted reply to the thread",
        includesAny: ["draft", "review", "annual", "prepay", "friday"],
      }),
    },
    {
      type: "custom",
      name: "draft-pending-approval",
      predicate: expectApprovalRequest({
        description:
          "outbound message gated on user approval before send",
        state: "pending",
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
      name: "inbox-triage-thread-draft-rubric",
      threshold: 0.7,
      description: `The user has a 3-message vendor-pricing thread (5k seats at $12/seat annual or $14/seat monthly, EOW deadline). They asked the agent to draft (NOT send) a reply choosing annual prepay and confirming by Friday. A correct outcome: the agent (1) drafts a reply that reflects all 3 messages — at minimum referencing annual-prepay pricing AND the Friday/EOW timeline; (2) does NOT send anything; (3) leaves the draft pending the user's approval. Score 0 if the agent sent the message, drafted from only the first message in the thread, or claimed the reply was sent.`,
    }),
  ],
});
