/**
 * Live-model draft-approval sweep (#9310): seeds two real pending approvals on the
 * live queue, asks for the sweep (the reply must name the seeded "Meridian" item,
 * a token absent from every user turn), then drives a split decision through the
 * live RESOLVE_REQUEST action and asserts both queue outcomes — one row approved,
 * one rejected with no gated side effect.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectApprovalRejectedNoSideEffect,
  expectApprovalResolvedApproved,
  expectPendingApprovalSeeded,
} from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "draft-approval-sweep",
  title:
    "Draft sweep grounds in the live queue and a split approve/reject decision lands",
  domain: "executive.approvals",
  tags: ["lifeops", "executive-assistant", "approvals", "messaging", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "LifeOps Draft Approval Sweep",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "seed-pending-meridian-reply",
      room: "main",
      actionName: "PERSONAL_ASSISTANT",
      text: "Queue my reply about the vendor renewal for sign-off before it goes out.",
      options: {
        action: "sign_document",
        documentName: "Meridian renewal reply",
        reason:
          "Outbound reply on the Meridian renewal thread; becomes awkward if it sits another day.",
      },
      assertResponse(text: string) {
        if (!/approval|approve/i.test(text)) {
          return "seed reply must say the Meridian reply is gated on approval";
        }
      },
    },
    {
      kind: "action",
      name: "seed-pending-quarterly-note",
      room: "main",
      actionName: "PERSONAL_ASSISTANT",
      text: "Also queue the quarterly note for sign-off; it is lower priority.",
      options: {
        action: "sign_document",
        documentName: "Quarterly update note",
        reason: "Quarterly investor update note; timing is flexible.",
      },
      assertResponse(text: string) {
        if (!/approval|approve/i.test(text)) {
          return "seed reply must say the quarterly note is gated on approval";
        }
      },
    },
    {
      kind: "message",
      name: "list-pending-drafts",
      room: "main",
      text: "What outbound items are waiting on me right now, and which one becomes awkward if it sits another day?",
      // Grounding outcome: the sweep must name the seeded queue item — the
      // token "meridian" only exists in the seeded queue row (options), never
      // in any user turn text, so an echoed reply cannot pass.
      responseIncludesAll: ["meridian"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must enumerate the two pending sign-offs actually sitting on the queue (the Meridian renewal reply and the quarterly update note) and flag the time-sensitive one first. Inventing items that were never queued, or omitting the seeded ones, fails.",
      },
    },
    {
      // Live-LLM resolution: split decision — approve one, hold the other.
      kind: "message",
      name: "approve-one-reject-other",
      room: "main",
      text: "Approve the renewal reply request and send it. Reject the quarterly note request — it stays on hold.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must confirm the split decision exactly: the Meridian renewal reply was APPROVED/sent and the quarterly update note was REJECTED/held. Swapping the two, approving both, or asking again fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "meridian-approval-pending-seeded",
      predicate: expectPendingApprovalSeeded("Meridian renewal reply"),
    },
    {
      type: "custom",
      name: "quarterly-note-approval-pending-seeded",
      predicate: expectPendingApprovalSeeded("Quarterly update note"),
    },
    {
      type: "selectedAction",
      actionName: ["RESOLVE_REQUEST"],
    },
    // OUTCOME: one row moved pending -> approved/executing/done ...
    {
      type: "custom",
      name: "sweep-approve-path-resolved",
      predicate: expectApprovalResolvedApproved(),
    },
    // ... and one row landed in rejected with no gated side effect.
    {
      type: "custom",
      name: "sweep-reject-path-no-side-effect",
      predicate: expectApprovalRejectedNoSideEffect(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "draft-sweep-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: two pending sign-offs existed on the live queue, the sweep enumerated them from real queue state, and the owner's split decision resolved one to approved and the other to rejected with no side effect on the held item.",
    },
  ],
});
