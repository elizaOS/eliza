// Defines the bill approval and payment LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectApprovalResolvedApproved,
  expectPendingApprovalSeeded,
} from "./_helpers/approval-outcome.ts";

/**
 * Live-model bill-approval-and-payment flow. Seeds a real pending
 * payment-authorization approval on the
 * live queue for the contractor invoice, resolves it through the live
 * RESOLVE_REQUEST action (pending -> approved/executing/done), and then
 * asserts the receipt-verification follow-up was captured as a scheduled item
 * whose arguments actually carry the receipt task (`selectedActionArguments`),
 * not just a reply that repeats the word "reminder".
 */
export default scenario({
  lane: "live-only",
  id: "bill-approval-and-payment",
  title:
    "Contractor invoice authorization resolves and a receipt follow-up is scheduled",
  domain: "executive.money",
  tags: ["lifeops", "executive-assistant", "money", "approvals", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "LifeOps Bill Approval and Payment",
    },
  ],
  turns: [
    {
      // Deterministic seed: real PENDING approval row gating the payment.
      kind: "action",
      name: "seed-pending-invoice-authorization",
      room: "main",
      actionName: "PERSONAL_ASSISTANT",
      text: "The contractor invoice is due this week. Queue the payment authorization; it does not pay out without me.",
      options: {
        action: "sign_document",
        documentName: "Contractor invoice payment authorization",
        reason:
          "Contractor invoice due this week; flagged as the riskiest open bill because the vendor changed banking details last month.",
      },
      assertResponse(text: string) {
        if (!/approval|approve/i.test(text)) {
          return "seed reply must say the payment is gated on approval";
        }
      },
    },
    {
      kind: "message",
      name: "surface-bill-risk",
      room: "main",
      text: "Which bills are waiting on me this week, and which one is the riskiest?",
      plannerExcludes: ["calendar_action"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must surface the pending contractor-invoice authorization as an item waiting on the owner and explain the concrete risk (recent banking-detail change), not a generic list of made-up bills with no queue backing.",
      },
    },
    {
      // Live-LLM resolution: the owner approves the payment authorization.
      kind: "message",
      name: "approve-payment-and-followup",
      room: "main",
      text: "Approve the Contractor invoice payment authorization request, and set a follow-up for tomorrow to verify the receipt posted.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must confirm the payment authorization was APPROVED and commit to a concrete follow-up tomorrow to verify the receipt posted. Asking for confirmation again, or dropping the receipt follow-up, fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "invoice-authorization-pending-seeded",
      predicate: expectPendingApprovalSeeded(
        "Contractor invoice payment authorization",
      ),
    },
    {
      type: "selectedAction",
      actionName: ["RESOLVE_REQUEST"],
    },
    {
      type: "actionCalled",
      actionName: "RESOLVE_REQUEST",
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "invoice-pending-to-approved",
      predicate: expectApprovalResolvedApproved(),
    },
    // OUTCOME: the receipt follow-up is a captured scheduled item whose
    // arguments carry the receipt task — not just reply wording.
    {
      type: "selectedActionArguments",
      name: "receipt-followup-scheduled-with-args",
      actionName: ["SCHEDULED_TASKS", "OWNER_REMINDERS", "OWNER_TODOS", "LIFE"],
      includesAll: ["receipt"],
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "bill-approval-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: a pending contractor-invoice payment authorization existed on the live queue, the assistant surfaced it with its concrete risk, the owner's approval resolved the queue row, and a receipt-verification follow-up was actually scheduled for tomorrow.",
    },
  ],
});
